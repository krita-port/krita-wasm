"""Exercise network isolation across the real build wrapper and descendants."""

import subprocess
import sys
import unittest
from pathlib import Path


class OfflineExecTest(unittest.TestCase):
    def test_descendants_deny_internet_sockets_and_allow_unix_ipc(self) -> None:
        probe = """
import socket
for family in (socket.AF_INET, socket.AF_INET6):
    try:
        with socket.socket(family, socket.SOCK_STREAM):
            pass
    except PermissionError:
        continue
    raise AssertionError("Internet socket creation was allowed")
with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM):
    pass
"""
        command = probe + (
            "\nimport subprocess, sys\n"
            f"subprocess.run([sys.executable, '-c', {probe!r}], check=True)\n"
        )
        subprocess.run(
            [
                sys.executable,
                Path(__file__).resolve().parents[1] / "scripts/offline-exec.py",
                sys.executable,
                "-c",
                command,
            ],
            check=True,
            capture_output=True,
            text=True,
        )
