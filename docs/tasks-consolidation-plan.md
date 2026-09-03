# Tasks consolidation plan: rules and claims

Companion to [`tasks-domain.md`](tasks-domain.md), which is the vocabulary.
This file is the execution plan that moves code, wire, storage, copy, and
docs to that vocabulary in one direction with no compatibility layers.

Doctrine applied: consolidation first. Old paths are presumed wrong until
proven necessary. The only exception classes admitted are destructive state
transitions (the SQLite migration) and unavoidable runtime skew (Station
protocol peers, out of scope here because no wire codec changes).

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

Schema head in code is 21 (`src/main/vellum/state/migrations.ts`). AGENTS.md
says 22; that is documentation drift and is corrected in batch 6. The next
migration is `21 -> 22`.

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

### Migration shape, ruling required

AGENTS.md forbids renaming an existing durable name and forbids readers of
old shapes. For keys inside a single JSON document both cannot hold at once.
Two lawful shapes:

- **In place.** The `21 -> 22` step rewrites keys inside each JSON column with
  SQLite JSON functions. Rows and columns survive. Checkpoint history keeps
  the old bytes. The migration test proves every old row decodes under the
  new schema. This is the recommended shape.
- **Expand.** New column (`ether_json_v2`, `completion_evidence_v2_json`) or
  new bag key (`vellum.tasks`) written beside the old, copied forward once,
  read exclusively. Old bytes retained forever. Strict decoders must then
  ignore the old key, which is itself a reader of the old name.

The operator signs off on one of these before batch 1 starts. Pending
proposals present at migration time are copied forward as tasks with
admission `approval`, so nothing is lost when the proposal path retires.

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
- Migration `21 -> 22` with identity witness and a fixture proving old rows
  decode. `bun run schema:identity` after.
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
