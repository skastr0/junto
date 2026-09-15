# Crew qualification, 2026-09-15

**The local crew implementation has substantial unit and database evidence;
the complete feature is not qualified in a real harness or a production
package.** The generated review workflow passes in Electron, while its
separate PTY trace still records a stalled fake author prompt. A workflow
assertion cannot stand in for successful terminal submission.

This reconciles the [required crew contract](../crew-contract.md) with
evidence checked through 07:43 BRT, 2026-09-15. Source reviewed includes
`192cbd228` (review receipt producer), `c5023ab8a` (notification and race
coverage), `6767b57fb` (write-seam registration), `a6949909e` (digest mount),
and the arriving `7500d1fc7` checkout adapter. Later dirty changes are listed
as pending, rather than included in those commits' results. This supersedes
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
| Stable mailbox identity, intent/outcome sequences, retained batch membership and crash reconciliation | Checked real repository and adapter transactions, rollback and reopen [U1, U2] | Not a database proof | Reported durable-mail scenarios [E1]; full crash/restart matrix unrun | Pending Devin evidence | Unrun |
| Notification distinct from read/reply/reaction, server sender and typed refs | Checked repository facts and reviewed projection tests [U1, U5] | No receipt proof | Reported mail ledger/read scenarios [E1] | Pending Devin evidence | Unrun |
| Ordinary compact notice, one notice per turn, no automatic repeat after uncertainty | Checked drive/service regressions and accepted-write counts [U2, U4] | Partial: shared submission gates and pending evidence [C1] | Reported mail scenarios [E1]; review trace contains stalled author/queued reviewer [E2] | Unqualified for new crew | Unrun |
| Immediate prompt, body-only 160-character cap, named refusal, same-message retry | Checked named-outcome and existing admission regressions [U4]; current prompt changes need their own rerun | Partial: same shared drive, not the full prompt control path [C1] | Reported 7 prompt scenarios [E1] | Unrun | Unrun |
| Durable notice fallback and explicit same-generation resume/retry | Pending storage, service, drive-release and composition changes [P1] | No qualification | Unrun for durable restart/resume semantics | Unrun | Unrun |
| Seat wait, authorized `--any`, revocation, generation replacement and cancellation | Checked service/observer regressions [U3]; current control dispatch inspected | Partial: state and composer interpretation only [C1] | Reported wait scenarios [E1] | Unrun | Unrun |
| Bounded terminal read/follow and task wait | Checked byte bounds, generation cursor, subscriptions and task events [U3] | Partial: observer grid source, not peer authorization/follow integration | Reported read/follow/task-wait scenarios [E1] | Unrun | Unrun |
| Typed commit evidence produces atomic reviewer receipt mail | Checked real task fact + mailbox + dedupe transaction, rollback, restart and claimant race [U1] | Not a receipt proof | Checked actual producer through generated review journey [E2] | Unrun | Unrun |
| Exact-subject green gate; blocking, repair, new epoch and green chain | Checked current epoch/hash/edge at writer, first-board rejection, stale/standalone-commit cases [U1] | Not a review-authority proof | Checked review journey, visible chain and digest [E2] | Unrun | Unrun |
| Checkout commit watch with exact checkout identity and no ambiguous author inference | Pure attribution/range tests exist; live adapter committed with reported 34 tests, not independently rerun [P2] | Not applicable to Git attribution | Unrun with production watcher composition | Unrun | Unrun |
| Operator mask/rule authoring, mail ledger, review view and digest | Projection/view tests exist [U5] | Not a UI proof | Review view/digest checked [E2]; remaining mail/prompt UI reported [E1] | Unrun | Unrun |
| Additive schema 23 to 24, old rows and frozen history | Real migration fixture exists [U5]; later retry/fallback schema edits still pending [P1] | Not applicable | Generated fresh home does not prove installed upgrade | Unrun installed-upgrade case | Unrun |

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
boot scan does not reconcile current live attempts. These receipts predate
the pending durable fallback/resume additions.

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

### U5 — projection and schema scope

The checked source includes
[mail fact precedence](../../tests/crew-mail-view.test.ts),
[port masks](../../tests/crew-port-mask.test.ts),
[task review projection](../../tests/crew-projection.test.ts), and
[migration 23 to 24](../../tests/crew-schema-migration.test.ts).
The migration fixture checks unchanged existing message/receipt table
definitions and retained work history. Authored tests and aggregate results
are not an independently checked production upgrade; the pending schema
edits also require fresh evidence.

### E1 — generated mail, prompt and observation journeys

`3d2dc0647` records **5 mail + 7 prompt + 8 wait/observe scenarios passed**.
Their checked [fixture](../../e2e/harness/crew-fixture.ts) uses real PTYs,
process-bound control descendants and app projections with a deterministic
fake TUI. No retained successful run log/report for those 20 scenarios was
independently opened in this assessment, so these cells remain reported.
The source is under active fixture correction; neither test authorship nor
a new build silently renews the prior run's result.

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
unattended PTY submission qualification. Fixture investigation remains open.

## Aggregate result and unfinished integration

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

- **P1, durable fallback/resume:** new repository/schema markers, mail
  service grants, adapter methods and drive hold release were dirty at the
  cutoff. They need a committed, checked composition and real restart/resume
  regression. The old scoped-resume 52-test receipt does not prove these
  new durable paths. In particular, the final semantics must match the
  contract's explicit fallback and retry authorization.
- **P2, checkout watch:** `7500d1fc7` commits the bounded Git adapter,
  claim-derived attribution and per-canvas supervisor with an author-reported
  34/34 test result. This assessment opened the source and commit, not that
  run's receipt. Root main-process composition and an end-to-end commit-to-mail
  case were still pending; a supervisor constructor alone does not start
  the product watcher.
- **Generated app coverage:** retain inspectable mail/prompt/wait results,
  finish the fake PTY fixture investigation, and rerun the final source.
  Review workflow success is already evidenced above; it is not pending
  merely because broader terminal qualification remains incomplete.
- **Real harness/package:** finish the isolated Devin run with actual
  running-source identity, physical-write trace and durable reads/reasons.
  No current checked receipt upgrades any new-crew package cell.

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
