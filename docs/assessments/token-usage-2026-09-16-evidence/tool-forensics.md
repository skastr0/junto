# Tool-call forensics — where the tokens went at the action level

Scope: `exec` tool calls and `exec_command` results only. Token accounting per response, turn
narrative and inter-agent mail belong to sibling agents and are not analysed here.

Source: `/Users/guilhermecastro/.codex/sessions/2026/09/13/rollout-2026-09-13T19-36-10-01a09ce9-ea56-7123-8596-5aa8368e82db.jsonl`
(read-only). Indexes: `/tmp/tt-invest/index/*.tsv`.

---

## Headline numbers

| # | Finding | Number |
|---|---|---|
| 1 | Tool calls in the session | **1,857** — 1,143 `exec` (61.6%), 714 typed function calls |
| 2 | Shell commands executed inside those `exec` calls | **2,329** (2,129 finished with an exit code, 200 returned a "still running" session id) |
| 3 | Bytes of tool arguments sent | **1,297,920** (1.30 MB); `exec` is 997,885 = **76.9%** |
| 4 | Bytes of tool output returned | **10,066,586** (10.07 MB); `exec` is 7,379,052 = **73.3%** |
| 5 | Original tool-output tokens | **1,904,970** |
| 6 | Tool-output tokens the model actually received | **~1,507,000** = **0.54%** of the session's **276,706,947** input tokens |
| 7 | Non-zero exits | **140 / 2,129** = 6.6% (108 × exit 1, 30 × exit 2, 1 × 113, 1 × 130) |
| 8 | Commands that returned nothing at all | **348 / 2,329** = 14.9% (`original_token_count == 0`) |
| 9 | Re-runs: normalized commands executed ≥2× / ≥3× | **101 / 39** groups, costing **64,127** / **40,085** re-run tokens |
| 10 | Total tool wall time | **1,496 s** of script wall + **408 s** of process polling ≈ **32 min**, inside a ~37 h session span |
| 11 | Whole-script truncations (output capped at ~40 KB per `exec` record) | **18** calls, **55** command results, **258,809** declared tokens, **~78k** never delivered |
| 12 | Largest single command result | **50,684** original tokens, of which **4,800** were delivered |
| 13 | Most expensive repeated action (tokens) | `cat package.json` **×4**, wasting **8,244** tokens |
| 14 | Most expensive repeated action (time) | `bash scripts/build-app.sh --target mac --sign` **started 4×, polled 23×, 257 s, every poll returned 0 tokens** |
| 15 | Worst thrash span | ordinals 15783..15969, 12 calls, 341 s, 20,067 tokens |

**The signal:** no tool call was expensive in absolute terms. All 2,329 commands together produced
under 2M original tokens, and the model received ~1.5M of them. The largest single result is 50,684
tokens. Tool traffic is therefore a rounding error against 276.7M input tokens, and no tool-level
loop or failure explains the burn. Whatever drove the total, it is the cost of re-sending
accumulated context, not the cost of running commands. (The last step of that argument is the
token-accounting agent's to close; I supply only the tool-side ceiling.)

---

## Method and reproducibility

Two problems in the supplied index forced a re-derivation:

1. **`outputs.tsv` is incomplete.** `build_index.py` keeps only result objects with a **top-level**
   `exit_code`. The session wraps most results as `{"i":0,"status":"fulfilled","value":{…"exit_code"…}}`
   or `{"cmd":…,"result":{"status":…,"value":{…}}}`, which the filter silently drops.
   Direct count: **1,495** results carry a top-level `exit_code`, **630** carry it nested — so
   `outputs.tsv` (1,493 rows) covers **~70%** of command results.
2. **`calls.tsv` has no command text** beyond 300 bytes and no per-command metrics, so repeats and
   per-command tokens cannot be computed from it.
3. **`outputs.tsv` also drops every truncated record.** The harness caps each `exec` output at
   ~40,150 bytes; in the 18 records that hit the cap the payload is prefixed with
   `Warning: truncated output (…)`, so it no longer starts with `{` and `build_index.py` extracts
   zero results from it even though 0–4 chunk objects are physically present. See §6.

I built a join instead: parse every `tools.X({…})` argument object out of the `exec` JS source, then
align invocations to result objects per call with a small DP that scores
`exec_command↔result-with-exit_code` and `write_stdin↔result-with-session_id` and allows gaps on both
sides. The assigned object's class correlates **perfectly** with the invocation's `yield_time_ms`:
all 117 results that carry a `session_id` instead of an `exit_code` belong to invocations that set
`yield_time_ms`, and none of them belongs to an invocation that did not. (1,783 of the 1,906
`exit_code` results have no `yield_time_ms`; the other 123 set it and still finished inside the yield
window.) The DP output is also identical to naive positional alignment on all 2,292 rows.

**Residual alignment risk, stated plainly.** Neither check proves correctness: both can be wrong in
the same way. 143 of 1,143 `exec` calls have a result-object count that differs from their
invocation count, and 122 calls mix `exec_command` and `write_stdin`. I hand-verified the 25 rows
behind the Q2 table against the raw records (which is how the ordinal-4660 fan-out case surfaced).
Per-command token figures for calls that mix the two tools should be treated as ±one row.

```bash
SRC=/Users/guilhermecastro/.codex/sessions/2026/09/13/rollout-2026-09-13T19-36-10-01a09ce9-ea56-7123-8596-5aa8368e82db.jsonl
python3 /tmp/tt-fw/extract4.py     # -> cmds.tsv, wstdin.tsv, outrec.tsv, calllevel.tsv
```

Outputs (all under `/tmp/tt-fw/`):

| file | one row per | columns |
|---|---|---|
| `cmds.tsv` | `tools.exec_command` call site (2,120) | ordinal, ts, call_id, idx, tool, cmd, exit_code, wall_s, orig_tokens, out_bytes, max_out, yield_ms, cmd_len, class, status, sid, out_head |
| `wstdin.tsv` | `tools.write_stdin` call site (148) | ordinal, ts, call_id, idx, session_id, yield_ms, max_out, chars_len, exit_code, wall_s, orig_tokens, out_bytes |
| `outrec.tsv` | `exec` call (1,143) | ordinal, ts, call_id, n_inv, n_obj, n_head, head_wall_s, head, trunc_notice_tokens, total_orig_tokens |
| `calllevel.tsv` | `exec` call (1,143) | …n_cmd, n_stdin, n_patch, n_other, head_wall_s, tokens, sig, first_cmd |

**Known limit:** 2,120 *syntactic* `tools.exec_command({…})` call sites but **2,329 executed
commands**. 15 sites fan out over an array literal, e.g.
`cmds.map(cmd=>tools.exec_command({cmd,max_output_tokens:1700}))`. Object-level counts
(2,329 / 1,904,970 tokens) are exact; per-command tables use the 2,120-row view and therefore
under-attribute the fan-out calls. One top-25 row (ordinal 4660) has an empty command string for
exactly this reason; I recovered it by hand (row 4 of the Q2 table).

---

## 1. Call inventory

```bash
awk -F'\t' 'NR>1{print $5"\t"$6}' /tmp/tt-invest/index/calls.tsv | sort | uniq -c | sort -rn
awk -F'\t' 'NR>1{s[$5"\t"$6]+=$8} END{for(k in s) printf "%-28s %9d\n",k,s[k]}' /tmp/tt-invest/index/calls.tsv | sort -k2 -rn
```

| kind | name | calls | input bytes | share of bytes |
|---|---|---|---|---|
| `custom_tool_call` | `exec` (JS sandbox running `exec_command`/`write_stdin`/`apply_patch`) | 1,143 | 997,885 | 76.9% |
| `function_call` | `js` (node_repl / CUA app driving) | 454 | 91,207 | 7.0% |
| `function_call` | `send_message` | 119 | 91,886 | 7.1% |
| `function_call` | `followup_task` | 93 | 106,911 | 8.2% |
| `function_call` | `sleep` | 17 | 356 | 0.0% |
| `function_call` | `list_agents` | 12 | 106 | 0.0% |
| `function_call` | `wait_agent` | 9 | 180 | 0.0% |
| `function_call` | `spawn_agent` | 8 | 9,385 | 0.7% |
| `function_call` | `js_reset` | 2 | 4 | 0.0% |
| **total** | | **1,857** | **1,297,920** | |

**Share of tool traffic that is `exec`:**
by call count 1,143/1,857 = **61.6%**; by argument bytes 997,885/1,297,920 = **76.9%**;
by returned bytes 7,379,052/10,066,586 = **73.3%**.

Output bytes per output record (the raw records, not the parsed chunks):

```bash
jq -r 'select(.type=="response_item" and .payload.type=="custom_tool_call_output") | .payload.output | if type=="string" then . else (map(.text//"")|join("")) end | length' "$SRC" | awk '{s+=$1;n++} END{printf "records=%d bytes=%d\n",n,s}'
jq -r 'select(.type=="response_item" and .payload.type=="function_call_output") | .payload.output | if type=="string" then . else (map(.text//"")|join("")) end | length' "$SRC" | awk '{s+=$1;n++} END{printf "records=%d bytes=%d\n",n,s}'
# -> custom_tool_call_output records=1143 bytes=7379052
# -> function_call_output   records=714  bytes=2687534
```

Inside the 1,143 `exec` calls, 1,126 contained at least one `exec_command`; 17 contained none (11 of
those 17 are pure `apply_patch`). Tool mix inside `exec`:

| tool | invocations | note |
|---|---|---|
| `exec_command` | 2,120 call sites → **2,329 executions** | 15 sites fan out over an array literal |
| `write_stdin` | 148 | process polling |
| `apply_patch` | 111 | **called as `tools.apply_patch("*** Begin Patch…")`** — a string argument, not an object literal |
| `clock__curr_time` | 21 | |
| `view_image` | 2 | |
| `web__run` / `md` | 1 each | |

`apply_patch` appears in only **101 of 1,143** `exec` calls (111 invocations, heavily batched —
1.1 patches per editing call). Call-level action mix (a call can carry several):

```bash
awk -F'\t' 'NR>1{n=split($10,a,";"); for(i=1;i<=n;i++) if(a[i]!="") c[a[i]]++} END{for(k in c) printf "%-12s %d\n",k,c[k]}' /tmp/tt-fw/calllevel.tsv | sort -k2 -rn
# inspect 637 | vcs 345 | pane 332 | log 323 | test 153 | edit 151 | poll 129 | start_app 66 | screenshot 22
```

**101 of 1,143 `exec` calls edited anything.** The session was overwhelmingly a *verification and
coordination* workload: 637 calls inspect files, 345 touch git state, 332 read sibling agent panes,
323 read logs.

---

## 2. The expensive outputs

```bash
awk -F'\t' 'NR>1 && ($14=="cmd"||$14=="stdin"){print $9"\t"$1"\t"$3"\t"$7"\t"$8"\t"$11"\t"$10"\t"$6}' /tmp/tt-fw/cmds.tsv \
  | sort -k1,1 -rn | head -25
```

Ranked by `original_token_count` (`orig`), with what the harness actually delivered
(`min(orig, max_out)`), and the number of `exec_command` call sites in the owning `exec` call
(batch size).

| # | orig | delivered | ordinal | exit | max_out | cmds in call | command |
|---|---|---|---|---|---|---|---|
| 1 | 50684 | 4800 | 10758 | 0 | 4800 | 2 | `tower glyph list vellum --orbit forge --json \| python3 -c '…print(json.dumps(…,indent=2))'` |
| 2 | 25993 | 1500 | 4764 | 0 | 1500 | 2 | `rg -n -m 8 'non.interactive\|auto mode\|permission.*denied\|…' /tmp/vellum-command-pty-matrix-20260914/preserved-sessions` |
| 3 | 16992 | 6000 | 7856 | 0 | 6000 | 3 | `git status --short` + `rg --files -g AGENTS.md -g CLAUDE.md -g GROK.md …` + `cat docs/security-doctrine.md` + `cat …/quasar/SKILL.md` (one shell command of a 3-command call; the other two returned 892 and 123 tokens) |
| 4 | 12321 | 12321 | 4660 | 0 | (var) | 1 | `rg -n 'fail\|Task\|status\|success' /tmp/vellum-command-pty-matrix-20260914/harness-status.json …/shared-status.json` — recovered by hand; the call site is `cmds.map(cmd=>tools.exec_command({cmd,max_output_tokens:1700}))` |
| 5 | 11511 | 5000 | 13789 | 0 | 5000 | 2 | `cat /tmp/isolated-devin-mail-hold.json; ps -axo pid,ppid,etime,command \| rg '(Electron.app/Contents/MacOS/Electron\|Junto.app/…)'` |
| 6 | 8401 | 2300 | 4262 | 0 | 2300 | 1 | `wc -c …/prime-finalize/stderr.log` + python heredoc scanning devin CLI logs |
| 7 | 7966 | 7300 | 4396 | 0 | 7300 | 1 | python heredoc reading `harness-status.json` / `shared-status.json` |
| 8 | 7088 | 7000 | 3986 | 0 | 7000 | 1 | `rg --files -g AGENTS.md -g CLAUDE.md …` + `cat docs/managed-terminal-verification.md \| head -140` + `cat docs/managed-terminal-plan.md` |
| 9 | 6861 | 5500 | 9636 | 0 | 5500 | 3 | `sed -n '1,100p' package.json && sed -n '1,160p' docs/assessments/pty-matrix-2026-09-14.md` |
| 10 | 6831 | 6500 | 2072 | 0 | 6500 | 1 | `sed -n '1,120p' AGENTS.md && sed -n '1600,1645p' src/main/vellum-command/ipc.ts && sed -n '1,160p' docs/managed-terminal-verification.md` |
| 11 | 6731 | 6000 | 8508 | 0 | 6000 | 3 | `sed -n '1,160p' /tmp/vellum-command-fresh-mail-20260914/read-receipts.ts && sed -n '1,180p' docs/assessments/pty-matrix-2026-09-14.md` |
| 12 | 6717 | 4800 | 5605 | 0 | 4800 | 1 | `sed -n '555,650p' …/managed-terminal-drive.ts && sed -n '210,285p' …/managed-terminal-drive.ts && sed -n '1,145p' docs/assessments/…` |
| 13 | 6535 | 2800 | 202 | 0 | 2800 | 1 | `rg --files test-results/pty-review-current && rg -n 'Error\|error\|missing\|terminal\|button\|replay\|attached' …` |
| 14 | 6376 | 6200 | 75 | 0 | 6200 | 3 | `sed -n '1,126p' e2e/harness/launch.ts && sed -n '417,580p' e2e/harness/launch.ts && cat tests/pty-e2e/README.md && sed -n '1,155p' …/pty-capture.ts` |
| 15 | 5941 | 5941 | 1245 | 0 | 7000 | 3 | `cat …/state/backup.ts; cat …/canvas-control/protocol.ts; rg -n 'dev-seed\|seed.*prod\|snapshot\|backup\|owner\|fixture' AGENTS.md package.js…` |
| 16 | 5751 | 5751 | 3839 | 0 | 8000 | 1 | `prism workflow runs events 7cdd2144-… --store …/live.sqlite > …/events.json` + python heredoc |
| 17 | 5651 | 5651 | 6908 | 0 | 9000 | 1 | python heredoc over `~/.vellum-command/logs/pty-delivery.jsonl` |
| 18 | 5602 | 5500 | 13428 | 0 | 5500 | 2 | `sed -n '28,45p' package.json` + `rg -n '^ FAIL \|^AssertionError\|^Error:' …/crew-isolated-diagnostic.log` |
| 19 | 5594 | 5594 | 10731 | 0 | 8000 | 4 | `sed -n '1,230p' src/shared/work-model.ts; sed -n '1,210p' src/shared/physics/verbs.ts; sed -n '1,200p' src/shared/message-delivery.ts` |
| 20 | 5579 | 5579 | 8000 | 0 | 7700 | 1 | `cat tests/injection-supervisor.test.ts` + `cat …/term/intervention/policy.ts` |
| 21 | 5465 | 5465 | 7240 | 0 | 5500 | 2 | `sed -n '1,145p' docs/managed-terminal-verification.md && sed -n '1,90p' docs/assessments/pty-matrix-2026-09-14.md` |
| 22 | 5460 | 4500 | 11559 | 0 | 4500 | 2 | `git log -7 --oneline` + `rg --files …/work` + `sed -n '1,72p' …/crew-integration-typecheck.log` |
| 23 | 5440 | 5440 | 4497 | 0 | 5500 | 1 | `rg -n 'coalescer\|flush\|attach\(' …/term/ipc.ts \| head -65` + `sed -n '1370,1518p' …/TerminalSurface.tsx` |
| 24 | 5259 | 3500 | 3735 | 0 | 3500 | 4 | `prism workflow models --worker devin --json` |
| 25 | 5102 | 5102 | 3855 | 0 | 5500 | 1 | python heredoc over `/tmp/vellum-command-pty-matrix-20260914/events.json` |

```bash
awk -F'\t' 'NR>1 && ($14=="cmd"||$14=="stdin"){print $9}' /tmp/tt-fw/cmds.tsv | sort -rn | head -25 | awk '{s+=$1} END{print s}'
# -> 241851
```

**Top-25 sum = 241,851 original tokens = 0.087% of the session's 276,706,947 input tokens.**
That is 12.7% of the 1,904,970 object-level tool-output total (15.1% of the 1,596,592 per-row total);
the remaining ~87% is spread over ~2,300 small reads.

**Single vs batched:** 12 of the 25 came from single-command `exec` calls; 13 came from batched
calls (6 calls with 2 commands, 5 with 3, 2 with 4). Batching did not create the big outputs — the
big outputs are `cat`/`sed`/`rg` over whole files and directories, and 24 of the 25 exited 0.

The workload shape is clear: the top of the table is dominated by bulk file reads
(`sed -n`, `cat`, `rg`) of source and docs, and by python heredocs over temp artifacts. Nothing here
is a runaway process; these are ordinary large reads.

---

## 3. Failures

```bash
# object-level truth (includes results nested under value/result):
jq -r 'select(.type=="response_item" and .payload.type=="custom_tool_call_output") | .payload.output[] | .text' "$SRC" \
 | python3 -c '<deep-unwrap; count exit codes>'
# -> command results: 2329   with exit_code: 2129   still-running (session_id): 200
# -> exit codes: {0: 1989, 1: 108, 2: 30, 113: 1, 130: 1}   non-zero: 140
# -> results with original_token_count == 0: 348
```

**Non-zero exits: 140 / 2,129 = 6.6%.** Grouped by code:

| exit | count | typical meaning |
|---|---|---|
| 0 | 1,989 | ok |
| 1 | 108 | `rg` no-match (20 of them), `sed`/`tail`/`cat` on a missing file, `ps \| rg` no-match, failing `bun run lint:*` |
| 2 | 30 | `rg` usage/IO error — bad path or bad pattern |
| 113 | 1 | `launchctl print gui/501/skastr0.vellumcommand` (service not loaded) |
| 130 | 1 | interrupted (SIGINT) |

By leading command — note this breakdown uses the aligned 2,120-row view, which resolves **116**
non-zero exits (the other 24 are in calls whose results I could not attribute to a single row):

```bash
awk -F'\t' 'NR>1 && $14=="cmd" && $7!="0" && $7!=""{split($6,a," "); split(a[1],b,"/"); print b[length(b)]"\texit="$7}' /tmp/tt-fw/cmds.tsv | sort | uniq -c | sort -rn
# 28 rg exit=1 | 14 rg exit=2 | 13 sed exit=1 | 7 tail exit=1 | 6 ps exit=1
#  6 herdr exit=1 | 6 git exit=1 | 6 bun exit=1 | 5 sed exit=2 | 4 cat exit=1 | …
```

**Which commands failed most often?** None did, in any meaningful sense. Grouping the 140 failures
by normalized command text, only **one** command failed more than once:

| failures | command |
|---|---|
| 2 | `/Users/guilhermecastro/.local/bin/herdr agent prompt w3F:p14 …` |

Every other failure is a distinct one-off. Most are benign: 20 of the 108 exit-1s are `rg` exiting 1
because it found nothing, which is a normal result, not an error. Excluding those, **~120 real
failures across 2,129 commands**, essentially all of the form "this path/pattern does not exist" —
the ordinary cost of exploration.

By turn:

```bash
awk -F'\t' 'NR==FNR{if(FNR>1) turn[$4]=$3; next} FNR>1 && ($14=="cmd") && $7!="0" && $7!=""{c[turn[$3]]++} END{for(k in c) printf "%d\t%s\n",c[k],k}' \
  /tmp/tt-invest/index/calls.tsv /tmp/tt-fw/cmds.tsv | sort -rn
```

| turn (started) | failures | commands run | failure rate |
|---|---|---|---|
| `01a0a430` (09-15 08:30 → 11:43) | 45 | 884 | 5.1% |
| `01a09ddc` (09-14 03:00 → 04:47) | 23 | 391 | 5.9% |
| `01a0a06f` (09-14 15:00 → 16:44) | 13 | 284 | 4.6% |
| `01a09ceb` (09-13 22:38) | 6 | 26 | 23% |
| `01a09d95` (09-14 01:44) | 5 | 29 | 17% |
| `01a09d1b` (09-13 23:29) | 5 | 121 | 4.1% |
| others | ≤4 each | | |

Failure rate is flat at ~5% across the three big turns. The final turn is not a failure spike; it is
simply the longest and busiest (884 of 2,120 commands, 41.7%).

**Exited 0 but useless — `orig_tokens == 0` / `out_bytes == 0`:**

```bash
awk -F'\t' 'NR>1 && ($14=="cmd"||$14=="stdin"){if($10=="0"){k=($7==""?"none":$7); e[k]++}} END{for(k in e) printf "exit=%-6s empty_results=%d\n",k,e[k]}' /tmp/tt-fw/cmds.tsv
# exit=none  99   <- background starts / polls that produced nothing yet
# exit=0     93   <- succeeded and returned nothing: pure waste
# exit=1     23
```

**348 command results (14.9%) returned zero tokens.** 93 of those are exit-0 empty — a command that
cost a round trip and yielded nothing. 99 are "no output yet" from long-running starts and polls.
`orig_tokens == 0` and `out_bytes == 0` coincide exactly (215 of 215 in the aligned per-row view),
so there is no case of output bytes with zero reported tokens.

---

## 4. Repeats and loops

Normalization (`/tmp/tt-fw/repeats.py`): temp-path directories collapse to `<TMPDIR>/` **keeping the
basename** so distinct files stay distinct, plus `<HEX>`, `<UUID>`, `<DATE>`, `<BIGNUM>`, `pid=<N>`,
`session_id<N>`, whitespace collapse.

```bash
python3 /tmp/tt-fw/repeats.py
# rows with parsed cmd: 2105
# distinct normalized cmds: 1854
# normalized cmds repeated >=2: 101      rows in repeats >=2: 352
# normalized cmds repeated >=3:  39      wasted tokens on repeats>=2: 64127   >=3: 40085
```

"Wasted" = tokens of every instance after the first in the group. Ranked by wasted tokens:

| # | times | wasted | total | ordinals | normalized command |
|---|---|---|---|---|---|
| 1 | 4 | 8244 | 10992 | 3135,7082,12378,15280 | `cat package.json` |
| 2 | 3 | 6300 | 9450 | 5020,7867,10605 | `herdr --skill` |
| 3 | 2 | 4109 | 6043 | 6141,10623 | `herdr agent list` |
| 4 | 6 | 3435 | 4122 | 1230,2261,3135,13004,13685,15253 | `cat /Users/guilhermecastro/.codex/skills/atomic-commits/SKILL.md` |
| 5 | 2 | 2980 | 2980 | 7765,7809 | `cat docs/assessments/pty-native-submission-<DATE>.md` |
| 6 | **11** | 2734 | 3054 | 12286,15280,15310,15332,15342,15366,15392,15844,15895,16042,16117 | `herdr agent read w3F:p1H --source visible` |
| 7 | 2 | 2291 | 3796 | 2775,3092 | `cat <TMPDIR>/vc-pty-run02-live-evidence.json` |
| 8 | **44** | 2150 | 2150 | 770,1186,1463,2050,3092,3116,3135,3244,3392,3413,3492,3636,3678,3698,4534,4727,5220,6097,6264,6297,6357,6522,6596,9180,9288,10947,11596,11926,12351,12979,14395,15239,15310,15378,15402,15438,15469,15495,15658,15811,15835,15881,15895,15969 | `git status --short` |
| 9 | 7 | 2055 | 2529 | 10672,12294,14671,14950,14958,14966,14972 | `herdr agent read w3F:p16 --source visible` |
| 10 | 8 | 1969 | 2287 | 12378,12414,12573,12632,12744,12811,13004,13052 | `/Users/…/bin/herdr agent read w3F:p1H --source visible` |
| 11 | 2 | 1481 | 3638 | 10947,11272 | `cat src/shared/managed-prompt.ts` |
| 12 | 3 | 1236 | 1916 | 6326,6408,6476 | `git -C <TMPDIR>/vellum-interrupt-admission diff -- src/main/…/managed-terminal-drive.ts` |
| 13 | 5 | 1156 | 1445 | 6576,6604,6611,6638,6649 | `tail -n 8 <TMPDIR>/vellum-command-build-<HEX>.log` |
| 14 | 2 | 1024 | 1437 | 5068,5133 | `git diff -- src/main/…/managed-terminal-drive.ts` |
| 15 | 2 | 984 | 4685 | 2050,7069 | `git diff --stat && git diff -- src/main/…/managed-terminal-drive.ts` |
| 16 | 7 | 983 | 1166 | 8684,8701,8878,9195,9246,9272,9413 | `herdr agent prompt w3F:p16 …` |
| 17 | 5 | 887 | 1104 | 6228,6280,6484,8453,9336 | `herdr agent read w3F:p15 --source recent-unwrapped --lines 18` |
| 18 | 2 | 882 | 1764 | 5014,6121 | `herdr --help` |
| 19 | 3 | 851 | 1132 | 12811,13770,13855 | `/Users/…/bin/herdr agent read w3F:p16 --source visible` |
| 20 | 2 | 827 | 2191 | 6408,6467 | `git show <HEX> --` |

Exact-string duplicates (no normalization) — the unambiguous subset:

```bash
awk -F'\t' 'NR>1 && $6!=""{c[$6]++; t[$6]+=$9} END{d=0;r=0;s=0; for(k in c) if(c[k]>=3){d++;r+=c[k];s+=t[k]} printf "distinct=%d rows=%d tokens=%d\n",d,r,s}' /tmp/tt-fw/cmds.tsv
# -> distinct=35 rows=211 tokens=50135
```

**Repeat cost is small.** 64,127 re-run tokens is **3.4%** of the 1,904,970 object-level tool-output
total and **0.023%** of session input. The loops are real but cheap:

- `git status --short` × 44 — the agent re-checking working-tree state at almost every step. 2,150
  tokens total.
- `herdr agent read <pane> --source visible` × 26 across the three top groups — polling sibling
  agent panes for new output. Family total 123 invocations / 53,204 tokens.
- `cat package.json` × 4 and `herdr --skill` × 3 — re-reading the same small config/skill files
  because earlier reads had scrolled out of view. This is the single largest wasted-token group
  (8,244), which is the honest measure of "how bad" the repeats got.

Family totals (activity share of the **1,596,592 per-row tool-output token total**; these are mostly
distinct targets, so this is workload shape, not waste):

| family | invocations | tokens | share of tool output |
|---|---|---|---|
| `sed -n …` (file range reads) | 332 | 563,540 | 35.3% |
| `rg …` | 280 | 274,417 | 17.2% |
| `herdr agent prompt …` (mail to siblings) | 183 | 26,868 | 1.7% |
| `tail … .log` | 160 | 66,842 | 4.2% |
| `python3 - <<'PY'` heredocs | 133 | 74,480 | 4.7% |
| `herdr agent read …` | 123 | 53,204 | 3.3% |
| `git status --short` (any suffix) | 90 | 42,382 | 2.7% |
| `git diff …` | 86 | 46,250 | 2.9% |
| `cat <TMPDIR>/…` | 40 | 45,852 | 2.9% |

Two-thirds of all tool output tokens go to `sed -n` and `rg`: reading source and docs.

---

## 5. Time sinks

**Measurement caveat, load-bearing.** `wall_time_seconds` on a per-command result is not the
command's wall time. 1,502 of 2,023 aligned per-command results report **< 0.1 ms** — e.g. ordinal 13
reports 2.3 µs for `pwd && git status --short && rg --files …` while its own script head says
`Wall time 0.5 seconds`. The split is not explained by batching (single-command calls: 72% sub-0.1 ms;
multi-command calls: 75%). I therefore use the **script head** (`Wall time N seconds`) for time and
treat per-command `wall_s` as unusable.

```bash
awk -F'\t' 'NR>1 && $7!=""{s+=$7; n++} END{printf "calls=%d total_head_wall=%.0fs\n",n,s}' /tmp/tt-fw/outrec.tsv
# -> calls=1143 total_head_wall=1496s = 24.9 min
awk -F'\t' 'NR>1{s+=$10} END{printf "%.1f s across %d polls\n",s,NR-1}' /tmp/tt-fw/wstdin.tsv
# -> 408.0 s across 148 polls
```

| script wall time | count |
|---|---|
| < 1 s | 645 |
| 1–5 s | 454 |
| 5–30 s | 37 |
| 30–60 s | 7 |
| ≥ 60 s | 0 |

**Total tool wall time ≈ 32 minutes** (1,496 s script + 408 s polling) inside a ~37 h session span.
No command ran longer than 30 s of *blocking* wall time; longer work was backgrounded.

**What hung — the signed macOS production build.** 117 `exec_command` invocations returned a
`session_id` (process still running, `yield_time_ms` reached); 108 distinct background processes were
then polled, 148 polls total.

```bash
awk -F'\t' 'NR>1{n[$5]++; w[$5]+=$10; t[$5]+=$11} END{for(k in n) printf "sid=%-8s polls=%-4d sum_wall=%8.2fs orig_tokens=%d\n",k,n[k],w[k],t[k]}' /tmp/tt-fw/wstdin.tsv | sort -t= -k3 -rn | head -5
# sid=71881 polls=11 sum_wall=  75.02s orig_tokens=2139
# sid=25573 polls=10 sum_wall= 128.40s orig_tokens=0
# sid=20466 polls= 7 sum_wall= 108.66s orig_tokens=0
# sid=95016 polls= 4 sum_wall=  15.01s orig_tokens=0
# sid=33400 polls= 2 sum_wall=   5.00s orig_tokens=0
```

Which commands started them:

```bash
awk -F'\t' 'NR>1 && ($16==25573||$16==20466||$16==71881){printf "sid=%-7s ord=%-6s %s\n",$16,$1,substr($6,1,130)}' /tmp/tt-fw/cmds.tsv
# sid=25573 ord=3252  env PATH=… VELLUM_COMMAND_FEATURE_PROFILE=ship … bash scripts/build-app.sh --target mac --sign > /tmp/vellum-command-fresh-production-build.log 2>&1
# sid=20466 ord=6557  mise exec bun@1.3.13 -- env … bash scripts/build-app.sh --target mac --sign > /tmp/vellum-command-build-54f79b07.log 2>&1
# sid=71881 ord=93    VELLUM_COMMAND_E2E_SHOW=1 bun run test:e2e:fast e2e/scenarios/mail-wakes-cold-seat.spec.ts … --workers=1
```

Poll timelines:

```bash
awk -F'\t' 'NR>1 && ($5==25573||$5==20466||$5==71881){printf "sid=%-7s ord=%-6s wall=%6.2fs yield=%-6s orig=%s\n",$5,$1,$10,$6,$11}' /tmp/tt-fw/wstdin.tsv | sort -k1,1 -k2,2n
```

| session | command | polls | yields | wall | tokens returned |
|---|---|---|---|---|---|
| 25573 | `bash scripts/build-app.sh --target mac --sign` (ord 3252) | 10 | 1 s ×6, 30 s ×4 | 128.4 s | **0** |
| 20466 | `… build-app.sh --target mac --sign` (ord 6557) | 7 | 1 s ×4, 30 s ×3 | 108.7 s | **0** |
| 33400 | `… build-app.sh --target mac --sign` (ord 5989) | 2 | 1 s ×2 | 5.0 s | **0** |
| 95016 | `… build-app.sh --target mac --sign` (ord 10040) | 4 | 1 s ×4 | 15.0 s | **0** |
| 71881 | `bun run test:e2e:fast …` (ord 93) | 11 | 1 s ×10, 30 s ×1 | 75.0 s | 2,139 |

**This is the one genuine polling loop.** The signed production build was started **4 times** and
polled **23 times** over **257 s**, and **every single poll returned zero tokens** — the build script
redirects its output to a log file, so `write_stdin` had nothing to report. The agent was polling a
silent process. The e2e test session is the same shape but did return output.

Across all sessions: **103 of 148 polls (70%) returned zero tokens**, and **9 of the 117 background
processes were never polled at all**. The `yield_time_ms` pattern is a 1 s quick-check (140 polls)
escalating to a 30 s wait (8 polls) only after repeated quick-checks came back empty: session 25573
ran 1 s ×6, then 30 s ×4; session 20466 ran 1 s ×2, then 30 s ×3, then back to 1 s ×2.

---

## 6. Truncation and budget

```bash
awk -F'\t' 'NR>1{n++; if($11!="")m++} END{printf "rows=%d with_max_out=%d (%.1f%%)\n",n,m,100*m/n}' /tmp/tt-fw/cmds.tsv
# -> rows=2120 with_max_out=2061 (97.2%)
awk -F'\t' 'NR>1 && $11!=""{print $11}' /tmp/tt-fw/cmds.tsv | sort -n | uniq -c | sort -rn | head -8
# 276 x 1000 | 140 x 2000 | 120 x 1500 | 105 x 3000 | 102 x 1800 | 94 x 2500 | 92 x 3500 | 85 x 5000
awk -F'\t' 'NR>1 && $11!=""{print $11}' /tmp/tt-fw/cmds.tsv | sort -n | awk '{a[NR]=$1} END{printf "n=%d min=%d p25=%d median=%d p75=%d p90=%d max=%d\n",NR,a[1],a[int(NR*0.25)],a[int(NR*0.5)],a[int(NR*0.75)],a[int(NR*0.9)],a[NR]}'
# -> n=2061 min=150 p25=1200 median=2000 p75=3500 p90=5500 max=15000
```

**2,061 of 2,120 `exec_command` call sites (97.2%) set `max_output_tokens`.** Median budget 2,000;
p90 5,500; max 15,000; min 150. 59 sites left it unset.

**Did the agent raise its own budget over time? No — it lowered it.** Median `max_out` by
ordinal bucket:

| ordinal bucket | n | median `max_out` |
|---|---|---|
| 0–1,700 | 110 | 2,900 |
| 1,700–3,400 | 146 | 2,000 |
| 3,400–5,100 | 203 | 2,200 |
| 5,100–6,800 | 263 | 2,000 |
| 6,800–8,500 | 192 | 2,400 |
| 8,500–10,200 | 168 | 1,500 |
| 10,200–11,900 | 263 | 2,500 |
| 11,900–13,600 | 300 | 2,250 |
| 13,600–15,300 | 246 | 2,500 |
| 15,300–17,000 | 170 | **1,400** |

The early exploration phase used somewhat larger budgets (median 2,900, max 15,000); the long tail
settled at 1,400–2,500. Budget tracks what the agent was doing (bulk reads early, targeted greps and
log tails late) rather than a learned correction — there is no monotonic increase anywhere.

**Per-command truncation:**

```bash
awk -F'\t' 'NR>1 && $11!="" && $9!=""{if($9+0>$11+0)c++} END{print c+0}' /tmp/tt-fw/cmds.tsv
# -> 24 results exceeded their budget
awk -F'\t' 'NR>1 && $16 ~ /^Warning: truncated output/{n++} END{print n+0}' /tmp/tt-fw/cmds.tsv
# -> 26 results begin with "Warning: truncated output (original token count: N)"
```

Only **24–26 results were cut off**, losing **112,941** tokens (`sum(orig) − sum(min(orig,max_out))`
over the aligned rows). The three worst overshoots:

| orig | max_out | ratio | command |
|---|---|---|---|
| 50,684 | 4,800 | 10.6× | `tower glyph list vellum --orbit forge --json \| python3 -c '…'` |
| 25,993 | 1,500 | 17.3× | `rg -n -m 8 'non.interactive\|auto mode\|permission.*denied\|…' …/preserved-sessions` |
| 16,992 | 6,000 | 2.8× | `git status --short` + `rg --files …` + `cat docs/security-doctrine.md` + `cat …/quasar/SKILL.md` |

**Re-run-after-truncation, confirmed twice:**

- Ordinal 10758 (`tower glyph list …`, 50,684 orig, 4,800 delivered) → the very next call,
  **ordinal 10766**, re-ran the same `tower glyph list vellum --orbit forge --json` with an explicit
  `[:7000]` slice and a narrower field projection, costing 1,381 tokens. This is a correct,
  cheap recovery.
- Ordinal 4764 (python heredoc + `rg` over `preserved-sessions`, 25,993 orig, 1,500 delivered) →
  ordinal 4781 followed with narrower targeted reads: `sed -n '35,100p' …/workflow-devin-worker.ts`
  plus a scoped `rg -n 'permissionMode|permission|devin:|swe-2|concurrency' …/….workflow…`. (Ordinal
  4772 in between is one of the 15 call sites whose command string I could not recover.)

**Whole-script truncation is the more damaging mode, and `outputs.tsv` cannot see it.** The harness
caps every `exec` output record at **~40,150 bytes**:

```bash
python3 - <<'PY'
import json
SRC=("...rollout-...jsonl")
outs={}
for line in open(SRC, errors="replace"):
    if '"response_item"' not in line: continue
    r=json.loads(line)
    p=r.get("payload") or {}
    if p.get("type")=="custom_tool_call_output":
        outs[p.get("call_id")]=sum(len(t.get("text") or "") for t in (p.get("output") or []))
b=sorted(outs.values())
print("records:",len(b),"max:",b[-1],"p99:",b[int(len(b)*.99)],"median:",b[len(b)//2])
PY
# -> records: 1143  max: 40150  p99: 40024  median: 3362
```

Exactly **18 records sit at that ceiling** (39,905–40,150 bytes; nothing exceeds 40,150). In each, the
harness prepends `Warning: truncated output (original token count: N)` and drops the script's
**trailing** results. Because the blob no longer starts with `{`, `build_index.py` parses **zero**
results out of it — my `outrec.tsv` shows `n_obj = 0` for all 18 — even though 0–4 chunk objects are
physically present.

> **Correction (round 2, pane w3F:p1Q).** An earlier version of this section said the harness "cuts
> the script's JSON mid-string". That is wrong. Re-measured in `waste-ledger.md` §8: all 18 blobs end
> cleanly at a chunk boundary (`"}}`) and contain **49 complete chunk objects** in total; the cap
> drops trailing results (≥12 results lost) rather than corrupting JSON. The 40,150-byte cap, the 18
> records, the 258,809 declared tokens and the 55 commands involved are unchanged.

```bash
awk -F'\t' 'NR>1 && $9!=""{printf "ord=%-6s notice_tokens=%-7s n_inv=%-3s n_obj=%-3s\n",$1,$9,$4,$5}' /tmp/tt-fw/outrec.tsv
# ord=25     notice=28725 n_inv=3 n_obj=0 | ord=45     notice=12611 n_inv=3 n_obj=0
# ord=1368   notice=18088 n_inv=3 n_obj=0 | ord=3698   notice=10203 n_inv=4 n_obj=0
# ord=3708   notice=10254 n_inv=4 n_obj=0 | ord=4554   notice=11364 n_inv=1 n_obj=0
# ord=4930   notice=23734 n_inv=1 n_obj=0 | ord=4942   notice=12564 n_inv=1 n_obj=0
# ord=6201   notice=11039 n_inv=4 n_obj=0 | ord=7765   notice=11573 n_inv=3 n_obj=0
# ord=10709  notice=23287 n_inv=4 n_obj=0 | ord=10719  notice=11375 n_inv=4 n_obj=0
# ord=10788  notice=11136 n_inv=3 n_obj=0 | ord=10999  notice=14181 n_inv=4 n_obj=0
# ord=13094  notice=10087 n_inv=4 n_obj=0 | ord=13692  notice=13059 n_inv=2 n_obj=0
# ord=14403  notice=11290 n_inv=4 n_obj=0 | ord=14491  notice=14239 n_inv=3 n_obj=0
```

**18 records, 55 command results, 258,809 declared tokens, of which ~40 KB per record survived.** The
commands ran (the head still reports `Wall time N seconds`) but the model got a notice plus the
leading results only, and **no exit code** — it could not tell success from failure. Ordinal 25 is the
canonical case: three commands including `cat AGENTS.md docs/security-doctrine.md` (24,355 tokens on
its own) vanished behind a 28,725-token notice, and the delivered payload was 40,024 bytes carrying 2
of the 3 results. The agent re-ran the reads.

Converting the delivered bytes at ~4 bytes/token, the 720,721 delivered bytes carry roughly 180k
tokens against 258,809 declared — so **~78k tokens of declared result content (≈30%) never reached the
model**. (The bytes→tokens conversion is an estimate; the 40,150-byte cap and the 258,809 declared
tokens are measured.)

---

## 7. Evidence of thrash

Definition used: **≥8 consecutive `exec` calls with no edit and no `git commit/add/cherry-pick`, in
which ≥3 calls re-run a command that also appears inside the same span** (normalized-identical).
`/tmp/tt-fw/thrash2.py`.

```bash
python3 /tmp/tt-fw/thrash2.py
# tight thrash spans: 7
```

| rank | tokens | calls | ordinals | elapsed | top repeats inside the span |
|---|---|---|---|---|---|
| 1 | 20,067 | 12 | 15783..15969 | 341 s (11:32:53 → 11:38:34) | `git status --short` ×5, `herdr agent read w3F:p1H --source visible` ×2 |
| 2 | 11,358 | 8 | 15310..15392 | 93 s (11:23:14 → 11:24:47) | `herdr agent read w3F:p1H --source visible` ×5, `git status --short` ×2 |
| 3 | 10,995 | 11 | 3369..3537 | 3,123 s (00:53:00 → 01:45:03) | `git status --short` ×3, `ps -axww … \| rg 'Junto.app/…'` ×2 |
| 4 | 7,685 | 14 | 14869..15034 | 296 s (11:06:34 → 11:11:30) | `herdr agent send-keys w3F:p16 ctrl+c` ×4, `herdr agent read w3F:p16 --source visible` ×4 |
| 5 | 6,756 | 8 | 15540..15612 | 85 s (11:27:15 → 11:28:40) | `tail -n 20/30 …crew-qa-…-unit.log` ×4, `git log -3 --oneline` ×2 |
| 6 | 5,679 | 9 | 6297..6408 | 158 s (03:57:11 → 03:59:49) | `git status --short` ×2, `herdr agent read w3F:p16 …` ×2, `git -C … diff …` ×2 |
| 7 | 3,253 | 11 | 6576..6665 | 300 s (04:04:28 → 04:09:28) | `tail -n 8 …/vellum-command-build-<HEX>.log` ×5 |

**Worst two spans, call by call:**

*Span 1 — ordinals 15783..15969, 12 calls, 341 s, 20,067 original tokens.*

| ordinal | time | tokens | cmd sites | classes | command |
|---|---|---|---|---|---|
| 15783 | 11:32:53 | 1,287 | 3 | log,inspect | python heredoc reading a temp json + log |
| 15811 | 11:33:40 | 644 | 3 | log,vcs | python heredoc reading a temp json |
| 15823 | 11:34:08 | 854 | 2 | log,pane | `herdr agent prompt w3F:p1H 'New bounded QA triage authorized…'` |
| 15835 | 11:34:20 | 1,846 | 3 | log,vcs | `tail -n 75 …/vellum-command-crew-e2e-<HEX>.log` |
| 15844 | 11:34:31 | 789 | 3 | pane,vcs,inspect | `herdr agent read w3F:p1H --source visible` |
| 15865 | 11:35:10 | 4,084 | 3 | inspect | `rg -n 'awaitTurnStart\|deliveryAwaitTurnStart\|FIRED\|…' src…` |
| 15881 | 11:35:44 | 1,218 | 3 | vcs,inspect | `rg -n -A 55 'assertExactCommittedCheckout' scripts/package-runtime-provenance.ts` |
| 15895 | 11:36:19 | 335 | 3 | pane,vcs,inspect | `herdr agent read w3F:p1H --source visible` |
| 15906 | 11:36:30 | 3,112 | 3 | inspect | `sed -n '1240,1425p' src/main/…/managed-terminal-drive.ts` |
| 15915 | 11:36:50 | 995 | 2 | start_app,inspect | `prism tools invoke quasar search --input '{…"FIRE…"}'` |
| 15923 | 11:36:59 | 4,599 | 3 | start_app,inspect,poll | `sed -n '355,400p' tests/pty-e2e/scenarios/drive-law.test.ts` |
| 15969 | 11:38:34 | 304 | 3 | pane,vcs | `herdr agent prompt w3F:p1H 'Root confirmed mail unresolved failure is PRODUCT…'` |

*Span 2 — ordinals 15310..15392, 8 calls, 93 s, 11,358 original tokens.*

| ordinal | time | tokens | cmd sites | classes | command |
|---|---|---|---|---|---|
| 15310 | 11:23:14 | 1,091 | 5 | start_app,pane,vcs,inspect | `git status --short` (+4 more) |
| 15320 | 11:23:22 | 1,725 | 4 | log,pane,vcs,test,inspect | `herdr agent send-keys w3F:p1H enter` |
| 15332 | 11:23:32 | 1,980 | 4 | log,pane,vcs,test | `tail -n 20 …/vellum-command-crew-typecheck-freeze.log` |
| 15342 | 11:23:41 | 263 | 3 | pane | `herdr agent send-keys w3F:p1H ctrl+c` |
| 15351 | 11:23:55 | 151 | 4 | start_app,log,pane,test | `herdr agent prompt w3F:p1H 'Current root instruction, supersedes queued audits…'` |
| 15366 | 11:24:20 | 3,311 | 4 | log,pane,inspect | `tail -n 20 …/vellum-command-crew-qa-<HEX>-build.log` |
| 15378 | 11:24:28 | 1,806 | 3 | vcs,inspect | `rg -n -A 35 -B 10 'FAIL\|AssertionError\|Error:' …/crew-qa-…-build.log` |
| 15392 | 11:24:47 | 1,031 | 4 | pane,vcs,inspect | `sed -n '66,124p' tests/actor-ledger.test.ts` |

Both spans are the same shape: **poll a sibling pane → tail a build/test log → grep the log →
re-poll**, with `git status --short` mixed in. The repeated element is the *pane read* and the *log
tail*, and the span ends when the log finally contains the answer. In span 2 the log tail is what
broke the loop: ordinals 15332/15366/15378 read three different log files from the same QA run.

**Scale check.** The two worst spans total **31,425 original tokens** — 1.6% of all tool output and
0.011% of session input. Thrash exists and is visible in the shape of the calls, but it is not where
the tokens went. Span 3 is the exception to "thrash is cheap": it spans **52 minutes of elapsed
time** for 11 calls, because it contains the `build-app.sh` polling wait described in §5.

**A note on a wider definition.** Widening the window to "no edit, one verify class repeated" gives
47 overlapping spans, the largest being ordinals 10510..10788 (24 calls, 107,764 tokens, but 15.9 h
of elapsed time — it straddles an overnight idle gap). That definition is too loose to be evidence:
it fires on any run of read-only calls, which is most of this session. The tight definition above is
the one that means "re-ran the same verification without new information".

> Correction recorded for the record: an earlier pass in this investigation used a broken edit
> detector (`apply_patch` is called with a string argument, so an object-literal scanner never saw
> it). That pass produced a spurious "271 consecutive calls with zero edits" span. With
> `apply_patch` counted correctly the same definition yields 47 spans of at most 24 calls, and the
> 271-call claim is withdrawn.

---

## What I could not determine

1. **Per-command wall time.** `wall_time_seconds` is broken for ~74% of results (sub-0.1 ms for
   commands that demonstrably took hundreds of ms). I used the script head instead, so per-command
   time rankings are unavailable — only per-`exec`-call.
2. **Agent attribution.** Tool calls carry no agent identity (`custom_tool_call.payload` has
   `call_id`, `id`, `input`, `name`, `status`, `internal_chat_message_metadata_passthrough` — and the
   last is only `{turn_id, create_time}`). The session spawned 8 sub-agents and exchanged 480
   agent messages, so some of the 2,120 commands were issued by sub-agents. **The per-agent split of
   this tool traffic is not recoverable from this log.** The "zero edits by the root agent" finding in
   §7 is therefore an observation about the *session*, not provably about the root agent.
3. **209 unaccounted commands.** 2,329 executions vs 2,120 syntactic call sites. I traced this to 15
   fan-out call sites (`cmds.map(cmd=>tools.exec_command(...))`), but I did not expand them, so 209
   commands have exact token totals (object-level) but no per-command row.
4. **Whether the 258,809 dropped tokens were ever recovered.** I found two clean
   re-run-after-truncation cases (§6) but did not trace all 18 records to a later compensating read.
5. **Cost of tool output to the session total.** I can state the single-pass figure (1.5M delivered
   tokens = 0.54% of 276.7M input). Converting that into amortized context cost requires per-response
   accounting, which is out of my scope by assignment.
