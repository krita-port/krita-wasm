"""Import locked, upstream-prebuilt runtime fonts without compiling anything."""

import hashlib
import json
import tempfile
import zipfile
from pathlib import Path
from typing import Any

from sdk import download, sha256

ROOT = Path(__file__).resolve().parents[1]


def cache_path(lock: dict[str, Any], work: Path) -> Path:
    digest = hashlib.sha256(json.dumps(lock, sort_keys=True).encode()).hexdigest()
    return work / "runtime-fonts" / f"{lock['name']}-{lock['version']}-{digest[:16]}"


def verify_tree(folder: Path, lock: dict[str, Any]) -> Path:
    if json.loads((folder / "fonts.json").read_text()) != lock:
        raise ValueError("Runtime font provenance does not match the lock")
    expected = {entry["path"] for entry in lock["files"]} | {"fonts.json"}
    actual = set()
    for path in folder.rglob("*"):
        if path.is_symlink():
            raise ValueError(f"Unexpected runtime font symlink: {path}")
        if path.is_file():
            actual.add(path.relative_to(folder).as_posix())
    if actual != expected:
        raise ValueError("Runtime fonts contain missing or unexpected files")
    for entry in lock["files"]:
        path = folder / entry["path"]
        if (
            not path.resolve().is_relative_to(folder.resolve())
            or sha256(path) != entry["sha256"]
        ):
            raise ValueError(f"Runtime font checksum mismatch: {entry['path']}")
    return folder


def import_fonts(lock: dict[str, Any], work: Path, archive: Path | None = None) -> Path:
    if lock["schema"] != 1:
        raise ValueError("Unsupported runtime font lock schema")
    for entry in lock["files"]:
        path = Path(entry["path"])
        if path.is_absolute() or ".." in path.parts:
            raise ValueError("Runtime font paths must stay inside the cache")
    destination = cache_path(lock, work)
    if destination.exists():
        return verify_tree(destination, lock)
    if archive is None:
        source = lock["archive"]
        archive = download(
            {
                "name": source["filename"],
                "url": source["url"],
                "sha256": source["sha256"],
            },
            destination=work / "downloads" / source["filename"],
        )
    elif sha256(archive) != lock["archive"]["sha256"]:
        raise ValueError("Font archive checksum mismatch; existing data is preserved")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=".font-import-", dir=destination.parent
    ) as temporary:
        tree = Path(temporary) / "fonts"
        tree.mkdir()
        with zipfile.ZipFile(archive) as package:
            for entry in lock["files"]:
                data = package.read(entry["member"])
                if hashlib.sha256(data).hexdigest() != entry["sha256"]:
                    raise ValueError(
                        f"Font archive member checksum mismatch: {entry['member']}"
                    )
                path = tree / entry["path"]
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
        (tree / "fonts.json").write_text(json.dumps(lock, indent=2) + "\n")
        verify_tree(tree, lock)
        tree.rename(destination)
    return destination


def load_locks() -> list[dict[str, Any]]:
    return [
        json.loads(path.read_text())
        for path in sorted((ROOT / "locks").glob("runtime*fonts.json"))
    ]


def verified_font_packages() -> list[tuple[dict[str, Any], Path]]:
    return [
        (lock, verify_tree(cache_path(lock, ROOT / "cache"), lock))
        for lock in load_locks()
    ]
