#!/usr/bin/env python3
"""Recompile pinned Krita catalogs into a fresh directory and compare bytes."""

import argparse
import hashlib
import json
import os
import subprocess
import tempfile
from pathlib import Path

import sdk
from runtime_bundle import read_catalogs

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "compiled",
        type=Path,
        help="Installed locale directory or packed runtime .tar.gz",
    )
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    if args.report.exists():
        raise ValueError("Preserving existing catalog comparison report")
    os.environ.update(
        {
            "KRITA_SDK_DIR": str(sdk.prefix("sdk")),
            "KRITA_I18N_DIR": str(sdk.prefix("i18n")),
        }
    )
    sdk.verify_i18n()
    source = Path(
        subprocess.check_output(
            [ROOT / "scripts/project.py", "source-path"], text=True
        ).strip()
    )
    msgfmt = Path(os.environ["KRITA_I18N_DIR"]) / "host/bin/msgfmt"
    hashes = {}
    packed = read_catalogs(args.compiled) if args.compiled.is_file() else None
    with tempfile.TemporaryDirectory(prefix="krita-catalog-compare-") as temporary:
        for po in sorted((source / "po").glob("*/krita.po")):
            fresh = Path(temporary) / (po.parent.name + ".mo")
            subprocess.run([msgfmt, "-o", fresh, po], check=True)
            installed = args.compiled / po.parent.name / "LC_MESSAGES/krita.mo"
            data = fresh.read_bytes()
            if data != (
                packed[po.parent.name] if packed is not None else installed.read_bytes()
            ):
                raise ValueError(f"Independent Krita catalog differs: {po.parent.name}")
            hashes[po.parent.name] = hashlib.sha256(data).hexdigest()
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(
        json.dumps(
            {
                "equal": True,
                "files": len(hashes),
                "sha256": hashes,
                "scope": "fresh own Krita catalogs versus installed build output",
            },
            indent=2,
        )
        + "\n"
    )
    print(
        f"PASS: {len(hashes)} independently compiled Krita catalogs match installed bytes"
    )


if __name__ == "__main__":
    main()
