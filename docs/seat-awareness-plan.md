# Seat awareness (Jev) — contract freeze

Status: proof-of-concept contract. Authored 2026-09-17 after the oracle review and the
first live TypeSafe/System One measurements in `scripts/jev-pty-poc.ts`.

This is the one-page agreement four workstreams build against. It is deliberately small.
It is **not** a product plan, and it changes no existing law.

## 1 - What this is

An **optional, asynchronous seat-awareness sidecar** that adds AI judgments about a live
managed-terminal seat. TypeSafe AI's `systemone` model (`jev-latest`, currently
`jev-1.13.0`) evaluates a bounded window of terminal evidence against a fixed pack of
narrow typed questions and returns constrained answers with calibrated probabilities.

Base functionality never depends on it: with no key, no network, or a failed provider,
Junto behaves exactly as it does today.

## 2 - Authority boundary (the law of this feature)

For identical terminal, lifecycle, and operator inputs:

> Enabling Jev, changing its answers, or making it unavailable must not change the
> deterministic seat events, managed write decisions, submitted bytes, delivery receipts,
> occupancy, or `needsLook`.

Therefore Jev may never:

- feed `evaluate()`, `SeatStateMachine`, or the composer verdict;
- veto, release, acknowledge, or retry a delivery;
- set or clear a flag, mark a seat seen, or author canvas state;
- change `seat.wait`, `seat.read.state`, the canvas digest, or any work-plane row;
- be the reason delivery stops or starts.

AI output is **attributed advisory display**, never authority. A concern is presented as
"AI suggests checking approval", never as a canonical `attention` transition. Canonical
attention always wins at presentation and is never downgraded.

Consequence, stated plainly: the paid feature improves **awareness**, not typing-safety
guarantees. If an operator later wants an AI warning to gate delivery, that is a separate
control-policy decision, not this feature.

## 3 - Observations (orthogonal, never a fatter enum)

The five-state control contract (`idle | working | attention | unknown | gone`) does not
change. Awareness adds separate, read-only axes, each with provenance:

| axis | vocabulary | source |
|---|---|---|
| occupancy | existing vacant/occupied | existing occupancy code |
| process lifecycle | existing opening/live/broken/closed | existing host facts |
| control activity | existing five states + reason + confidence | existing runtime |
| interaction | composer `empty | draft | null`; user/turn signals | existing probes |
| delivery observation | `none | queued | awaiting_turn | acknowledged | unresolved` | existing receipts |
| progress observation | ages of last output and last non-chrome text change; watchdog fact | awareness runtime |
| AI activity | `investigating | editing | running_command | testing | reviewing | reporting | indeterminate` | Jev (advisory) |
| AI concerns | `approval_requested | answer_requested | access_problem | execution_error | repetition` | Jev (advisory) |
| assessment availability | `not_assessed | current | stale | abstained | unavailable` | awareness runtime |

Laws preserved: a stalled or broken occupant is not a new occupancy category; `gone` is a
generation invalidation, not an AI conclusion; `done` stays the renderer's idle+unseen
derivation and hovering never marks a seat seen; an unavailable provider never lowers
canonical attention.

Every accepted judgment carries provenance: `bindingId, epoch, sourceSeq, evidenceHash,
observedAt, questionPackVersion, requestedModel, returnedModel, answers, evidence line
reference`. Model probabilities are not `AgentSeatConfidence`.

## 4 - Evidence, cadence, budget

- **Evidence**: bottom bounded window of the headless grid, id-tagged (`L000| text`),
  capped at 128 candidate lines and a byte cap. Composer drafts and known injected prompt
  bodies are excluded where extraction permits; known secrets and home paths are redacted.
  A non-flushing window accessor is used; background analysis never forces settlement.
- **One request per observation**, all questions batched. Starting pack: activity choice,
  turn-in-progress noul, four concern nouls, repetition choice, highlight-exists noul,
  highlight-line choice over the tagged ids plus `NONE`.
- **Triggers**: first stable screen of a generation; a material control transition or new
  deterministic attention; materially different working text (at most once per 60s); a
  turn-stall or unresolved-delivery episode (once per episode); hover cache-miss when
  budget permits. Never on spinner animation, byte increments, or attention heartbeats.
  Unchanged idle seats cost zero calls.
- **Coalescing** ~300 to 500ms with a maximum wait; one in-flight request and one
  replaceable pending observation per seat; four in-flight station-wide; bounded fair
  queue with hover and new concerns preferred.
- **Cache key**: bounded redacted evidence + generation + harness + geometry + relevant
  deterministic observations + question-pack version + model + temporal bucket. Never
  `seq` alone. Responses from retired epochs are rejected. Retained advisory content
  expires in about five minutes; a cache hit is not a new assessment.

**Window digest and freshness (decided 2026-09-17, after workstream D measured the risk).**
`windowDigest` is a **coarse material screen revision**, never a per-burst value:

- It is computed from the bounded, redacted evidence after **normalizing volatile chrome**:
  spinner and animation frames, elapsed-time counters, token counters, cursor position,
  byte and sequence counters, and repaints that leave the visible text identical.
- It is republished only when the normalized revision changes, and at most once per
  coalescing window. A seat printing continuously must not churn its digest on every burst,
  or a fresh judgment would read as stale within seconds on exactly the seats that work.
- The evidence digest, the cache key, and the staleness comparison are the **same
  normalization**, exported once by the projection (workstream C) and consumed by the
  scheduler (B) and the renderer (D). Two normalizations that disagree is the bug to avoid.
- **Freshness has two axes.** The excerpt is current only when its evidence digest equals
  the live window digest; otherwise it reads "last observed at <age>", never relabelled.
  The judgment (activity and concerns) stays `current` while within the TTL **and** the
  assessment belongs to the same control-state turn as the live seat, so a busy working
  seat keeps a useful label while its excerpt ages honestly. An assessment from a previous
  turn is `stale`.
- **Starting acceptance policy (to calibrate, not a guarantee)**: choice accepted when
  confidence >= 0.8 and top probability >= 0.8; noul concerns accepted at >= 0.9;
  otherwise abstain and say so. Independently evaluated questions are not independent
  evidence: never multiply their probabilities.
- **Envelope**: 20 to 60 calls per active seat-hour, 2k to 4k input tokens per call,
  hard caps 120 calls/seat/hour and 1000/station/hour, ceilings $0.025/seat/hour,
  $0.20/station/hour, $1/station/day. Provider p50 <= 300ms; event-to-fresh-advisory p50
  <= 1s when not throttled; **added latency on the deterministic path is zero**.
- **Failure**: missing key constructs no client; SDK called with `maxRetries: 0`, a ~2s
  timeout, and a generation-scoped AbortSignal; the scheduler owns backoff; credential
  errors stop calls until configuration changes; responses are validated at the adapter
  boundary (keys, finite probabilities, permitted choices, line-id membership); body
  logging is off. Provider failure shows deterministic status plus an honest
  `unavailable` or `stale` enrichment and never delays terminal startup or automation.

## 5 - Privacy (a launch condition, not a detail)

A discovered environment key is not consent. Live use requires one operator-visible
enrollment step stating that bounded terminal text leaves the machine, limited to
enrolled local managed seats. Redaction is not a confidentiality guarantee. Raw snapshots
and caches stay in memory; only settings and budget accounting persist, through the
existing app-owned store. Keys never enter IPC, artifacts, or logs.

## 6 - Acceptance

- **Zero-dollar baseline**: real captures through the real observer, checkpoints selected
  from the screen (never from model output), labels independent of both the rules and the
  model.
- **A/B**: awareness disabled versus enabled with success, contradictory answers, timeout,
  malformed response, rate limit, stale response, and old-generation response. Require an
  identical full deterministic trace: observer grids and signals, seat events and composer
  verdicts, write admission, submitted bytes and receipts, occupancy and `needsLook`.
- **PoC exit**: every displayed excerpt resolves to supplied evidence; accepted concerns
  meet a predeclared precision bar (initially 95%) with counts; enrichment is useful in at
  least 80% of displayed highlights as rated by the operator; freshness, cost, and failure
  behavior meet the envelope; enrollment is explicit; no raw terminal text in ordinary logs.

## 7 - Measured so far (2026-09-17, `scripts/jev-pty-poc.ts`)

19 live calls, $0.0020, p50 128ms, model `jev-1.13.0`, 1.6k to 7.9k input tokens per call.

- A 7-way "what is the agent doing" Choice was **low-confidence on every genuinely
  working screen** (0.46 to 0.60) and agreed with screen truth 3/10. A narrow
  turn-in-progress Noul on the same evidence agreed 9/10 raw (7/10 accepted at 0.9).
  Narrow property questions are the shape that works; taxonomies over a thin slice are not.
- The deterministic rules agreed with screen truth 9/10 on the same checkpoints. **Jev's
  value is not replacing them on what they already do.**
- All 8 adversarial cases passed: live permission dialog 0.97 versus the same dialog in
  history 0.07; fresh failure 0.97 versus an already-fixed failure 0.10; instruction text
  inside terminal output did not move any answer; a composer draft chip raised nothing;
  two identical failing windows read as repetition while two different attempts did not.
- Asking a temporal question without supplying temporal evidence produced a false
  "repetition yes" on two seats. Evidence must be supplied for every question that
  references it.
- Choice-option order was stable on a decisive screen (0.91 versus 0.94 confidence, same
  label). The Pulsar order-sensitivity failure did not reproduce here, on one case.

## 8 - Workstream ownership

| workstream | owns (new files only) | must not touch |
|---|---|---|
| A evidence and replay | `tests/pty-e2e/jev/**`, labels, checkpoint manifests, replay report | product source |
| B provider and scheduling | `src/main/junto/term/awareness/{jev-client,scheduler,runtime}.ts` + tests | questions, IPC, renderer |
| C questions and evidence projection | `src/main/junto/term/awareness/{questions,select-input,project-result}.ts` + tests | provider transport, IPC, renderer |
| D operator presentation | awareness renderer store + `SeatAwarenessHover` + tests | canvas mutation, control state |

The parent thread owns the shared schema, `package.json` and the lockfile, existing
observer and runtime wiring, IPC and preload, credential and privacy handling, the live
key and budget, integration, and the ship decision. No workstream edits another's files;
contract changes come back to the parent.
