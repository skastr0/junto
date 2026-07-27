#!/usr/bin/env python3
"""Observe the peer of a connected Unix-domain socket inherited as fd 0.

Used by Vellum's main-process control planes (work + browser) for process-bind
identity. Node/Electron has no portable SO_PEERCRED / LOCAL_PEERPID binding;
this helper dups stdin (the connection fd) and reads the peer credential.

macOS: LOCAL_PEERPID (SOL_LOCAL=0, opt=2)
Linux: SO_PEERCRED (SOL_SOCKET, SO_PEERCRED) → ucred.pid

With ``--process-chain``, emit one bounded JSON observation of the peer and
its ancestors. Every hop is read twice around exact executable resolution and
is accepted only when pid, ppid, uid, and process start identity remain stable.
The Station control plane uses two independent observations to bind its fixed
packaged client to a real system sshd ancestor without trusting process titles.
"""
from __future__ import annotations

import ctypes
import json
import os
import platform
import socket
import struct
import subprocess
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone


MAX_PROCESS_CHAIN_DEPTH = 12


@dataclass(frozen=True)
class ProcessHop:
    pid: int
    ppid: int
    uid: int
    start_key: str
    executable: str
    device: str
    inode: str


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
            SO_PEERCRED = 17
            raw = sock.getsockopt(socket.SOL_SOCKET, SO_PEERCRED, struct.calcsize("iII"))
            pid, _uid, _gid = struct.unpack("iII", raw)
            return int(pid)
        raise OSError(f"unix peer pid unsupported on {system}")
    finally:
        try:
            sock.close()
        except OSError:
            pass


def _linux_stat(pid: int) -> tuple[int, int, str]:
    proc = f"/proc/{pid}"
    with open(f"{proc}/stat", "r", encoding="ascii") as handle:
        raw = handle.read()
    close = raw.rfind(")")
    if close < 1 or close + 2 >= len(raw):
        raise OSError(f"malformed process stat for pid {pid}")
    fields = raw[close + 2 :].split()
    # fields[0] is field 3 (state), fields[1] is field 4 (ppid), and
    # fields[19] is field 22 (boot-relative process start ticks).
    if len(fields) < 20:
        raise OSError(f"short process stat for pid {pid}")
    ppid = int(fields[1])
    start_ticks = fields[19]
    if ppid < 0 or not start_ticks.isdecimal():
        raise OSError(f"invalid process identity for pid {pid}")
    return ppid, os.stat(proc).st_uid, start_ticks


def _linux_process(pid: int) -> ProcessHop:
    before = _linux_stat(pid)
    proc_executable = f"/proc/{pid}/exe"
    executable_link = os.readlink(proc_executable)
    if executable_link.endswith(" (deleted)"):
        raise OSError(f"deleted executable for pid {pid}")
    executable = os.path.realpath(executable_link)
    executable_stat = os.stat(proc_executable)
    after = _linux_stat(pid)
    if before != after:
        raise OSError(f"process identity raced for pid {pid}")
    return ProcessHop(
        pid=pid,
        ppid=before[0],
        uid=before[1],
        start_key=before[2],
        executable=executable,
        device=str(int(executable_stat.st_dev)),
        inode=str(int(executable_stat.st_ino)),
    )


_DARWIN_PROC_PIDPATHINFO_MAXSIZE = 4096


def _darwin_libproc() -> ctypes.CDLL:
    library = ctypes.CDLL("/usr/lib/libproc.dylib")
    library.proc_pidpath.argtypes = [
        ctypes.c_int,
        ctypes.c_void_p,
        ctypes.c_uint32,
    ]
    library.proc_pidpath.restype = ctypes.c_int
    return library


def _darwin_process_table() -> dict[int, tuple[int, int, str]]:
    result = subprocess.run(
        ["/bin/ps", "-axo", "pid=,ppid=,uid=,lstart="],
        check=False,
        capture_output=True,
        text=True,
        timeout=1.0,
        env={**os.environ, "LC_ALL": "C", "TZ": "UTC"},
    )
    if result.returncode != 0 or result.stderr.strip():
        raise OSError("system process table unavailable")
    rows: dict[int, tuple[int, int, str]] = {}
    for line in result.stdout.splitlines():
        if not line.strip():
            continue
        fields = line.split(None, 3)
        if len(fields) != 4:
            raise OSError("malformed system process table")
        pid_text, ppid_text, uid_text, start_text = fields
        if (
            not pid_text.isdecimal()
            or not ppid_text.isdecimal()
            or not uid_text.removeprefix("-").isdecimal()
        ):
            raise OSError("invalid system process identity")
        pid = int(pid_text)
        ppid = int(ppid_text)
        uid = int(uid_text)
        normalized_start = " ".join(start_text.split())
        try:
            parsed_start = datetime.strptime(
                normalized_start,
                "%a %b %d %H:%M:%S %Y",
            ).replace(tzinfo=timezone.utc)
        except ValueError as exc:
            raise OSError("invalid system process start identity") from exc
        if pid <= 0 or ppid < 0 or pid in rows:
            raise OSError("ambiguous system process identity")
        rows[pid] = (ppid, uid, str(int(parsed_start.timestamp())))
    if os.getpid() not in rows:
        raise OSError("incomplete system process table")
    return rows


def _darwin_process(
    library: ctypes.CDLL,
    pid: int,
    identity: tuple[int, int, str],
) -> ProcessHop:
    buffer = ctypes.create_string_buffer(_DARWIN_PROC_PIDPATHINFO_MAXSIZE)
    length = library.proc_pidpath(
        pid,
        buffer,
        _DARWIN_PROC_PIDPATHINFO_MAXSIZE,
    )
    if length <= 0:
        raise OSError(f"executable unavailable for pid {pid}")
    executable = os.path.realpath(
        buffer.raw[:length].rstrip(b"\x00").decode("utf-8", errors="strict")
    )
    executable_stat = os.stat(executable)
    return ProcessHop(
        pid=pid,
        ppid=identity[0],
        uid=identity[1],
        start_key=identity[2],
        executable=executable,
        device=str(int(executable_stat.st_dev)),
        inode=str(int(executable_stat.st_ino)),
    )


def process_chain(fd: int = 0) -> dict[str, object]:
    system = platform.system()
    peer = peer_pid(fd)
    trusted_sshd = {
        os.path.realpath(candidate)
        for candidate in (
            ["/usr/sbin/sshd"]
            if system in {"Darwin", "Linux"}
            else []
        )
        if os.path.isfile(candidate)
    }
    peer_uid: int
    if system == "Linux":
        # Authenticate the account from SO_PEERCRED itself, not /proc.
        sock = socket.fromfd(fd, socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            raw = sock.getsockopt(
                socket.SOL_SOCKET,
                17,  # SO_PEERCRED
                struct.calcsize("iII"),
            )
            credential_pid, peer_uid, _peer_gid = struct.unpack("iII", raw)
        finally:
            sock.close()
        if credential_pid != peer:
            raise OSError("peer credential changed during observation")
        observe = _linux_process
    elif system == "Darwin":
        # LOCAL_PEERPID is the kernel credential available on Darwin. One
        # complete, locale-pinned system ps snapshot supplies pid/ppid/uid/start
        # even for root-owned ancestors; libproc supplies exact executable
        # paths without trusting ps command titles.
        library = _darwin_libproc()
        before_table = _darwin_process_table()
        first_identity = before_table.get(peer)
        if first_identity is None:
            raise OSError("peer missing from system process table")
        first = _darwin_process(library, peer, first_identity)
        peer_uid = first_identity[1]

        def observe(pid: int) -> ProcessHop:
            identity = before_table.get(pid)
            if identity is None:
                raise OSError(f"process identity unavailable for pid {pid}")
            return _darwin_process(library, pid, identity)

    else:
        raise OSError(f"process chain unsupported on {system}")

    chain: list[ProcessHop] = []
    current = peer
    seen: set[int] = set()
    while current > 0 and len(chain) < MAX_PROCESS_CHAIN_DEPTH:
        if current in seen:
            raise OSError("process ancestry cycle")
        seen.add(current)
        hop = first if system == "Darwin" and len(chain) == 0 else observe(current)
        if hop.uid < 0 or hop.ppid < 0 or not os.path.isabs(hop.executable):
            raise OSError(f"invalid process observation for pid {current}")
        chain.append(hop)
        # The Station policy needs the authenticated session sshd, not its
        # root daemon or init ancestor. Stopping here avoids requiring proc
        # inspection authority beyond the proof-bearing system executable.
        if hop.executable in trusted_sshd:
            break
        if hop.ppid <= 1:
            break
        current = hop.ppid

    if not chain or chain[0].pid != peer:
        raise OSError("peer process missing from ancestry")
    for index in range(1, len(chain)):
        if chain[index - 1].ppid != chain[index].pid:
            raise OSError("incoherent process ancestry")
    if system == "Darwin":
        after_table = _darwin_process_table()
        for hop in chain:
            if after_table.get(hop.pid) != (
                hop.ppid,
                hop.uid,
                hop.start_key,
            ):
                raise OSError(f"process identity raced for pid {hop.pid}")
    return {
        "platform": system,
        "peer_pid": peer,
        "peer_uid": peer_uid,
        "chain": [asdict(hop) for hop in chain],
    }


def main() -> int:
    try:
        if len(sys.argv) == 1:
            print(peer_pid(0), end="")
        elif sys.argv == [sys.argv[0], "--process-chain"]:
            print(
                json.dumps(
                    process_chain(0),
                    sort_keys=True,
                    separators=(",", ":"),
                ),
                end="",
            )
        else:
            raise ValueError("expected no arguments or --process-chain")
        return 0
    except Exception as exc:  # noqa: BLE001 — surface to parent as non-zero
        print(f"unix-peer-pid: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
