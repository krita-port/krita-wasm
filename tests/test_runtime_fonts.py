"""Preserve verified prebuilt font inputs and reject corrupt cache content."""

import hashlib
import importlib.util
import io
import shutil
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from typing import Any
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

SPEC = importlib.util.spec_from_file_location(
    "runtime_fonts", Path(__file__).resolve().parents[1] / "scripts/runtime_fonts.py"
)
assert SPEC is not None and SPEC.loader is not None
fonts = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fonts)


class RuntimeFontsTest(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.archive = self.root / "upstream.zip"
        content = {"font.ttc": b"prebuilt font", "LICENSE": b"original license"}
        with zipfile.ZipFile(self.archive, "w") as package:
            for name, data in content.items():
                package.writestr(name, data)
            package.writestr("../unselected.txt", b"must never be extracted")
        self.lock: dict[str, Any] = {
            "schema": 1,
            "name": "fixture",
            "version": "1",
            "archive": {
                "filename": "upstream.zip",
                "url": "https://example.invalid/upstream.zip",
                "sha256": fonts.sha256(self.archive),
            },
            "files": [
                {
                    "member": name,
                    "path": "fonts/" + name,
                    "sha256": hashlib.sha256(data).hexdigest(),
                }
                for name, data in content.items()
            ],
        }

    def import_fonts(self) -> Path:
        return Path(fonts.import_fonts(self.lock, self.root / "work", self.archive))

    def test_imports_only_locked_font_and_license(self) -> None:
        with patch("sdk.urlopen", return_value=io.BytesIO(self.archive.read_bytes())):
            folder = fonts.import_fonts(self.lock, self.root / "work")
        self.assertEqual((folder / "fonts/font.ttc").read_bytes(), b"prebuilt font")
        self.assertEqual((folder / "fonts/LICENSE").read_bytes(), b"original license")
        self.assertFalse((folder.parent / "unselected.txt").exists())
        self.assertEqual(self.import_fonts(), folder)

    def test_rejects_corrupt_archive_without_overwriting_it(self) -> None:
        self.archive.write_bytes(b"corrupt")
        with self.assertRaisesRegex(ValueError, "archive checksum mismatch"):
            self.import_fonts()
        self.assertEqual(self.archive.read_bytes(), b"corrupt")

    def test_rejects_corrupt_member_without_installing_tree(self) -> None:
        self.lock["files"][0]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "member checksum mismatch"):
            self.import_fonts()
        self.assertFalse(fonts.cache_path(self.lock, self.root / "work").exists())

    def test_concurrent_verified_installation_reuses_winner(self) -> None:
        rename = Path.rename

        def concurrent(source: Path, destination: Path) -> Path:
            shutil.copytree(source, destination)
            return rename(source, destination)

        with patch.object(Path, "rename", concurrent):
            folder = self.import_fonts()
        self.assertEqual((folder / "fonts/font.ttc").read_bytes(), b"prebuilt font")
        fonts.verify_tree(folder, self.lock)

    def test_concurrent_corrupt_winner_is_preserved_and_rejected(self) -> None:
        rename = Path.rename

        def concurrent(source: Path, destination: Path) -> Path:
            shutil.copytree(source, destination)
            (destination / "fonts/font.ttc").write_bytes(b"corrupt winner")
            return rename(source, destination)

        with (
            patch.object(Path, "rename", concurrent),
            self.assertRaisesRegex(ValueError, "checksum mismatch"),
        ):
            self.import_fonts()
        folder = fonts.cache_path(self.lock, self.root / "work")
        self.assertEqual((folder / "fonts/font.ttc").read_bytes(), b"corrupt winner")

    def test_preserves_modified_cached_font(self) -> None:
        folder = self.import_fonts()
        (folder / "fonts/font.ttc").write_bytes(b"manual edit")
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            self.import_fonts()
        self.assertEqual((folder / "fonts/font.ttc").read_bytes(), b"manual edit")

    def test_rejects_unexpected_cache_files(self) -> None:
        folder = self.import_fonts()
        (folder / "extra").write_bytes(b"injection")
        with self.assertRaisesRegex(ValueError, "unexpected files"):
            self.import_fonts()

    def test_rejects_cached_symlink(self) -> None:
        folder = self.import_fonts()
        path = folder / "fonts/font.ttc"
        path.unlink()
        path.symlink_to(self.archive)
        with self.assertRaisesRegex(ValueError, "symlink"):
            self.import_fonts()

    def test_rejects_escaping_output_path(self) -> None:
        self.lock["files"][0]["path"] = "../escaped-font"
        with self.assertRaisesRegex(ValueError, "stay inside"):
            self.import_fonts()
        self.assertFalse((self.root / "escaped-font").exists())


if __name__ == "__main__":
    unittest.main()
