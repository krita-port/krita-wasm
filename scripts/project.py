#!/usr/bin/env python3
"""Pinned source preparation and local diagnostics; Python standard library only."""

import argparse
import filecmp
import hashlib
import json
import os
import re
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]


def run(args: list[str | Path], **kwargs: Any) -> subprocess.CompletedProcess[str]:
    return subprocess.run([str(a) for a in args], check=True, **kwargs)


def output(args: list[str | Path]) -> str:
    return run(args, stdout=subprocess.PIPE, text=True).stdout.strip()


def verified_upstream() -> tuple[Path, str]:
    source = ROOT / "krita"
    if not (source / ".git").exists():
        raise ValueError(
            "Missing submodule; run git submodule update --init --recursive"
        )
    commit = output(["git", "-C", source, "rev-parse", "HEAD"])
    if output(["git", "-C", source, "status", "--porcelain", "--untracked-files=all"]):
        raise ValueError(
            "Upstream submodule has local changes; refusing to ignore or overwrite them"
        )
    gitlink = output(["git", "-C", ROOT, "ls-files", "--stage", "--", "krita"])
    if gitlink and gitlink != f"160000 {commit} 0\tkrita":
        raise ValueError("Submodule HEAD does not match its recorded gitlink")
    return source, commit


def patch_series(series: bytes) -> list[Path]:
    folder = ROOT / "patches"
    patches = []
    for line in series.decode().splitlines():
        name = line.strip()
        if not name or name.startswith("#"):
            continue
        if not re.fullmatch(
            r"(?:port|upstream-fixes)/[A-Za-z0-9][A-Za-z0-9_.-]*\.patch", name
        ):
            raise ValueError(f"Invalid patch filename: {name}")
        path = folder / name
        if (
            not path.is_file()
            or path.is_symlink()
            or path.parent.is_symlink()
            or path in patches
        ):
            raise ValueError(f"Missing, duplicate or symlink patch: {name}")
        patches.append(path)
    unlisted = set(folder.rglob("*.patch")) - set(patches)
    if unlisted:
        raise ValueError(
            f"Patches missing from series: {sorted(p.relative_to(folder).as_posix() for p in unlisted)}"
        )
    return patches


def source_plan() -> tuple[Path, str, list[tuple[Path, bytes]], dict[str, Any], Path]:
    source, commit = verified_upstream()
    series = (ROOT / "patches/series").read_bytes()
    patches = [(path, path.read_bytes()) for path in patch_series(series)]
    digest = hashlib.sha256(series)
    for patch, contents in patches:
        digest.update(patch.relative_to(ROOT / "patches").as_posix().encode())
        digest.update(contents)
    manifest = {
        "commit": commit,
        "patch_sha256": digest.hexdigest(),
        "patches": [p.relative_to(ROOT / "patches").as_posix() for p, _ in patches],
    }
    dest = ROOT / "build/sources" / f"krita-{commit[:12]}-{digest.hexdigest()[:12]}"
    return source, commit, patches, manifest, dest


def source_inventory(tree: Path) -> dict[str, dict[str, Any]]:
    files: dict[str, dict[str, Any]] = {}
    for path in tree.rglob("*"):
        if path.name == ".krita-wasm-source.json":
            continue
        if path.is_symlink():
            files[path.relative_to(tree).as_posix()] = {"symlink": os.readlink(path)}
        elif path.is_file():
            with path.open("rb") as stream:
                files[path.relative_to(tree).as_posix()] = {
                    "sha256": hashlib.file_digest(stream, "sha256").hexdigest(),
                    "executable": bool(path.stat().st_mode & 0o111),
                }
    return files


def verified_source_path() -> Path:
    _, _, _, manifest, dest = source_plan()
    marker = dest / ".krita-wasm-source.json"
    recorded = json.loads(marker.read_text()) if marker.is_file() else {}
    if {key: recorded.get(key) for key in manifest} != manifest:
        raise ValueError(
            "No source matching current locks and patches; run prepare-source first"
        )
    if recorded.get("files") != source_inventory(dest):
        raise ValueError(
            "Prepared source has local changes; move it aside and run prepare-source"
        )
    return dest


def source_path() -> None:
    print(verified_source_path())


def build_source_path() -> None:
    """Switch only our managed alias, retaining every prepared source tree."""
    dest = verified_source_path()
    alias = dest.parent / "krita-build-current"
    previous = None
    if alias.is_symlink():
        previous = alias.resolve()
        marker = previous / ".krita-wasm-source.json"
        if (
            previous.parent != dest.parent
            or not re.fullmatch(r"krita-[a-f0-9]{12}-[a-f0-9]{12}", previous.name)
            or (previous.exists() and not marker.is_file())
        ):
            raise ValueError(f"Refusing to replace unmanaged source symlink: {alias}")
        if previous == dest:
            print(alias)
            return
    elif alias.exists():
        raise ValueError(f"Refusing to replace real source path: {alias}")
    if previous and previous.exists():
        try:
            recorded = json.loads((previous / ".krita-wasm-source.json").read_text())
            reusable = isinstance(recorded, dict) and recorded.get(
                "files"
            ) == source_inventory(previous)
        except (OSError, ValueError):
            reusable = False
        if not reusable:
            previous = None
    # A missing or locally changed previous tree cannot establish which bytes
    # produced retained Ninja objects. Refresh inputs instead of reusing mtimes.
    for new in dest.rglob("*"):
        if not new.is_file() or new.is_symlink():
            continue
        old = previous / new.relative_to(dest) if previous else None
        if (
            old is not None
            and old.is_file()
            and not old.is_symlink()
            and filecmp.cmp(old, new, shallow=False)
        ):
            os.utime(new, ns=(new.stat().st_atime_ns, old.stat().st_mtime_ns))
        else:
            new.touch()
    with tempfile.TemporaryDirectory(prefix=".alias-", dir=dest.parent) as temporary:
        link = Path(temporary) / "source"
        link.symlink_to(dest.name, target_is_directory=True)
        link.replace(alias)
    print(alias)


def prepare() -> None:
    source, commit, patches, manifest, dest = source_plan()
    parent = dest.parent
    parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        raise ValueError(
            f"Derived source already exists: {dest}. It may contain edits; use it or move it aside explicitly."
        )
    with tempfile.TemporaryDirectory(prefix=".prepare-", dir=parent) as temporary:
        staging = Path(temporary)
        archive = staging / "source.tar"
        run(
            [
                "git",
                "-C",
                source,
                "archive",
                "--format=tar",
                "-o",
                archive,
                commit,
            ]
        )
        tree = staging / "tree"
        tree.mkdir()
        with tarfile.open(archive) as stream:
            stream.extractall(tree, filter="data")
        # Prevent git apply from discovering the parent repository and silently
        # skipping paths outside its current subdirectory.
        patch_env = {**os.environ, "GIT_CEILING_DIRECTORIES": str(staging)}
        captured = []
        for index, (_, contents) in enumerate(patches):
            patch = staging / f"{index}.patch"
            patch.write_bytes(contents)
            captured.append(patch)
            run(
                ["git", "apply", "--check", "--whitespace=error-all", patch],
                cwd=tree,
                env=patch_env,
            )
            run(
                ["git", "apply", "--whitespace=error-all", patch],
                cwd=tree,
                env=patch_env,
            )
        # git apply gives every patched file a fresh timestamp, even if only a
        # different patch changed. Retain timestamps for byte-identical files
        # so switching the build alias does not recompile unchanged headers.
        alias = parent / "krita-build-current"
        if alias.is_symlink():
            previous = alias.resolve()
            if (
                previous.parent == parent
                and (previous / ".krita-wasm-source.json").is_file()
            ):
                touched = set()
                for patch in captured:
                    stats = run(
                        ["git", "apply", "--numstat", "-z", patch],
                        stdout=subprocess.PIPE,
                        text=True,
                    ).stdout
                    for record in stats.split("\0"):
                        fields = record.split("\t", 2)
                        if len(fields) == 3 and fields[2]:
                            touched.add(fields[2])
                for name in touched:
                    old, new = previous / name, tree / name
                    if (
                        old.is_file()
                        and new.is_file()
                        and not old.is_symlink()
                        and not new.is_symlink()
                        and old.read_bytes() == new.read_bytes()
                    ):
                        os.utime(
                            new, ns=(new.stat().st_atime_ns, old.stat().st_mtime_ns)
                        )
        if alias.is_symlink() and alias.resolve() == dest:
            # Recreating the active target replaces its instance even though
            # the alias name stays equal. Retained objects may predate it.
            for path in tree.rglob("*"):
                if path.is_file() and not path.is_symlink():
                    path.touch()
        manifest["files"] = source_inventory(tree)
        (tree / ".krita-wasm-source.json").write_text(
            json.dumps(manifest, indent=2) + "\n"
        )
        tree.rename(dest)
    print(dest)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command",
        choices=[
            "prepare-source",
            "source-path",
            "build-source-path",
        ],
    )
    args = parser.parse_args()
    try:
        {
            "prepare-source": prepare,
            "source-path": source_path,
            "build-source-path": build_source_path,
        }[args.command]()
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
