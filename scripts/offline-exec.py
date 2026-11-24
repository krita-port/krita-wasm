#!/usr/bin/env python3
"""Run a build with new IPv4/IPv6 sockets denied in this process and children.

Linux/libseccomp only. Unix sockets remain available for local build-tool IPC.
This does not alter system networking or any other process.
"""

import errno
import os
import platform
import socket
import sys

import pyseccomp as seccomp


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("Usage: offline-exec.py COMMAND [ARG ...]")
    if platform.system() != "Linux":
        raise SystemExit("offline-exec requires Linux and libseccomp.so.2")
    policy = seccomp.SyscallFilter(seccomp.ALLOW)
    for family in (socket.AF_INET, socket.AF_INET6):
        policy.add_rule(
            seccomp.ERRNO(errno.EPERM), "socket", seccomp.Arg(0, seccomp.EQ, family)
        )
    policy.load()
    for family in (socket.AF_INET, socket.AF_INET6):
        try:
            descriptor = socket.socket(family, socket.SOCK_STREAM)
        except PermissionError:
            continue
        descriptor.close()
        raise SystemExit("Socket restriction verification failed")
    print(
        "PASS: this build process and its children cannot create IPv4/IPv6 sockets",
        flush=True,
    )
    os.execvp(sys.argv[1], sys.argv[1:])


if __name__ == "__main__":
    main()
