# Method and reproduction

Three Amp agents coordinated through Herdr tab w3F:tC, each owning a disjoint slice:

| pane | agent | slice |
|---|---|---|
| w3F:p1P | coordinator | token accounting, floor decomposition, synthesis |
| w3F:p1Q | token-forensics | 1,857 tool calls, 2,329 shell commands, repeats, failures, truncation |
| w3F:p1R | session-narrative | 32 operator turns, 20 compactions, 8 sub-agents, 15-lane audit |

Shared index built by `build_index.py` (regenerable; TSVs not committed):
`calls.tsv`, `outputs.tsv`, `usage.tsv`, `tokens.tsv`, `turns.tsv`, `compactions.tsv`, `items.tsv`.

Source rollouts: `~/.codex/sessions/2026/09/{13,14,15}/rollout-*.jsonl` (read-only).
The root is `rollout-2026-09-13T19-36-10-01a09ce9-ea56-7123-8596-5aa8368e82db.jsonl`.

## Round-1 shared context (schema, raw record shapes, established facts)

# Shared context: Codex session token investigation

Three Amp agents in Herdr tab `w3F:tC` are investigating one Codex session.

- `w3F:p1P` (coordinator, "Token usage investigation") — token accounting + synthesis
- `w3F:p1Q` ("token-forensics") — tool-call forensics
- `w3F:p1R` ("session-narrative") — narrative, loops, inter-agent traffic

Operator question: **how and why did this session burn so many tokens; what actions did it get
stuck on; what did it have trouble with.**

## Source of truth (read-only, 265 MB, 16146 lines)

```
/Users/guilhermecastro/.codex/sessions/2026/09/13/rollout-2026-09-13T19-36-10-01a09ce9-ea56-7123-8596-5aa8368e82db.jsonl
```

Never `cat` it. `jq` over the whole file takes ~2 s, so whole-file passes are cheap.

## Normalized index (built by the coordinator, regenerable via /tmp/tt-invest/build_index.py)

`/tmp/tt-invest/index/` — small TSVs, tab-separated, no bodies (truncated heads only):

- `calls.tsv` — one row per tool call (1857 rows)
  `ordinal, timestamp, turn_id, call_id, kind, name, status, input_bytes, input_head`
  `kind` is `custom_tool_call` (the `exec` tool, JS sandbox) or `function_call`.
- `outputs.tsv` — one row per `exec_command` result parsed out of call outputs (1493 rows)
  `ordinal, timestamp, call_id, exit_code, wall_s, orig_tokens, out_bytes, chunk_id`
  `orig_tokens` is the model-reported `original_token_count` for that command's output.
- `usage.tsv` — one row per `token_usage_record` (1900 rows)
  `ordinal, timestamp, turn_id, response_id, input, cached, cache_write, output, reasoning,
  total, turn_input, turn_output, thread_total`
- `tokens.tsv` — one row per `event_msg/token_count` (2114 rows), cumulative thread totals
- `turns.tsv` — `task_started` / `task_complete` / `turn_aborted` (53 rows)
- `compactions.tsv` — one row per `compacted` record (21 rows)
- `items.tsv` — one row per `response_item`: `kind, role, author, recipient, n_bytes` (6270 rows)

## Raw record shapes

- `response_item` / `custom_tool_call`: `payload.name` (`exec`), `payload.input` (JS source),
  `payload.call_id`, `payload.status`.
- `response_item` / `custom_tool_call_output`: `payload.output` is a list of
  `{type:"input_text", text}`. After a `"Script completed\nWall time N seconds\nOutput:\n"` head,
  each `text` is a JSON object `{chunk_id, wall_time_seconds, exit_code, original_token_count,
  output}` for one `tools.exec_command` call. One `exec` call can batch many commands.
- `response_item` / `function_call`: `payload.name`, `payload.arguments` (JSON string).
- `response_item` / `reasoning`: only `encrypted_content` plus an optional `summary` — the model's
  reasoning text is **not** stored in cleartext, but `reasoning_output_tokens` is reported in usage.
- `inter_agent_communication_metadata` + `response_item`/`agent_message`: sub-agent mail. 480 each.
- `compacted`: `payload.window_number`, `payload.replacement_history`, and a nested
  `latest_token_usage_record` with the running `thread_token_usage`.

## Established facts (coordinator-verified)

- Model `gpt-6-astra`, `reasoning_effort: ultra`, `model_context_window: 258400`.
- Session wall span: 2026-09-13T22:38:13Z → 2026-09-15T11:43:22Z (~37 h with idle gaps).
- 26 `task_started`, 24 `task_complete`, 2 `turn_aborted`, 20 compactions.
- Running thread total at the 20th compaction: **267,112,572 tokens**.
- Thread totals are dominated by input: e.g. at compaction 2,
  `thread_token_usage = {input: 32,171,989, cached: 31,483,904, output: 39,347,
  reasoning: 11,633, total: 32,211,336}` — i.e. 99.88% input, 97.8% of input served from cache.
- `base_instructions` in `session_meta` is a large Codex system prompt; `message`/`developer`
  items carry AGENTS.md injections.
- The session itself used Codex multi-agent (`spawn_agent`, agent messages, `inter_agent_*`).

## Ground rules

- Separate **observation** from **inference**. Every load-bearing number needs a receipt: the
  command you ran and the output you saw. Quote the command.
- Do not restate the whole session. Report the signal.
- Write your findings to your assigned file under `/tmp/tt-invest/findings/`, and keep your
  terminal reply to a short summary with your top claims and the evidence behind them.

## Round-2 shared context (fleet ledger)

# Shared context #2: the session was one node of a fleet

Follow-up round. The operator's question: **is this burn "about right" for a task of this nature, or is
there obvious unoptimised usage?** They spent ~40% of a weekly limit on this effort and were told the
root agent had eight other sub-agents working.

## The finding that reframes everything

The 281M figure from round 1 was the **root agent only**. The root session spawned sub-agents that each
have their own rollout, and those are not counted in the root's ledger.

Parentage is explicit in each sub-agent rollout's first record:

```
session_meta.source.subagent.thread_spawn.parent_thread_id = "01a09ce9-ea56-7123-8596-5aa8368e82db"
session_meta.agent_path  = "/root/coverage_review"
session_meta.agent_nickname = "Dirac"
session_meta.thread_source  = "subagent"
session_meta.forked_from_id / subagent_history_start_ordinal  -> sub-agents fork the parent history
```

## The fleet ledger (verified: every descendant's parent_thread_id chains to the root)

| agent_path | depth | responses | first ctx | input tokens |
|---|---|---|---|---|
| `/root` (the session itself) | 0 | 1,929 | 31,480 | 284,839,426 |
| `/root/coverage_review` | 1 | 737 | 31,600 | 100,908,894 |
| `/root/production_build_review` | 1 | 506 | 36,546 | 67,341,737 |
| `/root/pty_delivery_assessment` | 1 | 429 | 39,853 | 60,124,323 |
| `/root/live_trace_options` | 1 | 379 | 31,937 | 51,881,042 |
| `/root/mail_receipt_fix` | 1 | 115 | 33,979 | 14,219,593 |
| `/root/factory_message_sources` | 1 | 90 | 39,853 | 10,688,522 |
| `/root/matrix_inventory` | 1 | 77 | 43,192 | 9,022,385 |
| `/root/native_cli_path` | 1 | 28 | 81,078 | 2,964,896 |
| `/root/coverage_review/claim_test_gaps` | 2 | 181 | 35,955 | 25,868,848 |
| `/root/live_trace_options/trace_tests` | 2 | 158 | 38,783 | 20,846,137 |
| `/root/production_build_review/amp_replay_review` | 2 | 186 | 35,961 | 24,592,485 |
| `/root/pty_delivery_assessment/fixture_receipt_review` | 2 | 126 | 45,721 | 16,706,235 |
| `/root/factory_message_sources/claim_identity` | 2 | 24 | 41,610 | 1,647,671 |
| `/root/production_build_review/amp_replay_review/…` | 3 | 60 | 32,166 | 7,868,764 |
| `/root/live_trace_options/trace_tests/credentials` | 3 | 31 | 44,493 | 2,743,145 |
| **root** | | | | **284,839,426** |
| **15 descendants** | | | | **417,424,677** |
| **effort total** | | | | **~704,137,000** |

Root is **40.5%** of the effort; the descendants are **59.5%**.

**The inherited-context tax:** each sub-agent forks the parent's context at spawn (32K–81K tokens) and
re-reads it on *every* response. `first_ctx × responses` per lane sums to **~113,500,000 tokens —
16.1% of the whole effort** — spent purely on sub-agents re-reading the history they inherited.

## Rollout locations

`~/.codex/sessions/2026/09/13/`, `09/14/`, `09/15/` — `rollout-*.jsonl`. The root is
`rollout-2026-09-13T19-36-10-01a09ce9-ea56-7123-8596-5aa8368e82db.jsonl` (274 MB). Filename times are
local (UTC−3); content timestamps are UTC.

Indexes for the root from round 1: `/tmp/tt-invest/index/*.tsv`, schema in
`/tmp/tt-invest/SESSION.md`. Round-1 findings: `/tmp/tt-invest/findings/` and
`/tmp/tt-invest/SYNTHESIS.md`. Read those before starting; do not re-derive them.

## Ground rules (unchanged)

- Separate observation from inference. Every load-bearing number needs the command and the output.
- Write to your assigned file under `/tmp/tt-invest/findings/`. Do not touch a sibling's file.
- Keep your terminal reply under 30 lines: top claims with numbers, and what you could not determine.
