# Local crew communication and reviews

Implementation contract for the operator's 2026-09-15 brief. The five product
rulings below are adopted. Interface details are being checked against the
current services before the implementation lanes share them.

## Product rulings

- `messages` offers `msg.prompt`, `seat.wait`, and `terminal.read` alongside
  mail. The operator may attenuate each independently. Observe is granted by
  default on an unmasked messages edge. A mask can only remove compiled ports.
- New peer envelopes say `mail from <seat>`. Sender identity comes from the
  admitted process and current seat generation, never client-supplied stamps.
- This iteration is local Command Center only. Remote delivery is explicitly
  unsupported; it cannot silently use a local path.
- A blocking review uses task rejection with a defect and advances the task
  epoch. It does not turn review disagreement into operator input-required.
- A directed `reviews` edge runs from reviewer to author. Review is not a
  general grant to update the author's work or write to its terminal.

The current actor-to-actor grant implementation already defaults to Full
bounded by offered/compiled ports. The brief's statement that it is currently
OptIn is stale; the new default-granted observation ruling is preserved.

## Shared invariants

1. Process-bound identity and current edge authorization guard every request.
   Long-lived waits and reads revalidate current authority before returning
   data. A removed edge cannot leave an authorized follow running forever.
2. Agents never author the canvas. Operator tests may generate canvas fixtures
   through the existing isolated test setup; this is not an agent API.
3. One product database and one owning runtime. All durable additions share
   one additive migration 23 to 24. Existing table definitions, immutable
   events and existing rows survive unchanged.
4. Delivery targets the stable ActorRef/seat, with a separate recipient
   generation for an attempt. Harness session ids are not mailbox addresses.
5. Physical acceptance and durable receipt are distinct. An uncertain write
   is visible and retained. Exactly-once across an external-TUI crash is not
   promised.
6. Ordinary mail never interrupts work. Immediate prompts use the same drive,
   idle/empty-composer gate and operator interlock. No raw input side door.
7. Each delivered change is a commit with checked evidence. Recorded replay,
   fake-harness app integration and real-harness runs remain distinct claims.

## Mail and immediate prompt

Keep the existing canonical Message and content-parts storage; add typed
optional subject, evidence refs, mail kind and sender stamp rather than a
parallel body store. CLI text/body is normalized once into text parts.

Evidence refs distinguish commit, file with line, task, seat, session-read
and URL. A session-read ref is a citation only; transcript reading is not
implemented here. New peer messages carry a server-stamped sender ActorRef,
generation and harness. Existing installed messages remain readable.

The attempt identity is message id plus recipient ActorRef plus generation.
Durably enqueue before any transport action. Transport outcomes distinguish
pre-write refusal, submitted notification and written-unresolved, with a
reason and physical write evidence. Public managed submission must not return
a boolean that collapses these outcomes.

Expose queued, notified, unresolved, refused, read, replied and reacted with
reasons. Transport state and read/reply/reaction facts must not erase one
another: preserve their timestamps and derive the displayed state. A later
receipt failure cannot turn an accepted notification into an eligible fresh
paste. Equal text with distinct message ids remains distinct mail.

An unresolved attempt is not automatically retried in its generation. A new
generation, explicit resume batch or operator retry authorizes a new attempt;
mere idle transitions, pulse ticks and subscriber remounts do not.

`msg send --prompt <seat> <text>` persists kind prompt with immediate policy.
Short full-body delivery requires idle and an empty composer. Busy or draft
returns retryable SeatBusy with the durable message id and a next step. Retry
must address that same id, not silently create another message. Oversize
immediate bodies refuse with an explicit input reason. `--fallback notice`
retains the same row and switches to ordinary notice policy.

Compact notices name the sender and point to `msg read <id>`. Reading one
message returns its complete body and marks that message read; listing the
own mailbox retains its existing read semantics. `msg sent` exposes readAt.
At most one automatic notice is admitted per seat turn window; batches retain
their exact membership through receipt recovery.

Harness templates declare native-channel, typed-notice and pull-only support.
Declare native-channel only when an implemented transport proves acceptance;
a harness hook that merely reports state is not a mail channel. Every harness
has pull-only, with doctrine explaining how to inspect its mailbox.

## Wait and observe

`seat wait <seat|--any> --until idle|attention|working|gone` is subscription
based, bounded to at most 600 seconds. It returns state, reason, confidence,
generation and event time, or a typed timeout. Register before checking the
current value so transitions cannot be lost. Any means currently authorized
peer seats, never all seats on the machine.

`tasks wait <id> --until completed|input-required|rejected` uses work change
events and current task-edge authority. Cancellation and timeout release all
subscriptions. Normal response is within 250 ms of the observed transition.

`seat read <seat> --lines N --since <seq> --follow --max-seconds S` reads a
settled observer grid and bounded scrollback. Return sequence, generation,
seat state and text. Sequence belongs to a generation; a replacement is
explicit, never concatenated into the old generation's stream. Follow has
duration and output-byte bounds. The read port grants no write, resize or
signal operation.

## Reviews

Task updates with typed commit refs generate durable receipt mail to current
reviewers. Checkout commit watches use exact checkout identity and commit
identity, coalescing duplicate observations. A watch must not claim arbitrary
commits in a shared checkout were authored by a particular seat.

Verdicts are immutable, seat-stamped, bound to task epoch and exact subject
refs. Posting requires a current reviewer-to-author edge and distinct seats.
Task and commit subjects retain enough receipt provenance to derive the
author and relevant task epoch; client assertions do not establish either.

An operator-authored requires-review rule on a task or board gates completion
on a distinct eligible reviewer's green verdict for the current epoch and
review subject. An old green cannot bless newly submitted commit refs. A
blocking verdict stores findings/refs and invokes existing rejection rules
atomically with the epoch change. Stale concurrent verdicts cannot move the
new epoch. The operator task view and digest expose the whole verdict chain.

## Evidence and delivery sequence

Land mail substrate first, then wait/observe, immediate prompt and reviews.
Independent fixture, capture and UI preparation may run in parallel.

- State/repository tests use the real current schema, transactions and old-row
  fixtures, including immutable history. Test uncertainty, refusal refunds,
  duplicate ids, same text with distinct ids, generation changes and crashes.
- Generated-canvas Playwright tests exercise the actual Electron composition,
  control socket, process-bound agent descendants, operator edge/rule editing
  and ledger/task UI. Fake harnesses make lifecycle extremes deterministic.
- Real harness runs use disposable homes and clean named sessions. Reuse only
  the minimum credential access a harness needs; never copy operator history
  or mutate its settings. Unsupported isolation/authentication is reported.
- Native packaged verification records the source commit and running bytes,
  then proves reads or explicit unresolved reasons, no duplicate physical
  delivery, and the blocking/fix/green task chain without manual submission.

Remote, agent-created seats, transcript APIs and agent canvas authoring are
outside this iteration.
