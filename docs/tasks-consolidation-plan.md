# Tasks consolidation plan: rules and claims

Companion to [`tasks-domain.md`](tasks-domain.md), which is the vocabulary.
This file is the execution plan that moves code, wire, storage, copy, and
docs to that vocabulary in one direction with no compatibility layers.

Doctrine applied: consolidation first. This is corrective removal of broken,
unshippable code, not migration support for respected legacy behavior. The old
paths and vocabulary are invalid and must disappear completely. Remote is
disabled and is not part of this cutover; no Station compatibility path or
pre-cutover Remote accommodation is added.

## Canonical end state

| Concept | Identifier | Wire and CLI | Copy |
|---|---|---|---|
| The node | `kind: "task"` unchanged | target | Tasks |
| Node settings | `TasksContract { instructions, rules, incoming, outgoing }` | `contract` | Board settings |
| Incoming | `incoming { handling, description, admission, waitMs, checks }` | | Incoming |
| Outgoing | `outgoing { handoff, description, checks }` | | Outgoing |
| Rule | `Rule { id, text }` | `rules[]` | Rule |
| Region rules | `region.contract.rules`, `region.contract.rulings` | | Region rules |
| Task's own rule | `TaskRule { id, text, board }` | `rules[]` on create | Rule at board |
| Rules in force | `rulesInForce(doc, boardId, task)` with provenance | `tasks rules` | |
| Agent's answer | `Claim { ruleId, text, refs? }` in `completionEvidence.claims` | `claims[]` on `tasks update` completed | Claim |
| Fork skip | `Waiver { ruleId, reason }` in `completionEvidence.waivers` | `waivers[]` | Waiver |
| Check | `Check { id, label, command }`, `CheckResult { checkId, side, command, exitCode, outputTail, at, epoch }` | `tasks check` | Check on entry, check on exit |
| Visit | `Visit { board, enteredAt, epoch, claimedBy?, exitedAt?, exit?, next?, handoffNote? }` in `task.visits` | | Path, Sent on |
| Defect | `TaskDefect { epoch, target, at }` unchanged | `defect` on `tasks update` rejected | Send back |
| Admission | `"auto" \| "approval" \| "operator"` | `admission` | Immediate, Approval, Me |
| Wait | `waitMs` contract, `waitFor` create, `waitUntil` task | `waitFor` | Wait before starting |
| Agent takes a task | `claimedBy`, `tasks claim` unchanged | | Claim |

Removed outright: `severity`, `ClaimSeverity`, soft waivers, `TaskProposal`
and its tables and ops as a live path, every railway identifier (`boarding`,
`Ticket`, `TicketSide`, `Passage`, `PassageExit`, `journey`, `emission`,
`emissionNote`, `claimableAfterMs`, `stationName`, `station` on task rules,
`metro`, `stop`, `line`), the "assigned" copy, "Copy existing", "Add for
approval", and the second creation mode.

## Durable storage

Schema head remains 21 (`src/main/vellum/state/migrations.ts`). This corrective
repair does not consume a schema version: fresh upgrades construct the fixed
version 21, while an existing invalid version-21 database is rewritten before
normal decode. The next unrelated schema migration remains `21 -> 22`.

None of the affected fields are SQL columns. They are keys inside JSON
columns:

1. `work_tasks.metadata_json["vellum.pipeline"]` holds `claims`, `epoch`,
   `journey`, `defects`, `holdUntil`, `boarding`, `admission`, `raisedBy`.
   Rule entries carry `severity` and `station`.
2. `work_task_finish.completion_evidence_json` holds
   `responses[{claimId, response, refs}]` and `claimWaivers[{claimId, reason}]`.
3. `canvas_nodes.ether_json` holds `tasks.contract.{instruction, claims,
   inbound, outbound}`, `tasks.stationName`, and
   `region.contract.{claims, rulings}`. Inbound holds `claimableAfterMs`,
   `checklist`, `instruction` (triage), `description`, `admission`. Outbound
   holds `emission`, `description`, `checklist`. Admission values are
   `operator-gated` and `operator-owned`.
4. `work_task_proposals`, `work_proposal_events`,
   `work_pending_proposal_commands`, `work_proposal_planning` hold proposals.

### Migration shape, ruled

The operator ruled a complete in-place corrective migration on 2026-09-04.
Corrected version 21 is installed transactionally during a fresh `20 -> 21`
upgrade or by a same-version pre-decode repair of an existing invalid 21. It:

- rewrites every affected authorial and material JSON value to the canonical
  Tasks vocabulary;
- rewrites affected Work commands, facts, proposal records, pending records,
  and their correlated content hashes coherently;
- converts pending proposals to submitted Tasks with admission `approval`,
  preserves approved work as its existing Task, and represents rejected
  proposal history as rejected Tasks;
- removes proposal tables after their information has been consolidated;
- advances canvas revision and portfolio intent identity for rewritten
  authorial documents;
- leaves no old key, column, table, codec, decoder, fallback, or dual writer.

The StateEngine's existing backup and transaction rollback are the recovery
boundary. A conversion failure aborts startup and surfaces the normal recovery
flow; there is no deferred backfill or partially converted runtime. Remote is
disabled for this change, so its wire version remains unchanged.

## Batches

Each batch is one commit behind `bun run verify`. Each renames code, wire,
copy, tests, and docs together so no batch leaves two vocabularies alive.

### B1. Model and storage

- `work-model.ts`: `Rule`, `TaskRule`, `Claim`, `Waiver`, `Check`,
  `CheckResult`, `Visit`, `TasksContract`, `TasksIncoming`, `TasksOutgoing`,
  admission literals. Delete severity.
- `canvas.ts`: `EtherRegionContract.rules`. `ether.tasks.name` replaces
  `stationName`.
- `claims.ts` becomes `rules.ts`: `rulesInForce`, `claimsRecorded`,
  `evaluateRules`, `evaluateForkWaivers`, `evaluateTerminalClose`,
  `requiredChecks`, `evaluateChecks`, admission helpers.
- Corrected `20 -> 21` construction plus same-version invalid-21 repair, with
  identity witness and a fixture proving old rows become canonical. `bun run
  schema:identity` after.
- Repository bag key and fold/lift renamed.

### B2. Gates and factory tick

- One `ruleSatisfied(rule, provenance, board, recorded, local)` used by the
  completion gate, the readiness report, the fork check, and the terminal
  check. Adopt the once-per-epoch reading for region and board rules.
- Delete the soft-waiver branch. Waiver accepted only when the rule's board is
  unreachable from the chosen Next.
- `factory-tick.ts`: `continue` instead of `break` when a task is not
  claimable and free actors remain; claim key joined with a separator; wake
  filter applies admission.
- Ownership: complete and forward require `claimedBy === caller`; fail,
  cancel, and input requests allowed for any connected seat; `archived` and
  `submitted` are operator only on the seat wire.
- Validate task rules at create: board exists, is a Tasks node, is on the
  path, ids unique.

### B3. Wire, CLI, agent docs

- Ops: `tasks.claims` becomes `tasks.rules`; `tasks.board` becomes
  `tasks.check`. Args: `rules`, `claims`, `waivers`, `waitFor`.
- `control.ts` error mapping carries structured `details` from the work
  service (`holder`, `from`, `to`, `missing`, `next_step`) instead of regex
  over message text. Domain codes `not_ready`, `unadmitted`, `fork_choice`,
  `wrong_home`, `operator_owned` map to typed errors with `next_step`.
- `tasks check` prints one JSON envelope to stdout, no table on stderr.
- `vellum-docs.ts` port descriptions generated from `TaskState` and the update
  args. Injection copy, few-shots, and the claim prompt (renamed rules packet)
  rewritten in the domain words with a paste-able completion example that
  includes `claims`.
- `docs/managed-terminal-plan.md` op table regenerated.

### B4. Proposals retirement

- Delete `TaskProposal`, proposal ops, `approve_proposals` and
  `reject_proposals` actions, proposal detail and menu, the proposal backfill,
  and the second creation mode. `workTaskPromote` remains as the approve door
  for admission `approval` and is labeled Approve.
- Awaiting approval lane removed. Tasks with admission `approval` show inside
  Queue with an Approve control. Structural, minimal.
- Proposal tables stop being written and read. Rows retained.

### B5. Renderer identifiers, files, copy

- `src/renderer/components/claims/` becomes `rules/`. `ClaimList` becomes
  `RuleList`. `SinkContractEditor` becomes `BoardSettings`.
  `RegionContractEditor` becomes `RegionRules`. `TaskMetroMap`,
  `TaskCreationMetroMap`, `StationStopCard`, `station-map.ts`,
  `station-pins.ts` become `TaskPath*`. `TaskStationConsole` becomes
  `TaskOperatorPanel`. `TaskJourney` becomes `TaskVisits`.
  `station-identity.ts` becomes `tasks-node-identity.ts`.
- Copy: the leftover strings found after the first copy pass (Inbound lane
  hint, operator panel, visits panel, path aria-labels, stranded rule warning,
  naming hint, admission unavailable reason, popover aria-labels), "assigned"
  back to "claim", severity chips removed, "claim" for law becomes "rule".
- Board settings header duplication resolved: eyebrow dropped.
- Lane word "Queue" derived from the visible lane set everywhere.

### B6. Docs and lexicon

- `architecture-factory-physics.md` gains a section on rules, claims,
  checks, visits, defects, and epochs.
- `vellum-protocol.md`, `security-doctrine.md`, `managed-terminal-plan.md`
  word sweep.
- AGENTS.md: schema head corrected, lexicon pointer to `tasks-domain.md`.
- Tests added: factory-tick starvation and key collision, wake with
  non-claimable tasks, per-task admission overlay, readiness and gate parity,
  region stack tie order by code point, `tasks list` and rules packet parity,
  migration fixture.

Order: B1, B2, B3, B5, B4, B6. B4 is separable.

## What dies and why it was alive

| Dies | Why it was alive |
|---|---|
| Severity and soft waivers | Rules were first imagined as gradeable |
| Proposals as code | The merge moved data, not code |
| Regex over error text | Shortcut at the CLI boundary |
| Four projections of law | Accretion, one per caller |
| Railway identifiers | Copy and code were renamed together the first time |
| Awaiting approval lane | Held both leftover proposals and approval tasks |

## Parked, tracked in the session ledger

Creation dialog redesign, single settings panel with two sections, TaskBoard
split into card, dialog, detail, and ops hook, thread and defect facts stamped
as message metadata, CLI filters and idempotency keys, region nesting bugs
(inner editor shows no outer rules, locale tie-break), law snapshot at claim
time.
