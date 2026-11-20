"""Inspect decoded RGBA pixels of browser-produced PNGs with Pillow."""

import hashlib
import io
import struct

from PIL import Image


def inspect_png(data: bytes) -> dict[str, int | str]:
    with Image.open(io.BytesIO(data), formats=["PNG"]) as image:
        image.verify()
    with Image.open(io.BytesIO(data), formats=["PNG"]) as image:
        rgba = image.convert("RGBA")
        pixels = rgba.tobytes()
        return {
            "width": rgba.width,
            "height": rgba.height,
            "dark_pixels": sum(
                r < 100 and g < 100 and b < 100 and a > 200
                for r, g, b, a in struct.iter_unpack("4B", pixels)
            ),
            "rgba_sha256": hashlib.sha256(pixels).hexdigest(),
        }
