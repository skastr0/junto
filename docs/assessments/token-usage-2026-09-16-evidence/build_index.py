#!/usr/bin/env python3
"""Normalize a Codex rollout jsonl into small TSV indexes.

Source (authoritative, read-only):
  /Users/guilhermecastro/.codex/sessions/2026/09/13/
  rollout-2026-09-13T19-36-10-01a09ce9-ea56-7123-8596-5aa8368e82db.jsonl

Outputs under /tmp/tt-invest/index/:
  calls.tsv      one row per tool call (function_call + custom_tool_call)
  outputs.tsv    one row per exec sub-command result parsed out of call outputs
  usage.tsv      one row per token_usage_record (per-response usage)
  tokens.tsv     one row per event_msg/token_count
  turns.tsv      one row per task_started / task_complete / turn_aborted
  compactions.tsv one row per compacted record
  items.tsv      one row per response_item (kind, sizes) for cheap distribution work
"""
import json
import os
import re
import sys

SRC = ("/Users/guilhermecastro/.codex/sessions/2026/09/13/"
       "rollout-2026-09-13T19-36-10-01a09ce9-ea56-7123-8596-5aa8368e82db.jsonl")
OUT = "/tmp/tt-invest/index"

os.makedirs(OUT, exist_ok=True)

def esc(s):
    if s is None:
        return ""
    return str(s).replace("\t", " ").replace("\n", " ").replace("\r", " ")

def flat_text(content):
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = []
    for c in content:
        if isinstance(c, dict):
            parts.append(c.get("text") or "")
    return "".join(parts)

f_calls = open(os.path.join(OUT, "calls.tsv"), "w")
f_outs = open(os.path.join(OUT, "outputs.tsv"), "w")
f_usage = open(os.path.join(OUT, "usage.tsv"), "w")
f_tokens = open(os.path.join(OUT, "tokens.tsv"), "w")
f_turns = open(os.path.join(OUT, "turns.tsv"), "w")
f_comp = open(os.path.join(OUT, "compactions.tsv"), "w")
f_items = open(os.path.join(OUT, "items.tsv"), "w")

f_calls.write("ordinal\ttimestamp\tturn_id\tcall_id\tkind\tname\tstatus\tinput_bytes\tinput_head\n")
f_outs.write("ordinal\ttimestamp\tcall_id\texit_code\twall_s\torig_tokens\tout_bytes\tchunk_id\n")
f_usage.write("ordinal\ttimestamp\tturn_id\tresponse_id\tinput\tcached\tcache_write\toutput\treasoning\ttotal\tturn_input\tturn_output\tthread_total\n")
f_tokens.write("ordinal\ttimestamp\tturn_id\ttotal_tokens\tinput\tcached\toutput\treasoning\tcontext_window\n")
f_turns.write("ordinal\ttimestamp\ttype\tturn_id\n")
f_comp.write("ordinal\ttimestamp\twindow_number\tthread_total\twindow_id\tprev_window_id\tretained_items\n")
f_items.write("ordinal\ttimestamp\tkind\trole\tauthor\trecipient\tn_bytes\n")

# call_id -> (ordinal, timestamp, kind, name)
calls = {}
exec_re = re.compile(r"^\s*\{.*\}$")

cur_turn = ""
line_no = 0
with open(SRC, "r", encoding="utf-8", errors="replace") as fh:
    for line in fh:
        line_no += 1
        if not line.strip():
            continue
        try:
            rec = json.loads(line)
        except Exception:
            continue
        ordinal = rec.get("ordinal", line_no)
        ts = rec.get("timestamp", "")
        rtype = rec.get("type")
        payload = rec.get("payload") or {}

        if rtype == "event_msg":
            ptype = payload.get("type")
            if ptype == "task_started":
                cur_turn = payload.get("turn_id", "")
                f_turns.write(f"{ordinal}\t{ts}\ttask_started\t{cur_turn}\n")
            elif ptype == "task_complete":
                f_turns.write(f"{ordinal}\t{ts}\ttask_complete\t{payload.get('turn_id','')}\n")
            elif ptype == "turn_aborted":
                f_turns.write(f"{ordinal}\t{ts}\tturn_aborted\t{payload.get('turn_id','')}\n")
            elif ptype == "token_count":
                info = payload.get("info") or {}
                tot = info.get("total_token_usage") or {}
                last = info.get("last_token_usage") or {}
                f_tokens.write("\t".join(esc(x) for x in [
                    ordinal, ts, payload.get("turn_id", cur_turn),
                    tot.get("total_tokens"), tot.get("input_tokens"),
                    tot.get("cached_input_tokens"), tot.get("output_tokens"),
                    tot.get("reasoning_output_tokens"),
                    payload.get("model_context_window"),
                ]) + "\n")
            continue

        if rtype == "token_usage_record":
            u = payload.get("usage") or {}
            tu = payload.get("turn_token_usage") or {}
            th = payload.get("thread_token_usage") or {}
            f_usage.write("\t".join(esc(x) for x in [
                ordinal, ts, payload.get("turn_id", cur_turn), payload.get("response_id"),
                u.get("input_tokens"), u.get("cached_input_tokens"),
                u.get("cache_write_input_tokens"), u.get("output_tokens"),
                u.get("reasoning_output_tokens"), u.get("total_tokens"),
                tu.get("input_tokens"), tu.get("output_tokens"), th.get("total_tokens"),
            ]) + "\n")
            continue

        if rtype == "compacted":
            th = (payload.get("latest_token_usage_record") or {}).get("thread_token_usage") or {}
            f_comp.write("\t".join(esc(x) for x in [
                ordinal, ts, payload.get("window_number"), th.get("total_tokens"),
                payload.get("window_id"), payload.get("previous_window_id"),
                len(payload.get("replacement_history") or []),
            ]) + "\n")
            continue

        if rtype == "response_item":
            ptype = payload.get("type")
            role = payload.get("role", "")
            author = payload.get("author", "")
            recipient = payload.get("recipient", "")

            if ptype in ("function_call", "custom_tool_call"):
                name = payload.get("name", "")
                body = payload.get("arguments") if ptype == "function_call" else payload.get("input")
                body = body or ""
                cid = payload.get("call_id", "")
                calls[cid] = (ordinal, ts, ptype, name)
                f_calls.write("\t".join(esc(x) for x in [
                    ordinal, ts, cur_turn, cid, ptype, name,
                    payload.get("status", ""), len(body), body[:300],
                ]) + "\n")
                f_items.write(f"{ordinal}\t{ts}\t{ptype}\t\t\t\t{len(body)}\n")
                continue

            if ptype in ("function_call_output", "custom_tool_call_output"):
                cid = payload.get("call_id", "")
                out = payload.get("output")
                n = 0
                texts = []
                if isinstance(out, str):
                    texts.append(out)
                elif isinstance(out, list):
                    for c in out:
                        if isinstance(c, dict):
                            texts.append(c.get("text") or "")
                for t in texts:
                    n += len(t)
                    s = t.strip()
                    if not (s.startswith("{") and s.endswith("}")):
                        continue
                    try:
                        o = json.loads(s)
                    except Exception:
                        continue
                    if not isinstance(o, dict) or "exit_code" not in o:
                        continue
                    f_outs.write("\t".join(esc(x) for x in [
                        ordinal, ts, cid, o.get("exit_code"), o.get("wall_time_seconds"),
                        o.get("original_token_count"), len(o.get("output") or ""),
                        o.get("chunk_id"),
                    ]) + "\n")
                f_items.write(f"{ordinal}\t{ts}\t{ptype}\t\t\t\t{n}\n")
                continue

            n = 0
            if ptype == "message":
                n = len(flat_text(payload.get("content")))
            elif ptype == "agent_message":
                n = len(flat_text(payload.get("content")))
            elif ptype == "reasoning":
                n = len(payload.get("encrypted_content") or "")
            f_items.write(f"{ordinal}\t{ts}\t{ptype}\t{role}\t{author}\t{recipient}\t{n}\n")
            continue

for f in (f_calls, f_outs, f_usage, f_tokens, f_turns, f_comp, f_items):
    f.close()

print("wrote indexes to", OUT)
for name in sorted(os.listdir(OUT)):
    p = os.path.join(OUT, name)
    print(f"  {name}: {os.path.getsize(p)} bytes")
