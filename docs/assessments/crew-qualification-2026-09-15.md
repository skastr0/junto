# Crew qualification, 2026-09-15

**The local crew implementation has substantial unit and database evidence;
the complete feature is not qualified in a real harness or a production
package.** Durable fallback/resume and checkout receipt composition now have
checked service/database results. Recorded Codex multiline evidence and an
actual fake-PTY submission now pass their bounded checks. The historical
generated review workflow passed while its PTY trace recorded a stalled
fake author prompt; its complete Electron rerun remains pending. The
observed Devin attempt wrote zero prompts.

This reconciles the [required crew contract](../crew-contract.md) with
the committed source cutoff **`9e4385864`**, 2026-09-15. New receipts cover
`9e4385864` (acknowledged-mail display), `4f84cb80a` / `cf52d96ab`
(recorded Codex multiline evidence) and `2d2e6a4e8` (raw fake-PTY fixture).
This includes the previous `171492635` lifecycle integration,
`8ef303514` (explicit fallback and generation-safe resume), `466f438e2`
(checkout composition), `396455873` (SHA author preservation), `f1b404998`
(one reviewer per stable seat), `e9c4324ac` (receipt writer tests),
`7fd50a94d` (captured Devin trust prompt) and `dd0e82d7a` (control retryability).
Each result below retains its actual run scope; several integration runs
tested the shared working tree before the corresponding commit. No quiet
test log alone proves a clean build's source identity. This supersedes
the integration status of the narrower
[wait/observe assessment](crew-wait-observe-2026-09-15.md), without changing
its historical receipts.

## Qualification matrix

**Checked** means the specific assertion and run receipt were inspected.
**Partial** states its limitation. **Reported** means an author recorded a
pass, but an independently inspectable run receipt was not found. **Unrun**
means unqualified at this layer. Corpus evidence is recorded output replay,
not a current external model turn. Package means the actual installed,
identified production artifact, not an Electron development build.

| Contract feature | Unit / state | Recorded corpus | Fake Electron | Real harness, new crew | Production package, new crew |
|---|---|---|---|---|---|
| Current process identity, directed edges and independently masked ports | Checked current authority and writer-race cases [U1, U3]; mask source/tests exist | No authority qualification from a screen recording | Reported mail/prompt/wait edge refusals [E1]; checked review scope/self-review refusal [E2] | Unrun | Unrun |
| Stable mailbox identity, intent/outcome sequences, retained batch membership and crash reconciliation | Checked real repository and adapter transactions, rollback and reopen [U1, U2, U6] | Not a database proof | Reported durable-mail scenarios [E1]; full crash/restart matrix unrun | Gate-only Devin attempt, zero writes [E3] | Unrun |
| Notification distinct from read/reply/reaction, server sender and typed refs | Checked repository facts; acknowledged notification outranks historical refusal/uncertainty without implying read [U1, U5] | No receipt proof | Reported mail ledger/read scenarios [E1] | No Devin read receipt [E3] | Unrun |
| Ordinary compact notice, one notice per turn, no automatic repeat after uncertainty | Checked drive/service regressions and accepted-write counts [U2, U4] | Partial: shared gates, including recorded Codex multiline evidence [C1] | Prior scenarios reported [E1]; repaired fake PTY checked separately, full Electron rerun pending [E4] | Unqualified for new crew | Unrun |
| Immediate prompt, body-only 160-character cap, named refusal, same-message retry | Checked named outcomes, explicit policy and same-ID retry [U4, U6]; control retains domain retryability [U8] | Partial: recorded Codex pending/ACK path now checked; full prompt control path remains separate [C1] | Reported 7 prompt scenarios [E1]; full repaired-fixture rerun pending | Unrun | Unrun |
| Durable notice fallback and explicit same-generation resume/retry | Checked real DB reopen, one notification across generations, current-grant ordering and generation fences [U6]; live callback wired [U8] | No full feature qualification | Unrun for durable restart/resume semantics | Unrun | Unrun |
| Seat wait, authorized `--any`, revocation, generation replacement and cancellation | Checked service/observer regressions [U3]; current control dispatch inspected | Partial: state and composer interpretation only [C1] | Reported wait scenarios [E1] | Unrun | Unrun |
| Bounded terminal read/follow and task wait | Checked byte bounds, generation cursor, subscriptions and task events [U3] | Partial: observer grid source, not peer authorization/follow integration | Reported read/follow/task-wait scenarios [E1] | Unrun | Unrun |
| Typed commit evidence produces atomic reviewer receipt mail | Checked real task fact + mailbox + dedupe transaction, rollback, restart and claimant race [U1] | Not a receipt proof | Checked actual producer through generated review journey [E2] | Unrun | Unrun |
| Exact-subject green gate; blocking, repair, new epoch and green chain | Checked current epoch/hash/edge at writer, first-board rejection, stale/standalone-commit cases [U1] | Not a review-authority proof | Checked review journey, visible chain and digest [E2] | Unrun | Unrun |
| Checkout commit watch with exact checkout identity and no ambiguous author inference | Checked 7 real Git/DB composition cases; atomic receipt writer and stable reviewer/source identity [U7]; lifecycle wired [U8] | Not applicable to Git attribution | Unrun with production watcher composition | Unrun | Unrun |
| Operator mask/rule authoring, mail ledger, review view and digest | Projection/view tests exist [U5] | Not a UI proof | Review view/digest checked [E2]; remaining mail/prompt UI reported [E1] | Unrun | Unrun |
| Additive schema 23 to 24, old rows and frozen history | Checked migration and write-seam gate within 21 passing tests [U5] | Not applicable | Generated fresh home does not prove installed upgrade | Unrun installed-upgrade case | Unrun |

Remote is explicitly outside this iteration. An explicit Remote refusal is
the correct contract outcome, not missing local parity or a Remote pass.
No harness has a qualified native mail channel merely because it emits
state hooks; pull-only remains the common declared fallback.

## Checked receipts

### U1 — durable review and mail repository

At source `192cbd228`, independently ran:

```sh
VELLUM_COMMAND_TEST_FEATURE_PROFILE=all-on bunx vitest run tests/crew-review-service.test.ts tests/crew-repository.test.ts
```

**27/27 tests, 2 files passed**, 07:37:08 BRT, duration 2.39 seconds.
The checked source changes in `192cbd228` and `c5023ab8a` are material:

- Task evidence, reviewer mailbox append and receipt dedupe commit inside
  the same repository transaction. Notification occurs after success in
  the service. A failed receipt insert rolls all three back.
- The receipt author is the current committed task claimant. A claimant
  change while the old author's update waits for the writer refuses without
  creating mail or notifications.
- Review authority, exact task epoch and subject are rechecked at the
  writer. A commit-only verdict uses durable author provenance and has no
  task rejection effect.

Primary tests:
[atomic receipt/restart](../../tests/crew-review-service.test.ts#L477),
[claimant race](../../tests/crew-review-service.test.ts#L649),
[commit authority race](../../tests/crew-review-service.test.ts#L793), and
[intent/batch/immutable-verdict repository tests](../../tests/crew-repository.test.ts).
This proves the producer and transaction behavior; it does not prove that
an external reviewer reads the receipt or submits a verdict.

### U2 — real attempt-store adapter

`d0e94195` adds
[11 checked tests](../../tests/crew-mail-attempt-store.test.ts) using the real
CrewRepository and StateEngine. The passing run at 06:31:02 proved compiled
ActorRef mapping rather than node-as-seat, atomic batch rollback and
membership, intent before transport, outcome before receipt, cross-generation
notification suppression, identity/read failure before writes, and
close/reopen crash recovery before traffic. The earlier batch-association
case failed before the producer repair, then passed.

The current [main composition](../../src/main/vellum-command/ipc.ts#L1682)
reconciles old intents before configuring live mail delivery. A delayed
boot scan does not reconcile current live attempts. The fallback/resume
additions now have their own receipts in U6.

### U3 — wait and observe

The [focused assessment](crew-wait-observe-2026-09-15.md) preserves the
independently checked service, observer and CLI results and exact limits.
They cover register-before-current, grant revocation after registration,
current authorized peer replacement, dead-generation events, observer
replacement during read, UTF-8 bounds and subscription cleanup. Current
[control dispatch](../../src/main/vellum-command/work/control.ts#L1529)
now reaches all three live operations; the earlier assessment's
unintegrated-control statement is historical.

Seat wait returns the existing state event, confidence and reason. It does
not substitute the stricter transport-idle policy. A low-confidence idle
alone is not evidence of a false state answer.

### U4 / C1 — submission outcomes and captured frames

`c2b96a01`'s four focused files passed **53/53** at 07:15:21 after the
attempt-owned generation evidence correction in `5e8f61fc9`.
`e9c40040c` and `2687ce32`'s seven files were independently run all-on at
07:28:15: **107 passed, 1 existing skip**. These preserve captured bytes,
classification, pending-text gates, named status/reason and physical-write
counts. The rejected-transport case proves zero accepted envelopes and
receipts during refusal, then exactly one accepted envelope and receipt
when writing becomes available, with no later repeat.

Relevant source tests are the
[Amp recorded-composer replay](../../tests/pty-e2e/scenarios/amp-composer-readiness.test.ts),
[protocol loop](../../tests/pty-e2e/scenarios/protocol-loop.test.ts),
[generation recovery](../../tests/managed-terminal-submit-recovery.test.ts)
and [delivery trace](../../tests/pty-delivery-trace.test.ts).
This is shared-drive qualification on specific captured/modeled cases;
the new crew prompt, authorization, receipt and UI paths are additional
boundaries.

**Recorded Codex multiline correction:** `4f84cb80a` recognizes the
contiguous literal-composer layout above the former bottom-ten-row limit;
it can prove a draft, not idle or an empty composer. `cf52d96ab` keeps the
test compatible with ES2022. The primary source is
[Codex paste-chip](../../tests/pty-e2e/corpus/codex/paste-chip.jsonl), whose
content is literal text despite the scenario name. The
[regression](../../tests/codex-multiline-pending.test.ts) finds 17 pending
frames carrying the exact 15-line payload, then distinguishes submitted
history from the live empty composer. An adjacent-frame replay through
the observer, seat runtime and shared drive accepts exactly one paste and
one CR, with pending evidence gone before the accepted working event.

`/tmp/vellum-command-codex-multiline-gate-20260915.log` records **140/140
tests in 7 files**, 08:15:35 BRT. This closes the recorded-evidence gap for
those cases. It is replay of captured native bytes, not a fresh real Codex
model run or a crew-workflow qualification.

### U5 — projection and schema scope

The checked source includes
[mail fact precedence](../../tests/crew-mail-view.test.ts),
[port masks](../../tests/crew-port-mask.test.ts),
[task review projection](../../tests/crew-projection.test.ts), and
[migration 23 to 24](../../tests/crew-schema-migration.test.ts).
The migration fixture checks unchanged existing message/receipt table
definitions and retained work history.
`/tmp/vellum-command-crew-integration-gate.log` records **21/21 tests in
3 files**, 07:56:18 BRT: `main-authoring-gate`, `crew-schema-migration` and
`single-write-seam-crew-boundaries`, all-on with `--maxWorkers=4`.
It tested the shared tree after `e52ea0e27`; it is not a clean-package
upgrade run. The number 21 is the test count: the current schema is **24**,
with the additive migration **23 to 24**.

`9e4385864` also corrects mail display precedence: reacted, replied, read,
notified, unresolved, refused, queued. A proven notification wins over
historical refusal/uncertainty; those timestamps remain intact and no
read fact is invented. Without notification, unresolved still wins over
refusal. The updated contract and
[display regression](../../tests/crew-mail-view.test.ts#L57) agree.
`/tmp/vellum-command-notified-display-before.log` records **3 failed,
17 passed in 2 files**; `/tmp/vellum-command-notified-display-after.log`
records **69/69 in 5 files**, 08:22:23 BRT. This is fact/display
qualification, not proof that an external recipient received or read mail.

### U6 — corrected durable fallback and resume

Independent real StateEngine/CrewRepository and drive probes found three
defects in `e52ea0e27`: explicit fallback disappeared after busy refusal and
reopen; plain immediate refusal granted fallback without a request; and an
old-generation grant released the current drive when its own grant failed,
allowing a second physical paste. The adopted regressions all fail against
that exact earlier commit:
`/tmp/vellum-command-fallback-before-e52-corrections.log`.

`8ef303514` corrects those paths. Only an explicit fallback request persists
notice policy, before transport gates and under the message reservation.
Pre-cancelled requests do not mutate policy, failed policy writes propagate,
and suspended requests do not continue to transport. Resume uses fresh
matching generations before and after the durable grant; missing snapshots
cannot authorize from cached state. Main's generation-carrying callback
checks the current host epoch synchronously before releasing the drive.

The [11 real database cases](../../tests/crew-mail-notice-fallback.test.ts)
prove fallback surviving reopen, one actual drive paste followed by durable
notification and no repeat after another reopen/new generation, current-grant
ordering, old/replaced generation protection, paused policy, cancellation,
reservation and failed/unknown authority reads. Evidence:

- **35/35 focused tests**, 2 files, exact `e52ea0e27` plus the three correction
  files: `/tmp/vellum-command-fallback-isolated-fixed.log`, 08:12:49 BRT.
  The same isolated source passed typecheck.
- **145/145 adjacent tests**, 9 files, all-on:
  `/tmp/vellum-command-fallback-takeover-adjacent.log`, 08:11:16 BRT.
  Effect, write-seam, product-name and no-middle-dot lint gates passed.

This upgrades service/database qualification. It does not establish live
harness acceptance or external exactly-once behavior.

### U7 — real Git and checkout receipt composition

`466f438e2` connects the watcher to current factory authority and the atomic
receipt writer. `396455873` refuses an entire batch if any SHA would acquire
a different author; `f1b404998` collapses parallel eligible review edges by
stable reviewer seat. The checked tests in `e9c4324ac` cover all-recipient
commit/rollback, claimant changes, reviewer coalescing and conflicting SHA
provenance. Source receipts:
[writer tests](../../tests/checkout-receipt-writer.test.ts) and
[composition tests](../../tests/checkout-watch-composition.test.ts).
The related writer/review gate log,
`/tmp/vellum-command-checkout-receipt-writer-20260915.log`, records
**46/46 tests in 2 files**, 08:02:39 BRT, before those working-tree fixes
were committed.

`/tmp/vellum-command-checkout-composition-final.log` records **7/7 tests**,
08:05:43 BRT. These create real Git repositories and commit through the real
Canvases, Work, CrewRepository and StateEngine services. They check silent
baseline, commit-before-notify and dedupe, read failure/retry, process
replacement provenance, stopped writes, shared-checkout ambiguity and late
claimant change. Host records are supplied fixtures and notification is
spied; the test ends at the callback, not the PTY or a real reviewer.

### U8 — app lifecycle and control integration

`171492635` starts checkout supervision only in Command Center, follows role
changes, stops it when product automation suspends, and wires the
generation-checked drive release after durable mail authorization. These
are now composed product paths, not merely constructors.

`/tmp/vellum-command-crew-lifecycle-gate-final.log` records **28/28 tests in
4 files**, 08:03:10 BRT: `main-authoring-architecture`, `main-authoring-ipc`,
`index-shutdown-wiring` and `terminal-shutdown-receipts`, all-on with
`--maxWorkers=4`. That run used the shared tree with the later-committed
lifecycle wiring; it did not launch a production package.

`dd0e82d7a` preserves domain `retryable` and next-step details through the
real verdict control socket. Its checked log is
`/tmp/vellum-command-work-control-retryable-green.log`: **48 passed, 1
skipped**, 07:56:54 BRT. Authentication, framing and response mapping are
real; the new cases stub the domain verdict result. This is control-path
qualification, not a model turn.

### E1 — generated mail, prompt and observation journeys

`3d2dc0647` records **5 mail + 7 prompt + 8 wait/observe scenarios passed**.
Their checked [fixture](../../e2e/harness/crew-fixture.ts) uses real PTYs,
process-bound control descendants and app projections with a deterministic
fake TUI. No retained successful run log/report for those 20 scenarios was
independently opened in this assessment, so these cells remain reported.
The fixture correction is now committed and has the actual fake-PTY proof
in E4. Neither that narrower proof nor a new build renews these earlier
complete Electron journeys.

### E2 — generated review workflow, separately from PTY health

`/tmp/vellum-command-crew-review-native-192cbd228.log` records a real
Electron run of the explicitly named **`[fake-tui]`** scenario. It reached
the blocking/repair/green chain, then failed to find `canvas-digest-body`.
The source mount defect was fixed in `a6949909e`.

The corrected run in
`/tmp/vellum-command-crew-review-native-digest-fixed.log` is **1/1 passed**,
including the visible verdict chain and digest. It ran product source
`192cbd228` plus that digest fix in the isolated QA worktree, main PID
`42869`, disposable home `/tmp/vellum-command-e2e-hDhTWj/home`.
The filename's `native` does not turn its fake harness into a real model.

The independently opened trace
`/tmp/vellum-command-crew-review-native-digest-pty.jsonl` also contains an
author claim paste followed by refused continuation and a reviewer
`queue-timeout`. Therefore the passing review workflow is not successful
unattended PTY submission qualification. The complete Electron review
journey has not been rerun after the fixture repair at this cutoff; the
1/1 is historical evidence for the earlier workflow.

### E3 — isolated Devin has not proved delivery

The preserved `/tmp/isolated-devin-mail-facts.json` has `physicalPastes: 0`,
`readAt: null` and an enqueue-only gate reason. The corresponding
`/tmp/isolated-devin-pty-delivery-69728.jsonl` contains nine events: binding
invalidation, evidence and gates, with no physical write event. This proves
neither a read nor written-unresolved containment; no prompt was written.
An artifact's notification label cannot upgrade that trace to accepted
delivery.

`7fd50a94d` fixes the captured directory-trust match: Devin printed
`Yes, trust` without the trailing space required by the former rule.
The classifier regression supplies the captured visible text directly to
`evaluate()`, not a full observer replay. This adapter repair does not
demonstrate that the restarted real harness accepts mail;
the corrected fixture/run still requires fresh, identified evidence.

### E4 — corrected fake fixture over an actual PTY

`2d2e6a4e8` gives the fake Codex process raw UTF-8 input, bracketed-paste
mode and the idle `codex` title. It retains split paste-start/end markers
between input callbacks and records the complete submitted payload's length
and hash. This removes cooked-input echo/buffering that misrepresented the
composer to the observer.

The inspected `/tmp/vellum-command-fake-codex-20260915/report.json` and
`probe.test.ts` exercise the installed fixture through **node-pty**, the real
SessionObserver, SeatStateRuntime and shared drive. Paste markers were
deliberately split across three writes. Before CR, the observer reports
draft, positive pending text, bracketed paste enabled and title `codex`.
The result is submitted with one paste, one CR, one complete 209-byte
15-line submit event, matching SHA-256
`c373534f3f9b9a7141519d7f51f2cf9153cc9ebb610fec91d01b5db4c63c54c0`,
and no attention event. Raw stdin is exactly the paste envelope plus CR.

The retained `probe.log` is **1/1 passed** and `focused.log` is **22/22 in
2 files**, both in that evidence directory. This qualifies the actual fake
process's PTY/observer/drive boundary. It does not launch Electron, traverse
crew authorization or mail receipts, or call a real model provider.

## Aggregate result and remaining qualification

The completed all-on run is preserved at
`/tmp/vellum-command-crew-all-on-integrated-20260915.log`:

| Run | Checked result |
|---|---|
| Shared | 5,044 passed, 18 skipped; 501 passed, 4 skipped files |
| Isolated | 2,540 passed, 44 skipped, 2 failed; 211 passed, 5 skipped, 2 failed files |
| Command | Failed, exit 1 |

The two failures were the write-seam register and a state-write-budget
timing assertion. The latter independently passed 2/2 in a focused
single-worker rerun recorded at
`/tmp/vellum-command-state-budget-focused.log`; this does not make the
aggregate run green. `6767b57fb` registers the missing boundaries, but the
recorded aggregate predates that correction and further edits.

A fresh clean QA checkout,
`/tmp/vellum-command-crew-qa-9e438586`, is pinned to `9e4385864`.
Its build and unit runs are in progress at this update; no result is
claimed for them, and it has not supplied a renewed Electron or native
qualification receipt.

- **Final integrated run:** the focused corrections do not renew the old
  full-suite result. Rerun the final committed bundle and retain its source
  identity and outcomes; no full-green claim is made here.
- **Generated app coverage:** run the complete mail/prompt/wait/review
  journeys against the corrected fixture on the final source. Its bounded
  actual-PTY proof does not clear the historical workflow's hidden stall.
- **Codex live coverage:** the recorded multiline evidence and fake PTY
  boundary now pass; fresh real-harness crew delivery remains unqualified.
- **Real harness/package:** finish the isolated Devin run with actual
  running-source identity, physical-write trace and durable reads/reasons.
  No current checked receipt upgrades any new-crew package cell.
- **Nonblocking drift follow-up:** renderer
  [reviewGateOf](../../src/renderer/lib/crew-review-view.ts#L263) and server
  [evaluateReviewGate](../../src/main/vellum-command/work/reviews.ts#L486)
  duplicate latest-verdict, exact-subject and current-reviewer logic. The
  inspected rules agree today, including blocking winning a same-time tie.
  This is a future drift risk, not a demonstrated current review failure.

## Authentication and historical evidence boundaries

The checked capture manifests document Hermes missing stored Codex
credentials and Kimi lacking configured login/provider; neither observed a
successful model turn. Muse used its deterministic echo provider only.
These are capture-time limitations, not fresh authentication probes or new
crew successes. Primary receipts:
[Hermes](../../tests/pty-e2e/corpus/hermes/manifest.json#L205),
[Kimi](../../tests/pty-e2e/corpus/kimi/manifest.json#L170),
[Muse](../../tests/pty-e2e/corpus/muse/manifest.json#L198).
The log named `/tmp/vellum-crew-auth-matrix-final.log` is a two-test unit
admission receipt, not external harness login evidence.

The [September 14 installed Devin proof](pty-fresh-mail-2026-09-14.md)
belongs to source `ce3c10ae`, before crew. Its preserved replacement
identity/trace artifacts show three physical pastes, three submitted
verdicts, fresh-mail acknowledgement and a two-board completion. It remains
valid for those cases. It cannot qualify new prompt policy, wait/read,
review receipts, verdicts, checkout watches or schema 24.

An external TUI crash between byte acceptance and durable receipt still
prevents a universal exactly-once guarantee. The contract is to preserve
uncertainty, retain delivery identity and prevent an unauthorized repeat;
the remaining matrix must prove those visible behaviors on the final build.
