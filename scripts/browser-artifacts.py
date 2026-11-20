#!/usr/bin/env python3
"""Validate actual browser downloads and installed translation catalogs."""

import argparse
import gettext
import hashlib
import io
import json
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import Any

from png_check import inspect_png
from runtime_bundle import read_catalogs


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kind", choices=["png", "kra", "autosave", "catalog"])
    parser.add_argument("path", type=Path)
    parser.add_argument("--languages", default="[]")
    parser.add_argument("--width", type=int, default=256)
    parser.add_argument("--height", type=int, default=256)
    args = parser.parse_args()
    result: dict[str, Any]
    if args.kind == "png":
        result = inspect_png(args.path.read_bytes())
    elif args.kind in ("kra", "autosave"):
        with zipfile.ZipFile(args.path) as archive:
            assert archive.testzip() is None, "Bad KRA ZIP member"
            assert archive.read("mimetype") == b"application/x-krita"
            tree = ET.fromstring(archive.read("maindoc.xml"))
            image = next(
                node for node in tree.iter() if node.tag.lower().endswith("image")
            )
            assert (int(image.attrib["width"]), int(image.attrib["height"])) == (
                args.width,
                args.height,
            )
            layers = [
                node for node in tree.iter() if node.tag.lower().endswith("layer")
            ]
            assert len(layers) >= 2, "KRA lost editable layers"
            # Native autosave deliberately omits mergedimage.png; its editable
            # layer bytes are verified again after actual application recovery.
            projection = inspect_png(
                archive.read(
                    "preview.png" if args.kind == "autosave" else "mergedimage.png"
                )
            )
            assert int(projection["dark_pixels"]) > 10, "KRA has no painted pixels"
        result = {
            "bytes": args.path.stat().st_size,
            "sha256": hashlib.sha256(args.path.read_bytes()).hexdigest(),
            "layers": len(layers),
            "projection": projection,
        }
    else:
        result = {}
        languages = json.loads(args.languages)
        catalogs = read_catalogs(args.path / "krita.bundle.tar.gz", languages)
        for label in ("&File", "Text Properties"):
            result[label] = label
            for language in languages:
                if language in ("en", "en_US"):
                    break
                if language in catalogs:
                    translation = gettext.GNUTranslations(
                        io.BytesIO(catalogs[language])
                    )
                    if translation.gettext(label) != label:
                        result[label] = translation.gettext(label)
                        break
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
