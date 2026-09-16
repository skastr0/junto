# Token usage assessment — Codex session `01a09ce9` and its sub-agent fleet

Date: 2026-09-16
Subject: `codex resume 01a09ce9-ea56-7123-8596-5aa8368e82db` (Junto PTY injection → crew brief)
Method: three-agent Herdr investigation (`w3F:tC`), raw-rollout forensics. Evidence in
`docs/assessments/token-usage-2026-09-16-evidence/`.

## Headline

**The effort cost 704,631,267 tokens, not the 281M the root session reports.** The root rollout
(285.9M) is only **40.6%**; it spawned **15 descendant rollouts at depth 1–3** carrying another
**418.8M**. That is **41.9% of all 1,683,579,069 Codex tokens in September 2026** — matching the
operator's independent observation of spending ~40% of a weekly limit on this work.

Parentage is explicit in every descendant's first record:

```
session_meta.source.subagent.thread_spawn.parent_thread_id = "01a09ce9-ea56-7123-8596-5aa8368e82db"
session_meta.agent_path     = "/root/coverage_review"
session_meta.agent_nickname = "Dirac"
session_meta.forked_from_id / subagent_history_start_ordinal   -> sub-agents FORK the parent history
```

| | responses | input tokens | share |
|---|---|---|---|
| `/root` | 1,936 | 286,044,802 | 40.6% |
| 15 descendants | — | 418,750,773 | 59.4% |
| **effort total** | | **704,631,267** | |

> The root session is **live**. It grew from 265 MB to 274.8 MB during this investigation, a new turn
> started 2026-09-16T04:07:29Z, and a frozen snapshot taken mid-analysis read 1,936 responses /
> 286,044,802 input. Any total quoted here is already stale.

## The mechanism

Burn is `responses × context`, and the fit is near-exact: **Pearson r = 0.9985** between tool calls per
turn and input tokens per turn, with 1.01 model responses per tool call.

```
1,857 tool calls x 151,177 average input tokens per call = 280.7M input tokens
```

97.23% of input was served from cache, so the raw count overstates the bill — but 7,766,987 tokens of
genuinely new content were re-read **36× on average**. Burn rate was flat at **28.5M input tokens per
active hour** across 9.84 h of active turns (37.09 h wall, 27.25 h idle). Four turns are 79.5% of it;
turn 26 alone is 31.9%.

The same law holds across the fleet: per-response input is 68,653–142,921 tokens (mean 133,490) against
the root's 147,662, so a lane's cost is `responses × context`. **Lanes are not more wasteful per
response; they simply pay a fixed fork tax many times.**

## Three defects, measured

### 1. Sub-agents fork the parent transcript — 113,465,903 tokens (16.1% of the effort)

Each lane forks the parent's history and re-reads it on **every** response: 27.2% of all descendant
spend. The natural experiment is already in the data:

| lane | fork setting | inherited ctx | responses | outcome |
|---|---|---|---|---|
| `mail_receipt_fix` | **`fork_turns: none`** | 33,979 | 115 | 2 commits, **5 messages, all FINAL_ANSWER, zero chatter** — cleanest lane in the fleet |
| `native_cli_path` | forked at ordinal 96 | **81,078** | 28 | 1 commit, **76.6% of its cost was pure fork tax** |

### 2. Compaction retains every user message — 40,721,127 tokens (14.2% of the root)

115 of 117 user messages survive compaction verbatim, so the post-compaction floor grew **31,480 →
80,823 tokens (2.29×)**, tracking retained-text volume at **r = 0.971**. Attribution of the excess:

| retained content | amortized cost | share of root |
|---|---|---|
| peer reports (Herdr lane traffic) | 16,816,898 | 5.88% |
| 4 operator screenshots (3.64 MB base64) | 15,944,329 | 5.57% |
| operator's own text | 3,656,532 | 1.28% |
| modelling constant | 4,303,368 | 1.50% |

The screenshots were still being re-sent 20 compactions after they were posted.

### 3. Compaction fires at 215–244K against a 258,400 window

Average context 147,756. The relationship is linear:

| average context | input tokens |
|---|---|
| 147,756 (actual) | 280,736,459 |
| 110,817 | 210,552,344 |
| 73,878 | 140,368,229 |

## Ranked waste ledger (root, 286,044,802 input)

| # | cause | tokens | share |
|---|---|---|---|
| 1 | Floor growth from compaction retention | 40,721,127 | 14.24% |
| 2 | ⚠ Peer-report channel, full retention-aware cost | 18,162,580 | 6.35% |
| 3 | Failed Prism/Devin fan-out (ord 3849..4548, 34 m) | 12,211,212 | 4.27% |
| 4 | Build/sign wait (ord 6031..7401, 47 m) — **almost none avoidable** | 22,077,345 | 7.72% |
| 5 | `agent_message` amortized (480 items) | 5,477,803 | 1.92% |
| 6 | `exec` calls that returned nothing (51) | 3,331,905 | 1.17% |
| 7 | Re-run waste, amortized | 3,817,310 | 1.33% |
| 8 | Output truncation (18 capped records) | ≤ ~500,000 | ≤0.17% |

**Avoidable: 47,870,342 (16.7%), or ~54M (18.9%) including the failed fan-out. Inherent: ~232M (81%).**
Rows 1 and 2 overlap; do not sum them.

## The allocation was fine; the shape was expensive

The lane audit found **15 of 15 lanes earned their tokens — 0 marginal, 0 wasted**: 45
first-person-attributed commits resolving to real commits, 6 further test files, and 3 findings-only
lanes whose findings are demonstrably in the current code. Cross-lane duplication was negligible — of
148 distinct `file:line` references across 178 FINAL_ANSWERs, 5 were cited by two lanes and none by
three.

- **Best value:** `/root/factory_message_sources/claim_identity_review` — 1,647,671 tokens, 24
  responses, 12 minutes, 3 findings all incorporated into `4cf844a5` → **0.55M tokens per verified
  outcome**. Cheap because it was short: the fork tax was paid 24 times, not 737.
- **Worst value:** `/root/production_build_review/amp_replay_review` — 24,592,485 tokens, 186
  responses, 19.8 h, 1 landed test file → **24.59M per landed artifact**.
- **Largest line item:** `/root/coverage_review` — 100,908,894 tokens (14.3% of the effort), of which
  **60.9% was spent in the crew phase carrying PTY-era context from 37 hours earlier**.

Cutting lanes would have cut real deliverables. Cutting the **fork** is what the 113.5M would have
bought.

## What actually got stuck

| episode | ordinals | wall | repeated verb |
|---|---|---|---|
| package build / sign / install | 6031→7401 | **47 m 09 s** | poll build log + `codesign`, rebuild, sign again |
| 14-harness Devin fan-out | 3849→4548 | **34 m 50 s** | dispatch lane → poll `prism workflow runs show` → recover report |
| stale-frame visual verification | 1621→2241 | **19 m 46 s** | restart app, re-capture screenshot (screen ≠ accessibility tree) |
| compaction pauses (×20) | — | **48 m 48 s total** | produce summary, no tool call recorded |

All 20 intra-turn silences >120 s in the entire 37-hour session are compaction pauses. Nothing else
ever went quiet. Tool-level failures were trivial: 140 of 2,129 non-zero exits (6.6%), 20 of them `rg`
finding nothing.

## Recommendations

Ranked by measured impact. Details and counter-arguments in `RECOMMENDATIONS.md` (evidence directory).

1. **Spawn sub-agents without forking the transcript** — point them at artifacts (paths, hashes,
   contracts) instead. Worth most of 113.5M. `fork_turns: none` already exists and was used once.
2. **Summarise user messages in compaction instead of retaining them**, keep only the last N turns
   verbatim, and drop image attachments older than one window. Worth most of 40.7M.
3. **Trigger compaction near 120K instead of 220K.** Largest single lever on the root; linear. Accept
   the added information loss knowingly.
4. **Trim the 65,047-char world state** (`agents_md` is 39,918 of it) and inject only the delta after
   the first window.
5. **Batch tool calls.** 1,857 calls served 111 `apply_patch` edits — a 19:1 read-to-write ratio.
   Halving the call count halves the root's burn.
6. **Re-fork lanes that outlive their context**; do not park lanes for 20–36 h (`credential_scan` was
   alive 19.6 h for 31 responses).
7. **Envelope peer reports.** They arrive as anonymous `role: user` turns — a correctness hazard *and*
   5–6% of root input. The crew brief already names this fix.
8. **Give every lane a token budget and an explicit success predicate.** The fan-out reported
   `completed` with every task failed because each task was wrapped in `Effect.either` with no
   requirement that any succeed.

**Do not** switch models or lower reasoning effort: output is **0.24%** of tokens (683,799 of
281,420,258) and reasoning is 202,318. The burn is input re-reads, not generation.

**Expected result (estimate, not measured):** removing the fork tax and the retention defect is ~154M
of 704M (22%) with no loss of deliverable. Adding the ceiling lever plausibly lands the same work near
350–400M.

## Verification and limits

- Root totals match the session's own ledger exactly (sum of per-response totals = final
  `thread_total`). A second independent counter (`event_msg/token_count`) reports 1.7% lower.
- Fleet parentage was verified from each rollout's `session_meta`, not inferred from filenames.
- **A correction:** an earlier pass of this investigation reported the peer channel at 0.4% of root
  input by amortizing each report only to the end of its own window. That model was wrong — compaction
  retains user messages across windows. Two independent methods now give 14.2M and 16.8M (5.1–6.4%).
- **Not recoverable from these logs:** the payloads of 384 inter-agent messages and all reasoning items
  (encrypted only); the per-agent split of the 2,129 shell commands; per-command wall time
  (`wall_time_seconds` is broken for ~74% of results); the token cost of the 4 retained screenshots
  (charged as image tokens, not recorded).
- One index defect found and corrected by a peer agent: the shared extractor kept only top-level
  `exit_code`, missing 630 nested results. Command-level numbers in the evidence use the corrected join.
