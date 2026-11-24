"""Check the release archive contract used by the browser and catalog checks."""

import importlib.util
import io
import os
import tarfile
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "runtime_bundle", Path(__file__).resolve().parents[1] / "scripts/runtime_bundle.py"
)
assert SPEC is not None and SPEC.loader is not None
bundle = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bundle)


class RuntimeBundleTest(unittest.TestCase):
    def test_nested_release_is_reproducible_and_preserves_catalog_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "catalog"
            source.write_bytes(b"actual catalog bytes")
            resources = root / "resources.tar"
            long_name = "krita/share/templates/" + "directory/" * 12 + "example.kra"
            members = [
                (long_name, source),
                ("krita/share/locale/zh_CN/LC_MESSAGES/krita.mo", source),
            ]
            bundle.write_archive(resources, members)
            first, second = root / "first.gz", root / "second.gz"
            bundle.write_archive(first, [("resources.tar", resources)], compressed=True)
            source.chmod(0o700)
            os.utime(source, (1234, 1234))
            bundle.write_archive(resources, members)
            resources.chmod(0o600)
            os.utime(resources, (5678, 5678))
            bundle.write_archive(
                second, [("resources.tar", resources)], compressed=True
            )
            self.assertEqual(first.read_bytes(), second.read_bytes())
            self.assertEqual(
                bundle.read_catalogs(first), {"zh_CN": source.read_bytes()}
            )
            self.assertEqual(bundle.read_catalogs(first, ["ru"]), {})
            with tarfile.open(fileobj=io.BytesIO(resources.read_bytes())) as archive:
                member = archive.extractfile(long_name)
                assert member is not None
                self.assertEqual(member.read(), source.read_bytes())
                self.assertTrue(
                    all(
                        item.mtime == 0
                        and item.uid == 0
                        and item.gid == 0
                        and item.mode == 0o644
                        for item in archive
                    )
                )

    def test_rejects_ambiguous_names(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "file"
            source.write_bytes(b"data")
            for files in [
                [("../escape", source)],
                [("/absolute", source)],
                [("same", source), ("same", source)],
            ]:
                with self.assertRaises(ValueError):
                    bundle.write_archive(root / "invalid.tar", files)
