#!/usr/bin/env python3
"""Evidence probe for docs/assessments/cost-observability-2026-09-18.md.

Read-only. Answers two questions against the operator's own machine:

1. What seats exist on the Junto board, and which of them name a harness
   session id? (Read from a throwaway copy of `~/.junto/state/junto.db`, so the
   live database is never opened or locked.)
2. For each named session, does the harness's own session file exist on disk,
   and does it carry per-turn token and cost data?

Run: `python3 probe.py` (stdlib only).

`junto.db` is copied to a temp file first because the live database is normally
held by the app runtime; the copy is read with `mode=ro&immutable=1` and is
deleted on exit. Nothing is written to the harness homes or to `~/.junto`.
"""

import glob
import json
import os
import shutil
import sqlite3
import tempfile
from urllib.parse import quote

HOME = os.path.expanduser("~")
JUNTO_DB = os.path.join(HOME, ".junto", "state", "junto.db")


def board_sessions(db_path):
    """Seat nodes that name a harness session, with the harness and launch cwd."""
    con = sqlite3.connect(f"file:{db_path}?mode=ro&immutable=1", uri=True)
    con.row_factory = sqlite3.Row
    out = []
    for row in con.execute(
        "select ether_json from canvas_nodes where ether_json is not null"
    ):
        try:
            ether = json.loads(row["ether_json"])
        except ValueError:
            continue
        terminal = (ether or {}).get("terminal") or {}
        if terminal.get("sessionId"):
            out.append(
                (
                    terminal.get("harness"),
                    terminal["sessionId"],
                    (terminal.get("launch") or {}).get("cwd"),
                )
            )
    con.close()
    return out


def claude_probe(cwd, sid):
    """~/.claude/projects/<cwd with / replaced by ->/<sessionId>.jsonl"""
    path = os.path.join(
        HOME, ".claude", "projects", cwd.replace("/", "-"), sid + ".jsonl"
    )
    if not os.path.exists(path):
        return None, path
    totals = {"input": 0, "output": 0, "cache_read": 0, "cache_creation": 0}
    models = set()
    with open(path, errors="replace") as handle:
        for line in handle:
            try:
                record = json.loads(line)
            except ValueError:
                continue
            message = record.get("message") or {}
            usage = message.get("usage")
            if not isinstance(usage, dict):
                continue
            totals["input"] += usage.get("input_tokens") or 0
            totals["output"] += usage.get("output_tokens") or 0
            totals["cache_read"] += usage.get("cache_read_input_tokens") or 0
            totals["cache_creation"] += usage.get("cache_creation_input_tokens") or 0
            if isinstance(message.get("model"), str):
                models.add(message["model"])
    return dict(totals, cost_field=False, models=sorted(models)), path


def codex_probe(cwd, sid):
    """~/.codex/sessions/**/rollout-*.jsonl, located by session id."""
    pattern = os.path.join(HOME, ".codex", "sessions", "**", f"*{sid}*.jsonl")
    matches = glob.glob(pattern, recursive=True)
    if not matches:
        return None, pattern
    path = matches[0]
    last_total = None
    with open(path, errors="replace") as handle:
        for line in handle:
            try:
                record = json.loads(line)
            except ValueError:
                continue
            payload = record.get("payload") or {}
            if payload.get("type") != "token_count":
                continue
            info = payload.get("info") or {}
            total = info.get("total_token_usage")
            if isinstance(total, dict):
                last_total = total
    return dict(last_total, cost_field=False) if last_total else None, path


def grok_probe(cwd, sid):
    """~/.grok/sessions/<encodeURIComponent(cwd)>/<sessionId>/updates.jsonl"""
    root = os.path.join(HOME, ".grok", "sessions")
    candidates = glob.glob(os.path.join(root, "*", sid, "updates.jsonl"))
    if not candidates:
        candidates = glob.glob(os.path.join(root, "*", f"*{sid}*", "updates.jsonl"))
    if not candidates:
        return None, os.path.join(root, quote(cwd, safe=""), sid, "updates.jsonl")
    path = candidates[0]
    totals = {"turns": 0, "input": 0, "output": 0, "total": 0, "costUsdTicks": 0}
    with open(path, errors="replace") as handle:
        for line in handle:
            try:
                record = json.loads(line)
            except ValueError:
                continue
            update = ((record.get("params") or {}).get("update")) or {}
            if update.get("sessionUpdate") != "turn_completed":
                continue
            usage = update.get("usage") or {}
            totals["turns"] += 1
            totals["input"] += usage.get("inputTokens") or 0
            totals["output"] += usage.get("outputTokens") or 0
            totals["total"] += usage.get("totalTokens") or 0
            totals["costUsdTicks"] += usage.get("costUsdTicks") or 0
    return totals, path


def pi_probe(cwd, sid):
    """~/.pi/agent/sessions/--<cwd-encoded>--/<timestamp>_<sessionId>.jsonl"""
    encoded = "--" + cwd.strip("/").replace("/", "-").replace(":", "-") + "--"
    root = os.path.join(HOME, ".pi", "agent", "sessions", encoded)
    candidates = glob.glob(os.path.join(root, f"*{sid}*.jsonl"))
    if not candidates:
        return None, root
    path = candidates[0]
    totals = {"input": 0, "output": 0, "total": 0, "cost": 0.0, "cost_field": False}
    with open(path, errors="replace") as handle:
        for line in handle:
            try:
                record = json.loads(line)
            except ValueError:
                continue
            usage = (record.get("message") or {}).get("usage") or record.get("usage")
            if not isinstance(usage, dict):
                continue
            totals["input"] += usage.get("input") or 0
            totals["output"] += usage.get("output") or 0
            totals["total"] += usage.get("totalTokens") or 0
            cost = usage.get("cost")
            if isinstance(cost, dict) and "total" in cost:
                totals["cost"] += cost.get("total") or 0
                totals["cost_field"] = True
    return totals, path


# Harnesses whose session files carry usage. Cursor, Devin, Antigravity, Kimi,
# Muse, Fx, Omp, Prime Agent, and Amp have no probe here.
PROBES = {
    "claude": claude_probe,
    "codex": codex_probe,
    "grok": grok_probe,
    "pi": pi_probe,
}


def main():
    if not os.path.exists(JUNTO_DB):
        raise SystemExit(f"no junto database at {JUNTO_DB}")

    workdir = tempfile.mkdtemp(prefix="junto-cost-probe-")
    db_copy = os.path.join(workdir, "junto.db")
    try:
        shutil.copy2(JUNTO_DB, db_copy)
        sessions = board_sessions(db_copy)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

    print(f"seats naming a session: {len(sessions)}")
    for harness, session_id, cwd in sessions:
        probe = PROBES.get(harness)
        if probe is None:
            print(f"{harness:14} {session_id:40} NO PROBE")
            continue
        if not cwd:
            print(f"{harness:14} {session_id:40} no cwd on node")
            continue
        try:
            data, path = probe(cwd, session_id)
        except OSError as exc:
            print(f"{harness:14} {session_id:40} ERROR {exc}")
            continue
        if data:
            print(f"{harness:14} {session_id:40} FOUND    {json.dumps(data)}")
        else:
            print(f"{harness:14} {session_id:40} missing")
            print(f"{'':14} looked at {path}")


if __name__ == "__main__":
    main()
