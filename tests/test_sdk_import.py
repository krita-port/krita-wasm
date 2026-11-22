"""Prebuilt SDK integrity and filesystem boundary checks."""

import hashlib
import io
import json
import os
import platform
import shutil
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch
from urllib.request import Request

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import sdk as sdk_import

verify_i18n = sdk_import


class SdkIntegrityTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.file = self.root / "target/lib/probe.a"
        self.file.parent.mkdir(parents=True)
        self.file.write_bytes(b"prebuilt library")
        self.manifest: dict[str, Any] = {
            "schema": 1,
            "stage": "krita-dependencies",
            "host": {"system": platform.system(), "architecture": platform.machine()},
            "target": {"qt_linkage": "static", "threads": True},
            "files": {
                "target/lib/probe.a": {
                    "sha256": hashlib.sha256(self.file.read_bytes()).hexdigest(),
                    "executable": False,
                }
            },
        }
        self.save()

    def save(self) -> None:
        (self.root / "sdk.json").write_text(json.dumps(self.manifest))

    def test_accepts_complete_verified_tree(self) -> None:
        sdk_import.verify_tree(self.root)

    def test_rejects_modified_library(self) -> None:
        self.file.write_bytes(b"modified library")
        with self.assertRaisesRegex(ValueError, "file mismatch"):
            sdk_import.verify_tree(self.root)

    def test_rejects_added_file(self) -> None:
        (self.root / "unexpected.cmake").write_text("untracked injection")
        with self.assertRaisesRegex(ValueError, "unexpected files"):
            sdk_import.verify_tree(self.root)

    def test_rejects_escaping_symlink(self) -> None:
        self.file.unlink()
        self.file.symlink_to("/etc/passwd")
        self.manifest["files"]["target/lib/probe.a"] = {"symlink": "/etc/passwd"}
        self.save()
        with self.assertRaisesRegex(ValueError, "Escaping SDK path"):
            sdk_import.verify_tree(self.root)

    def test_rejects_incompatible_host(self) -> None:
        self.manifest["host"]["architecture"] = "unsupported-architecture"
        self.save()
        with self.assertRaisesRegex(ValueError, "host platform"):
            sdk_import.verify_tree(self.root)

    def test_rejects_changed_executable_bit(self) -> None:
        self.file.chmod(0o755)
        with self.assertRaisesRegex(ValueError, "file mismatch"):
            sdk_import.verify_tree(self.root)

    def test_i18n_rejects_mixing_exception_abis_and_jspi_profiles(self) -> None:
        self.manifest.update(
            stage="i18n", emscripten="7.0.0", qt="6.10.2", kde_frameworks="6.24.0"
        )
        base_temp = tempfile.TemporaryDirectory()
        self.addCleanup(base_temp.cleanup)
        base_dir = Path(base_temp.name)
        library = base_dir / "target/lib/probe.a"
        library.parent.mkdir(parents=True)
        library.write_bytes(self.file.read_bytes())
        variants: tuple[dict[str, Any], ...] = (
            {},
            {"cxx_exceptions": "wasm-native", "jspi": True},
            {"cxx_exceptions": "wasm-native", "jspi": False},
        )
        with patch.dict(
            os.environ, KRITA_SDK_DIR=str(base_dir), KRITA_I18N_DIR=str(self.root)
        ):
            for supplement in variants:
                self.manifest["target"] = {
                    "qt_linkage": "static",
                    "threads": True,
                    **supplement,
                }
                self.save()
                for base in variants:
                    metadata = {
                        **self.manifest,
                        "target": {"qt_linkage": "static", "threads": True, **base},
                    }
                    (base_dir / "sdk.json").write_text(json.dumps(metadata))
                    with self.subTest(supplement=supplement, base=base):
                        if (
                            supplement == base
                            and base.get("cxx_exceptions") == "wasm-native"
                            and base.get("jspi") is True
                        ):
                            self.assertEqual(verify_i18n.verify_i18n(), self.root)
                        else:
                            with self.assertRaisesRegex(
                                ValueError, "exception or JSPI ABI mismatch"
                            ):
                                verify_i18n.verify_i18n()


class NightlyReleaseTest(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / ".emscripten-version").write_text("7.0.0\n")
        self.addCleanup(patch.stopall)
        patch.object(sdk_import, "ROOT", self.root).start()
        patch.object(sdk_import, "urlopen", side_effect=self.open_url).start()
        self.payloads: dict[str, bytes] = {}
        self.metadata: dict[str, Any] = {}
        self.publish(1)

    def archive(self, files: dict[str, bytes]) -> bytes:
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
            for name, data in sorted(files.items()):
                member = tarfile.TarInfo(name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
        return buffer.getvalue()

    def publish(
        self, revision: int, *, i18n_qt: str = "6.10.2", emscripten: str = "7.0.0"
    ) -> None:
        assets: list[dict[str, Any]] = []
        for name, (stage, filename) in sdk_import.PACKAGES.items():
            library = f"{name} binary {revision}".encode()
            manifest = {
                "schema": 1,
                "stage": stage,
                "host": {
                    "system": platform.system(),
                    "architecture": platform.machine(),
                },
                "emscripten": emscripten,
                "qt": i18n_qt if name == "i18n" else "6.10.2",
                "kde_frameworks": "6.24.0",
                "target": {
                    "qt_linkage": "static",
                    "threads": True,
                    "cxx_exceptions": "wasm-native",
                    "jspi": True,
                },
                "files": {
                    "target/lib/probe.a": {
                        "sha256": hashlib.sha256(library).hexdigest(),
                        "executable": False,
                    }
                },
            }
            data = self.archive(
                {
                    "sdk.json": json.dumps(manifest).encode(),
                    "target/lib/probe.a": library,
                }
            )
            url = "https://example.invalid/" + filename
            self.payloads[url] = data
            assets.append(
                {
                    "id": revision * 10 + len(assets),
                    "name": filename,
                    "state": "uploaded",
                    "digest": "sha256:" + hashlib.sha256(data).hexdigest(),
                    "browser_download_url": url,
                }
            )
        self.metadata = {
            "id": 1,
            "tag_name": "latest",
            "html_url": "https://example.invalid/latest",
            "updated_at": str(revision),
            "body": f"revision {revision}",
            "assets": assets,
        }

    def open_url(self, request: Request, timeout: int = 60) -> io.BytesIO:
        if request.full_url == sdk_import.RELEASE_API:
            return io.BytesIO(json.dumps(self.metadata).encode())
        return io.BytesIO(self.payloads[request.full_url])

    def test_concurrent_sdk_import_verifies_the_winner(self) -> None:
        asset = sdk_import.resolve_release()["packages"]["sdk"]["binary"]
        archive = sdk_import.download(asset)
        rename = Path.rename

        def concurrent(source: Path, destination: Path) -> Path:
            shutil.copytree(source, destination)
            return rename(source, destination)

        with patch.object(Path, "rename", concurrent):
            folder = sdk_import.import_sdk("sdk", archive)
        sdk_import.verify_tree(folder)

    def test_updated_nightly_reuses_names_without_reusing_stale_bytes(self) -> None:
        sdk_import.fetch()
        previous = sdk_import.prefix("sdk")
        self.publish(2)
        sdk_import.fetch()
        self.assertNotEqual(sdk_import.prefix("sdk"), previous)
        self.assertTrue(previous.is_dir())
        sdk_import.verify()

    def test_running_build_keeps_selected_release_when_nightly_refreshes(self) -> None:
        sdk_import.fetch()
        selected = sdk_import.release()
        first = sdk_import.prefix("sdk")
        self.publish(2)
        sdk_import.fetch()
        self.assertNotEqual(sdk_import.prefix("sdk"), first)
        with patch.dict(os.environ, KRITA_SDK_RELEASE=json.dumps(selected)):
            self.assertEqual(sdk_import.prefix("sdk"), first)
            self.assertEqual(sdk_import.release(), selected)
            sdk_import.verify()

    def test_verification_keeps_its_initial_selection_during_refresh(self) -> None:
        sdk_import.fetch()
        first = sdk_import.release()
        self.publish(2)
        sdk_import.fetch()
        second = sdk_import.release()
        changed = sdk_import.prefix("sdk") / "target/lib/probe.a"
        changed.write_bytes(b"concurrent selection has a corrupt library")
        selection = self.root / "build/sdk-release.json"
        selection.write_text(json.dumps(first))
        digest = sdk_import.sha256
        switched = False

        def refreshing_digest(path: Path) -> str:
            nonlocal switched
            if not switched and path == sdk_import.archive_path(
                first["packages"]["sdk"]["binary"]
            ):
                switched = True
                selection.write_text(json.dumps(second))
            return str(digest(path))

        with patch.object(sdk_import, "sha256", side_effect=refreshing_digest):
            sdk_import.verify()
        self.assertTrue(switched)
        self.assertEqual(sdk_import.release(), second)

    def test_bad_download_preserves_successful_selection(self) -> None:
        sdk_import.fetch()
        path = self.root / "build/sdk-release.json"
        before = path.read_bytes()
        self.publish(2)
        self.metadata["assets"][0]["digest"] = "sha256:" + "0" * 64
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            sdk_import.fetch()
        self.assertEqual(path.read_bytes(), before)
        sdk_import.verify()

    def test_offline_verification_rejects_corrupted_cached_binary(self) -> None:
        sdk_import.fetch()
        with patch.object(
            sdk_import, "urlopen", side_effect=AssertionError("Network access")
        ):
            sdk_import.verify()
            archive = sdk_import.archive_path(sdk_import.selected("sdk")["binary"])
            archive.write_bytes(b"corrupted binary")
            with self.assertRaisesRegex(ValueError, "archive checksum mismatch"):
                sdk_import.verify()

    def test_concurrent_download_verifies_and_preserves_the_winning_file(self) -> None:
        asset = sdk_import.resolve_release()["packages"]["sdk"]["binary"]
        correct = self.payloads[asset["url"]]
        for winner in [correct, b"corrupted concurrent download"]:
            with self.subTest(valid=winner == correct):
                destination = self.root / "downloads" / "winner.tar.gz"
                destination.unlink(missing_ok=True)

                def publish_winner(
                    source: Path, target: Path, data: bytes = winner
                ) -> None:
                    target.write_bytes(data)
                    raise FileExistsError(target)

                with patch.object(os, "link", side_effect=publish_winner):
                    if winner == correct:
                        self.assertEqual(
                            sdk_import.download(asset, destination), destination
                        )
                    else:
                        with self.assertRaisesRegex(
                            ValueError, "archive checksum mismatch"
                        ):
                            sdk_import.download(asset, destination)
                self.assertEqual(destination.read_bytes(), winner)

    def test_missing_digest_does_not_select_a_release(self) -> None:
        self.metadata["assets"][0]["digest"] = None
        with self.assertRaisesRegex(ValueError, "no SHA256 digest"):
            sdk_import.fetch()
        self.assertFalse((self.root / "build/sdk-release.json").exists())

    def test_incompatible_pair_does_not_replace_the_working_selection(self) -> None:
        sdk_import.fetch()
        path = self.root / "build/sdk-release.json"
        before = path.read_bytes()
        self.publish(2, i18n_qt="6.11.0")
        with self.assertRaisesRegex(ValueError, "SDK mismatch: qt"):
            sdk_import.fetch()
        self.assertEqual(path.read_bytes(), before)

    def test_assets_replaced_during_download_do_not_activate(self) -> None:
        sdk_import.fetch()
        path = self.root / "build/sdk-release.json"
        before = path.read_bytes()
        self.publish(2)
        calls = 0

        def changing_release(request: Request, timeout: int = 60) -> io.BytesIO:
            nonlocal calls
            if request.full_url == sdk_import.RELEASE_API:
                calls += 1
                if calls == 2:
                    self.metadata["assets"][0]["id"] += 100
            return self.open_url(request, timeout)

        with (
            patch.object(sdk_import, "urlopen", side_effect=changing_release),
            self.assertRaisesRegex(ValueError, "assets changed while downloading"),
        ):
            sdk_import.fetch()
        self.assertEqual(path.read_bytes(), before)

    def test_cached_inventory_is_checked_against_selected_archive(self) -> None:
        sdk_import.fetch()
        folder = sdk_import.prefix("sdk")
        manifest = folder / "sdk.json"
        data = json.loads(manifest.read_text())
        data["qt"] = "untrusted"
        manifest.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, "selected release"):
            sdk_import.prefix("sdk")
        with self.assertRaisesRegex(ValueError, "inventory differs"):
            sdk_import.fetch()

    def test_new_toolchain_requires_explicit_local_toolchain_update(self) -> None:
        self.publish(2, emscripten="8.0.0")
        with self.assertRaisesRegex(ValueError, "Emscripten version differs"):
            sdk_import.fetch()
        self.assertFalse((self.root / "build/sdk-release.json").exists())


if __name__ == "__main__":
    unittest.main()
