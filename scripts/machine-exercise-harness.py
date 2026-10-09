#!/usr/bin/env python3
"""A real PTY harness stand-in, driven by one JSON instruction per submission.

Place a wrapper named codex on the exercise core's PATH. It runs this script,
with JUNTO_EXERCISE_CLI naming that run's packaged CLI. Commands: onboard,
send {target,text}, mail, signal {text}, exit. Every operation invokes the real
CLI with the seat's inherited credential. No database or socket is opened here.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import termios
import tty


def main():
    if "--version" in sys.argv:
        print("codex-cli 0.0.0-junto-exercise")
        return 0
    home = Path(os.environ["JUNTO_HOME"]).resolve(strict=True)
    root = home.parent
    if not (root / "exercise-owner").is_file() or home.name != "home":
        raise RuntimeError("stand-in requires an exercise-owned home")
    cli = Path(os.environ["JUNTO_EXERCISE_CLI"]).resolve(strict=True)
    if not cli.is_relative_to(root):
        raise RuntimeError("stand-in CLI must belong to this exercise")
    if not os.environ.get("JUNTO_WORK_TOKEN"):
        raise RuntimeError("stand-in must be started as a Junto seat")
    if not sys.stdin.isatty():
        raise RuntimeError("stand-in requires a real PTY")
    receipts = root / f"harness-{os.getpid()}.jsonl"
    log = receipts.open("x")
    fd = sys.stdin.fileno()
    saved = termios.tcgetattr(fd)
    composer = bytearray()
    escape = bytearray()
    pasting = False

    def emit(event):
        line = json.dumps(event, ensure_ascii=False)
        log.write(line + "\n")
        log.flush()
        sys.stdout.write("\r\n" + line + "\r\n")
        sys.stdout.flush()

    def paint(working=False):
        # These are the real observer's Codex idle/composer and OSC working
        # cues, not a fabricated observer result or an in-process fake PTY.
        title = "⠋ Codex" if working else ""
        prompt = "Working" if working else "› " + composer.decode("utf-8", errors="replace")
        sys.stdout.write(f"\x1b]0;{title}\x07\r\x1b[2K{prompt}")
        sys.stdout.flush()

    def submit():
        text = composer.decode("utf-8", errors="strict").strip()
        composer.clear()
        if not text:
            return True
        paint(working=True)
        try:
            instruction = json.loads(text)
        except json.JSONDecodeError:
            # Junto's typed mail notices are observations, never instructions.
            emit({"kind": "notice", "text": text})
            return True
        try:
            op = instruction["op"]
            if op == "exit":
                emit({"kind": "exit", "ok": True})
                return False
            if op == "onboard":
                args = ["onboard"]
            elif op == "mail":
                args = ["msg", "list"]
            elif op == "send":
                args = ["msg", "send", json.dumps({
                    "target": instruction["target"], "text": instruction["text"]})]
            elif op == "signal":
                args = ["feedback", instruction["text"]]
            else:
                raise ValueError("expected onboard, send, mail, signal, or exit")
            result = subprocess.run([str(cli), *args], capture_output=True,
                                    text=True, timeout=20)
            output = result.stdout if result.returncode == 0 else result.stderr
            emit({"kind": "command", "op": op, "exit": result.returncode,
                  "response": json.loads(output)})
        except Exception as error:
            emit({"kind": "error", "error": f"{type(error).__name__}: {error}"})
        return True

    try:
        tty.setraw(fd)
        sys.stdout.write("\x1b[?2004h")
        emit({"kind": "ready", "receipts": str(receipts)})
        paint()
        while True:
            chunk = os.read(fd, 4096)
            if not chunk:
                break
            for byte in chunk:
                if escape or byte == 27:
                    escape.append(byte)
                    if bytes(escape) == b"\x1b[200~":
                        pasting = True
                        escape.clear()
                    elif bytes(escape) == b"\x1b[201~":
                        pasting = False
                        escape.clear()
                    elif not any(sequence.startswith(escape)
                                 for sequence in (b"\x1b[200~", b"\x1b[201~")):
                        escape.clear()
                    continue
                if byte in (3, 4):
                    return 0
                if byte in (10, 13) and not pasting:
                    if not submit():
                        return 0
                elif byte in (8, 127):
                    if composer:
                        composer.pop()
                elif byte >= 32 or (pasting and byte in (10, 13)):
                    composer.append(byte)
                if len(composer) > 65536:
                    composer.clear()
                    emit({"kind": "error", "error": "instruction exceeds 64 KiB"})
            paint()
    finally:
        sys.stdout.write("\x1b[?2004l\x1b]0;\x07\r\n")
        sys.stdout.flush()
        termios.tcsetattr(fd, termios.TCSANOW, saved)
        log.close()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}), file=sys.stderr)
        sys.exit(1)
