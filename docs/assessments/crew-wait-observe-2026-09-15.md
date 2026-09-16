# Crew wait and observe assessment

Assessment target: `5f435696` plus the `seat.wait`/`seat.read`/`tasks.wait`
service and observer window it depends on, 2026-09-15 UTC.
This is an engineering assessment of one crew step, not a claim that the
operations are integrated or end-to-end qualified.

## What this step is

Step 2 of the crew brief (contract deleted by operator ruling 2026-09-16): parity with a peer-agent
surface by letting a seat wait on another seat, read another seat's settled
screen, and wait on a task. Every operation is a read. The port grants no
input, no resize, and no signal; nothing here authors the canvas.

## Landed units

| Commit | Unit | Evidence |
|---|---|---|
| `7a35af2c` | Read byte bound charged a separator per line instead of per kept line, so a window that fit was clipped short and a single line exactly at the budget was reported as clipped after being returned whole. Now charged between kept lines and cut on a UTF-8 code-point boundary. | `tests/seat-control.test.ts` 14/14, including a 65,536-byte multibyte single line and a 20,000-emoji line with no lone surrogate. |
| `25447496` | `ObserverGridWindow` and `SessionObserver.readWindow`/`TerminalObserverPlane.readWindow`: a bounded read-only window over retained scrollback plus viewport, re-resolving the observer after the await so a replacement mid-read cannot pair an old generation's screen with a new generation's session. | `tests/term-observer.test.ts`, `tests/local-session-host.test.ts` unchanged and passing. |
| `bbce9778` | The service: `seat.wait`, `seat.read`, `tasks.wait` over the seat state stream, the settled grid, and the work mutation seam. Injectable core plus `liveSeatObservation` wiring. | `tests/seat-observation.test.ts` 28/28; independent adversarial suite `tests/crew-seat-observation-adversarial.test.ts` 7/7. |
| `5f435696` | The command surface: `seat wait <seat\|--any> --until ...`, `seat read <seat> [--lines] [--since --since-generation] [--follow --max-seconds]`, `tasks wait <task> --target <sink> --until ...`. Pure flag lowering plus a transport timeout derived from the operation deadline. | `tests/seat-cli.test.ts` 9/9. |

Adjacent suites re-run green: 164/164 across term-observer, seat-state-runtime,
local-session-host and the seat suites; 100/100 across crew-physics,
crew-port-mask, work-control-protocol, work-control-process-revocation,
perf-probe, terminal-seat-architecture, actor-seat-architecture,
terminal-contracts, work-cli and work-world.

## Contract decisions worth recording

- **Bounded by construction.** A wait is capped at 600 s and a follow at 600 s,
  a read at 2,000 lines and 64 KiB. A caller that needs longer re-issues; a
  stuck peer cannot hang a caller.
- **Authority is re-derived, not remembered.** The caller's grant is re-read
  from a fresh live document before an event is accepted and before every
  return, including after an awaited grid read. A canvas commit on the caller's
  canvas re-derives immediately, so a revoked edge ends a wait or a follow in
  milliseconds instead of at the deadline. The canvas subscription is installed
  before the current value is checked, and a post-registration recheck closes
  the gap where a grant is removed before the subscription exists.
- **A redrawn authorized set is rebuilt.** For `--any`, a set that changed
  (peer removed, peer added) restarts the wait on the fresh set, so a newly
  authorized seat that is already in the requested state is answered rather
  than waited past.
- **Sequence belongs to a generation.** A cursor is a sequence plus its
  generation, and the two travel together. A replacement generation is reported
  as `replaced: true` with the returned window's own generation; text is never
  relabeled as the new session's, and the window is never concatenated across
  generations.
- **A wait reports, it does not police.** `seat.wait` returns the seat state
  event as the machine published it, with `reason` and `confidence`. It applies
  no readiness policy of its own, so a pull-only harness that legitimately sits
  on a low-confidence idle is not stranded, and the caller decides what the
  confidence is worth.
- **Read-only means read-only.** The only screen access on this path is
  `readWindow`. No write, resize, signal, dispose or tier call is reachable.

## Verified

- Bounded wait, timeout, and typed `Timeout` error with the last observed state.
- Revoked edge mid-wait and mid-follow fails `ScopeError` (measured 2-5 ms), and
  every subscription is released on settle, timeout, revocation or
  interruption.
- A transition delivered synchronously at registration is not lost; a
  transition landing between the current check and the subscription is not
  lost.
- A dead-generation seat event never answers a wait; the timeout explains it.
- Follow returns immediately when output already settled past the cursor, ends
  at its duration on a quiet seat, and reports a replacement explicitly.
- Task wait wakes on work mutations and on task-edge revocation.
- A wait answers the machine's event with no debounce of its own (under the
  250 ms budget in test).

## Not verified here

- **Integration.** `control.ts` dispatch and central CLI registration are root's
  change; until they land, the operations are not reachable through the work
  socket. Integration instructions were sent with the exact seam.
- **End-to-end and native.** No Playwright journey and no packaged run has yet
  exercised these ops over the real socket with real seats.
- **Remote seats.** Out of this iteration by ruling. A wait answers from this
  process's seat state machine, so a remote seat's transitions are not observed
  rather than guessed at.
- **Harness corpus coverage.** Amp's Sending frame (paste chip, no title
  spinner) replays as working at high confidence, so idle is not reported
  there. Codex Action Required has no committed corpus capture, so that
  refusal path remains synthetic-qualified only.
