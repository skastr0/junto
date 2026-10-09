#!/usr/bin/env python3
"""Run a command on an authenticated Xvfb, retaining its owned stop handle.

Usage: scripts/with-app-run-lock.sh python3 scripts/machine-exercise-display.py
       --receipt /absolute/display.json -- bun scripts/linux-ci-packaged-smoke.ts APP
Child stdout/stderr are unchanged. The receipt covers display startup/cleanup.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import select
import signal
import subprocess
import tempfile
import time


def stop(child):
    if child is None:
        return None
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=8)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=5)
    return child.returncode


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--receipt", required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("provide a command after --")
    if os.environ.get("JUNTO_APP_RUN_LOCK_HELD") != "1":
        parser.error("run through scripts/with-app-run-lock.sh")
    receipt_path = Path(args.receipt)
    if not receipt_path.is_absolute():
        parser.error("receipt must be an absolute path")
    receipt = {"ok": False, "command": command}
    display_child = None
    command_child = None

    def interrupted(signum, _frame):
        raise RuntimeError(f"display exercise interrupted by signal {signum}")

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        with tempfile.TemporaryDirectory(prefix="junto-display-", dir="/tmp") as temporary:
            root = Path(temporary)
            auth = root / "Xauthority"
            auth.touch(mode=0o600)
            cookie = secrets.token_hex(16)
            with (root / "xvfb.log").open("w+") as log:
                for _ in range(20):
                    number = 200 + secrets.randbelow(9800)
                    display = f":{number}"
                    if (Path(f"/tmp/.X{number}-lock").exists() or
                            Path(f"/tmp/.X11-unix/X{number}").exists()):
                        continue
                    # Cookie goes through stdin, never argv or the receipt.
                    subprocess.run(["xauth", "-f", str(auth)],
                                   input=f"add {display} . {cookie}\n", text=True,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                   check=True, timeout=5)
                    ready_read, ready_write = os.pipe()
                    try:
                        display_child = subprocess.Popen([
                            "Xvfb", display, "-screen", "0", "1280x800x24",
                            "-nolisten", "tcp", "-auth", str(auth),
                            "-displayfd", str(ready_write),
                        ], stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                            pass_fds=(ready_write,))
                    finally:
                        os.close(ready_write)
                    environment = {**os.environ, "DISPLAY": display, "XAUTHORITY": str(auth)}
                    deadline = time.monotonic() + 10
                    ready = False
                    try:
                        answer = bytearray()
                        while display_child.poll() is None and time.monotonic() < deadline:
                            if select.select([ready_read], [], [], 0.05)[0]:
                                chunk = os.read(ready_read, 32)
                                if not chunk:
                                    break
                                answer.extend(chunk)
                                if b"\n" in answer:
                                    # Only this spawned child owns the pipe's
                                    # write end: another display cannot satisfy it.
                                    ready = (bytes(answer) == f"{number}\n".encode()
                                             and display_child.poll() is None)
                                    break
                            if len(answer) > 16:
                                break
                    finally:
                        os.close(ready_read)
                    if ready:
                        break
                    stop(display_child)
                    display_child = None
                else:
                    raise RuntimeError("could not start an authenticated owned display")
                receipt["display"] = display
                try:
                    command_child = subprocess.Popen(command, env=environment)
                    receipt["commandExit"] = command_child.wait()
                    receipt["ok"] = receipt["commandExit"] == 0
                finally:
                    stop(command_child)
                    receipt["displayExit"] = stop(display_child)
                    receipt["displayStopped"] = display_child.poll() is not None
                    display_child = None
        receipt["temporaryRootRemoved"] = not root.exists()
    except Exception as error:
        receipt["error"] = f"{type(error).__name__}: {error}"
        receipt["ok"] = False
    finally:
        stop(command_child)
        stop(display_child)
        receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
    return 0 if receipt["ok"] else int(receipt.get("commandExit") or 1)


if __name__ == "__main__":
    raise SystemExit(main())
