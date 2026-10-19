# Harness domain

Status: accepted 2026-10-16, building. Owner: pty-lead. The contract is code
in `src/shared/harness-domain/` with tests in `tests/harness-domain.test.ts`;
where this document and the code differ, the code wins.

**Scope of this effort: the PTY stream only.** Signals come from what the
seat's terminal emits: rendered screen text, titles, and in-band escapes such
as OSC 7501. No plugins, hooks, HTTP APIs, daemons or transcript tailing are
built in this effort. The vocabulary names those channels so they slot in
later without a contract change, and the coverage matrix below records what
they would add. The architecture lands first; channels expand after.

Junto features need to know what a seat is doing and why it stopped: working,
waiting on a permission, out of quota until 15:00, compacting, failed on an
expired login. Today a seat state is five values (`idle`, `working`,
`attention`, `unknown`, `gone`, see `src/shared/agent-seat-state.ts:9`). Across
all fourteen screen rule packs only pi recognizes compaction and retries, and
only kimi recognizes one error. No harness reports a usage limit.

This document defines a domain layer over generic harness concerns: one typed
vocabulary of signals, a derived status, commands, and per-harness capability
declarations. Features build on the vocabulary. Harnesses feed it through
channels, at whatever fidelity each harness allows.

## Principles

1. **Junto's vocabulary, not a harness's API.** The core sees signals such as
   `UsageLimitHit` or `CompactionStarted`. It never sees an HTTP route, a hook
   name or a screen string.
2. **Every fact carries its source and fidelity.** A usage limit read from a
   Codex rollout and one matched on a screen are the same signal with different
   provenance.
3. **Capabilities are declared per harness, and "none" is explicit.** A feature
   asks whether a seat can report usage limits and how reliably, and the type
   makes it handle the answer.
4. **Channels degrade instead of failing.** When a richer channel breaks after a
   vendor update, the next one carries the seat, down to the screen.
5. **A harness is a data record.** Per-harness code exists only as decoders for
   structured formats a harness writes (transcripts, event streams, APIs). A
   decoder is an Effect Schema, so format drift fails loudly in conformance
   tests instead of silently misreading.

## Domain

All schemas live in `src/shared/harness-domain/` (Effect 4 Schema), shared by
main, renderer and the `junto` CLI.

### Signals

Facts a seat reports. One tagged union inside one envelope.

```ts
SeatSignal =
  | SessionIdentified { sessionId, transcriptPath? }
  | ActivityObserved { activity: "idle" | "working" }   // a state seen, not an event
  | TurnStarted { turnId? }
  | TurnEnded { outcome: "completed" | "interrupted" | "failed" }
  | ToolStarted { tool? }
  | PermissionRequested { tool?, detail?, requestId? }
  | PermissionResolved { decision? }
  | QuestionAsked { text? }
  | DialogShown { kind: "trust" | "login" | "update" | "picker" | "unknown" }
  | UsageLimitHit { scope: "rate" | "session" | "5h" | "weekly" | "monthly" | "credits" | "org" | "unknown",
                    resetsAt?: DateTime, provider?, message }
  | Retrying { attempt?, max?, retryInMs?, cause: "rate" | "overloaded" | "network" | "server" | "unknown" }
  | UsageLevel { contextPct?, contextTokens?, contextWindow?, quotaPct?, quotaWindow?, quotaResetsAt?, costUsd? }
  | CompactionStarted { trigger: "auto" | "manual" | "unknown" }
  | CompactionEnded { ok, tokensBefore?, tokensAfter? }
  | ErrorRaised { kind: "auth" | "network" | "provider" | "model" | "contextOverflow" | "outputLimit"
                        | "policy" | "tool" | "crash" | "unknown",
                  retryable?, message }
  | ProcessExited { code?, signal?, expected }

SignalEnvelope = { seat, at, source, fidelity, signal }
source   = "screen" | "osc7501" | "hook" | "report" | "transcript" | "api" | "process"
fidelity = "native"   // a structured field the harness wrote for this purpose
         | "parsed"   // a structured record whose meaning needs a pattern (text in an error field)
         | "screen"   // rendered text or titles
```

### Status

What features read. A reducer folds signals into one snapshot per seat, with
channel precedence `api > report > hook > transcript > osc7501 > screen`.

```ts
SeatStatus =
  | Starting
  | Idle
  | Working { phase: "thinking" | "tool" | "compacting" | "retrying" }
  | Blocked { reason: Permission { requestId? } | Question | Dialog { kind }
                      | UsageLimit { scope, resetsAt? } | Error { kind } }
  | Exited
  | Unknown

SeatSnapshot = { status, since, sessionId?, usage?: UsageLevel, lastError?, provenance }
```

`Blocked { UsageLimit }` is distinct from `Working { retrying }`: a hard limit
stops the seat until a reset or an operator action, a transient rate limit
retries on its own.

### Commands

What Junto does to a seat. Each fails with a typed error.

```ts
deliverMail { text, mode: "queue" | "steer" | "interrupt" }
answerPermission { requestId, decision: "once" | "always" | "reject" }
interrupt
compact
resume

errors: Unsupported { capability } | NotReady { status } | DeliveryFailed { cause }
```

### Capabilities

Each harness record declares, per signal and per command, how it is supported:

```ts
Support = { level: "native" | "parsed" | "screen" | "none", channel: Channel }
HarnessCapabilities = Record<SignalKind | CommandKind, Support>
```

A conformance test per harness (spawn the real binary, run one scripted turn)
asserts every declared `native` and `parsed` capability. Installed `--version`
outside the record's supported range marks the seat "unverified version".

### Session location

Where a harness keeps one session is part of the contract
(`session-location.ts`). Each record declares `sessions`: `none`, or a `store`
and what a located session is (`transcript`, `folder`, `database`). A test
holds the declaration to main's store table (`term/session-existence.ts`).
A harness supplies the location two ways:

- **Locator.** Main looks in the declared store by session id.
  `locateHarnessSession` always answers: `Located { path, source: "store" }`,
  or `Missing { none | unsearchable }` (nothing under the id, or Junto cannot
  look).
- **Report.** The harness names the path itself, as `SessionIdentified`'s
  `transcriptPath` on a structured channel. The path comes from the seat's
  own process, so main keeps it only when it resolves, links followed, inside
  that harness's store on this machine and names the session. A path read off
  the screen is refused.

Every session close saves the location on the seat's session row, and
`junto onboard` says why a session has none instead of leaving a bare null.

## Settings and params

Harness configuration is part of the same domain (`params.ts`,
`inventory.ts`, `native-config.ts`). Settings, the seat's Params section and
the launch picker render and validate from it, never from a harness branch.

- **Params** are dials on one launch: model, provider, effort, mode,
  permission mode, profile, extra args. Each harness declares its options
  (fixed list, the machine's inventory, or free text), how a value is emitted
  (flag, config key, env, model slug, per-value flags), what a resume does with
  it (`repass`, or `frozenWithSession` for Amp's mode), which layers may set it,
  companion tokens (Devin `autonomous` brings `--sandbox`) and unoffered values.
- **Layers** resolve launch over seat over `machineDefault` over
  `harnessDefault`. A param nobody set in Junto resolves to nothing and nothing
  is emitted, so the harness's own config decides (operator decision,
  2026-10-14, confirmed 2026-10-16). `defaultValue` is the harness default a
  picker shows, never passed.
- **Inventory** is keyed by harness and the seat's machine (`HostId`), fresh for
  six hours, and a reader never waits: a stale answer is served with
  `refreshing`, and a failed scan says why. Each machine keeps its last good
  scans in its own junto.db, a cache rebuilt from the harnesses: one row per
  harness scan, model, per-model effort and profile, and a trigram full-text
  index over the models (`harness-models-state-schema.ts`). Nothing is written
  under the Junto home.
- **Native config** is a separate, explicit write to a harness's own config
  file on a named machine. Settings are declared per harness for a verified
  version range with typed values; anything else is refused before a file is
  touched. Product owns the catalogue and the writer against these types.

## Sources beyond the harness

The harness is one of four authors of facts about a seat. All four write the same
`SignalEnvelope`, so one reducer and one urgency ladder see everything.

| Author | What it says | Today | Authority |
|---|---|---|---|
| harness | the signals above, through the channels below | screen state only | deterministic |
| seat | the seat's own report: `junto blocked`, `junto escalate`, `junto feedback`, suggested replies | operator feed items | deterministic, self-reported |
| awareness | Jev classification of a bounded terminal window: 6 `activity.*`, 5 `concern.*`, 9 `health.*` questions (`src/main/junto/term/awareness/questions.ts`), each with its own probability and evidence hash | feed `health` items, advisory display | advisory |
| system | process exit, heartbeat stall, delivery receipts | occupancy `stalled`, `gone` | deterministic |

Awareness signals keep their current boundary: they carry `probability`,
`questionId` and the evidence hash, they never drive a command, and they never
outrank a deterministic signal. They can corroborate one (a screen-read
permission prompt plus `concern.approval_requested`), and they can raise a need
the harness cannot see (`health.thrashing`, `concern.repetition`).

```ts
source += "seat" | "awareness" | "system"
AwarenessSignal { questionId, answer, probability, evidenceHash, packVersion }
```

## Urgency

Four orderings exist today and disagree:

| Where | Ladder |
|---|---|
| occupancy (`src/shared/occupancy/derive.ts`) | activity_blocked > attention > stalled > working > idle |
| region rollup (`src/shared/region-rollup.ts:32`) | blocked > attention > working > ready > idle |
| operator feed (`FEED_URGENCY`) | blocked 5 > attention 4 > escalate 3 > feedback 2 > health 1 |
| desktop notifications (`desktop-notifications.ts:93`) | blocked 4 > failed 3 > needsYou 2 > done 1 |

"Failed" exists only in notifications, "stalled" only in occupancy, "ready" only
in the rollup. With signals formalized, urgency becomes one table in the domain
package. Each surface projects from it instead of keeping its own.

Urgency belongs to a **need**, derived from status plus seat and awareness
signals, not to a raw signal. A `Retrying` signal and a `UsageLimitHit` are both
limits; only one needs anyone.

```ts
Need { kind, urgency, actor: "operator" | "junto" | "none", since, provenance }
```

Each need's level sits on the one urgency ladder, `src/shared/wire/urgency.ts`;
the rank is the ladder as a number, higher more urgent.

| Rank | Level | Need | From | Actor |
|---|---|---|---|---|
| 9 | blocked | seat `junto blocked` | seat | operator |
| 8 | stopped | `Blocked { UsageLimit }` with no reset or no auto wake, `Blocked { Error: auth \| crash }`, unexpected exit | harness, system | operator, or junto failover |
| 7 | waiting | `Blocked { Permission \| Question \| Dialog }` | harness | operator |
| 6 | escalated | seat `junto escalate`; awareness `waiting_on_operator`, `approval_requested`, `answer_requested` | seat, awareness | operator |
| 5 | review | seat `junto feedback` | seat | operator |
| 4 | done | a finished turn nobody has read | harness | operator |
| 3 | degraded | `Working { retrying }`, `Blocked { UsageLimit }` with a scheduled wake, stall, awareness `stuck`, `thrashing`, `repetition`, `confused` | harness, system, awareness | junto, or none |
| 2 | working | `Working { * }` | harness | none |
| 1 | resting | `Idle` | harness | none |
| 0 | offline | an expected exit, an unknown state | harness | none |

Rules: awareness alone never lifts a need above escalated. Fidelity changes the confidence
a surface shows, never the urgency: a permission prompt read off the screen is as
urgent as one reported by a hook. `actor: "junto"` marks needs a feature may
resolve on its own (wake at reset, fail over, retry), which is what lets
automation sit on the ladder without paging the operator.

## Channels

Each channel is a scoped `Stream<SignalEnvelope>` per seat. Only decoders are
per-harness.

| Channel | Mechanism | Shared or per harness | Needs config written |
|---|---|---|---|
| screen | rule packs, extended so a rule can emit a signal and capture fields with named groups, e.g. `resets (?<resetsAt>.+)` | shared engine, data packs (exists) | no |
| osc7501 | Program Status Protocol, `ESC]7501;state=idle\|working\|blocked\|done\|error[:kind=permission\|question\|auth]:app=..[:msg=base64]`. Junto must answer the `7501;?` query | shared | no (`PI_PROGRAM_STATUS=1`, `AGY_CLI_OSC7501=on` are env) |
| report | herdr wire (`pane.report_agent`, `pane.report_agent_session`) on a per-seat socket; generalizes the prime-agent server | shared | no for muse, fx, prime-agent (env activated) |
| hook | hook or extension posts to the report socket | shared shim, per-harness event map | per-process flags where possible, see below |
| transcript | tail the session file the harness already writes | per-harness Schema decoder | no |
| api | opencode HTTP and SSE on `--port` | per-harness adapter | no |
| process | exit code and signal | shared (exists) | no |

The transcript channel is the most important finding of the signal survey. Most
harnesses already write structured errors, limits, compaction and usage to disk,
and none of it reaches the screen. Tailing it writes no harness config. It
depends on knowing the seat's session id, which makes session identity the
foundation of everything else.

## Coverage

Best channel per signal, with fidelity: **N** native, **P** parsed, **S** screen,
**none** not observable. Evidence was checked against real data on this machine
where marked (seen); the rest comes from docs, source or binary strings.

| Harness | Usage limit | Reset time | Retrying | Usage level | Compaction | Errors | Permission, question | Turn |
|---|---|---|---|---|---|---|---|---|
| claude | transcript N (`error:"rate_limit"`), seen | statusLine `rate_limits.resets_at` N (needs `--settings`) | S | transcript tokens P; statusLine 5h and 7d percent N | transcript N, auto or manual, pre and post tokens, 60 sessions seen | transcript N (`authentication_failed`, `server_error`, more) | hook N | hook, transcript N |
| codex | rollout N (`usage_limit_exceeded`), 33 seen | rollout N (`rate_limits.*.resets_at`, window minutes) | S | rollout N (percent used, context window) | rollout N, trigger via hook only | rollout N (`codex_error_info`) | hook N, S | rollout N |
| grok | hook N class only | none | `updates.jsonl` N | `signals.json` N | `updates.jsonl` N, 7 seen | hook N, partial | `events.jsonl` N, osc7501 | `events.jsonl` N |
| devin | S, never seen live | none | S | `sessions.db` P | hook N, db P | S, db P | hook N, osc7501 | hook N |
| cursor | hook N class only (`stop.status`) | none (vendor usage API) | none | `preCompact` hook N | `preCompact` start only | hook N partial | `preToolUse` hook N | hook N |
| agy | S ("AI credits balance is too low") | `/usage` S | log P | S | S | `cli.log` P | hook N, osc7501 | `Stop` hook N (`terminationReason`) |
| amp | S, never seen live | none | S | thread JSON P | `cli.log` P | plugin state N, no text | plugin N | plugin N, title S |
| opencode | api N (`APIError`), 5 seen | none | api N (`retry`, attempt, next) | api N (tokens, cost) | api N, auto or manual | api N (8 error types), 43 overflow seen | api N | api N |
| pi | transcript P (text) | text only | S | extension N | extension N (reason) | transcript P | osc7501 N | osc7501 N |
| omp | transcript N (`errorId & 0x80000`) | text only | extension N | `omp usage --json` N | extension N | osc7501 and `errorId` N | osc7501 N | osc7501 N |
| prime-agent | report N, no cause class | none | S | transcript P | S | report N, no class | report N | report N |
| kimi | wire P (`provider.auth_error` text), 6 seen | text only | wire N, 2 seen | wire N | wire N | wire P | wire N | wire N |
| hermes | request dump N (`usage_limit_reached`), 1 seen | request dump N (`resets_at`) | log P | `state.db` N | `state.db` P | hook N (classified) | hook N, title S | title S |
| muse | transcript N plus text, 6 seen | ISO time in text P | transcript N | transcript N | transcript N (trigger) | transcript N | report N | report N, transcript N |
| fx | S | none | S | `usage.jsonl` P | S | S | report N (`permission`, `question`) | report N |

Headlines:

- **Usage limits are observable on every harness.** Without parsing text:
  codex, omp, opencode, hermes, muse, claude and grok (class), cursor (class).
  A machine-readable reset time exists for codex, hermes and claude (statusLine);
  muse, pi, kimi and omp carry it as text. The rest need the out-of-band quota
  APIs Junto's usage plane already calls (`src/shared/usage.ts`).
- **Compaction is structured on eleven harnesses.** agy, amp (log only), fx and
  prime-agent fall back to the screen.
- **Retry attempts are structured only on grok, kimi, muse, omp and opencode.**
  Elsewhere they are screen text, and a seat that is retrying must not be read
  as blocked.
- **Weakest harnesses:** fx, agy and devin report limits on the screen only, and
  Junto's corpus has no limit, error or compaction capture for any harness.

## Config ladder

The signals above need no config written to any harness. Hooks add precision and
mail delivery. In order of intrusion:

1. **No writes:** screen, osc7501, transcript, report (env activated), opencode api.
2. **Per-process, Junto-owned files:** claude `--settings` and `--plugin-dir`,
   codex `-c`, devin `--config`, pi and omp `-e`, amp plugin directory. The
   harness's own config is never touched.
3. **Global, gated on a Junto seat env var:** grok, kimi, hermes, agy. Crosses
   the current no-config rule; opt in per harness, with herdr-style versioned
   status. Grok also runs `~/.claude/settings.json` hooks, so a global Claude hook
   would fire in grok seats.

## Build order

PTY stream only (see Scope). Each step lands with no behaviour change unless it
says otherwise.

1. **Domain package (landed).** Signals, envelope, status reducer with channel
   precedence, needs and the urgency table, capabilities, commands with typed
   refusals (`admitCommand`). Pure, no runtime wiring.
2. **Screen channel emits signals.** Rule packs gain signal emission with named
   captures (`resets (?<resetsAt>.+)`), and the engine emits `SignalEnvelope`s.
   The five-value `AgentSeatState` becomes a projection of `SeatStatus`.
3. **OSC 7501 in-band.** Parse the Program Status Protocol out of the PTY byte
   stream and answer the `7501;?` query; env activation only (pi, omp, agy,
   devin).
4. **Harness records.** One record per harness with its capabilities, rule
   pack and PTY profile. The `if`/`switch` ladders become record lookups.
5. **Screen captures per harness.** Limit, retry, compaction and error
   scenarios recorded into `tests/pty-e2e/corpus/` and covered by each pack.
6. **Surfaces project from needs.** Occupancy, region rollup, feed and desktop
   notifications read `NEED_CAUSES` instead of their own ladders; mail
   delivery goes through `admitCommand`.

Channels beyond the PTY (transcript, hook, report, api) are a later effort.

## Open questions for the operator

- Transcript tailing reads harness dotdirs under the operator home. They are not
  TCC-protected folders, but `docs/macos-privacy.md` should list the reads.
- The claude statusLine (5h and weekly percent with reset times) needs a
  per-process `--settings` file, rung 2 of the config ladder.
- Rung 3 crosses the no-config rule for four harnesses.
