#!/usr/bin/env python3
"""Download/verify upstream prebuilt fonts and their original license."""

import argparse

from runtime_fonts import ROOT, import_fonts, load_locks

parser = argparse.ArgumentParser(description=__doc__)
args = parser.parse_args()
for lock in load_locks():
    print(import_fonts(lock, ROOT / "cache"))
