#!/usr/bin/env python3
"""Resolve and verify Nightly dependency releases; never build third-party code."""

import argparse
import hashlib
import json
import os
import platform
import re
import shlex
import shutil
import sys
import tarfile
import tempfile
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
RELEASE_API = (
    "https://api.github.com/repos/krita-port/krita-prebuilder/releases/tags/latest"
)
PACKAGES = {
    "sdk": ("krita-dependencies", "krita-wasm-sdk-stage4-jspi.tar.gz"),
    "i18n": ("i18n", "krita-wasm-i18n-ci.tar.gz"),
}


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def release() -> dict[str, Any]:
    path = ROOT / "build/sdk-release.json"
    if not path.is_file():
        raise ValueError("No selected SDK release; run python scripts/sdk.py fetch")
    record: dict[str, Any] = json.loads(path.read_text())
    return record


def selected(name: str) -> dict[str, Any]:
    if name not in PACKAGES:
        raise ValueError("Unknown dependency SDK")
    return dict(release()["packages"][name])


def prefix(name: str) -> Path:
    entry = selected(name)
    folder = ROOT / "cache/sdk" / f"{name}-{entry['binary']['sha256'][:16]}"
    if folder.exists() and sha256(folder / "sdk.json") != entry["inventory_sha256"]:
        raise ValueError("Cached SDK inventory does not match the selected release")
    return folder


def archive_path(asset: dict[str, Any]) -> Path:
    name: str = asset["name"]
    digest: str = asset["sha256"]
    if (
        Path(name).name != name
        or not re.fullmatch(r"[a-f0-9]{64}", digest)
        or urlsplit(asset["url"]).scheme != "https"
    ):
        raise ValueError(
            "SDK assets require a plain filename, SHA256 digest and HTTPS URL"
        )
    return ROOT / "cache/downloads" / digest[:16] / name


def download(asset: dict[str, Any], destination: Path | None = None) -> Path:
    cached = archive_path(asset)
    destination = destination if destination is not None else cached
    destination.parent.mkdir(parents=True, exist_ok=True)
    if not destination.exists():
        print(f"Downloading {asset['name']}…", file=sys.stderr, flush=True)
        with tempfile.TemporaryDirectory(
            prefix=".download-", dir=destination.parent
        ) as temporary:
            staged = Path(temporary) / asset["name"]
            request = Request(asset["url"], headers={"User-Agent": "krita-wasm"})
            with urlopen(request, timeout=60) as response, staged.open("wb") as stream:
                shutil.copyfileobj(response, stream)
            if sha256(staged) != asset["sha256"]:
                raise ValueError(f"SDK download checksum mismatch: {asset['name']}")
            try:
                os.link(staged, destination)
            except FileExistsError:
                pass  # Verify the concurrent winner below without overwriting it.
    if sha256(destination) != asset["sha256"]:
        raise ValueError(
            f"SDK archive checksum mismatch: {asset['name']}; existing data preserved"
        )
    return destination


def resolve_release() -> dict[str, Any]:
    request = Request(
        RELEASE_API,
        headers={"Accept": "application/vnd.github+json", "User-Agent": "krita-wasm"},
    )
    with urlopen(request, timeout=60) as response:
        metadata = json.load(response)
    assets = {
        item["name"]: item for item in metadata["assets"] if item["state"] == "uploaded"
    }
    packages = {}
    for name, (_, filename) in PACKAGES.items():
        if filename not in assets:
            raise ValueError(
                f"Nightly release is missing {filename}; retry after publication completes"
            )
        asset = assets[filename]
        digest = asset.get("digest") or ""
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
            raise ValueError(f"Nightly asset has no SHA256 digest: {filename}")
        packages[name] = {
            "binary": {
                "id": asset["id"],
                "name": filename,
                "sha256": digest.removeprefix("sha256:"),
                "url": asset["browser_download_url"],
            }
        }
    return {
        "release": {
            key: metadata[key]
            for key in ("id", "tag_name", "html_url", "updated_at", "body")
        },
        "packages": packages,
    }


def verify_tree(folder: Path) -> None:
    manifest = json.loads((folder / "sdk.json").read_text())
    if manifest["schema"] != 1 or manifest["stage"] not in {
        "krita-dependencies",
        "i18n",
    }:
        raise ValueError("Unsupported SDK schema/stage")
    if (
        manifest["host"]["system"] != platform.system()
        or manifest["host"]["architecture"] != platform.machine()
    ):
        raise ValueError("SDK host platform does not match this machine")
    if (
        manifest["target"]["qt_linkage"] != "static"
        or not manifest["target"]["threads"]
    ):
        raise ValueError("SDK must contain static multithreaded Qt")
    actual = {
        p.relative_to(folder).as_posix()
        for p in folder.rglob("*")
        if p.is_file() or p.is_symlink()
    }
    if actual != set(manifest["files"]) | {"sdk.json"}:
        raise ValueError("SDK contains missing or unexpected files")
    for name, entry in manifest["files"].items():
        path = folder / name
        if not path.resolve().is_relative_to(folder.resolve()):
            raise ValueError(f"Escaping SDK path: {name}")
        if "symlink" in entry:
            if not path.is_symlink() or path.readlink().as_posix() != entry["symlink"]:
                raise ValueError(f"SDK symlink mismatch: {name}")
        elif (
            path.is_symlink()
            or sha256(path) != entry["sha256"]
            or bool(path.stat().st_mode & 0o111) != entry["executable"]
        ):
            raise ValueError(f"SDK file mismatch: {name}")


def verify_pair(base: Path, supplement_path: Path) -> None:
    verify_tree(base)
    verify_tree(supplement_path)
    supplement = json.loads((supplement_path / "sdk.json").read_text())
    sdk = json.loads((base / "sdk.json").read_text())
    if supplement["stage"] != "i18n":
        raise ValueError("KRITA_I18N_DIR must point to an i18n supplement")
    if any(
        target.get("cxx_exceptions") != "wasm-native" or target.get("jspi") is not True
        for target in (sdk["target"], supplement["target"])
    ):
        raise ValueError("i18n/base SDK exception or JSPI ABI mismatch")
    for key in ("emscripten", "qt", "kde_frameworks"):
        if supplement[key] != sdk[key]:
            raise ValueError(f"i18n/base SDK mismatch: {key}")


def verify_i18n() -> Path:
    supplement_path = Path(os.environ["KRITA_I18N_DIR"]).resolve(strict=True)
    base = Path(os.environ["KRITA_SDK_DIR"]).resolve(strict=True)
    verify_pair(base, supplement_path)
    return supplement_path


def import_sdk(name: str, archive: Path) -> Path:
    destination = ROOT / "cache/sdk" / f"{name}-{sha256(archive)[:16]}"
    if destination.exists():
        with tarfile.open(archive) as stream:
            inventory = stream.extractfile("sdk.json")
            if inventory is None or hashlib.sha256(
                inventory.read()
            ).hexdigest() != sha256(destination / "sdk.json"):
                raise ValueError(
                    "Cached SDK inventory differs from its release archive"
                )
        verify_tree(destination)
    else:
        destination.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(
            prefix=".sdk-import-", dir=destination.parent
        ) as temporary:
            tree = Path(temporary) / "sdk"
            tree.mkdir()
            with tarfile.open(archive) as stream:
                stream.extractall(tree, filter="data")
            verify_tree(tree)
            tree.rename(destination)
    manifest = json.loads((destination / "sdk.json").read_text())
    if manifest["stage"] != PACKAGES[name][0]:
        raise ValueError(f"SDK manifest has the wrong stage: {name}")
    if manifest["emscripten"] != (ROOT / ".emscripten-version").read_text().strip():
        raise ValueError(
            "Nightly SDK Emscripten version differs from .emscripten-version; shared SDK was not changed"
        )
    return destination


def fetch() -> None:
    record = resolve_release()
    folders = {}
    for name, entry in record["packages"].items():
        archive = download(entry["binary"])
        folder = import_sdk(name, archive)
        entry["inventory_sha256"] = sha256(folder / "sdk.json")
        folders[name] = folder
    verify_pair(folders["sdk"], folders["i18n"])
    current = resolve_release()
    if any(
        record["packages"][name]["binary"] != current["packages"][name]["binary"]
        for name in PACKAGES
    ):
        raise ValueError(
            "Nightly assets changed while downloading; previous selection preserved. Run fetch again."
        )
    path = ROOT / "build/sdk-release.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=".sdk-release-", dir=path.parent
    ) as temporary:
        staged = Path(temporary) / path.name
        staged.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")
        staged.replace(path)


def verify() -> None:
    for name in PACKAGES:
        entry = selected(name)
        archive = archive_path(entry["binary"])
        if not archive.is_file() or sha256(archive) != entry["binary"]["sha256"]:
            raise ValueError(f"Dependency archive checksum mismatch: {name}")
    verify_pair(prefix("sdk"), prefix("i18n"))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command", choices=("fetch", "environment", "verify", "verify-i18n")
    )
    args = parser.parse_args()
    if args.command == "verify-i18n":
        verify_i18n()
        return
    if args.command == "verify":
        verify()
        return
    if args.command == "fetch":
        fetch()
    for name, variable in [("sdk", "KRITA_SDK_DIR"), ("i18n", "KRITA_I18N_DIR")]:
        folder = prefix(name)
        if not folder.is_dir():
            raise ValueError("Dependency SDK missing; run python scripts/sdk.py fetch")
        print(f"export {variable}={shlex.quote(str(folder))}")


if __name__ == "__main__":
    main()
