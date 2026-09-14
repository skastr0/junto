# Vellum Command native submission repair

The intermittent Devin stuck-chip defect was reproduced on the installed
production app, corrected in `7d2d6cb1`, and verified on its signed replacement.
The repeat native run exercised the same failing interleaving: our paste
removed strong idle evidence before Enter. The replacement continued the
accepted submission and the task completed normally.

This record qualifies that defect and the exercised local factory path. The
[full PTY matrix assessment](pty-matrix-2026-09-14.md) remains the inventory
of other mechanisms and unqualified cases.

## Correction

The drive used `isSeatIdle` both to admit a new paste and to authorize Enter
after the paste. Devin's welcome placeholder supplies strong idle evidence.
A pending chip replaces it, leaving a correctly detected draft and
low-confidence idle. Reusing paste admission after this repaint refused
Enter. Whether the chip painted inside the 80 ms settle determined success.

The shared destination factory now supplies a submission continuation check.
It requires an actual snapshot and an idle destination, then either strong
idle evidence or a readable draft containing this drive's own pending text.
Working, attention, missing, unknown and gone states refuse. Admission remains
strict. Primary CR, chip CR and bounded recovery CR all use continuation;
binding, cancellation, resize and operator-input protections remain in place.
An unresolved accepted paste still prevents automatic repaste in that binding
generation. No automatic Ctrl+C cleanup was restored.

Source: [drive](../../src/main/vellum-command/term/drive/managed-terminal-drive.ts),
[shared factory](../../src/main/vellum-command/term/drive/managed-drive-factory.ts),
[seat runtime](../../src/main/vellum-command/term/agent-state/runtime.ts).
Command Center and Node Remote supply the same runtime state lookup. This
does not qualify the separate Node Remote factory-composition gap.

## Other repairs included in this package

The earlier matrix findings concern more than this gate. These corrections
are also ancestors of the running build; their component regressions are
separate from the native proof below.

| Area | Included correction | Limit |
|---|---|---|
| Claim identity | `4cf844a5` anchors receipts to the canonical claim fact, retaining identity across progress/comments and changing it on release/reclaim | Does not close the crash window between external submit and durable receipt |
| Mail reservations | `02a420ab`, `b9185f17`, `9832392b` preserve accepted batch membership, reserve individual messages across batch admission, and keep partial receipt recovery on the batch path | Acceptance membership is process-local; this launch did not exercise fresh mail |
| Submission evidence | `3e1da200`, `1824c0d1` reject false success while literal text remains, qualify accepted turn-start counts, and recognize wrapped/ruleless pending text; Cursor/Agy probes were corrected | Targeted matcher fixes do not qualify every adapter |
| Asynchronous ownership | `d5c78547`, `6df3111f`, `a3ff5bf7` fence generations/cancellation, wait through mid-span resize, bound recovery, and preserve parked input in one ordered queue | No acknowledged backpressure or hard memory bound; observer freshness remains separate |
| Idle interrupt | `54f79b07` reserves one in-flight interrupt per binding generation and releases only its own reservation | Explicit interrupt policy remains distinct from removed failed-submit cleanup |
| Remote overseer | `88583418`, `cf5b718f` route Remote overseer prompts through the destination drive and shared lifecycle; timeout has a named uncertain result | Full Remote pulse/mail/supervisor/board/doctrine composition, clipboard preflight and remote cancellation identity remain unqualified |
| Session attribution | `68d35167` refuses multiple matching fx index candidates instead of choosing the newest | It does not reserve one session across competing seats when only one candidate is indexed |

The native progress-note run below directly exercises claim identity as well
as submission. Other rows retain their narrower source/test evidence.

## Running package identity

Both launches used the default production home, the saved 192-node/57-edge
factory and its existing named Devin sessions, with normal scheduling enabled.
No isolated QA home, renderer development server or fake harness was used.
Devin CLI version: `3000.10.21`.

| Fact | Failed launch | Corrected launch |
|---|---|---|
| Source commit | `54f79b076528649998004a2efd9f64c6e2e1f44b` | `7d2d6cb1201503fef499be7231c10b03bd4350c7` |
| Main PID | `68917` | `14290` |
| Launch, UTC | `2026-09-14T04:10:48.043727Z` | `2026-09-14T04:34:04.507347Z` |
| Installed archive SHA-256 | `ceea7089a167a8c3c5e2f59f31fbcf73c11a6a93f692f424ecd37a564e6bf0cf` | `6ad3677ed79de0698075021b0d29111738156a4deb05efed7682ac43491aa31d` |
| Build cohort | `91377f1c-013a-484f-9f21-8b18b2451169` | `672f5e98-092c-4dfd-a3f8-2bdd805b7964` |

The replacement's installed archive matched the release archive. Its extracted
main payload was 4,071,211 bytes with SHA-256
`7d9d5cc2ca0b02a76e37e2468049647da3726c920af2f2b891e188fc90c1a32f`,
matching packaged provenance. The running PID held the installed archive's
inode `310246899`; its executable path was
`/Applications/Vellum Command.app/Contents/MacOS/Vellum Command`.
The previous main PID exited through normal app shutdown before installation.
The signed build and staged/installed package audits completed successfully.
These checks identify the actual executable and payload; the app version
remained `0.2.1` and alone cannot distinguish these builds.

## Before: Enter was never sent

The saved 180-row trace has 15 delivery attempts, two accepted pastes, one
submit CR, no recovery CR and no interrupt bytes. Intake submitted successfully.
Downstream delivery `063ddaf8-8141-44a3-8789-8430ede25b25`, rows 86–109,
did not:

| UTC time | Observed event |
|---|---|
| `04:13:58.886` | Paste accepted, 4,757 bytes; settle starts |
| `04:13:58.914` | Strict idle false, 28 ms after paste |
| `04:13:58.967` | Settle ends; idle gate refuses before any CR |
| `04:13:58.967` | `written-unresolved`, `prompt-stalled`, false result |

Input/resize latches were false and no operator writes were held during this
span. Thirteen subsequent attempts at the same payload were refused without
physical writes. Containment prevented destructive repetition; it did not
submit the chip. Computer Use showed the pending chip and needs-input state.

A read-only observe lease captured the real terminal. Replaying its bytes
through the observer and seat runtime produced draft composer, chip present,
low-confidence idle, no visible idle chrome, and `isSeatIdle: false`.
The completed intake separately restored the welcome placeholder and strong
idle; permanent failure to re-arm after completion was not reproduced.

## After: the same race completes automatically

The replacement automatically retried the existing downstream claim.
Delivery `59e3af4c-b561-452b-b6e3-3a1ea8e34020` used the same payload SHA-256
as the failed attempt:
`4dadd85e98d8c2af02e4f636c9510aa9e50cb959683c2d22bf69de1f76b0ba64`.
It submitted at `04:34:13.562Z` with one paste and one CR. That retry did not
repaint the chip before settle, so it alone would not prove the repaired branch.

A second task was created through the native intake board, with all existing
region/board rules and the existing downstream path. Each worker recorded a
marker and two separate working progress notes before normal completion.
Its downstream delivery `29c81032-d224-454f-af99-a257f284e8fc` exercised the
exact race:

| Live journal row | UTC time | Observed event |
|---|---|---|
| 487–489 | `04:37:03.620` | Paste accepted, 4,566 bytes; 80 ms settle starts |
| 490 | `04:37:03.633` | Strict idle false, 13 ms after paste |
| 492–495 | `04:37:03.700` | Settle ends; continuation true; submit CR accepted |
| 497–500 | `04:37:03.700–.701` | Continuation true; chip visible; chip CR accepted |
| 502–508 | `04:37:03.715` | Working event, pending text false, accepted ACK, submitted |

No input or resize interference occurred during this span. The chip still
visible immediately after the first CR may reflect delayed observer repaint;
it does not by itself prove Devin swallowed that CR. What is proven is that
the recipe continued through both CR stages and obtained submission evidence.

Computer Use then showed both tasks completed, both boards at zero open /
three done (including the original pre-QA task), and the downstream result
with the marker, progress notes and preserved handoff. Its composer returned
to the empty welcome placeholder. No manual Enter, Escape or Ctrl+C submitted
or advanced either task in these production launches.

Corrected-launch counts at the checkpoint: six admission attempts, three
accepted pastes, three submit CRs, one chip CR, three submitted verdicts,
zero recovery CRs, zero interrupts and zero duplicate physical pastes.
The other three attempts occurred during initial seat attachment and wrote
nothing. Progress notes did not trigger another claim briefing.
These counts remained unchanged through `04:46Z`, more than eight minutes
after the second task completed, across subsequent normal factory ticks.

| QA task | Result |
|---|---|
| `01M2F1WB4PDFP3RTCYVVCN81P7`, PTY live proof 54f79b07 | Intake completed before repair; previously stuck downstream claim completed after repair |
| `01M2F37KKR75RD0W5C5DKBDX1M`, PTY continuation proof 7d2d6cb1 | Both boards completed on the replacement, with distinct progress notes and handoff verification |

## Regression and integrated gate

Commit `7cf79f68` adds [four deterministic regressions](../../tests/pty-own-paste-idle.test.ts)
using a sanitized copy of the native pending frame through real
`SessionObserver`, `SeatStateRuntime` and the shared destination drive.
Chip repaint at +28 ms still permits both CR stages at +80 ms despite strict
idle being false. Working and permission frames during settle refuse CR and
repaste. A literal draft gets one bounded recovery CR; neither positive case
receipts until pending evidence clears and the runtime observes working.

The identical test and fixture bytes were run at `54f79b07`: both positive
cases failed because no CR was written, and both refusal cases passed.
All four pass with the repair. These are captured-frame/model regressions,
complementing the actual native acceptance above.

Final integrated validation at `7cf79f68`: **7,003 tests passed, 62 skipped**
with `bun run test --testTimeout=15000`; `bun run typecheck` passed. Product
name, no-middot, Effect runPromise and single-write-seam lints passed.
The commit after the packaged `7d2d6cb1` adds only tests and the fixture;
the running production implementation is unchanged. This verification record
and its links are documentation-only additions.

## Evidence and limits

Private local receipts are under
`/tmp/vellum-command-native-repro-54f79b07/` and
`/tmp/vellum-command-native-repro-7d2d6cb1/`: build identity, delivery journal,
trace summary and observe-lease captures/replays. Row numbers above refer to
`~/.vellum-command/logs/pty-delivery.jsonl` at this checkpoint; filtered copies
use different offsets. Raw session history stays outside the repository.

This establishes native automatic claim submission, completion, handoff and
absence of progress-induced duplicate pastes in the exercised sessions.
Unread edge-contract mail visible in the ledger was historical and already
accepted before these launches; it is not a new mail-delivery proof. This
does not qualify every producer, all fourteen harnesses, Remote execution,
crash receipt reconciliation, observer freshness, or the full input/resize/
lifecycle matrix. Herdr's separately reported stuck injections remain
unqualified by this Vellum Command repair.
