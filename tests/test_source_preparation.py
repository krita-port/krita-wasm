"""Exercise patch application and preservation guarantees using small Git fixtures."""

import importlib.util
import io
import json
import os
import subprocess
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
        path = self.patches / "port/change.patch"
        path.write_text(path.read_text().replace("+after", "+next"))
        second = self.prepare()
        with redirect_stdout(io.StringIO()):
            project.build_source_path()
        self.assertEqual(alias.resolve(), second)
        self.assertEqual((first / "hello.txt").read_text(), "manual edit\n")
        self.assertEqual((second / "hello.txt").read_text(), "next\n")

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

    def test_new_source_reuses_only_identical_patched_file_timestamps(self) -> None:
        first = self.prepare()
        os.utime(first / "hello.txt", ns=(1000000000, 1000000000))
        with redirect_stdout(io.StringIO()):
            project.build_source_path()
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
        self.gitlink = f"160000 {'0' * 39}1 0\tkrita"
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


if __name__ == "__main__":
    unittest.main()
