#!/usr/bin/env python3
"""Measure cache rewrites paid after idle gaps in this repo's Claude Code transcripts.

Rerun: python3 -I docs/research/cache-cold/measure.py [--days 7] [--now ISO]
"""
import argparse, glob, json, os, sys
from datetime import datetime, timedelta, timezone

ROOT = os.path.expanduser("~/.claude/projects/-Users-guilhermecastro-Projects-junto")
GAPS_MIN = (5, 60)


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def calls(path):
    """One entry per API call: streamed chunks of one response share message.id."""
    seen, out = set(), []
    with open(path, errors="replace") as fh:
        for line in fh:
            if '"usage"' not in line:
                continue
            try:
                r = json.loads(line)
            except ValueError:
                continue
            m = r.get("message") or {}
            u = m.get("usage")
            if r.get("type") != "assistant" or not u or not r.get("timestamp"):
                continue
            key = r.get("requestId") or m.get("id")
            if key in seen:
                continue
            seen.add(key)
            cc = u.get("cache_creation") or {}
            out.append({
                "t": ts(r["timestamp"]),
                "session": r.get("sessionId"),
                "model": m.get("model"),
                "write": u.get("cache_creation_input_tokens") or 0,
                "write_1h": cc.get("ephemeral_1h_input_tokens") or 0,
                "write_5m": cc.get("ephemeral_5m_input_tokens") or 0,
                "read": u.get("cache_read_input_tokens") or 0,
                "input": u.get("input_tokens") or 0,
            })
    out.sort(key=lambda c: c["t"])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=float, default=7)
    ap.add_argument("--now")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    now = ts(a.now) if a.now else datetime.now(timezone.utc)
    since = now - timedelta(days=a.days)

    files = glob.glob(f"{ROOT}/*.jsonl") + glob.glob(f"{ROOT}/*/subagents/*.jsonl")
    tot = {"calls": 0, "write": 0, "read": 0, "input": 0, "files": 0}
    start = {"n": 0, "write": 0}
    gap = {g: {"n": 0, "write": 0, "write_1h": 0, "write_5m": 0} for g in GAPS_MIN}
    gaps_list = []
    for f in files:
        if datetime.fromtimestamp(os.path.getmtime(f), timezone.utc) < since:
            continue
        cs = calls(f)
        kind = "subagent" if "/subagents/" in f else "main"
        prev = None
        used = False
        for c in cs:
            inwin = since <= c["t"] <= now
            if inwin:
                used = True
                tot["calls"] += 1
                for k in ("write", "read", "input"):
                    tot[k] += c[k]
                if prev is None:
                    start["n"] += 1
                    start["write"] += c["write"]
                else:
                    mins = (c["t"] - prev).total_seconds() / 60
                    for g in GAPS_MIN:
                        if mins > g:
                            gap[g]["n"] += 1
                            for k in ("write", "write_1h", "write_5m"):
                                gap[g][k] += c[k]
                    if mins > GAPS_MIN[0]:
                        gaps_list.append({**c, "gap_min": round(mins, 1), "kind": kind,
                                          "file": os.path.relpath(f, ROOT)})
            prev = c["t"]
        tot["files"] += used

    worst = sorted(gaps_list, key=lambda c: -c["write"])[:10]
    res = {
        "window": [since.isoformat(), now.isoformat()],
        "totals": tot,
        "session_first_calls": start,
        "gaps": {f">{g}min": {**v, "share_of_all_writes": v["write"] / tot["write"] if tot["write"] else 0}
                 for g, v in gap.items()},
        "worst10": [{"session": w["session"], "file": w["file"], "kind": w["kind"],
                     "time": w["t"].isoformat(), "gap_min": w["gap_min"], "model": w["model"],
                     "cache_write": w["write"], "cache_read": w["read"]} for w in worst],
    }
    if a.json:
        json.dump(res, sys.stdout, indent=2, default=str)
        return
    print(f"window {res['window'][0]} .. {res['window'][1]}")
    print(f"calls {tot['calls']} in {tot['files']} transcripts; cache_write {tot['write']:,} "
          f"cache_read {tot['read']:,} uncached_input {tot['input']:,}")
    print(f"session first calls: {start['n']} turns, cache_write {start['write']:,} "
          f"({start['write'] / tot['write']:.1%})")
    for g, v in res["gaps"].items():
        print(f"gap {g}: {v['n']} turns, cache_write {v['write']:,} ({v['share_of_all_writes']:.1%}); "
              f"1h-ttl {v['write_1h']:,} 5m-ttl {v['write_5m']:,}")
    print("worst 10 single rewrites after a gap >5min:")
    for w in res["worst10"]:
        print(f"  {w['time'][:19]}Z  {w['cache_write']:>9,}  gap {w['gap_min']:>7}m  "
              f"{w['kind']:<8} {w['session']}  {w['model']}")


main()
