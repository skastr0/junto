"""Bounded target-side boot/status/shutdown step; never opens a product database."""
import hashlib
import json
import os
import platform
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time


def exchange(stream, client, frame):
    client.sendall((json.dumps(frame) + "\n").encode())
    line = stream.readline(1024 * 1024)
    if not line:
        raise RuntimeError("control socket closed without a response")
    return json.loads(line)


def probe(config):
    root = Path(config["root"]).resolve(strict=True)
    if (root / "exercise-owner").read_text().strip() != config["owner"]:
        raise RuntimeError("exercise ownership marker differs")
    home = root / "home"
    home.mkdir(mode=0o700)  # Refuse reuse, including after a failed run.
    entry = root / "install/core/junto.cjs"
    env = {key: value for key, value in os.environ.items()
           if not key.startswith("JUNTO_") and key not in
           ("INVOCATION_ID", "ELECTRON_RUN_AS_NODE", "NODE_PATH")}
    env["JUNTO_HOME"] = str(home)
    env["NODE_PATH"] = str(entry.parent / "node_modules")
    result = {"root": str(root), "home": str(home), "steps": {},
              "platform": platform.system(), "architecture": platform.machine(),
              "node": subprocess.check_output([config.get("node", "node"), "--version"],
                                               text=True, timeout=5).strip(),
              "entrySha256": hashlib.sha256(entry.read_bytes()).hexdigest()}
    child = None

    def interrupted(signum, _frame):
        raise RuntimeError(f"exercise interrupted by signal {signum}")

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        with (root / "runtime.log").open("w") as log:
            child = subprocess.Popen([config.get("node", "node"), str(entry)],
                                     env=env, stdout=log, stderr=subprocess.STDOUT)
            deadline = time.monotonic() + 20
            term = home / ".junto/term/control.sock"
            work = home / ".junto/work/control.sock"
            while child.poll() is None and time.monotonic() < deadline:
                if term.exists() and work.exists():
                    break
                time.sleep(0.05)
            if child.poll() is not None or not term.exists() or not work.exists():
                raise RuntimeError("core did not expose term and work sockets within 20 seconds")
            result["steps"]["boot"] = {"ok": True}
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.settimeout(3)
                client.connect(str(term))
                with client.makefile("r") as stream:
                    auth = exchange(stream, client, {
                        "token": (home / ".junto/term/token").read_text().strip()})
                    if not auth.get("ok"):
                        raise RuntimeError("term authentication failed")
                    ping = exchange(stream, client, {"v": 1, "id": "ping", "op": "ping"})
                    seats = exchange(stream, client, {"v": 1, "id": "list", "op": "list"})
            if not ping.get("ok") or ping.get("data", {}).get("pong") is not True:
                raise RuntimeError("term ping did not return pong")
            if not seats.get("ok") or seats.get("data", {}).get("sessions") != []:
                raise RuntimeError("fresh home did not report an empty seat list")
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.settimeout(3)
                client.connect(str(work))
                with client.makefile("r") as stream:
                    unauthenticated = exchange(stream, client, {"token": "probe", "op": "ping"})
            if unauthenticated.get("ok") or unauthenticated.get("error", {}).get("type") != "AuthError":
                raise RuntimeError("work socket did not refuse an unregistered seat")
            result["steps"]["status"] = {"ok": True, "ping": ping, "seats": seats,
                                           "unregisteredSeat": unauthenticated}
    except Exception as error:
        result["error"] = f"{type(error).__name__}: {error}"
    finally:
        if child is not None:
            started = time.monotonic()
            forced = False
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    forced = True
                    child.kill()
                    child.wait(timeout=3)
            result["steps"]["shutdown"] = {
                "ok": child.returncode == 0 and not forced,
                "exit": child.returncode, "forced": forced,
                "seconds": round(time.monotonic() - started, 3)}
        result["ok"] = (not result.get("error") and
                        all(result["steps"].get(step, {}).get("ok")
                            for step in ("boot", "status", "shutdown")))
        (root / "receipt.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


if __name__ == "__main__":
    try:
        receipt = probe(json.loads(sys.argv[1]))
    except Exception as error:
        receipt = {"ok": False, "error": f"{type(error).__name__}: {error}"}
    print(json.dumps(receipt), flush=True)
    sys.exit(0 if receipt["ok"] else 1)
