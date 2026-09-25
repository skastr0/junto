# Thread health calibration, 2026-09-25

**Verdict.** The shipped pack (`awareness-pack/2`) read 9 of 10 labelled screens correctly after one evidence fix. It raised no false alarm in either run, and its one miss was conservative. The operator's motivating case, a thread that stopped to ask something versus one that finished, separates cleanly: `health.waiting_on_operator` scored 0.97 on the prose hand-back and 0.02 on the verified finish.

## What was run

- **Script:** `scripts/thread-health-calibrate.ts`, which goes through the product's own `selectAwarenessInput`, `makeAwarenessModel` and `projectAwarenessAnswers`. This is not the harness pack, so the numbers describe what ships.
- **Model:** `jev-1.13.0`, one call per screen, 20 calls in total.
- **Tokens and cost:** about 40k input tokens at the $0.042 per million launch price, under $0.002.
- **Latency:** 277 to 784 ms per call.
- **Screens:** ten constructed in the shape of real Claude Code sessions. They are not captures, which limits what this run can claim. Each label was written from the screen alone before any call.
- **Evidence:** `thread-health-2026-09-25-evidence/run-1.json` (before the fix) and `run-2.json` (after).

| screen | label | run 1 | run 2 |
|---|---|---|---|
| prose hand-back, work unfinished | waiting_on_operator | waiting 0.97 | waiting 0.97 |
| verified finish, nothing asked | succeeding | succeeding 0.94 | succeeding 0.94 |
| same install timing out, retried | stuck | stuck 0.94 | stuck 0.94 |
| edit, fail, revert, edit again | thrashing | thrashing 0.92 | thrashing 0.92 |
| misread task, apologising | confused | no reading (confused 0.04) | confused 0.97 |
| 214 errors, context 3%, skipping work | overwhelmed | overwhelmed 0.91 | overwhelmed 0.91 |
| plan steps landing, tests green | going_well | going_well 0.94 | going_well 0.94 |
| reading and searching | steady | steady 0.92 | steady 0.92 |
| finished plus extra verified fixes | exceeding | succeeding (exceeding 0.83) | succeeding (exceeding 0.83) |
| boxed permission dialog | waiting_on_operator | no reading | waiting 0.95 |

## The defect this found (fixed in `795114112`)

Both run-1 misses on the bad end were evidence loss, not model error. `detectComposerExclusion` sent only 2 of 11 lines on the confused screen and 2 of 12 on the permission dialog:

- **Rounded boxes.** The rounded-box rule treated Claude Code's permission dialog as a composer box and deleted it. This affects the existing `concern.approval_requested` question too, which had never seen a boxed dialog.
- **Glyph lines.** The prompt-glyph rule treated an earlier `> ...` operator message in history as a draft, and deleted it along with every agent line below it.

**The fix.** A box with a question, a selection cursor and numbered options is a dialog. A glyph line with an agent bullet (`⏺`) below it is history. A draft, numbered or not, is still excluded, and tests pin both directions.

## Reading the numbers

- **Ten constructed screens are a smoke test, not a precision bar.** The acceptance bars stay at the pack's 0.9 and 0.1, and nothing was tuned on this set.
- **"Exceeding" is the hardest claim, and it abstained.** It scored 0.83, inside the band, so the surface said "succeeding", the weaker true claim. That is the intended direction: `HEALTH_REQUIRES_ALSO` keeps "exceeding" from ever standing without a verified finish.
- **Several good readings often co-occur.** For example, succeeding 0.94, going_well 0.96 and steady 0.95 appeared together. Precedence picks the strongest claim, and the rest travel as signals for the sidebar.
- **The approval concern stayed in its band on the dialog.** After the fix, `concern.approval_requested` still did not pass its bar, while `health.waiting_on_operator` read 0.95. This one case is not enough to recalibrate the concern.

## Open

- **Real captures.** Score the health questions on the held-out split from `tests/pty-e2e/jev`, once those windows carry health labels.
- **The drive hold.** `seat-hold` still reads only concerns. Health is display only, by design, and it does not feed the hold.
