#!/usr/bin/env python3
"""Reject external translation units in the application's actual compile graph."""

import argparse
import json
import shlex
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("build", type=Path)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument(
        "--sdk",
        type=Path,
        help="Verified prebuilt root for archive/object link auditing",
    )
    parser.add_argument("--i18n", type=Path)
    args = parser.parse_args()
    build = args.build.resolve(strict=True)
    roots = [
        args.source.resolve(strict=True),
        build,
        Path(__file__).resolve().parents[1] / "src",
    ]
    entries = json.loads((build / "compile_commands.json").read_text())
    failures = set()
    for entry in entries:
        source = Path(entry["file"])
        if not source.is_absolute():
            source = Path(entry["directory"]) / source
        source = source.resolve()
        if not any(source.is_relative_to(root) for root in roots):
            failures.add(source)
    if failures:
        raise SystemExit(
            "External source files must be precompiled in the SDK:\n"
            + "\n".join(map(str, sorted(failures)))
        )
    print(
        f"PASS: {len(entries)} compilation units belong to Krita, port glue or this build's generated integration code"
    )
    if args.sdk:
        library_roots = [build, args.sdk.resolve(strict=True)]
        if args.i18n:
            library_roots.append(args.i18n.resolve(strict=True))
        libraries = set()
        for line in (build / "build.ninja").read_text().splitlines():
            if not line.startswith("  LINK_LIBRARIES = "):
                continue
            for token in shlex.split(line.partition(" = ")[2]):
                path = Path(token)
                if path.is_absolute() and path.suffix in (".a", ".o"):
                    libraries.add(path.resolve())
        escaped = sorted(
            path
            for path in libraries
            if not any(path.is_relative_to(root) for root in library_roots)
        )
        if escaped:
            raise SystemExit(
                "Linked archive/object escapes verified prebuilt/build roots:\n"
                + "\n".join(map(str, escaped))
            )
        print(
            f"PASS: {len(libraries)} linked archives/objects stay inside verified prebuilts and this build"
        )


if __name__ == "__main__":
    main()
