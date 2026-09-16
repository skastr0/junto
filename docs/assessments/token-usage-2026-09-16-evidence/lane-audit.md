# Per-lane delivery audit of the sub-agent fleet

Scope: the 15 descendant rollouts of root Codex session `01a09ce9`. The peer-report channel and the
root's waste ledger are owned by sibling panes and are not re-derived here. Round-1 findings
(`/tmp/tt-invest/findings/narrative-loops.md`) are taken as given.

Evidence scripts: `/tmp/tt-invest/p1R-scratch/lanes2.py` (per-lane scan, mode `A`), `finals.py`
(FINAL_ANSWER extraction), `commits3.py` (authorship-tight commit attribution), `artifacts.txt`
(referenced-path existence), `duplication.txt` (cross-lane file:line overlap).

---

## Criteria, stated before they are applied

A lane **earned its tokens** if it produced at least one of:

- **(A) a landed commit** — a hash the lane attributes to itself with first-person phrasing
  ("Committed `x`", "Delivered `x`", "Landed `x`") that resolves to a real commit in
  `/Users/guilhermecastro/Projects/vellum`; or
- **(B) a landed file** — a repo test/doc file that exists today and that the lane states it wrote,
  even when another lane committed it (several lanes were explicitly told "no commit, as instructed");
- **(C) a consumed finding** — a specific defect with a `file:line` receipt that a different lane or
  the root verifiably acted on, established by inspecting the resulting commit or file.

A lane is **marginal** if its only deliverable is a finding whose consumption I could not verify. A
lane is **wasted** if nothing under (A), (B) or (C) is recoverable.

Efficiency is reported as **input tokens ÷ landed artifacts** (A + B). Three lanes deliver only under
(C); for those I report tokens ÷ verified-consumed findings instead and mark the row with †, because
mixing the two denominators would flatter reviewer lanes and punish builder lanes. **Result:
15 earned (12 with landed artifacts, 3 findings-only), 0 marginal, 0 wasted.**

---

## Per-lane ask, deliverable and verdict

The literal task text is **not recoverable** for any lane: the initial instruction is a
`Message Type: NEW_TASK` `agent_message` whose cleartext payload is empty and whose body is
`encrypted_content` (888 B for `coverage_review`), and the parent's `spawn_agent` argument is
encrypted too. The `ask` column is therefore each lane's **own first assistant message after that
boundary**, which restates its task in its own words. Deliverables are quoted from the lane's
`FINAL_ANSWER` messages, which are fully cleartext.

| lane | spawned → ended (UTC) | the ask (lane's own restatement of its task) | the deliverable — substance of its largest FINAL_ANSWERs | verdict | why |
|---|---|---|---|---|---|
| `coverage_review` | 2026-09-13T22:38:34<br>→ 2026-09-15T11:43:38 | The `tests/pty-e2e` suite does **not** satisfy visual app E2E acceptance. It exercises real production classes against recorded output or an in-process TUI model; it never launches Electron or capture… | **ord 3622** (3783 B): The claim path still has two duplication mechanisms independent of failed-submit containment. - **Progress changes the receipt key.** [kernel/service.ts:1117](/Users/guilhermecastro/Projects/vellum/src/main/vellum-command/kernel/service.ts:… <br> **ord 135** (3458 B): The `tests/pty-e2e` suite does **not** satisfy visual app E2E acceptance. It exercises real production classes against recorded output or an in-process TUI model; it never launches Electron or captures the app. The largest evidence gaps: - …<br>*2 finals, 8 authored commits* | **EARNED** | 8 commits incl. the retry-storm root cause and the claim-identity diagnosis; worst rate of the big lanes |
| `production_build_review` | 2026-09-14T00:45:24<br>→ 2026-09-15T11:43:22 | Use `bash scripts/build-app.sh --target mac --sign` for a fresh signed macOS bundle. It rebuilds main/renderer/preload, standalone CLI, and native `node-pty`; requires pinned Bun 1.3.13 and committed … | **ord 5063** (2706 B): No Vellum Command or QA process is running now. Installed/release bundles still contain `eefaafff`, cohort `e29aeedd-a715-4212-80a3-129e41b18326`; current HEAD is `d1543a09`. Existing provenance/build tooling is sufficient; no helper edits … <br> **ord 3226** (2084 B): Use `bash scripts/build-app.sh --target mac --sign` for a fresh signed macOS bundle. It rebuilds main/renderer/preload, standalone CLI, and native `node-pty`; requires pinned Bun 1.3.13 and committed source. Add `--verify` for typecheck, al…<br>*2 finals, 10 authored commits* | **EARNED** | 10 commits + diagnosed and recovered the Devin fan-out |
| `pty_delivery_assessment` | 2026-09-14T01:42:31<br>→ 2026-09-15T11:43:38 | Current transport still has several independently demonstrated correctness defects. The screenshot’s exact sequence cannot be attributed without its write trace. However, I independently read `34b4e3d… | **ord 3633** (5812 B): Current transport still has several independently demonstrated correctness defects. The screenshot’s exact sequence cannot be attributed without its write trace. However, I independently read `34b4e3d9` and confirmed that build still contai… <br> **ord 5095** (3053 B): The “six unguarded side doors” claim is misleading. Verified against `d1543a09`; no files modified. \| Claim \| Verdict and receipt \| \|---\|---\| \| Local overseer falls back to raw prompt when drive is unavailable \| **Refuted.** Both pr…<br>*2 finals, 9 authored commits* | **EARNED** | 9 commits + specified the submission-continuation fix that became `7d2d6cb1` |
| `live_trace_options` | 2026-09-13T22:47:23<br>→ 2026-09-15T11:44:43 | Use direct `electron-vite dev` with a fresh absolute `VELLUM_COMMAND_HOME`, unchanged `HOME`, `VELLUM_COMMAND_DEV_TOOLS=1`, and `VELLUM_PERF=1`. Clear inherited work-control/E2E variables first. This … | **ord 386** (1920 B): Use direct `electron-vite dev` with a fresh absolute `VELLUM_COMMAND_HOME`, unchanged `HOME`, `VELLUM_COMMAND_DEV_TOOLS=1`, and `VELLUM_PERF=1`. Clear inherited work-control/E2E variables first. This runs the actual app and actual installed… <br> **ord 1309** (1168 B): The existing seed scripts do **not** satisfy the sole-opener requirement: both open production SQLite externally; the shell script also checkpoints it. Fastest existing full-state source is the retained [September 13 backup](/Users/guilherm…<br>*2 finals, 10 authored commits* | **EARNED** | 10 commits incl. the PTY delivery trace the whole session depended on |
| `coverage_review/claim_test_gaps` | 2026-09-14T01:43:09<br>→ 2026-09-15T11:36:05 | The existing claim regression covers refusal and stalled-paste containment. It does not exercise history changes after acceptance, process restart, or competition between claim briefings and mailbox d… | **ord 1940** (3082 B): **Retained events can rebuild an ephemeral delivery view, but the current report path never supplies ordinary mailbox mail to its Remote recipient.** - **Distribution:** CC emits only its `(CC, targetRemote)` command lane; its local fact la… <br> **ord 873** (2093 B): The requested claim lifecycle is untested in the checked-in suite. - [Kernel regression](/Users/guilhermecastro/Projects/vellum/tests/kernel-claim-delivery-stall.test.ts:258) covers pre-write retry → acceptance, but never modifies history o…<br>*2 finals, 0 authored commits* | **EARNED** | wrote 3 test suites that landed under other lanes' commits |
| `production_build_review/amp_replay_review` | 2026-09-14T15:56:05<br>→ 2026-09-15T11:42:13 | Recommended focused replacement for `amp-composer-readiness.test.ts`: - Replay each of `startup-idle`, `type-echo`, `paste-chip`, and `working-turn` into a **fresh** `SessionObserver`, `SeatStateRunti… | **ord 623** (3014 B): Recommended focused replacement for `amp-composer-readiness.test.ts`: - Replay each of `startup-idle`, `type-echo`, `paste-chip`, and `working-turn` into a **fresh** `SessionObserver`, `SeatStateRuntime`, and shared factory drive at **120×3… <br> **ord 1163** (1999 B): Read-only inventory complete; no edits or checks run. \| Caller \| Boolean assumption \| Recommendation \| \|---\|---\|---\| \| `term/managed-pulse-bridge.ts:13–17, 37–41` \| Writer still returns `Promise<boolean>` \| Change **writer** to `…<br>*2 finals, 1 authored commits* | **EARNED** | 1 commit; its `ManagedPromptOutcome` inventory fed the parent's `c3122f3a`/`ca170b43` |
| `live_trace_options/trace_tests` | 2026-09-13T23:33:15<br>→ 2026-09-15T11:32:55 | Added [pty-delivery-trace.test.ts](/Users/guilhermecastro/Projects/vellum/tests/pty-delivery-trace.test.ts). **9/9 pass** covering redaction, queued correlation and acknowledgements, gate evidence, th… | **ord 2825** (1026 B): Use the captured trust screen before one GUI Enter: question, selected `❭ 1 Yes, trust`, and exit option. It exists in [mail-notice.jsonl](/Users/guilhermecastro/Projects/vellum/tests/pty-e2e/corpus/devin/mail-notice.jsonl:1). Then require … <br> **ord 964** (955 B): At `886f1255`: - **Metadata overstates Hermes submission evidence.** [Manifest:132](/private/tmp/vellum-composer-adapters/tests/pty-e2e/corpus/hermes/manifest.json:132) says idle returns; line 125 records `false`. [Captured frames](/private…<br>*2 finals, 0 authored commits* | **EARNED** | wrote 2 suites that landed; corrected capture metadata the parent had trusted |
| `pty_delivery_assessment/fixture_receipt_review` | 2026-09-14T04:37:24<br>→ 2026-09-15T11:41:02 | Fixture passes: dimensions 136×37, 37 lines, composer/rules/footer exact; private transcript replaced. Independent replay matches native capture: low-confidence idle, draft composer, chip present. Two… | **ord 2626** (2350 B): Verified evidence inventory: - **Fake Electron mail/prompt/wait:** source contains 5 mail, 7 prompt, 8 wait/observe scenarios. Commit `3d2dc0647` reports **20/20 passed** on all-on Electron, but I found no archived pass log to independently… <br> **ord 2749** (1663 B): No confirmed new defect in the repository operations reviewed. - `grantHeldAttempt` uses one transaction and exact canvas/node/message/seat/generation predicates; it refuses notified, non-held and already-open rows ([crew-repository.ts:763]…<br>*2 finals, 2 authored commits* | **EARNED** | 2 commits + 1 suite; refuted an unproven parent claim |
| `mail_receipt_fix` | 2026-09-14T03:01:29<br>→ 2026-09-14T13:19:50 | I’ll inspect the mailbox delivery implementation, its focused tests, and the governing security notes, then reproduce the failure through the public service APIs before patching only the two owned fil… | **ord 7806** (3589 B): Read-only reconciliation: **Legitimately fixed in committed code** - **S7 phantom batch receipts:** `02a420ab` stores immutable `acceptedBatchMembers`; recovery stamps only IDs in the accepted payload. Proven by `batch receipt recovery only… <br> **ord 5101** (665 B): Implemented and committed the mailbox batch receipt fix. - Added immutable accepted batch membership tracking in `message-delivery.ts`. - Recovery stamps only IDs from the accepted transport payload. - Added public API regression: A/B accep…<br>*2 finals, 2 authored commits* | **EARNED** | 2 commits, zero chatter — cleanest message profile in the fleet |
| `factory_message_sources` | 2026-09-14T01:42:23<br>→ 2026-09-14T03:44:36 | The feature has several independent delivery owners that converge only at the PTY’s `writePrompt(bindingId, text, options): Promise<boolean>`. Source identity and durable receipts do not reach the que… | **ord 3590** (5303 B): The feature has several independent delivery owners that converge only at the PTY’s `writePrompt(bindingId, text, options): Promise<boolean>`. Source identity and durable receipts do not reach the queued write. \| Producer \| Trigger and ro… <br> **ord 4083** (1211 B): Both defects reproduced. Artifacts: - [Standalone probe](/tmp/vellum-command-pty-matrix-20260914/mail-probes.ts) - [JSON results](/tmp/vellum-command-pty-matrix-20260914/mail-probes.results.json) Rerun: ```sh bun --no-install --cwd /Users/g…<br>*2 finals, 1 authored commits* | **EARNED** | 1 commit; produced the producer/identity table and reproduced 2 mail defects |
| `matrix_inventory` | 2026-09-14T01:56:02<br>→ 2026-09-14T15:40:12 | Inventory complete: [matrix JSON](/tmp/vellum-command-pty-matrix-inventory.json), derived from `eefaafff`. No source modifications, live-app actions, or test executions. **Canonical matrix:** 15 regis… | **ord 4103** (3240 B): **Confirmed source wiring gap for the displayless Node Remote; observer/state evaluation is present.** No live process or test was run. \| Plane \| Node Remote source result \| \|---\|---\| \| PTY host, raw control, screen observer \| Prese… <br> **ord 3814** (2196 B): Inventory complete: [matrix JSON](/tmp/vellum-command-pty-matrix-inventory.json), derived from `eefaafff`. No source modifications, live-app actions, or test executions. **Canonical matrix:** 15 registry IDs: `claude`, `codex`, `grok`, `her…<br>*2 finals, 1 authored commits* | **EARNED** | 1 commit; produced the canonical 15-harness matrix the fan-out consumed |
| `production_build_review/amp_replay_review/amp_test_review` | 2026-09-14T16:12:41<br>→ 2026-09-15T10:21:27 | I’ll check the recorded ACK wiring and scenario selection for material false positives, keeping the review read-only. | **ord 955** (1535 B): - **Current information loss:** `term/managed-spawn-plan.ts:72–94` collects undirected neighbors without grants; `shared/managed-terminal-injection.ts:374–395` groups only by kind. `nodeHasActionableFactoryEdge` also excludes agent-only con… <br> **ord 1020** (1332 B): - **Roundtrip:** `term-control.ts:298–306` accepts known `ports`, including `[]`; missing ports also decode. Unknown ports, nonarrays, or an extra `grants` key reject. Decode returns its input (`:344`), so JSON-serialize/parse first, then a…<br>*2 finals, 0 authored commits* | **EARNED (findings-only)** | 1 verified finding landed (`397313579`); no artifact of its own |
| `native_cli_path` | 2026-09-15T11:33:28<br>→ 2026-09-15T11:39:44 | Committed **39ccbd53**. Isolated Devin now requires a matching committed, all-on standalone CLI, verifies its receipt/hash, and copies it into sandbox `.local/bin` before credential seeding. **12/12 t… | **ord 16018** (477 B): Committed **39ccbd53**. Isolated Devin now requires a matching committed, all-on standalone CLI, verifies its receipt/hash, and copies it into sandbox `.local/bin` before credential seeding. **12/12 tests pass**, brand lint passes; owned fi…<br>*1 finals, 1 authored commits* | **EARNED** | 1 commit; 77% of its cost is inherited-context re-read |
| `live_trace_options/trace_tests/credential_scan` | 2026-09-14T15:32:20<br>→ 2026-09-15T11:07:47 | At `886f1255`, scanned 13 committed files and decoded all 26 frames (549,548 bytes). Matches: private keys **0**, provider tokens **0**, JWTs **0**, bearer tokens **0**, credential assignments **0**, … | **ord 1181** (1215 B): `lines: 40` already requests the bottom 40 lines of the **observer viewport**. There is no `maxChars` or bottom-offset argument. - Defaults: **40 lines**, maximum **2,000**, fixed **64 KiB** byte cap. [seat-control.ts:28](/Users/guilhermeca… <br> **ord 792** (660 B): The public `CanvasesService.read` path and shared real `StateEngine` are genuine. Three material assertion gaps: - **MEDIUM, lines 222–230:** foreign sink/canvas verdicts lack corresponding task rows, so the SQL join discards them before sc…<br>*2 finals, 0 authored commits* | **EARNED (findings-only)** | 2 findings landed in `tests/crew-projection.test.ts`; 4 null secret scans |
| `factory_message_sources/claim_identity_review` | 2026-09-14T03:24:03<br>→ 2026-09-14T03:38:03 | Use the material task’s `fact_event_home/fact_entity_home/fact_seq` as the anchor, then follow exact predecessor identities to the nearest `task.claim`. - Return `WorkRecordId \| undefined`; verify cu… | **ord 457** (1748 B): Use the material task’s `fact_event_home/fact_entity_home/fact_seq` as the anchor, then follow exact predecessor identities to the nearest `task.claim`. - Return `WorkRecordId \| undefined`; verify current row is active and belongs to the e… <br> **ord 602** (836 B): Found three issues in the focused diff: 1. **SQL blocker, now corrected:** `work_facts` uses `result_json`, not `body_json`. 2. **Upgrade replay after editing the brief:** `describeTask` replaces `history[0]`. If that was the saved claim bo…<br>*2 finals, 0 authored commits* | **EARNED (findings-only)** | 3 findings, all 3 verified in `4cf844a5` — best tokens-per-outcome in the fleet |

---

## Per-lane table

`alive` = last record minus first record in the lane's own rollout. `msgs` = all agent_messages the
lane emitted, counted across every recipient's rollout (a lane's outgoing messages are recorded in the
**recipient's** file, never in its own — see the correction in §7). `chatter` = envelope-only
`MESSAGE` notifications with an empty cleartext payload. `cmp inh/perf` = compaction records inherited
from the fork versus compactions the lane actually performed. `tok/landed` = input tokens ÷ landed
artifacts.

| lane | d | nickname | alive | resp | msgs | FINAL | chatter | commits | files | landed | cmp inh/perf | input tokens | % of fleet | tok/landed |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `coverage_review` | 1 | Dirac | 37.1 h | 737 | 208 | 26 | 163 | 8 | 0 | **8** | 0/8 | 100,908,894 | 24.2% | 12.61M |
| `production_build_review` | 1 | Huygens | 35.0 h | 506 | 143 | 20 | 104 | 10 | 0 | **10** | 1/5 | 67,341,737 | 16.1% | 6.73M |
| `pty_delivery_assessment` | 1 | Hubble | 34.0 h | 429 | 118 | 19 | 86 | 9 | 0 | **9** | 1/5 | 60,124,323 | 14.4% | 6.68M |
| `live_trace_options` | 1 | Aquinas | 37.0 h | 379 | 117 | 17 | 85 | 10 | 0 | **10** | 0/4 | 51,881,042 | 12.4% | 5.19M |
| `coverage_review/claim_test_gaps` | 2 | Noether | 33.9 h | 181 | 56 | 19 | 37 | 0 | 3 | **3** | 1/2 | 25,868,848 | 6.2% | 8.62M |
| `production_build_review/amp_replay_review` | 2 | Dewey | 19.8 h | 186 | 67 | 19 | 38 | 1 | 0 | **1** | 1/2 | 24,592,485 | 5.9% | 24.59M |
| `live_trace_options/trace_tests` | 2 | Kierkegaard | 36.0 h | 158 | 56 | 13 | 37 | 0 | 2 | **2** | 0/1 | 20,846,137 | 5.0% | 10.42M |
| `pty_delivery_assessment/fixture_receipt_review` | 2 | Herschel | 31.1 h | 126 | 42 | 13 | 29 | 2 | 1 | **3** | 1/1 | 16,706,235 | 4.0% | 5.57M |
| `mail_receipt_fix` | 1 | Hegel | 10.3 h | 115 | 5 | 5 | 0 | 2 | 0 | **2** | 0/1 | 14,219,593 | 3.4% | 7.11M |
| `factory_message_sources` | 1 | Carson | 2.0 h | 90 | 22 | 4 | 16 | 1 | 0 | **1** | 1/1 | 10,688,522 | 2.6% | 10.69M |
| `matrix_inventory` | 1 | Bohr | 13.7 h | 77 | 15 | 4 | 11 | 1 | 0 | **1** | 1/1 | 9,022,385 | 2.2% | 9.02M |
| `production_build_review/amp_replay_review/amp_test_review` | 3 | Laplace | 18.1 h | 60 | 17 | 10 | 7 | 0 | 0 | **0** | 0/0 | 7,868,764 | 1.9% | 7.87M † |
| `native_cli_path` | 1 | Locke | 0.1 h | 28 | 8 | 1 | 7 | 1 | 0 | **1** | 7/0 | 2,964,896 | 0.7% | 2.96M |
| `live_trace_options/trace_tests/credential_scan` | 3 | Russell | 19.6 h | 31 | 12 | 6 | 6 | 0 | 0 | **0** | 0/0 | 2,743,145 | 0.7% | 2.74M † |
| `factory_message_sources/claim_identity_review` | 2 | Faraday | 0.2 h | 24 | 8 | 2 | 6 | 0 | 0 | **0** | 1/0 | 1,647,671 | 0.4% | 1.65M † |
| **fleet total** | | | | **3,127** | **894** | **178** | **632** | **45** | **6** | **51** | | **417,424,677** | 100% | 8.19M |

† measured against **verified-consumed findings** rather than landed artifacts: `amp_test_review` 1,
`credential_scan` 2, `claim_identity_review` 3. See §4.

Totals reconcile with `SESSION2.md` exactly: descendant input 417,424,677; responses 3,127.

Note on the `files` column: it counts files that landed under a **different** lane's commit. A seventh
file of the same kind, `amp_replay_review`'s `crew-doctrine-grants.test.ts`, was committed by the lane
itself in `1afba33f0`, so it is counted once, under `commits` rather than `files`.

### Verdict

**All 15 lanes delivered something verifiable; none is wasted.** 45 commits carry first-person
attribution from a lane and resolve to real commits in the repo; 6 further test files were written by
lanes that were told not to commit and were committed by their parents; and the three lanes with
neither produced findings that are demonstrably in the current code. Cross-lane duplication is
negligible: of **148 distinct `file:line` references** across all 178 FINAL_ANSWERs, only **5 were
cited by two different lanes and none by three** (`duplication.txt`). The fleet partitioned the
problem rather than repeating it.

**The burn is not misallocated across lanes; it is structurally inflated.** Per-response input is
nearly constant across the fleet — 68,653 to 142,921 tokens, mean **133,490**, against the root's
147,662 — so a lane's cost is `responses × context`, exactly the law the coordinator established for
the root. What varies between lanes is only how long each stayed alive and how fast it responded. Two
structural multipliers dominate:

1. **The inherited-context tax: 113,465,903 tokens = 27.2% of the descendant spend** (16.1% of the
   whole ~704M effort). Each lane forks the parent's history and re-reads it on every response; this
   is `first_ctx × responses`, and it is a *fixed* cost per lane that only amortizes if the lane does
   a lot of work. `native_cli_path` is the extreme case: it forked an 81,078-token context, made 28
   responses in six minutes, and **77% of its 2.96M tokens is that fork being re-read**.
2. **15 concurrent lanes, most of them parked.** `credential_scan` was alive 19.6 h for 31 responses
   (1.6 responses/hour); `trace_tests` 36.0 h for 158; `claim_test_gaps` 33.9 h for 181. A parked lane
   still costs nothing per second — but the moment it responds it re-reads its full inherited context,
   so a wide fleet pays the fork tax many times over for a small total number of responses.

The honest answer to "about right or obviously misallocated" is: **the allocation was fine and the
per-lane output was real; the shape was expensive.** Cutting lanes would have cut real deliverables.
Cutting the *fork* (spawning lanes with a pointer to the parent's artifacts instead of a copy of its
history) is what the 113.5M would have bought.

---

## 1. Did `coverage_review` deliver value proportionate to 14.3% of the effort?

**Short answer: it delivered more than any other single lane, at the worst rate in the fleet. It
earned its tokens, but it is the single biggest efficiency loss in the effort.**

Numbers: 100,908,894 input tokens (24.2% of the descendant spend; 14.3% of the ~704M effort), 737
responses, 208 messages emitted of which **163 (78%) were envelope-only notifications with an empty
cleartext payload**, 8 compactions, 26 FINAL_ANSWERs, 8 authorship-attributed commits. That is
**12.61M tokens per landed commit** — the worst rate of the four depth-1 "big" lanes
(`live_trace_options` 5.19M, `pty_delivery_assessment` 6.68M, `production_build_review` 6.73M) — and
**6.3 notifications per deliverable**.

Its 8 verified commits:

| commit | subject |
|---|---|
| `27517c619` | test(term): reproduce destructive working-claim redelivery |
| `b3b53c219` | test(term): assert bounded recovery in drive scenarios |
| `ae13b0c7a` | fix(work): refund rejected deliveries before a paste |
| `91df3c310` | docs(pty): distinguish current qualification from historical matrix |
| `4a1860876` | feat(cli): discover crew mail and seat operations |
| `466f438e2` | feat(work): compose checkout receipts with live factory authority |
| `7087edea5` | fix(term): recognize the active Devin command approval chooser |
| `166392050` | fix(work): classify checkout task sinks through factory physics |

And its load-bearing findings. Three of these changed what the root did next:

- **ord 1457 (23:35:13)** — *"Confirmed: an accepted paste can return `false`, send Ctrl+C, and be
  delivered again on the next kernel cycle. Primary receipts: Successful physical paste is counted
  before subsequent CR/ack failure: [managed-terminal-drive.ts:1089]… Cleanup writes Ctrl+C without
  checking `isSeatIdle`: [managed-terminal-drive.ts:1026]."* This is the retry-storm root cause; it
  drove the containment commit `91546531`.
- **ord 3622 (01:48:09)** — *"The claim path still has two duplication mechanisms independent of
  failed-submit containment. **Progress changes the receipt key.** kernel/service.ts:1117 uses the
  newest history message as the claim boundary… **Successful transport followed by failed receipt
  persistence can replay.**"* This is the diagnosis behind `4cf844a5` ("anchor claim delivery receipts
  to work facts").
- **ord 8664 (15:29:37)** — *"Three findings in `aeef95ae`: **Blocking:** Command Center pulse
  registration calls its own dispatcher recursively. Probe produced a stack overflow with zero drive
  writes. **Missing Remote mail source:** … **Generation ownership:** identical doctrine text lets an
  old completion consume a newly armed generation's doctrine."* A blocking defect, caught by review.

Plus the canvas decoder defects at `src/shared/canvas.ts:748` and `:716` (ord 11094), the renderer and
transport audit (ord 4544), and the Devin approval-chooser classification fix (`7087edea`).

**Judgement.** Its FINAL_ANSWERs are not padding: 26 of them, most carrying a commit hash or a
`file:line` receipt, and three that redirected the root's plan. If you price the lane by what it
found, it is the most productive lane in the fleet. If you price it by what it cost per unit, it is
the least efficient. Both statements are true, and the reason is structural rather than behavioural:
it was the **first lane spawned (22:38:34) and the last to stop (11:43:38)** — alive for 37.08 of the
session's 37.09 hours — so it accumulated 737 responses at 19.9 responses/hour, and every one of them
re-read a context that grew all session. Its compaction cadence (1 per 92 responses) matches the root's
exactly (1 per 92), so it was not compaction-pathological.

**Where the 14.3% actually went:** 23.3M tokens (23.1%) is the inherited-context tax (31,600 × 737);
the remaining 77.6M is the cost of 737 responses over a growing context. It is not that the lane did
wasteful things — it is that it was alive for the entire session and kept answering.

---

## 2. The Devin fan-out versus the Codex-native sub-agents

**The distinction can be made from the log, and it is unambiguous: none of the 15 lanes belongs to
the Devin fan-out.**

Positive identification of the 15: every one has `session_meta.thread_source == "subagent"` and a
`session_meta.source.subagent.thread_spawn.parent_thread_id` that chains to `01a09ce9` (verified by
`lanes2.py` `chain_to_root()`; two files with a parent that chains to a *different* root —
`/root/platform_test_skips` and `/root/landing_deploy`, parent `01a093ea-…` — were excluded). They
are Codex-native sub-agents, each with a `~/.codex/sessions/2026/09/…/rollout-*.jsonl`.

The Devin fan-out leaves a completely different footprint:

- A Prism workflow run: `prism workflow runs show 2cb0474e-cf02-48ef-a1cb-ea11172ff51c --store /tmp/vellum-command-pty-matrix-20260914/harness-live.sqlite` (4× in the root's shell calls, from root ordinal 3993).
- `/tmp/vellum-command-pty-matrix-20260914/session-map.json` — `runId`s `2cb0474e-…` (14 tasks) and
  `4f56bc47-…` (8 tasks), **22 tasks, `workflowTaskStatus: "failed"` for all 22**, with task IDs
  `harness_claude`, `harness_codex`, `harness_grok`, `harness_hermes`, `harness_pi`,
  `harness_prime_agent`, `harness_kimi`, `harness_muse`, `harness_devin`, `harness_cursor`,
  `harness_agy`, `harness_amp`, `harness_fx`, `harness_omp`, plus `claims_receipts`, `mail_producers`,
  `drive_protocol`, `observer_evidence`, `local_transport`, `remote_transport`, `renderer_lifecycle`,
  `lifecycle_coverage`.
- Devin session names (`rhinestone-chinchilla`, `jasper-larkspur`, `deadpan-astronomy`, `valley-flare`,
  `zenith-hiss`, `good-handbell`, …) with identity receipts pointing at
  `~/.local/share/devin/cli/logs/devin_*.log`. **106 Devin CLI logs** were written in the
  2026-09-13 22:00 → 2026-09-14 04:00 local window.
- No rollout file anywhere under `~/.codex/sessions/` is a Devin session (0 matches).

**Two of the 15 Codex lanes serviced the fan-out, which is exactly the conflation to avoid:**

- `matrix_inventory` (spawned 01:56:02, inside the fan-out window) produced the canonical
  15-harness/12-axis matrix JSON at `/tmp/vellum-command-pty-matrix-inventory.json` — the *input* the
  Prism workflow fanned out over. The root assigned "ten distinct audit lanes" 49 seconds after this
  lane reported (root ord 3799, 02:00:27).
- `production_build_review` diagnosed and recovered it: ord 3963 (02:09:57) *"Root cause is confirmed:
  **Devin's noninteractive `auto` mode rejected a shell command needing approval, ended the turn, and
  Prism misclassified the incomplete export as bad JSON.**"*; ord 4357 (02:27:20) *"Both recoveries
  completed successfully with unchanged `auto` permissions, preserved sessions, **zero further
  tools**, and valid final JSON."*; ord 4422 (02:30:35) *"Preserved all 22 task-to-session mappings
  with evidence in session-map.json."*

So the "14 harnesses, 14 Devins" fan-out cost 22 failed Devin tasks and appears in **zero** of the 15
rollouts; the Codex-native fleet was the thing that diagnosed it. Any accounting that adds the Devin
sessions to these 15 would double-count, and any accounting that treats the 15 as "the fan-out" would
be wrong about what they were doing.

---

## 3. Nesting

**Correction to the brief:** there are **five** lanes at depth 2, not three, and two at depth 3. The
five depth-2 lanes are `coverage_review/claim_test_gaps`, `live_trace_options/trace_tests`,
`production_build_review/amp_replay_review`, `pty_delivery_assessment/fixture_receipt_review`, and
`factory_message_sources/claim_identity_review`. Also, three of SESSION2's lane names are
abbreviations of the real `agent_path`: `claim_identity` → `/root/factory_message_sources/claim_identity_review`;
`credentials` → `/root/live_trace_options/trace_tests/credential_scan`; `…` →
`/root/production_build_review/amp_replay_review/amp_test_review`.

The delegation protocol makes children useful for one specific reason, and the log shows it
consistently: **a child gets a clean, narrow context and can afford to be adversarial, while the
parent is deep in integration work.** In four of the five chains the child's output is a *refutation
or a gap list*, not more of the same work.

### Chain 1 — `coverage_review` → `claim_test_gaps` (depth 2) → nothing

Cost 25,868,848 / 181 responses / 33.9 h; 0 commits, 3 landed test files; 1 inherited + 2 performed
compactions. **What it added that the parent could not:** it wrote the test suites that the parent was
too deep in integration to write, and it repeatedly reported them as *failing*, which is the useful
half. ord 873: *"The requested claim lifecycle is untested in the checked-in suite."* ord 3468:
*"Strengthened the fifth test and ran the file: **3 passed, 2 failed**. - Stale epoch-0 blocking write
incorrectly succeeds after epoch-1 reclaim. - Receipt failure trigger remains bypassed."* ord 3910:
*"Run: **1 passed, 1 failed**. Review completion correctly refuses; ordinary working updates currently
drop supplied completion evidence."* Three of its files landed:
`tests/crew-review-service.test.ts` (917 lines, committed in `c5023ab8a`),
`tests/crew-review-service-remote.test.ts` (235 lines, `7d8faeb09`),
`tests/checkout-watch-composition.test.ts` (400 lines, `466f438e2`). It also independently reproduced
the parent's two `canvas.ts` decoder findings (see §7 on duplication).

### Chain 2 — `live_trace_options` → `trace_tests` (depth 2) → `credential_scan` (depth 3)

Cost 20,846,137 / 158 responses / 36.0 h, then 2,743,145 / 31 responses / 19.6 h. **What `trace_tests`
added:** it wrote the two suites that turned the parent's instrumentation into gates —
`tests/pty-delivery-trace.test.ts` (262 lines, committed `2687ce329`) and
`tests/crew-projection.test.ts` (committed `b49807fba`) — and it audited capture metadata that the
parent had taken on trust: ord 964 *"**Metadata overstates Hermes submission evidence.** Manifest:132
says idle returns; line 125 records `false`."* That correction produced `a3bd61cd` and `0fd236335`.
**What `credential_scan` added:** a secrets sweep of the growing PTY corpus and an adversarial read of
the parent's own new test. Four scans, all null (ord 222: 13 files / 26 frames / 549,548 bytes / 0
matches; ord 420: 19 frames / 0 matches; ord 552: 46 frames / 1,194,375 bytes / 0 matches), then the
gap list at ord 792: *"**MEDIUM, lines 222–230:** foreign sink/canvas verdicts lack corresponding task
rows, so the SQL join discards them before scope filtering. Create those foreign tasks. **MEDIUM,
lines 271–274:** scale assertions check lengths only. Reusing one verdict/attempt across every item can
pass; assert each item's verdict ID and queued timestamp."* Both landed: `tests/crew-projection.test.ts`
now creates `foreign-home` / `foreign-sink` / `foreign-canvas` tasks (lines 231–236) and asserts
per-item `verdictId` (line 292).

### Chain 3 — `production_build_review` → `amp_replay_review` (depth 2) → `amp_test_review` (depth 3)

Cost 24,592,485 / 186 responses / 19.8 h, then 7,868,764 / 60 responses / 18.1 h. **What
`amp_replay_review` added:** it owned the Amp readiness corpus end-to-end — the replacement spec
(ord 623), the 13/13 passing standalone replay (ord 997), `tests/crew-doctrine-grants.test.ts`
(11,505 bytes, committed `1afba33f0`) — and it carried the `ManagedPromptOutcome` boundary analysis
that became `c3122f3a` and `ca170b43`. **What `amp_test_review` added:** adversarial review of its
parent's own tests, and the single sharpest finding of that chain, ord 487 (09:05:10): *"**Remote false
success:** `term/control-server.ts:675` returns the outcome object; `term/control-client.ts:862`
applies **`Boolean(res.data)`**, making refused/unresolved outcomes true. `term/router.ts:654`
propagates that into `overseer/native.ts:637–640`, which reports delivery."* This landed as
`397313579 fix(term): preserve uncertain submission outcomes at transport boundaries` — the current
file now reads `readManagedPromptOutcome(res.data)` and throws `TermControlTransportUncertainError`.
Its parent relayed the same finding 96 seconds later (ord 1394), so the child found it and the parent
carried it upward.

### Chain 4 — `pty_delivery_assessment` → `fixture_receipt_review` (depth 2) → nothing

Cost 16,706,235 / 126 responses / 31.1 h; 2 commits + 1 landed file. **What it added:** independent
refutation, which the parent could not do for its own claims. ord 1306: *"**Confirmed:** late resize
ACK from lease A can suppress lease B's first resize permanently. `TerminalSurface.tsx:826–875` shares
in-flight/ACK state across leases."* ord 1595: *"Two confirmed defects: **Stale generation read:**
`observer/index.ts:158` returns a disposed observer's empty old-generation window after replacement…
**Exact-fit clipping:** `seat-control.ts:300` counts an extra trailing newline."* And the sharpest
kind of contribution, a *refusal*: ord 3313: *"The saved trace **does not prove false submission or
notification**. It proves `msg.send` accepted message `01M2JD9JY81E9ZSCQHXPYQ8159`, then the
unresolved-row count stayed zero for 90 seconds."* It wrote `tests/terminal-surface-lifecycle.test.ts`
(8,445 bytes, committed `821dcead8`).

### Chain 5 — `factory_message_sources` → `claim_identity_review` (depth 2) → nothing

Cost 1,647,671 / 24 responses / 12 minutes; 0 commits, 0 files, but 3 findings **all three of which
are in `4cf844a5`**. This is the tightest delegation in the fleet. ord 602: *"Found three issues in the
focused diff: 1. **SQL blocker, now corrected:** `work_facts` uses `result_json`, not `body_json`. 2.
**Upgrade replay after editing the brief:** `describeTask` replaces `history[0]`. If that was the saved
claim boundary, `findIndex` returns `-1` and the fallback misses an existing receipt. Always check the
immutable boundary ID… 3. **Cache eviction order:** filling newest-to-oldest evicts the current material
head on histories longer than 1,024 facts. Fill in reverse order."* Verified in the commit:
`git show 4cf844a50` contains `json_extract(fact.result_json, '$.task.history[0].messageId')`,
`boundary_message_id` / `boundary_index` columns, a comment reading *"Describe replaces history[0], so
retain the original boundary"*, and `for (const key of Array.from(visited).reverse())`.

### Where the log does **not** show the child's contribution

`amp_test_review` and `credential_scan` have no commits and no files; their value rests entirely on
findings being consumed by another lane, which I verified for one finding each. For
`amp_test_review`'s other nine FINAL_ANSWERs the log shows the parent receiving and forwarding them but
does not show them being acted on, so I cannot price them.

---

## 4. Best and worst value

Attribution is the hard part of this question, so I give the worst on two stated bases and name the
largest absolute line item separately. All three are defensible; they disagree because "value" means
different things for a builder lane, a reviewer lane and a parked lane.

### Worst value: `/root/production_build_review/amp_replay_review`

**24,592,485 input tokens, 186 responses, 19.8 h alive, 1 landed artifact → 24.59M tokens per landed
artifact.** That artifact is a single test file, `tests/crew-doctrine-grants.test.ts` (11,505 bytes),
committed by the lane itself as `1afba33f0`. This is the worst rate in the fleet on the artifact basis:
**1.95× worse than `coverage_review`** (12.61M) and **2.36× worse than `trace_tests`** (10.42M). It also
emits the most messages of any nested lane (67, ahead of `trace_tests` and `claim_test_gaps` at 56).

It is *not* an idle lane: 19 of its FINAL_ANSWERs are detailed reviews of its parent's Amp corpus and
of the crew authz seam, and at least one of them (ord 1163, the `ManagedPromptOutcome` caller
inventory: *"kernel/service.ts:1164–1177 — `if (!accepted)` controls claim proof and subsequent durable
receipt — Bridge must return true **only for submitted**"*) fed the parent's `c3122f3a` and `ca170b43`.
So its work landed through its parent rather than under its own name. On the artifact basis it is the
worst value; on a findings basis it is mid-pack. I name it because the metric that answers "where would
a cut have hurt least" is landed artifacts, and 24.59M tokens for one test file is the fleet's lowest
yield.

**Worst on the findings-only basis: `/root/production_build_review/amp_replay_review/amp_test_review`**
— 7,868,764 tokens, 60 responses, 18.1 h, 0 commits, 0 files, 1 verifiably consumed finding → **7.87M
tokens per verified outcome.** It is the most expensive lane with no artifact of its own, and the one
finding I could trace to code (`control-client.ts:862` `Boolean(res.data)`, ord 487) was also relayed
upward by its parent 96 seconds later, so the root would likely have received it anyway. I am not
calling it wasted: nine of its ten finals are substantive adversarial reviews of its parent's tests and
I cannot rule out that they were used.

### Largest absolute line item: `/root/coverage_review`

**100,908,894 tokens = 24.2% of the descendant spend, 14.3% of the whole effort, at 12.61M tokens per
landed commit** — the worst rate of the four big depth-1 lanes (`live_trace_options` 5.19M,
`pty_delivery_assessment` 6.68M, `production_build_review` 6.73M) and the worst chatter (163
empty-payload notifications, 6.3 per deliverable). It is also the lane whose output mattered most (§1),
so its cost is a *scheduling* cost rather than a quality cost. Measured decomposition at the crew-phase
boundary (2026-09-15T08:30Z):

| phase | responses | input tokens | share of lane | authored commits |
|---|---|---|---|---|
| 09-13 22:38 → 09-15 08:30 (PTY phase) | 292 | 39,419,985 | 39.1% | 4 (`27517c61`, `b3b53c21`, `ae13b0c7`, `91df3c31`) |
| 09-15 08:30 → 11:43 (crew phase) | 445 | 61,488,909 | 60.9% | 4 (`4a186087`, `466f438e`, `7087edea`, `16639205`) |

Both phases produced load-bearing work, so this is not a lane that should have been deleted. It is the
lane that should have been **re-forked**: its inherited-context tax is 31,600 × 737 = 23,289,200 tokens,
and the 39.4M it spent before the crew phase was spent carrying a PTY-era context into crew work. The
concrete lever is the one the verdict names — a lane that outlives its context should be replaced by a
fresh fork of the *current* artifacts rather than kept alive for 37 hours.

### Best value: `/root/factory_message_sources/claim_identity_review`

**1,647,671 input tokens, 24 responses, 12 minutes, 3 findings, all 3 verifiably incorporated into
`4cf844a5` → 0.55M tokens per verified outcome.** Best rate in the fleet by a factor of 2.5 over the
next best (`credential_scan` at 1.37M), best findings-per-response ratio of any lane (3/24), and the
shortest-lived lane (0.2 h) — which is exactly why it is cheap: the inherited-context tax is paid 24
times instead of 737. It found a SQL blocker (`work_facts` uses `result_json`, not `body_json`), a
boundary-retention bug (`describeTask` replaces `history[0]`), and a cache-eviction inversion, all
three verified in `4cf844a50`.

Runners-up: `credential_scan` at 1.37M per consumed finding (2 of 2 landed in
`tests/crew-projection.test.ts`); and among lanes that produced real artifacts,
`pty_delivery_assessment/fixture_receipt_review` at **5.57M per landed artifact** (16,706,235 tokens,
2 commits, 1 landed file, 1 performed compaction) — the best of the four large-ish depth-2 lanes.

Two more lanes deserve naming for opposite reasons:

- **Cleanest protocol:** `/root/mail_receipt_fix` — 115 responses, **5 messages, all 5 FINAL_ANSWER,
  zero envelope-only chatter**, 2 commits, 14,219,593 tokens. It is the only lane spawned with an
  explicit model and effort (`gpt-5.6-luna` / `max`, `fork_turns: none`) — and `fork_turns: none` is
  precisely the fork-tax mitigation identified in the verdict.
- **Most overhead-dominated:** `/root/native_cli_path` — 2,964,896 tokens in six minutes for one
  commit, with a first context of **81,078 tokens** (the largest of any lane, because it forked the
  parent's late-session history) re-read 28 times = **2,270,184 tokens (76.6%) of pure
  inherited-context tax**. It also inherited 7 of the root's compaction records into its own rollout.

---

## 5. Self-reported trouble relevant to lane value

Not re-derived from round 1; these are the lane-side statements that bear on whether the fleet was
well used.

- **`production_build_review`, ord 4422 (02:30:35):** *"No new model calls. Seven late tasks performed
  zero tools; the assessment remains incomplete, with no claim that all 14 harness audits finished."*
  **[observed]** The fan-out's tail was empty lanes; the Codex lane said so rather than reporting
  success.
- **`pty_delivery_assessment`, ord 5095 (03:07:29):** *"The "six unguarded side doors" claim is
  misleading. Verified against `d1543a09`; no files modified."* followed by a five-row
  claim/verdict/receipt table in which one row reads *"**Refuted.**"* and one *"**Confirmed,
  production-reachable.**"* **[observed]** This is a peer report (Muse's) being audited rather than
  accepted, which is the behaviour the fleet existed to provide.
- **`fixture_receipt_review`, ord 3313 (11:41:20):** *"The saved trace **does not prove false
  submission or notification**."* **[observed]** A child refusing to certify its parent's conclusion.
- **`coverage_review`, ord 11446 (09:06:22):** *"Typecheck still fails elsewhere, with no diagnostics
  in the two owned files."* **[observed]** Repeated across lanes (also `pty_delivery_assessment` ord
  8937, `live_trace_options` ord 13300, `trace_tests` ord 15217, `amp_replay_review` ord 3580) — the
  concurrent-edit tree meant many lanes spent responses distinguishing "my files are clean" from
  "someone else's file is broken". That is a real, quantifiable coordination cost of a 15-lane fleet,
  and it is not attributable to any single lane.

---

## 6. Corrections to `SESSION2.md`

1. **Compaction counts in the fleet table are not "compactions this lane performed."** 15 of the
   `compacted` records across the 15 lanes are **inherited**: the fork re-materializes the parent's
   compaction records into the child's rollout at the fork instant. `native_cli_path` is the extreme
   case — all **7** of its records carry timestamps `11:33:28.871`–`11:33:28.899Z`, i.e. within 28 ms
   of its own spawn, and their `window_number`s are the root's 14–20. It performed **zero**
   compactions. Corrected split (inherited/performed): `production_build_review` 1/5,
   `pty_delivery_assessment` 1/5, `claim_test_gaps` 1/2, `amp_replay_review` 1/2,
   `factory_message_sources` 1/1, `matrix_inventory` 1/1, `fixture_receipt_review` 1/1,
   `claim_identity_review` 1/0, `native_cli_path` 7/0, `coverage_review` 0/8, `live_trace_options` 0/4,
   `trace_tests` 0/1, `mail_receipt_fix` 0/1, `credential_scan` 0/0, `amp_test_review` 0/0.
   **The fleet performed 31 compactions; the root performed 21.**
2. **A lane's outgoing messages are recorded in the recipient's rollout, not its own.**
   `coverage_review`'s own rollout contains **zero** `agent_message`s authored by `/root/coverage_review`
   and 136 incoming ones. Round 1's figure of 161 messages from `coverage_review` (seen in the root's
   rollout) and this file's 208 (seen across all recipients) are the same phenomenon measured at
   different recipients; 161 went to `/root` and 47 to five peers and its child.
3. **Three lane names are abbreviated.** See §3.
4. **Depth-2 count is five, not three.** See §3.
5. **The root session is still live.** The root rollout now ends at `2026-09-16T04:30:57Z` with a
   27th turn opened at `2026-09-16T04:07:29.812Z` (ord 16148) and no `task_complete`; its thread total
   has grown to **287,911,483** and it has 1,942 responses and 21 compactions. Round 1's window ended
   at ord 16145 / 267,112,572. **Delta since round 1: 42 responses and 6,451,660 input tokens.** Every
   total in this effort is a moving target while the subject keeps running.

---

## 7. What I could not determine

1. **The literal task text for any of the 15 lanes.** Each lane's initial instruction is a
   `Message Type: NEW_TASK` `agent_message` whose cleartext payload is empty and whose body is
   `encrypted_content` (888 bytes for `coverage_review`); the parent's `spawn_agent` argument is
   encrypted too. The "ask" column is therefore the lane's **own first assistant message after that
   boundary**, which restates the task. It is the lane's framing, not the root's words.
2. **Whether most findings were consumed.** I verified consumption for the findings named in §1, §3 and
   §4 by inspecting the resulting commit or file. For the remaining ~150 FINAL_ANSWERs the log shows
   delivery to the recipient but not uptake, so my "earned" verdicts rest on landed artifacts wherever
   possible and on verified consumption only where I state it.
3. **Authorship of commits claimed near-verbally.** My first extraction captured any hash near a
   commit-word and produced 58 "commits", including ones a lane merely verified (`"Tests committed in
   \`466f438e2\`"`). The tightened extraction (`commits3.py`, first-person verb immediately followed by
   the hash) yields 45. I used 45. Some genuine commits may still be missed if a lane phrased
   attribution unusually.
4. **Per-lane wall-clock cost of the Devin fan-out.** It ran 22 Devin sessions to failure across two
   Prism runs, but Devin's own token accounting is not in these logs, so the fan-out's cost cannot be
   added to the 704M and is not included here.
5. **Whether the parked lanes cost anything while parked.** I can measure responses, not idle. A lane
   alive for 19.6 h with 31 responses contributed 31 context re-reads; whether holding 15 sub-agent
   sessions open had any other cost is not visible in the rollouts.
