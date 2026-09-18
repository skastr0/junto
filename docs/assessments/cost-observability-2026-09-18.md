# Cost and token observability for Junto seats

Date: 2026-09-18
Status: exploration, read-only. No product code changed.
Scope: can Junto report cost (or a defensible cost proxy) per session, per seat,
and per task, using the harnesses it already manages, the session tracking it
already does, and the work-plane task claims it already records?

Method: read Junto's usage and work planes, read the Quasar adapter set at
`../quasar/packages/cli/src/adapters`, then probe this machine's real
`~/.junto/state/junto.db` (read-only copy) and the real harness session files
those seats name. Probe script: `/tmp/junto-cost-probe/probe.py`.

---

## Headline

Three facts decide the whole design.

1. **Junto already stores the join key.** Every seat node carries
   `ether.terminal.bindingId` and `ether.terminal.sessionId`, and
   `bindingId` hashes to the `actor_seat_id` that every task claim, transition,
   message, and artifact carries. Task to seat to harness session is a complete
   durable path today.
2. **Junto already reads harness session files for tokens and cost, twice.**
   `hermes-source` reads `~/.hermes` `state.db` for tokens and
   `estimated_cost_usd`; `grok-source` reads `~/.grok/sessions/**/updates.jsonl`
   for per-turn tokens and `costUsdTicks`. Both are quota-plane aggregates over
   a 7-day window, not per-session rows. The seam exists; only the grain and the
   coverage are missing.
3. **The one thing Junto never stores is usage itself.** The usage plane's only
   durable row is a singleton snapshot blob of percentage windows with no seat,
   session, or task column. There is no per-session token table anywhere in the
   schema.

So the answer to "is there any cost tracking we can do at all" is: **not today,
and yes trivially, because every input already exists.** What is missing is a
usage ledger at session grain and a priced projection at task grain.

---

## 1. What Junto tracks today

### 1.1 The usage plane is quota, not spend

`src/shared/usage.ts` is the whole contract: `ProviderQuota` with
`windows[].usedPercent`, plus optional `creditsRemaining` and a free-form
`extras`. There is no token field and no cost field in the shared type.

Durable storage is one row (`src/main/junto/usage/state-schema.ts`):

```sql
CREATE TABLE IF NOT EXISTS usage_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  snapshots_json TEXT NOT NULL, last_live_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
```

Measured on this machine: exactly one row, last written 2026-08-03, holding
percentage windows. No seat, session, or task column exists, so nothing in the
usage plane can be attributed to work today.

### 1.2 Two sources already read harness session files

This is the load-bearing precedent.

| source | reads | extracts | grain |
|---|---|---|---|
| `usage/hermes-source.ts` | `~/.hermes/**/state.db` (sqlite) | input, output, cache-read, reasoning, total tokens, `actual_cost_usd` / `estimated_cost_usd`, billing mode | 7-day aggregate, one quota card |
| `usage/grok-source.ts` | `~/.grok/sessions/<cwd>/<id>/updates.jsonl` | per-turn `inputTokens`, `outputTokens`, `totalTokens`, `costUsdTicks` | per-turn parsed, summed to a 7-day window |

Both fold into the same fail-open `UsageSnapshot` envelope and both mark
themselves `partial: true` in `extras`, because a subscription has no limit
surface. `grok-source` is explicit that `costUsdTicks` scale is unverified and
refuses to invent a USD claim.

Every other native source (`claude`, `codex`, `copilot`, `cursor`, `devin`,
`kimi`, `ollama`, `opencode-go`, `openrouter`, `antigravity`, `synthetic`) is a
credential-and-endpoint quota reader. `claude-source` GETs
`https://api.anthropic.com/api/oauth/usage` for plan windows;
`codex-source` GETs `https://chatgpt.com/backend-api/wham/usage` for rate-limit
windows. Neither returns tokens or dollars.

### 1.3 Session tracking is a canvas fact plus process-local observation

Durable session identity is exactly one field: `ether.terminal.sessionId` on the
seat node, inside `canvas_nodes.ether_json`. Alongside it, `bindingId` is a
stable ULID for the seat. Runtime facts (`epoch`, `status`, `pid`, `cwd`,
`title`) are explicitly not stored (`src/shared/terminal.ts`).

`bindingId` is the root of the work-plane identity:

```
actor_seat_id = "seat_" + sha256("junto/actor-seat/v1", installationId, bindingId)
```

(`src/main/junto/station/actor-seat-compiler.ts`), and `ProjectedActorSeat`
carries `harness` and `sessionId` beside `seatId`, so Command Center holds each
Remote seat's session identity too.

Everything learned from the PTY (seat state machine, turn progress, agent-state
rules per harness, stall detection) is in-memory only. There is no
seat-observation table. The one durable session table in the schema is
`overseer_live_sessions`, which is the overseer Live journal, not a seat
harness session.

### 1.4 The work plane already carries the attribution spine

- `work_tasks.actor_seat_id` is the claimed seat, projected from
  `task.claimedBy`; the table's own CHECK ties `working` /
  `input-required` / `auth-required` to a non-null `actor_seat_id`.
- `work_task_transitions` is append-only with `from_state`, `to_state`,
  `actor_seat_id`, `origin_at`, `received_at`, `operation` in
  (`task.create`, `task.claim`, `task.transition`, ...).
- `work_events` is the immutable log, with `origin_at` and `received_at` per
  record, and a CHECK-closed `operation` set that includes `task.claim`.

So a claim interval per seat per task is derivable from an immutable log today.
No new table is needed to know *when* a seat held a task.

### 1.5 Measured board state (this machine, read-only copy of `junto.db`)

- 47 terminal nodes: 42 seats and 5 plain `terminal` geography nodes.
- Harness mix: claude 12, grok 7, codex 6, agy 5, devin 4, cursor 3, pi 3,
  prime-agent 2, terminal 5.
- 30 of 47 carry a `sessionId`. The gaps are exact: **codex 6 of 6 missing,
  agy 5 of 5 missing, prime-agent 1 of 2 missing.** Claude, grok, pi, devin,
  cursor are complete.
- 363 tasks, 297 `task.claim` transitions, 53 distinct `actor_seat_id` values,
  276 tasks currently carrying a claimed seat, 1299 transition rows.

This is a real workload with a real claim history, not a toy board.

---

## 2. What the Quasar adapters teach

Quasar normalizes provider usage into a provider-neutral `UsageRecord`
(`packages/protocol/src/normalized-session.ts`):

```
inputTokens, outputTokens, reasoningTokens,
cacheCreationInputTokens, cacheReadInputTokens, totalTokens,
cost, currency
```

All optional, all `NonNegativeInteger`/`NonNegativeNumber`, keyed by
`sessionId`, `eventId`, `timestamp`, `model`, `modelProvider`. One record per
assistant turn. Cost is a first-class optional field, and when a provider does
not supply it, the adapter omits it rather than estimating.

Measured adapter coverage (read from
`packages/cli/src/adapters/*.ts`):

| provider | tokens | cost | notes |
|---|---|---|---|
| claude | input, output, cache creation, cache read | no | subscription; `modelProvider: "anthropic"`, model captured |
| codex | input, output, reasoning, cache read, cache write, total | no | from `token_count` events, `total_token_usage` preferred |
| opencode | input, output, reasoning, total | **yes** | `data.cost` |
| amp | input, output, cache read, cache creation | no | plus a `usage_metadata` artifact with `maxInputTokens`, `totalInputTokens` |
| grok | input, output, total | no | plus `costUsdTicks` in its own counters |
| hermes | input, output, total | **yes** | `actual_cost_usd` then `estimated_cost_usd` |
| kimi | input, output, cache read, cache creation | no | |
| pi | input, output, total | **yes** | `usage.cost.total` |
| prime | input, output, total | **yes** | `usage.cost.total` |
| omp | input, total | **yes** | `usage.cost.total` |
| cursor | **nothing** | no | a usage record is emitted with ids and model only, no counters |
| devin | **nothing** | no | no usage extraction at all |
| antigravity | **nothing** | no | no usage extraction at all |

The three gaps Quasar itself has are the same three Junto would have, and they
are honest ones: the data is not on disk.

### 2.1 Verified against this machine's real files

The probe resolved real session files for the seats on the board:

| harness | result |
|---|---|
| claude | 10 of 11 resolved. Per-turn `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, model. No cost field. One seat resolved a 68.0M cache-read session. |
| grok | resolved, per-turn tokens and `costUsdTicks`. |
| pi | resolved, per-turn tokens **and real dollar cost** (`cost.total`): 0.556, 0.562, 0.082 USD on three seats. |
| codex | no seat carries a `sessionId`, so nothing to resolve. A fresh rollout file confirms `token_count` events with the full breakdown (4,838,563 input / 4,647,296 cached / 3,572 output / 183 reasoning / 4,842,135 total). |
| devin, cursor | session ids are slugs (`gilded-windflower`), not uuids; no probe written, and Quasar extracts nothing for them anyway. |
| agy, prime-agent | no `sessionId` on the nodes that would need it. |

---

## 3. So what is actually possible

Three tiers, in increasing order of ambition. Tier 1 and 2 are cheap and land
most of the value. Tier 3 is the interesting one and is also the risky one.

### Tier 1 — per-session token truth (no dollars)

Read each seat's harness session file, normalize per-turn usage into the Quasar
shape, and store one row per turn keyed by `(session_id, turn_index)`. This is
the same read `hermes-source` and `grok-source` already do, at session grain
instead of a 7-day aggregate. Providers: claude, codex, grok, pi, prime-agent,
kimi, omp, amp, opencode. Not cursor, devin, antigravity.

Deliverable: tokens per session, per seat, per canvas, per region, per
harness, per model. Tokens are an honest unit even when dollars are not.

### Tier 2 — dollars where dollars exist, proxies where they do not

Where the harness writes cost (hermes, pi, prime, omp, opencode), store it as
given. Where it does not (claude, codex, kimi, amp), the only honest options
are: (a) report tokens and refuse a dollar figure, (b) apply a published
per-model price table as an explicit, labeled estimate, or (c) report a
subscription-relative share, meaning this session's tokens as a fraction of the
plan window's total observed tokens, which is a real observable and needs no
pricing assumption at all.

Option (c) is the one that fits Junto's existing honesty doctrine. Junto
already refuses to invent a weekly limit surface for Hermes and refuses to
convert Grok ticks to dollars. The same discipline says: dollars for the
harnesses that write dollars, token share for the rest, and never a
silently-fabricated price.

### Tier 3 — cost per task, and task budgets

This is the request that makes the whole thing worth building, and the join
already exists:

```
task  --claim-->  work_tasks.actor_seat_id  --sha256-->  bindingId
      --canvas node-->  ether.terminal.sessionId + harness
      --harness file-->  per-turn usage records (timestamped)
```

The claim interval comes from `work_task_transitions.origin_at`
(`task.claim` to the next transition off `working`), and the usage records are
timestamped, so attribution is an interval intersection, not a heuristic. A
seat that holds two tasks in sequence splits cleanly. A seat that holds two
tasks concurrently, or a subagent fleet that spawns child sessions, does not,
and that is the real hard problem (section 4).

With Tier 3, `Costs` and `Seats` become computed regions, and a task can carry a
token budget that the kernel checks at claim time the way it already checks
`claimable` and `taskIsClaimReady`.

---

## 4. The hard problems

1. **Subagent fan-out breaks session attribution.** The existing
   `docs/assessments/token-usage-2026-09-16.md` measured this exactly: a Codex
   root session reported 285.9M input tokens while 15 descendant rollouts
   carried another 418.8M, so the effort was 704.6M, not 281M. A Junto seat
   session that spawns children undercounts by 59% unless the ledger follows
   `parentSessionId` / `lineageRootSessionId`. Quasar already models this
   (`sessionEdges`, lineage roots); Junto does not.
2. **One seat, many tasks, overlapping in time.** Interval intersection is
   correct for sequential claims and ambiguous for concurrent ones. The
   transition log gives exact intervals, but nothing today says a task was
   *paused* while another ran.
3. **Six codex seats and five agy seats have no session id.** Capture is
   proof-gated (`session-capture-persist.ts`) and these harnesses never proved
   one. Cost attribution is impossible for a seat with no session, so either
   capture improves or those seats report unattributed tokens.
4. **Remote seats.** Command Center holds each Remote seat's `sessionId` in the
   projection, but the session files live on the Remote. Junto reads Remote
   files over SSH already (host inspection, deploy, process plane), so the
   mechanism exists; the policy question is whether cost reads belong in the
   Station protocol or in an SSH-side probe.
5. **Session files are untrusted input.** They are large, append-only, and
   actively written by a live harness. Quasar's answer is fingerprint plus
   row-level delta with no locks; Junto's existing sources cap bytes
   (`grok-source` reads at most 80 files and 512 KiB tails). Whatever is built
   must never take a lock a live harness cares about.
6. **Subscription cost is genuinely not knowable.** Claude Code and Codex on a
   subscription produce no dollar figure anywhere on disk. Any dollar number
   for them is a modeling choice, and it must be labeled as one.

---

## 5. Recommended path

1. **Session-grain usage ledger first.** Extend the usage plane's existing
   reader pattern to per-turn usage rows keyed by seat and session, in the
   Quasar-normalized shape. Tokens only. This is additive, expand-only, and
   testable against real files with no network and no credentials.
2. **Task attribution second.** Join the ledger to `work_task_transitions`
   intervals through `actor_seat_id` to `bindingId` to `sessionId`. Ship
   token-per-task before dollar-per-task.
3. **Dollars third, and only where the harness wrote them.** Label every
   derived number as derived. Add the price table only as an explicitly
   operator-visible model, never as a silent default.
4. **Lineage before budgets.** A budget checked against a root session that
   undercounts by 59% is worse than no budget. Follow subagent lineage first,
   then let a task carry a token budget.
5. **Do not touch the quota plane.** Percentage windows and spend are different
   questions with different sources and different failure modes. Keep
   `usage_state` as it is and add beside it.

## 6. Open questions for the architecture pass

- Should the ledger be Junto-owned (Junto reads harness files) or
  Quasar-owned (Quasar ingests, Junto asks)? Quasar is already the canonical
  normalizer for 13 harnesses and already has the lineage model; Junto owns the
  task and seat identity Quasar has no concept of.
- Is a token budget a work-plane fact (a task field the kernel enforces) or an
  observational rollup the operator reads? Budgets that gate claims are
  product physics; budgets that only report are a HUD.
- What is the honest unit for a subscription harness: tokens, share of window,
  or a labeled price estimate? This is a product-trust decision, not a
  technical one.
