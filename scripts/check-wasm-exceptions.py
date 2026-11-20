#!/usr/bin/env python3
"""Validate a final module and reject legacy Wasm exception instructions."""

import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wasm", type=Path)
    parser.add_argument(
        "--wasm-opt", default="wasm-opt", help="Use the pinned toolchain Binaryen"
    )
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    result = subprocess.run(
        [args.wasm_opt, str(args.wasm), "--metrics", "--all-features"],
        check=True,
        capture_output=True,
        text=True,
    )
    counts = {
        name: int(count)
        for name, count in re.findall(
            r"^\s*(Try|TryTable|Rethrow|ThrowRef|Pop)\s*:\s*(\d+)\s*$",
            result.stdout,
            re.MULTILINE,
        )
    }
    legacy = {name: counts.get(name, 0) for name in ("Try", "Rethrow", "Pop")}
    if any(legacy.values()) or not counts.get("TryTable"):
        raise SystemExit(
            f"Expected standard exception handling with no legacy instructions: {counts}"
        )
    with args.wasm.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    report = {
        "schema": 1,
        "exception_instructions": "standard-exnref",
        "wasm_sha256": digest,
        "legacy": legacy,
        "try_table": counts["TryTable"],
        "throw_ref": counts.get("ThrowRef", 0),
        "binaryen": subprocess.check_output(
            [args.wasm_opt, "--version"], text=True
        ).strip(),
    }
    if args.report:
        args.report.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    main()
