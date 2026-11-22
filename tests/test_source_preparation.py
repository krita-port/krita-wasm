"""Exercise patch application and preservation guarantees using small Git fixtures."""

import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from typing import Any
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "project", Path(__file__).resolve().parents[1] / "scripts/project.py"
)
assert SPEC is not None and SPEC.loader is not None
project = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(project)


class SourcePreparationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "krita"
        self.source.mkdir(parents=True)
        (self.source / ".git").mkdir()
        (self.source / "hello.txt").write_text("before\n")
        self.commit = "a" * 40
        self.gitlink = f"160000 {self.commit} 0\tkrita"
        self.original_run = project.run
        mock_output = patch.object(project, "output", side_effect=self.git_output)
        mock_output.start()
        self.addCleanup(mock_output.stop)
        mock_run = patch.object(project, "run", side_effect=self.run_command)
        mock_run.start()
        self.addCleanup(mock_run.stop)
        self.patches = self.root / "patches"
        self.patches.mkdir(parents=True)
        (self.patches / "port").mkdir()
        (self.patches / "series").write_text("port/change.patch\n")
        (self.patches / "port/change.patch").write_text(
            "diff --git a/hello.txt b/hello.txt\n--- a/hello.txt\n+++ b/hello.txt\n"
            "@@ -1 +1 @@\n-before\n+after\n"
        )
        mock_root = patch.object(project, "ROOT", self.root)
        mock_root.start()
        self.addCleanup(mock_root.stop)

    def git_output(self, args: list[str | Path]) -> str:
        if args[3:5] == ["rev-parse", "HEAD"]:
            return self.commit
        if args[3] == "status":
            return (
                ""
                if (self.source / "hello.txt").read_text() == "before\n"
                else " M hello.txt"
            )
        if args[3] == "ls-files":
            return self.gitlink
        raise AssertionError(f"Unexpected Git metadata request: {args}")

    def run_command(
        self, args: list[str | Path], **kwargs: Any
    ) -> subprocess.CompletedProcess[str]:
        if len(args) > 3 and args[3] == "archive":
            with tarfile.open(Path(args[args.index("-o") + 1]), "w") as archive:
                data = b"before\n"
                info = tarfile.TarInfo("hello.txt")
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
            return subprocess.CompletedProcess(args, 0, "")
        result: subprocess.CompletedProcess[str] = self.original_run(args, **kwargs)
        return result

    def prepare(self) -> Path:
        stream = io.StringIO()
        with redirect_stdout(stream):
            project.prepare()
        return Path(stream.getvalue().strip())

    def test_applies_patch_inside_parent_repository_without_modifying_submodule(
        self,
    ) -> None:
        dest = self.prepare()
        self.assertEqual((dest / "hello.txt").read_text(), "after\n")
        self.assertEqual((self.source / "hello.txt").read_text(), "before\n")
        manifest = json.loads((dest / ".krita-wasm-source.json").read_text())
        self.assertEqual(manifest["commit"], self.commit)
        self.assertEqual(manifest["patches"], ["port/change.patch"])

    def test_refuses_to_overwrite_derived_source_with_manual_edits(self) -> None:
        dest = self.prepare()
        (dest / "hello.txt").write_text("manual edit\n")
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.prepare()
        self.assertEqual((dest / "hello.txt").read_text(), "manual edit\n")
        with self.assertRaisesRegex(ValueError, "local changes"):
            project.verified_source_path()

    def test_source_path_only_returns_matching_existing_provenance(self) -> None:
        with self.assertRaisesRegex(ValueError, "No source matching"):
            project.source_path()
        dest = self.prepare()
        stream = io.StringIO()
        with redirect_stdout(stream):
            project.source_path()
        self.assertEqual(Path(stream.getvalue().strip()), dest)
        (dest / ".krita-wasm-source.json").write_text("{}")
        with self.assertRaisesRegex(ValueError, "No source matching"):
            project.source_path()

    def test_refuses_dirty_upstream(self) -> None:
        (self.source / "hello.txt").write_text("manual edit\n")
        with self.assertRaisesRegex(ValueError, "local changes"):
            self.prepare()

    def test_build_alias_switches_without_touching_previous_tree(self) -> None:
        first = self.prepare()
        with redirect_stdout(io.StringIO()):
            project.build_source_path()
        alias = first.parent / "krita-build-current"
        self.assertEqual(alias.resolve(), first)
        (first / "hello.txt").write_text("manual edit\n")
        (first / ".krita-wasm-source.json").write_text("{truncated")
        path = self.patches / "port/change.patch"
        path.write_text(path.read_text().replace("+after", "+next"))
        second = self.prepare()
        with redirect_stdout(io.StringIO()):
            project.build_source_path()
        self.assertEqual(alias.resolve(), second)
        self.assertEqual((first / "hello.txt").read_text(), "manual edit\n")
        self.assertEqual((second / "hello.txt").read_text(), "next\n")
        self.assertEqual((first / ".krita-wasm-source.json").read_text(), "{truncated")

    def test_incremental_build_rebuilds_when_patch_is_removed_or_restored(self) -> None:
        first = self.prepare()
        with redirect_stdout(io.StringIO()):
            project.build_source_path()
        alias = first.parent / "krita-build-current"
        work = self.root / "ninja"
        work.mkdir()
        (work / "build.ninja").write_text(
            "rule copy\n  command = cp $in $out\n"
            f"build result.txt: copy {alias}/hello.txt\n"
        )

        def build() -> str:
            subprocess.run(["ninja", "-C", str(work)], check=True, capture_output=True)
            return (work / "result.txt").read_text()

        self.assertEqual(build(), "after\n")
        # A timestamp-preserving manual edit must not let the next prepared
        # tree inherit a timestamp belonging to an object built from old bytes.
        path = first / "hello.txt"
        previous_time = path.stat().st_mtime_ns
        path.write_text("before\n")
        os.utime(path, ns=(previous_time, previous_time))
        patch_file = self.patches / "port/change.patch"
        original = patch_file.read_text()
        patch_file.unlink()
        (self.patches / "series").write_text("")
        second = self.prepare()
        with redirect_stdout(io.StringIO()):
            project.build_source_path()
        # Configure without Ninja, then recreate the active path as advised
        # for a manually changed tree. The retained object still contains A.
        retained = second.with_name(second.name + "-retained")
        second.rename(retained)
        self.assertEqual(self.prepare(), second)
        with redirect_stdout(io.StringIO()):
            project.build_source_path()
        self.assertEqual(build(), "before\n")
        self.assertEqual((retained / "hello.txt").read_text(), "before\n")
        path.write_text("after\n")
        patch_file.write_text(original)
        (self.patches / "series").write_text("port/change.patch\n")
        with redirect_stdout(io.StringIO()):
            project.build_source_path()
        self.assertEqual(build(), "after\n")

    def test_builds_with_different_sdks_cannot_share_the_source_alias(self) -> None:
        scripts = self.root / "scripts"
        scripts.mkdir()
        actual = Path(__file__).resolve().parents[1] / "scripts/build-krita"
        shutil.copyfile(actual, scripts / "build-krita")
        (scripts / "build-krita").chmod(0o755)
        (scripts / "sdk.py").write_text(
            "import os\nprint('export KRITA_SDK_DIR=' + os.environ['TEST_SDK'])\n"
        )
        (scripts / "configure-krita").write_text("#!/bin/sh\nexit 0\n")
        (scripts / "configure-krita").chmod(0o755)
        (scripts / "with-emsdk").write_text("#!/bin/sh\nprintf ready\nread ignored\n")
        (scripts / "with-emsdk").chmod(0o755)
        with subprocess.Popen(
            [str(scripts / "build-krita")],
            env={**os.environ, "TEST_SDK": str(self.root / "sdk-a")},
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        ) as first:
            assert first.stdout is not None and first.stdin is not None
            try:
                self.assertEqual(first.stdout.read(5), b"ready")
                second = subprocess.run(
                    [str(scripts / "build-krita")],
                    env={**os.environ, "TEST_SDK": str(self.root / "sdk-b")},
                    capture_output=True,
                    check=False,
                    timeout=5,
                )
                self.assertEqual(second.returncode, 1)
                self.assertIn(b"Another Krita build", second.stderr)
            finally:
                first.stdin.write(b"done\n")
                first.stdin.flush()
                first.wait(timeout=5)

    def test_packaging_keeps_checkout_locked_after_child_build_exits(self) -> None:
        scripts_path = Path(__file__).resolve().parents[1] / "scripts"
        sys.path.insert(0, str(scripts_path))
        spec = importlib.util.spec_from_file_location(
            "package_krita", scripts_path / "package-krita.py"
        )
        assert spec is not None and spec.loader is not None
        packager = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(packager)
        lock = self.root / "build/cmake/krita.lock"

        def capture_package(
            output: Path, release_url: str | None, lock_fd: int, frontend: Path
        ) -> None:
            # A child can inherit the package lock and finish normally. The
            # competing builder must still be excluded during output capture.
            child = subprocess.run(
                ["flock", "-n", str(lock_fd)],
                pass_fds=(lock_fd,),
                check=False,
            )
            self.assertEqual(child.returncode, 0)
            contender = subprocess.run(["flock", "-n", str(lock), "true"], check=False)
            self.assertEqual(contender.returncode, 1)

        with (
            patch.object(packager, "ROOT", self.root),
            patch.object(packager, "package", side_effect=capture_package),
            patch.object(
                sys, "argv", ["package-krita.py", "--output", str(self.root / "out")]
            ),
        ):
            packager.main()
        subprocess.run(["flock", "-n", str(lock), "true"], check=True)

    def test_build_alias_refuses_real_directory_and_foreign_symlink(self) -> None:
        dest = self.prepare()
        alias = dest.parent / "krita-build-current"
        alias.mkdir()
        with self.assertRaisesRegex(ValueError, "real source path"):
            project.build_source_path()
        alias.rmdir()
        alias.symlink_to(self.source)
        with self.assertRaisesRegex(ValueError, "unmanaged source symlink"):
            project.build_source_path()
        self.assertEqual(alias.resolve(), self.source)

    def test_missing_previous_tree_rebuilds_from_the_new_source(self) -> None:
        previous = self.prepare()
        with redirect_stdout(io.StringIO()):
            project.build_source_path()
        alias = previous.parent / "krita-build-current"
        work = self.root / "ninja-missing"
        work.mkdir()
        (work / "build.ninja").write_text(
            "rule copy\n  command = cp $in $out\n"
            f"build result.txt: copy {alias}/hello.txt\n"
        )
        subprocess.run(["ninja", "-C", str(work)], check=True, capture_output=True)
        self.assertEqual((work / "result.txt").read_text(), "after\n")
        retained = previous.with_name(previous.name + "-retained")
        previous.rename(retained)
        patch_file = self.patches / "port/change.patch"
        patch_file.write_text(patch_file.read_text().replace("+after", "+replacement"))
        current = self.prepare()
        os.utime(current / "hello.txt", ns=(1000000000, 1000000000))
        with redirect_stdout(io.StringIO()):
            project.build_source_path()
        subprocess.run(["ninja", "-C", str(work)], check=True, capture_output=True)
        self.assertEqual((work / "result.txt").read_text(), "replacement\n")
        self.assertEqual(alias.resolve(), current)
        self.assertEqual((retained / "hello.txt").read_text(), "after\n")
        alias.unlink()
        patch_file.unlink()
        (self.patches / "series").write_text("")
        self.prepare()
        with redirect_stdout(io.StringIO()):
            project.build_source_path()
        subprocess.run(["ninja", "-C", str(work)], check=True, capture_output=True)
        self.assertEqual((work / "result.txt").read_text(), "before\n")

    def test_patch_edit_during_archive_cannot_change_captured_content(self) -> None:
        path = self.patches / "port/change.patch"
        original = path.read_text()

        def edit_after_archive(
            args: list[str | Path], **kwargs: Any
        ) -> subprocess.CompletedProcess[str]:
            result = self.run_command(args, **kwargs)
            if len(args) > 3 and args[3] == "archive":
                path.write_text(original.replace("+after", "+raced"))
            return result

        with patch.object(project, "run", side_effect=edit_after_archive):
            dest = self.prepare()
        self.assertEqual((dest / "hello.txt").read_text(), "after\n")
        path.write_text(original)
        self.assertEqual(project.verified_source_path(), dest)

    def test_new_source_reuses_only_identical_patched_file_timestamps(self) -> None:
        first = self.prepare()
        with redirect_stdout(io.StringIO()):
            project.build_source_path()
        os.utime(first / "hello.txt", ns=(1000000000, 1000000000))
        path = self.patches / "port/change.patch"
        path.write_text(
            "Subject: same content, new patch digest\n\n" + path.read_text()
        )
        second = self.prepare()
        self.assertEqual((second / "hello.txt").stat().st_mtime_ns, 1000000000)
        path.write_text(path.read_text().replace("+after", "+different"))
        third = self.prepare()
        self.assertNotEqual((third / "hello.txt").stat().st_mtime_ns, 1000000000)
        self.assertEqual((third / "hello.txt").read_text(), "different\n")

    def test_updated_submodule_revision_selects_new_derived_source(self) -> None:
        first = self.prepare()
        self.commit = "b" * 40
        self.gitlink = f"160000 {self.commit} 0\tkrita"
        second = self.prepare()
        self.assertNotEqual(first, second)
        self.assertEqual(
            json.loads((second / ".krita-wasm-source.json").read_text())["commit"],
            self.commit,
        )
        self.assertTrue(second.name.startswith(f"krita-{self.commit[:12]}-"))
        self.assertEqual((first / "hello.txt").read_text(), "after\n")

    def test_prepares_checked_out_submodule_before_gitlink_is_staged(self) -> None:
        self.gitlink = ""
        source = self.prepare()
        self.assertEqual(
            json.loads((source / ".krita-wasm-source.json").read_text())["commit"],
            self.commit,
        )

    def test_refuses_wrong_gitlink(self) -> None:
        for entry in (
            f"160000 {'0' * 39}1 0\tkrita",
            f"160000 {self.commit} 1\tkrita",
            f"160000 {self.commit} 1\tkrita\n160000 {'b' * 40} 2\tkrita\n160000 {'c' * 40} 3\tkrita",
        ):
            with self.subTest(entry=entry):
                self.gitlink = entry
                with self.assertRaisesRegex(ValueError, "recorded gitlink"):
                    self.prepare()

    def test_failed_patch_leaves_no_partial_source(self) -> None:
        path = self.patches / "port/change.patch"
        path.write_text(path.read_text().replace("-before", "-missing context"))
        with self.assertRaises(subprocess.CalledProcessError):
            self.prepare()
        self.assertEqual(list((self.root / "build/sources").iterdir()), [])

    def test_refuses_unlisted_patch(self) -> None:
        (self.patches / "upstream-fixes").mkdir()
        (self.patches / "upstream-fixes/forgotten.patch").write_text("unlisted\n")
        with self.assertRaisesRegex(ValueError, "missing from series"):
            self.prepare()

    def test_refuses_series_path_traversal(self) -> None:
        for name in (
            "../outside.patch",
            "port/../outside.patch",
            "/outside.patch",
            "unknown/change.patch",
            "port/nested/change.patch",
            "port/./change.patch",
            "change.patch",
        ):
            with self.subTest(name=name):
                (self.patches / "series").write_text(name + "\n")
                with self.assertRaisesRegex(ValueError, "Invalid patch filename"):
                    self.prepare()

    def test_applies_both_categories_in_series_order(self) -> None:
        (self.patches / "upstream-fixes").mkdir()
        (self.patches / "upstream-fixes/final.patch").write_text(
            "diff --git a/hello.txt b/hello.txt\n--- a/hello.txt\n+++ b/hello.txt\n"
            "@@ -1 +1 @@\n-after\n+final\n"
        )
        (self.patches / "series").write_text(
            "port/change.patch\nupstream-fixes/final.patch\n"
        )
        dest = self.prepare()
        self.assertEqual((dest / "hello.txt").read_text(), "final\n")
        manifest = json.loads((dest / ".krita-wasm-source.json").read_text())
        self.assertEqual(
            manifest["patches"], ["port/change.patch", "upstream-fixes/final.patch"]
        )

    def test_refuses_symlink_category(self) -> None:
        (self.patches / "upstream-fixes").symlink_to(
            self.patches / "port", target_is_directory=True
        )
        (self.patches / "series").write_text("upstream-fixes/change.patch\n")
        with self.assertRaisesRegex(ValueError, "symlink patch"):
            self.prepare()


class CompileGraphTest(unittest.TestCase):
    def test_link_inputs_cannot_escape_verified_roots(self) -> None:
        script = (
            Path(__file__).resolve().parents[1] / "scripts/check-compile-sources.py"
        )
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            build, source, sdk = (root / name for name in ("build", "source", "sdk"))
            for directory in (build, source, sdk):
                directory.mkdir()
            (build / "compile_commands.json").write_text("[]")
            (build / "alias.a").symlink_to(root / "outside.a")
            special = sdk / "dollar$ and space"
            special.mkdir()
            for library, allowed in (
                ("local.a", True),
                ("../sdk/prebuilt.a", True),
                (str(sdk / "prebuilt.a"), True),
                (f'"{special / "prebuilt.a"}"'.replace("$", "$$"), True),
                ('"../outside$$ dir/lib.a"', False),
                ("../outside.a", False),
                (str(root / "outside.o"), False),
                ("alias.a", False),
                ("-lm -lembind -lidbfs.js", True),
                ("-l:outside.a", False),
                ("-loutside", False),
                ("-L../outside -lm", False),
                ("-Wl,-l:outside.a", False),
            ):
                with self.subTest(library=library):
                    (build / "build.ninja").write_text(
                        f"  LINK_LIBRARIES = {library}\n"
                    )
                    result = subprocess.run(
                        [
                            sys.executable,
                            str(script),
                            str(build),
                            "--source",
                            str(source),
                            "--sdk",
                            str(sdk),
                        ],
                        capture_output=True,
                        text=True,
                        check=False,
                    )
                    self.assertEqual(
                        result.returncode == 0, allowed, result.stdout + result.stderr
                    )
                    if not allowed:
                        self.assertRegex(
                            result.stderr, "escapes verified|Unverified linker library"
                        )


if __name__ == "__main__":
    unittest.main()
