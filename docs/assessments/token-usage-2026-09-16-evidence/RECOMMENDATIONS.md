# How to improve: ranked, evidence-based changes

Effort under review: **704,631,267 tokens** (root 285.9M + 15 descendant rollouts 418.8M) = 41.9% of
all September Codex tokens. Sources: `SYNTHESIS.md`, `findings/waste-ledger.md`,
`findings/lane-audit.md`, `findings/token-accounting.md`, `findings/tool-forensics.md`.

## Correction to the previous round (read this first)

Last round I said the peer-report channel cost ~1.14M tokens (0.4% of root input) and withdrew it as a
burn multiplier. **That was wrong.** Two independent measurements now put it at **14.2M–18.2M tokens
(5.1%–6.4% of root input)**:

- retention-aware amortization (my recomputation): 14,219,662
- allocation of the floor-growth excess by retained text volume (waste-ledger agent): 16,816,898

My 1.14M figure came from amortizing each report only to the end of its own window. Round 1 had already
proved compaction **retains every user message verbatim**, so a report appended at ordinal X is re-read
on *every* subsequent response for the rest of the session, across all later windows. The window-limited
model was simply the wrong model. The round-1 instinct was right and the round-2 "correction" was the
error.

## The three levers that matter, ranked by measured size

### 1. Stop forking the parent transcript into sub-agents — 113,465,903 tokens (16.1% of the effort)

Each spawned lane forks the parent's history (`forked_from_id`, `subagent_history_start_ordinal`) and
re-reads that inherited context on **every** response. Summed over 15 lanes: **113.5M tokens, 27.2% of
all descendant spend.**

The natural experiment is already in the data:

| lane | fork setting | inherited ctx | responses | outcome |
|---|---|---|---|---|
| `mail_receipt_fix` | **`fork_turns: none`** (no `forked_from_id`) | 33,979 | 115 | 2 commits, **5 messages, all FINAL_ANSWER, zero chatter** — cleanest lane in the fleet |
| `native_cli_path` | forked at ordinal 96 | **81,078** | 28 | 1 commit, **76.6% of its cost was pure fork tax** |

**Do:** spawn lanes with a pointer to artifacts — task text, file paths, commit hashes, interface
contracts — instead of a copy of the parent's conversation. `fork_turns: none` is already available and
was used exactly once.

### 2. Fix compaction retention — 40,721,127 tokens (14.2% of root input)

Compaction retains 115 of 117 user messages verbatim, so the post-compaction floor grew 31,480 →
80,823 tokens (2.29×) and every response in later windows paid it. Attribution inside the excess:

| retained content | amortized cost | share of root |
|---|---|---|
| peer reports | 16,816,898 | 5.88% |
| 4 operator screenshots (3.64 MB base64) | 15,944,329 | 5.57% |
| operator's own text | 3,656,532 | 1.28% |
| modelling constant | 4,303,368 | 1.50% |

**Do:** fold user messages into the compaction summary instead of retaining them verbatim; keep only the
last N turns verbatim; drop image attachments older than one window. All four screenshots were still
being re-sent 20 compactions after they were posted.

### 3. Lower the compaction ceiling — the largest lever on the root

Burn is `responses × context`, and it is linear in the ceiling (round 1: r = 0.9985 on responses,
and the counterfactual table is linear). Compaction fired at a consistent **215,244** against a 258,400
window, giving an average context of **147,756**.

| average context | input tokens |
|---|---|
| 147,756 (actual) | 280,736,459 |
| 110,817 | 210,552,344 |
| 73,878 | 140,368,229 |

**Do:** trigger compaction near 120K rather than 220K. Cost of the extra events is bounded — each
compaction reads only the context at trigger, so total compaction overhead is roughly constant while
average context halves. **Tradeoff to accept knowingly:** more frequent summarisation means more
information loss per cycle, and each cycle re-injects the 65 KB world state (below).

## Cheap, high-certainty wins

4. **Shrink the world-state floor — 65,047 chars re-injected 21 times.** `agents_md` alone is 39,918
   chars, `host_skills` 22,371. It sits in the floor of every response *and* is re-injected after every
   compaction. Trim AGENTS.md, and inject only the delta after the first window.
5. **Batch tool calls.** Burn = `calls × context`. 1,857 calls served 111 `apply_patch` edits — a 19:1
   read-to-write ratio. Halving the call count halves the root's burn. This is a *call-count* lever, not
   a re-run lever (see "what not to do").
6. **Kill empty round trips — 3,331,905 tokens (1.17%)** from 51 `exec` calls that returned nothing;
   348 results returned zero tokens, 93 of them exit-0 successes.
7. **Re-fork lanes that outlive their context.** `coverage_review` spent **60.9% of its tokens
   (61.5M) in the crew phase while carrying PTY-era context** from 37 hours earlier. A lane whose task
   has moved on should be replaced by a fresh spawn against current artifacts, not kept alive.
8. **Do not park lanes for a day.** `credential_scan` was alive 19.6 h for 31 responses,
   `trace_tests` 36.0 h for 158, `claim_test_gaps` 33.9 h for 181. A parked lane is free per second,
   but each of its responses re-reads the full inherited context. Close idle lanes.

## Protocol fixes (correctness, and they also cut tokens)

9. **Envelope peer reports.** They arrive as anonymous `role: user` turns, indistinguishable from your
   own speech — now measured at 5–6% of root input on top of being a correctness hazard. The crew brief
   already names the fix: *"The envelope always names the sending seat."*
10. **Give every lane a token budget and an explicit success predicate.** The Prism/Devin fan-out
    reported `completed` with every task failed because each task was wrapped in `Effect.either` with no
    requirement that any succeed. A success predicate would have failed it at 12.2M tokens instead of
    after seven operator turns.

## What NOT to do — counterintuitive but measured

- **Do not reach for a cheaper model or lower reasoning effort.** Output is **0.24%** of tokens
  (683,799 of 281,420,258); reasoning is 202,318. The burn is input re-reads. `ultra` effort is not why
  this was expensive.
- **Do not chase re-run waste.** Normalized re-runs are 3,817,310 amortized (1.33%). The agent re-ran
  `git status --short` 44 times and `cat package.json` 4 times; it is a tidiness problem, not a cost one.
- **Do not cut lanes on cost grounds.** The lane audit found **15 of 15 lanes earned their tokens,
  0 marginal, 0 wasted** — 45 first-person-attributed commits, 6 more test files, 3 findings-only lanes
  whose findings are in the current code. Cross-lane duplication was negligible (5 of 148 distinct
  `file:line` references cited twice, none three times). The fleet partitioned the problem; the *shape*
  was expensive, not the *allocation*.
- **Do not blame the build/sign wait.** The 47-minute episode carries 22.1M tokens but almost none is
  avoidable — the agent kept doing other work while `codesign` ran.

## Expected result (estimate, not a measurement)

| lever | measured size |
|---|---|
| fork tax removed | 113.5M |
| compaction retention fixed | 40.7M |
| compaction ceiling halved | ~140M on the root |
| empty round trips + world-state trim | ~10M |

Removing the fork tax and the retention defect alone is **~154M of 704M = 22%**, with no loss of
deliverable. Adding the ceiling lever plausibly lands the same work near **350–400M**. I have not
measured that; it is an extrapolation from the linear ceiling relationship.

## Best and worst lane, for calibration

- **Best:** `/root/factory_message_sources/claim_identity_review` — 1,647,671 tokens, 24 responses,
  12 minutes, 3 findings all incorporated into `4cf844a5` → **0.55M tokens per verified outcome**. It is
  cheap precisely because it was short: the fork tax was paid 24 times, not 737.
- **Worst:** `/root/production_build_review/amp_replay_review` — 24,592,485 tokens, 186 responses,
  19.8 h, 1 landed test file → **24.59M per landed artifact**.
