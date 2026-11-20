#!/usr/bin/env python3
"""Build Krita against the frozen SDK and stage local static web files."""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

import i18n_index
import project
import runtime_fonts
import sdk
from runtime_bundle import write_archive

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output", required=True, type=Path, help="New, non-existing output directory"
    )
    parser.add_argument(
        "--release-url",
        help="HTTPS Release download or Releases page URL shown by the manual loader",
    )
    args = parser.parse_args()
    if args.release_url and urlsplit(args.release_url).scheme != "https":
        raise ValueError("Release links require HTTPS")
    output = args.output.resolve()
    if output.exists():
        raise ValueError(f"Refusing to overwrite existing output: {output}")
    # Downloads belong to the explicit fetch step, before the frozen build.
    subprocess.run(["pnpm", "build:web"], cwd=ROOT, check=True)
    os.environ.update(
        {
            "KRITA_SDK_DIR": str(sdk.prefix("sdk")),
            "KRITA_I18N_DIR": str(sdk.prefix("i18n")),
        }
    )
    font_packages = runtime_fonts.verified_font_packages()
    i18n = Path(os.environ["KRITA_I18N_DIR"]).resolve(strict=True)
    sdk.verify_i18n()
    # A failed rebuild must never package stale artifacts left by an earlier
    # successful build. Reuse Ninja's dependency checks instead of guessing.
    # Upstream mixes runtime data with development archives in one component.
    # Build the configured Krita targets before installing, then discard the
    # non-runtime archives from the static web bundle.
    subprocess.run([str(ROOT / "scripts/build-krita"), "all"], check=True)
    source = project.verified_source_path()
    sdk_path = Path(os.environ["KRITA_SDK_DIR"]).resolve(strict=True)
    build = ROOT / "build/cmake" / f"krita-{sdk_path.name}-wasm"
    alias = ROOT / "build/sources/krita-build-current"
    if not alias.is_symlink() or alias.resolve() != source:
        raise ValueError(
            "Build source alias does not match current patches; build Krita first"
        )
    for name in ("krita.js", "krita.wasm", "qtloader.js"):
        if not (build / "bin" / name).is_file():
            raise ValueError(
                f"Missing application output: {name}; finish the Krita build first"
            )
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=".package-krita-", dir=output.parent
    ) as temporary:
        staging = Path(temporary)
        install_root = staging / "install-root"
        install = install_root / "krita"
        # DESTDIR also suppresses desktop icon-cache update hooks.
        subprocess.run(
            ["cmake", "--install", str(build), "--prefix", "/krita"],
            env={**os.environ, "DESTDIR": str(install_root)},
            check=True,
        )
        i18n_index.compile_native_messages(install / "share", i18n / "host/bin/msgfmt")
        web = staging / "web"
        shutil.copytree(ROOT / "build/web", web)
        for name in ("krita.js", "krita.wasm", "qtloader.js"):
            shutil.copyfile(build / "bin" / name, web / name)
        shutil.copyfile(ROOT / "LICENSE", web / "COPYING")
        files: list[tuple[str, Path]] = []

        for relative in ("share", "lib/qml"):
            folder = install / relative
            if not folder.is_dir():
                raise ValueError(f"Missing installed resources: {relative}")
            for path in sorted(folder.rglob("*")):
                if path.is_symlink():
                    raise ValueError(f"Unexpected symlink in runtime resources: {path}")
                if not path.is_file() or path.suffix == ".a":
                    continue
                name = path.relative_to(install).as_posix()
                files.append(("krita/" + name, path))
        # Fontconfig's runtime data and licensed test font are prebuilt SDK
        # assets, not host fonts. Preserve their browser filesystem paths.
        for source_dir, destination in (
            ("share/krita-wasm-sdk/fonts", "/fonts"),
            ("etc/fonts", "/etc/fonts"),
            ("usr/share/fontconfig/conf.avail", "/usr/share/fontconfig/conf.avail"),
        ):
            folder = sdk_path / "target" / source_dir
            if not folder.is_dir():
                raise ValueError(f"Missing SDK runtime data: {source_dir}")
            for path in sorted(folder.rglob("*")):
                if path.is_symlink() and not path.resolve().is_relative_to(sdk_path):
                    raise ValueError(f"Escaping SDK resource: {path}")
                if path.is_file():
                    name = path.relative_to(folder).as_posix()
                    files.append(((destination + "/" + name).lstrip("/"), path))
        for path in sorted((sdk_path / "licenses").rglob("*")):
            if path.is_file():
                name = path.relative_to(sdk_path / "licenses").as_posix()
                files.append(("krita/share/licenses/sdk/" + name, path))
        for font_lock, fonts in font_packages:
            for entry in font_lock["files"]:
                files.append((entry["destination"].lstrip("/"), fonts / entry["path"]))
        for relative, destination in [
            ("target/share", "/krita/share"),
            ("licenses", "/krita/share/licenses/i18n"),
        ]:
            for path in sorted((i18n / relative).rglob("*")):
                if path.is_file():
                    name = path.relative_to(i18n / relative).as_posix()
                    files.append(((destination + "/" + name).lstrip("/"), path))
        index = i18n_index.build_index(install / "share")
        expected_languages = {
            path.parent.name for path in (source / "po").glob("*/krita.po")
        }
        if not expected_languages.issubset(index["languages"]):
            raise ValueError(
                "Installed application is missing compiled Krita translations"
            )
        (web / "i18n.json").write_text(
            json.dumps(index, ensure_ascii=False, indent=2) + "\n"
        )
        sdk_target = json.loads((sdk_path / "sdk.json").read_text())["target"]
        (web / "runtime.json").write_text(
            json.dumps(
                {
                    "jspi": bool(sdk_target.get("jspi")),
                    "cxx_exceptions": sdk_target.get("cxx_exceptions", "emscripten-js"),
                }
            )
            + "\n"
        )

        write_archive(web / "resources.tar", files)
        runtime_names = (
            "COPYING",
            "i18n.json",
            "krita.js",
            "krita.wasm",
            "qtloader.js",
            "resources.tar",
            "runtime.json",
        )
        payload = web / "krita.bundle.tar.gz"
        write_archive(
            payload, [(name, web / name) for name in runtime_names], compressed=True
        )
        with payload.open("rb") as stream:
            payload_hash = hashlib.file_digest(stream, "sha256").hexdigest()
        descriptor = {
            "schema": 2,
            "mode": "auto",
            "filename": payload.name,
            "cache_version": payload_hash,
            "release_url": args.release_url,
        }
        (web / "bundle.json").write_text(
            json.dumps(descriptor, indent=2, sort_keys=True) + "\n"
        )
        # Only the loader belongs on Pages. The release archive is deliberately
        # absent from this directory, including when it is served locally.
        pages = web / "pages"
        shutil.copytree(ROOT / "build/web", pages)
        for name in ("i18n.json", "COPYING"):
            shutil.copyfile(web / name, pages / name)
        manual = {
            key: value for key, value in descriptor.items() if key != "cache_version"
        }
        (pages / "bundle.json").write_text(
            json.dumps({**manual, "mode": "manual"}, indent=2, sort_keys=True) + "\n"
        )
        write_archive(
            web / "krita.pages.tar.gz",
            [
                (path.relative_to(pages).as_posix(), path)
                for path in sorted(pages.rglob("*"))
                if path.is_file()
            ],
            compressed=True,
        )
        for name in runtime_names:
            if name not in {"COPYING", "i18n.json"}:
                (web / name).unlink()

        hashes = {}
        for path in sorted(web.rglob("*")):
            if path.is_file():
                with path.open("rb") as stream:
                    hashes[path.relative_to(web).as_posix()] = hashlib.file_digest(
                        stream, "sha256"
                    ).hexdigest()
        manifest = {
            "status": "packaged application; see validation reports for acceptance",
            "source": json.loads((source / ".krita-wasm-source.json").read_text()),
            "dependency_release": sdk.release(),
            "sdk": json.loads((sdk_path / "sdk.json").read_text())["target"],
            "sdk_inventory_sha256": hashlib.sha256(
                (sdk_path / "sdk.json").read_bytes()
            ).hexdigest(),
            "runtime_fonts": [lock for lock, _ in font_packages],
            "i18n_inventory_sha256": hashlib.sha256(
                (i18n / "sdk.json").read_bytes()
            ).hexdigest(),
            "application_inputs": {
                path.relative_to(ROOT).as_posix(): hashlib.sha256(
                    path.read_bytes()
                ).hexdigest()
                for path in sorted(
                    [
                        *(ROOT / "src").rglob("*"),
                        *(ROOT / "web").rglob("*"),
                        *(ROOT / "locks").glob("*.json"),
                        *ROOT.glob("tsconfig*.json"),
                        ROOT / "vite.config.ts",
                        ROOT / "package.json",
                        ROOT / "pnpm-lock.yaml",
                        ROOT / ".emscripten-version",
                        ROOT / ".gitmodules",
                        *(ROOT / "scripts").glob("*"),
                    ]
                )
                if path.is_file()
            },
            "cmake_cache_sha256": hashlib.sha256(
                (build / "CMakeCache.txt").read_bytes()
            ).hexdigest(),
            "files": hashes,
        }
        (web / "build.json").write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n"
        )
        web.rename(output)
    print(output)


if __name__ == "__main__":
    main()
