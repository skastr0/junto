#!/usr/bin/env python3
"""Observe the peer PID of a Unix-domain socket inherited as fd 0.

Used by Vellum Command's local work and browser control planes for process-bind
identity. Node/Electron has no portable SO_PEERCRED / LOCAL_PEERPID binding;
this helper dups stdin (the connection fd) and reads the kernel credential.

macOS: LOCAL_PEERPID (SOL_LOCAL=0, opt=2)
Linux: SO_PEERCRED (SOL_SOCKET, SO_PEERCRED) → ucred.pid
"""
from __future__ import annotations

import platform
import socket
import struct
import sys


def peer_pid(fd: int = 0) -> int:
    # fromfd dups so the parent Node socket stays valid.
    sock = socket.fromfd(fd, socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        system = platform.system()
        if system == "Darwin":
            # SOL_LOCAL=0, LOCAL_PEERPID=2 → int
            return int(sock.getsockopt(0, 2))
        if system == "Linux":
            # SO_PEERCRED: struct ucred { pid_t pid; uid_t uid; gid_t gid; }
            so_peercred = 17
            raw = sock.getsockopt(
                socket.SOL_SOCKET,
                so_peercred,
                struct.calcsize("iII"),
            )
            pid, _uid, _gid = struct.unpack("iII", raw)
            return int(pid)
        raise OSError(f"unix peer pid unsupported on {system}")
    finally:
        try:
            sock.close()
        except OSError:
            pass


def main() -> int:
    try:
        if len(sys.argv) != 1:
            raise ValueError("expected no arguments")
        print(peer_pid(0), end="")
        return 0
    except Exception as exc:  # noqa: BLE001 — surface to parent as non-zero
        print(f"unix-peer-pid: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
