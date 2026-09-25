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

## 2 - Authority boundary (revised 2026-09-17: the AI drives)

The sidecar **drives seat state**. It is not decoration: the judgments below become the seat's
state, its health, and an input to the delivery gate. What the operator asked for, and what the
measurements now support, is exactly this: a refinement of the PTY subsystem that makes it more
reactive and more intelligent than chrome rules can be.

The AI drives:

- **seat state** — `blocked_on_access | waiting_on_approval | waiting_on_answer | error_looping |
  execution_failed | reviewing | editing | testing | running_command | investigating | unclear`,
  none of which the deterministic rule packs can compute from chrome alone;
- **seat health** — `attention | degraded | active | clear | unknown`, derived from the same
  judgments and rolled up for the canvas;
- **the delivery hold** — fail-closed, described below.

Three bounds remain, and each is measured rather than cautious:

1. **A proven dialog is not downgraded.** If the deterministic engine publishes `attention` for
   a seat, an AI reading of the same screen cannot replace it: the derived state is reported as
   detail and the control state stands. The screen proves a dialog; the model guesses at intent.
2. **There is no AI idle.** The model never gets to say a seat is idle, because a wrong idle is
   the one answer that could release automation. Absence of a judgment means the deterministic
   state is the state.
3. **The AI may hold a delivery closed, never open one.** A wrong hold costs a delayed prompt; a
   wrong release types into a dialog. Pulsar measured the hazard directly: swapping two
   alternatives flipped a verdict with the candidate unchanged, so a single-shot judgment is not
   a stable basis for releasing an irreversible action. The hold is an additional gate input,
   never a substitute for the deterministic one, and it is never the reason a delivery proceeds.

Base functionality never depends on it: with no key, no network, or a failed provider, the
deterministic state is the state, and the canvas keeps working.

Jev still may not author canvas documents, set or clear flags, mark a seat seen, acknowledge a
submission, or write work-plane rows. Those are control-plane powers, and none of them is needed
for the seat to be reactive.

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

**`indeterminate` is not a finding (decided 2026-09-17 from a real-wire defect).** The
projection publishes `activity: "indeterminate"` whenever no activity property was
established, which is a different fact from the model answering indeterminate. So
`indeterminate` makes an observation a judgment, but it is never a finding: it does not take
the headline and it never pre-empts a decisive negative. Workstream D found this on the real
chain, where a decisive negative for every concern rendered "Activity unclear" and the
clear fact never surfaced; the renderer now ranks headline claims as concern, then a
determinate activity, then checked and clear, then activity unclear, and shows a clear fact
as a secondary line beneath any stronger finding rather than replacing it. No finding is
ever hidden by a clear one.

**A concern and its absence never coexist.** Each Noul answer lands in exactly one branch of
the projection (at or above the present bar, at or below the absent bar, or the silent band
between), and the concerns list is built by reading only the accepted map, so the wire
cannot carry both for one concern from one observation. Measured on ten real captures with
constructed responses: zero collisions, and a bar sweep at 0.1 and 0.1000001 produces
absence then silence, with no value producing both. The renderer still pins the guard at
ingest and at presentation, and the raised concern wins if it ever fires.

**"Checked and clear" needs the band and the availability together.** The strong claim was
overreaching: the surface said it whenever any concern was ruled out, which on a real quiet
row can be one concern out of four with the rest in the silent band, so "I answered every
question" and "I answered one" rendered the same card. The assessment now carries
`unansweredConcerns`: the concern questions that were asked and not decisively answered, in
pack order. Workstream C derives it by testing decisiveness rather than by filtering
abstentions, because a missing answer produces no abstention entry and an abstentions-only
filter would report empty on a partial response, which is the same hole one layer down. So
three ways a concern goes unanswered are all covered: the band, a model decline for
insufficient evidence, and no answer arriving for a question that was asked. A question the
pack could not ask is excluded by construction, by checking the request's own asked set, not
by inspecting reasons. The copy rule is two-state and needs both facts: **checked and clear
only when `unansweredConcerns` is a present empty list AND a judgment exists** (current or
stale); an abstained or unavailable assessment has no judgment at all, so it cannot reach the
clear branch. Anything else is the weaker **no concern raised**. Currency is deliberately not
one of the facts, revised 2026-09-17 after workstream D implemented the stricter version and
flagged the consequence: a decisive negative is a finding, and a determinate finding keeps
its label when the judgment ages, with the chip carrying LAST OBSERVED. Requiring currency
would have rendered an aged but complete assessment as **no concern raised**, whose meaning
is "some questions went unanswered" — a factual misstatement about evidence that was fully
answered. Absent and empty are deliberately
not the same: decode leaves an omitted field undefined rather than normalizing it, and the
strong claim requires a present empty list, so a version skew between producer and renderer
degrades to the weaker claim rather than to a false strong one. Workstream B caught that my
first version of this paragraph was false: the decoder normalized an absent field to empty,
which supports the strong claim, so the stated safe direction was the unsafe one until the
decode was fixed.

**One gate, off in the ship profile (2026-09-18).** The whole subsystem — the advisory
sidecar, the hover that paints its judgment, the peer-help request and its thread, and the
AI hold on the delivery gate — is one compile-time feature gate,
`SEAT_AWARENESS_ENABLED` / `JUNTO_SEAT_AWARENESS`, and it is **off** in `SHIP_FEATURES`.
A ship build constructs no client, observes nothing, renders no surface and refuses the
collaboration action, so it behaves exactly as it did before the feature existed; the
all-on profile turns it on for development, and `JUNTO_SEAT_AWARENESS=1` turns it on for a
single build. Inside the gate, `advanced.seatAwareness` remains the operator's runtime
opt-out and `JUNTO_AWARENESS=on|off` the dev override, so an enabled build still has a
switch the operator owns.

The reason for a dark gate rather than a default-on setting is the open question in 8c:
the calibration numbers describe the harness pack, not the pack that ships, and the hold
can defer an operator prompt. Neither belongs in a ship build until it is measured on its
own terms. The privacy consequence is unchanged and stated plainly: with the gate on,
bounded terminal text leaves the machine for enrolled local managed seats.

**The disabled sidecar says so.** With awareness disabled the wiring constructs no client, and
the scheduler publishes one judgment-free `unavailable` notice with reason `not_configured`, so
the card reads UNAVAILABLE and names the reason. `NOT ASSESSED` stays reserved for a running
sidecar with no observation for that binding yet, because an operator who never enabled
awareness would read that as pending rather than off. A gate-off notice is never cached and can
never age into stale. The renderer is deliberately not told about enrollment: it is a
control-plane fact, and the advisory plane must not need it. A missing key while enrolled
publishes `missing_key` instead, so the two reasons stay distinguishable on the surface.

**Two guards that point the safe way.** If a producer contradicts itself by listing a concern
as both decisively absent and unanswered, the unanswered entry is kept and the claim stays
weak: dropping it can empty the list, and an empty list is what licenses the strong claim, so
resolving the contradiction in favour of the stronger claim would be the unsafe direction. The
weaker fact is true under either reading. A raised concern needs no such guard, because the
clear branch is unreachable while any concern is raised. Separately, the omitted-field path is
a guard rather than a live path today: the projection's and the scheduler's assessments both
always carry a present list, empty on a failure, so nothing in the running system omits the
field; the undefined branch exists for a future or skewed producer, and workstream D corrected
their own earlier framing to say so.

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

**The excerpt never claims currency (revised 2026-09-17, after measurement).** Two
independent measurements agree that a busy seat changes its material revision about once
per second: workstream D replayed an 88-second real test run and saw 56.4 revisions per
minute at a one-second cadence, and the parent replayed nine corpus captures through the
real observer with the projection's own normalization and measured material revision gaps
of p50 1s, p75 3.25s, p90 4.5s, max 7.75s across 32 gaps, with 53% at or below one second.
No digest-based currency claim can therefore be both stable and true: unfloored the label
flickers about once a second, and any stability floor long enough to stop the flicker
(10s, versus a maximum observed gap of 7.75s) leaves the excerpt reading last observed for
the whole turn. So the excerpt is always an age-attributed quotation from its own
observation, and the judgment axis carries the currency claim. The stability floor stays
as an exported constant at 10s for the transition, and goes to zero once the stronger
claim below lands.

**Documented upgrade, not built:** producer-side containment, which would let the excerpt
claim "still on screen" honestly. The shape is `evidenceStillPresent(assessment,
liveWindow)` as a pure predicate in the projection, returning false on a different
binding, epoch, or generation, published by the scheduler as `liveAssessmentId` on the
window event so the renderer compares two ids it was handed and never sees evidence. It is
the right claim to make when the excerpt's presence on screen is what the operator needs;
it costs one wire field and three coordinated changes, so it waits for that need.
- **Starting acceptance policy (to calibrate, not a guarantee)**: choice accepted when
  confidence >= 0.8 and top probability >= 0.8; noul concerns accepted at >= 0.9;
  otherwise abstain and say so. Independently evaluated questions are not independent
  evidence: never multiply their probabilities.
- **A Noul is two-sided (decided 2026-09-17 from the held-out measurement).** A Noul
  carries as much information in a confident no as in a confident yes, and the first
  policy threw the no side away: on the frozen holdout, `turn_in_progress` published
  1 answer above 0.9 while 28 answers at or below 0.2 were all correct, and every
  concern question was wrong zero times at every threshold tested. So a Noul publishes
  a negative verdict at <= 0.1 as well, and only the band between the two bars is an
  abstention. For concerns, a negative is an accepted absence, which is what lets the
  surface distinguish "checked and clear" from "not assessed". For `turn_in_progress`,
  a negative is a cross-check against the control plane rather than a displayed state,
  because the deterministic engine already owns idle versus working.
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
  behavior meet the envelope; the opt-out is reachable and reversible in Settings; no raw
  terminal text in ordinary logs.

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

## 7a - Held-out evaluation (2026-09-17, workstream A's harness, run by the parent)

Frozen split, 42 checkpoints over 10 captures reserved before the run, 42 calls, 0 errors,
158,545 input and 23,964 output tokens, **$0.006659**, p50 136 ms, max 482 ms, model
`jev-1.13.0`. Deterministic trace digests unchanged before and after the paid calls on all
9 captures read: the authority boundary held under real traffic.

| question | published (>= 0.9) | correct | wrong | abstained |
|---|---|---|---|---|
| approval_requested | 7 | 7 | 0 | 10 |
| access_problem | 17 | 17 | 0 | 10 |
| execution_error | 13 | 12 | 0 | 13 |
| answer_requested | 11 | 3 | 0 | 23 |
| turn_in_progress | 1 | 0 | 0 | 34 |
| activity | 37 | 34 (all `indeterminate` against an `indeterminate` label) | 3 | 0 |
| highlight_line | 13 | 13 | 5 mismatched | 24 |

Read this as precision-first with low coverage, which is the safe direction, plus two
honest negatives:

- **The concern questions were never wrong**, at any threshold tested, on any checkpoint.
  Access problems, approval prompts, and live execution failures are the value: those are
  exactly where the deterministic rules are weakest.
- **The activity taxonomy produced no grounded signal.** All 42 labels are `indeterminate`
  because no rendered live chrome in this corpus carries an activity marker, so the 34
  agreements are agreement on "nothing to say" and the 3 non-`indeterminate` answers are
  ungrounded. The earlier "3/10 agreement" figure was an unanswerable question, not a model
  failure. Activity stays marked unmeasured until a capture paints distinguishable work.
- **The `no` side of every Noul was being discarded**, which is what the two-sided rule
  above fixes: `turn_in_progress` at or below 0.2 published 28 correct answers with zero
  errors while the yes side published 1.

**Harness lessons live with the harness.** `tests/pty-e2e/jev/README.md` carries the four
measured traps that cost real time, in the order they cost it: the sync fake-timer advance
fails silently because the grid never absorbs the write and the snapshot never settles, so
use the async variant with a zero-length per-feed drain; a derived Noul negative bar of
`1 - 0.9` is 0.09999999999999998 and silently abstains at exactly 0.1, which cost two of
nine correct negatives; the 7-way activity Choice has no ground truth in this corpus; and a
re-score must join stored answers to the current manifest labels, or a label correction can
never take effect. The manifest stays reproducible from the CLI with no test runner, which
is why the stall frames are pinned by a test rather than carried in the manifest: a stall
frame's label depends on injected time, so the same capture would label differently in
different environments. The honest shape of a stalled checkpoint is a capture holding a
real silence longer than the threshold.

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

## 8a - Measured live in the app (2026-09-17)

The first live run: a real PTY, a real key, one seat, a real screen. It found a defect
that no unit test and no corpus capture had caught, and the fix is in the scheduler.

**The defect.** The interval floor (`workingTextIntervalMs`, 60 s) suppresses an ask when a
material revision arrives too soon after the last one. The suppressed revision was only
re-examined on the *next observation*, so a seat that changed and then went quiet — a
blocked dialog, a finished turn — was never asked about it. Live: a seat printed an
approval menu and blocked on `read`; the judgment on the card stayed "checked and clear"
about the bare `$` prompt it had been asked about a minute earlier, with the model's own
numbers for that empty screen (approval 0.02, access 0.02, answer 0.09, execution 0.03) and
`unansweredConcerns: []`, which is the *strong* claim. The card was confidently clear about
a screen that no longer existed.

**The fix.** A material revision suppressed by the floor arms one timer per seat for that
digest; it fires when the floor expires and asks if that revision is still the newest. It
does not fire when bytes kept arriving (the ordinary path owns that), it does not stack on
a pending or in-flight ask, and it does not retry a refusal. Falsified the usual way: with
the arm removed, the new test reads one call where it should read two.

**What the same seat said after the fix**, about the real menu (evidence: the command echo,
`JEV-LIVE-PROBE`, "Do you want to allow this action?", the two options):

| judgment | evidence it read | result |
|---|---|---|
| before the fix | `$` and 31 blank rows | `checked and clear`; approval 0.02, access 0.02, answer 0.09, execution 0.03; unanswered empty |
| after the fix | the rendered menu | `no concern raised`; access 0.03 and execution 0.04 decisively absent, **approval and answer unanswered**; excerpt "Do you want to allow this action?" |

That is the design working end to end: on a real blocked approval the model declines to
call it decisively, the claim degrades to the weaker one, and the operator sees the quoted
line with its age. `e2e/scenarios/jev-live.spec.ts` runs this and is opt-in
(`JUNTO_LIVE_JEV=1`) because it spends money on a real provider.

## 8b - Exercised at volume, live (2026-09-18)

The held-out split, paid, against real harness captures: **42 calls, 18.5s wall clock at
concurrency 4, p50 130 ms per call, max 311 ms, 158,520 input tokens, $0.0067 total**.
Six mismatches over 42 checkpoints and nine questions; on the concern questions that carry
the product, 2 wrong out of 65 accepted answers (approval 1, repetition 1; answer_requested,
access_problem and execution_error were never wrong). The deterministic trace was re-read
before and after the paid calls and was unchanged on all nine captures, so the model plane
still cannot touch the control path.

**Jev now drives one thing.** `awareness/seat-hold.ts` turns each advisory into the seat
verdict the drive reads: `isSeatIdle` is now `deterministic idle AND not AI-held`, so a seat
Jev judges blocked on an approval or an access problem is not typed into. The direction is
deliberate and tested: the AI can only add a hold, never open one, and every unknown (no
verdict, a refusal, the gate off, an abstention, a seat the sidecar has not observed)
clears it. A failure is reported and not held: an execution failure is degraded, not a
dialog, and the seat can still take a prompt.

**What the live runs showed about the concern bar.** The corpus dialog screen
`devin/startup-trust#293` scores approval_requested 0.94 and answer_requested 0.96. The same
lines printed into a live shell score approval 0.03, twice, decisively absent, and the
card's excerpt quotes "Do you trust the authors of this directory?" — the model read the
line and still called the seat clear. It is right: a menu printed above a live shell prompt
is not a seat blocked at a dialog, and the prompt is the tell. The consequence for
measurement is that a raw shell cannot exercise the holding path; that needs a managed seat
running a harness.

## 8c - Two packs, one product (open, found 2026-09-18)

The evaluation harness and the product do not ask the same questions, and that is not
cosmetic:

| | harness (`tests/pty-e2e/jev/pack.ts`) | product (`awareness/questions.ts`) |
|---|---|---|
| questions | 9 | 12 |
| activity | one 7-way Choice | six narrow Nouls combined by precedence |
| turn_in_progress | a Noul | absent |
| Noul criteria | true/false text per question | none sent |
| evidence | a window PAIR (earlier + now) | one window plus a within-window note |

Every calibration number in this document (the held-out run, "concerns never wrong", the
per-axis agreement) was produced with the harness pack. **None of it has been measured for
the pack that ships.** The two can disagree on identical bytes, and the disagreement is
large enough to change a decision: the same screen scored access_problem 0.98 through the
harness request and 0.02 through the product request, and the 0.02 was the product's own
bug (a composer rule deleting the error block, fixed in `select-input`). After that fix the
product request answers 0.96 on the same screen.

The open work is one of:
- **align** the product's pack to the frozen evaluated pack (prompts, criteria, question
  set, and the pair), so the measurements describe the product; or
- **evaluate the product's own pack**, by running the harness's windows through the
  product's request builder and scoring against the same labels.

Until one of those is done, treat the numbers above as describing the harness, not the
product, and treat the concern bar as unvalidated for what ships.

## 9 - Collaboration (shipped 2026-09-17): a seat asks a peer

The fleet's own coordination problem is not knowing *what* each seat is doing, it is
knowing *who to ask*. A seat that is blocked, looping or waiting on an answer holds a
question; another seat on the canvas often holds the answer. The product now closes that
loop with machinery the fleet already had.

**What the operator sees.** Hovering an agent card shows a collaboration block under the
awareness card: `Iris can help`, why it is that peer, the exact question the request will
carry, and one button, `Ask Iris`. Clicking it turns the suggestion into an open thread on
the same card, `Iris [asked] waiting for a reply`, and stops offering that peer until it
answers. When the reply lands, the thread reads `answered` with the reply text.

**What the click does.** It appends one mailbox message to the peer, through
`workSystemMailboxNotify`, on the operator's authority. The message carries the question,
the reason, the asking seat's own screen lines, and the exact `junto msg reply` command
that answers it, including its own message id. Delivery is the existing crew-mail path, so
a busy seat queues the notice and a cold seat is woken by it. Nothing is sent without the
click: the awareness sidecar can suggest a peer and phrase the question, but it cannot
reach a mailbox.

**Where the suggestion comes from.** The ranking runs on the deterministic facts first, so it
still produces a peer and a question when the sidecar is off or has no key (the model gate
off: peers are agent seats on the same canvas, excluding the asking seat, seats with no
binding, seats that have left, and seats already holding an unanswered request. Ranking is
a topic overlap between the asking seat's own evidence (its label, its control detail, its
excerpt, its concerns, its recent mail) and the peer's (label, activity, excerpt, recent
mail), with a bonus for an available seat. The awareness judgments improve the copy when
the sidecar is enrolled: a peer whose own screen carries the topic is described as such,
and the basis is recorded as `awareness` rather than `fleet`.

**The return path.** A reply is any message in the document carrying
`metadata.inReplyTo` equal to the request id, which is exactly what `junto msg reply`
stamps. Threads are read from the same canvas projection the crew-mail surface already
paints, so a thread cannot claim something the mailbox does not say. A request that has
just been sent is held in renderer state until the projection catches up, and a
document-derived thread always wins over that local copy.

**Not in this slice.** Standing instructions ("when this seat goes idle, ask Iris"), a
fleet-wide coordination inbox, duplicate-work detection, semantic recall of past rescues,
and reply notifications while the source seat is not hovered. The first is the natural
next step: the same request, dispatched by a stored trigger instead of a click.

**The hover paints (fixed 2026-09-17).** The advisory hover was mounted inside the card
body, which `NodeShell` clips: it was in the DOM with a real box and was painted away, so
the entire operator-facing half of the sidecar (activity, concerns, excerpt, freshness,
the clear claim) reached the renderer and was displayed by nothing. Component tests and the
preview both rendered the hover directly, which is why neither caught it. Both seat node
kinds now render the hover through the shell's overlay slot, the card body and the hover
derive their status through one function (`seatCardStatus`) so the echo cannot drift, and
`e2e/scenarios/seat-awareness-card.spec.ts` asserts a hit test inside the hover's own box,
because `toBeVisible()` passes for a clipped element.


## 10 - Thread health (2026-09-25)

**What it adds.** A tenth read-only axis beside activity and concerns: how the seat's thread is going, on one spectrum from `stuck`, `looping`, `thrashing`, `confused`, `overwhelmed` and `waiting_on_operator`, through `steady`, to `going_well`, `succeeding` and `exceeding`. The contract is `src/shared/thread-health.ts`.

**It is not the seat's own claim.** Declared agent signals (`src/shared/agent-signals.ts`) are the agent's claim; health is Jev's reading. The two are never merged, and every surface labels health "AI reads".

**How it is asked.** `awareness-pack/2` adds nine narrow health Nouls. Each names the look-alike it must not be mistaken for, for example a finished turn versus one that stopped to ask. None asks about time the window cannot show, so looping stays with the temporal-pair repetition question.

**How answers combine.** `HEALTH_DERIVATION` is a precedence, never a product:
- waiting on the operator comes first;
- trouble outranks success;
- the good end is ranked strongest claim first.

The approval, answer and access concerns count as waiting, and an accepted repetition counts as looping, so nothing is asked twice. `exceeding` publishes only together with an accepted `succeeding`.

**What travels.** Health absences are audit facts, never readings. The reading rides the assessment it came from, and decode refuses it if it names another observation.

**Authority.** Health is display only. It feeds no seat state, no delivery, and not the hold in `seat-hold.ts`.

**Freshness differs from the judgment rule on purpose.** A health reading stays current inside the TTL, or while the live window digest still equals the one it was observed on. The case the operator asked for, a thread idle because it is waiting on them, would otherwise age out the moment its turn ended.

**Surfaces.**
- **The card.** The activity mark's rim carries the tone:
  - trouble: broken amber ring;
  - waiting: amber ring;
  - steady: no ring;
  - good: green ring.

  `useThreadHealthMark` supplies it. While the seat has an open declared `blocked` or `escalate`, a waiting reading is hidden and a good one is drawn quiet, so the corner never contradicts itself. Health is never crimson; that hue belongs to declared and control blockers.
- **The focus sidebar.** `ThreadHealthSection` shows the headline, its confidence, every other accepted reading, and the provenance.

**Measured.** See `docs/assessments/thread-health-2026-09-25.md`: 9/10 on constructed screens through the product pack, no false alarms, and one conservative miss. The run also found and fixed a composer-exclusion defect that deleted boxed permission dialogs from the evidence.
