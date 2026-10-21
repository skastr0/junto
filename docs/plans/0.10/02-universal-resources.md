# 02 Universal resources

Proposed owner: remote. Reviewers: canvas, cli.

## Target

Every node that does not need a host's runtime exists on every machine:
tasks, artifacts, automations, labels, files, links, regions (notes are
untouched by 0.10, operator decision 10). Seats,
terminals and browser pages stay on their host. A seat on any machine reads
and writes resources in its reach (01) with the same commands and the same
result. Mentions and threads work across machines with the same rules.

## Today

- One editing machine per canvas (`canvases.editor_installation_id`,
  `src/main/junto/model/state-schema.ts:30-35`). Others hold a read-only copy
  sent whole and replaced when newer, no merging (`docs/machines.md:40-54`;
  `src/main/junto/model/service.ts:146-188`).
- The copy is cut per destination: full seats for the target, peers for
  other seats, terminals only to their own machine, region outlines unless a
  target seat is inside (`src/shared/canvas-copy.ts:198-254`). Notes, labels,
  files, links and every disabled kind stay on the editing machine.
- Only `message.append` and `delivery.accepted` rows cross
  (`src/shared/work-exchange.ts:43-76`), plus a `signals` frame. Signal
  attachments never cross (`work-exchange.ts:133-137`).
- Rows are `(writer installation, seq)`, immutable, idempotent by content
  hash; a different hash for the same id fails `identity-conflict`
  (`src/main/junto/work/repository.ts:8228-8360`). Rule 4: one writer, no
  conflict handling (`docs/machines.md:64-75`).
- `work_tasks` and `work_artifacts` carry `entity_home`; the unique key gives
  each machine its own lane (`src/main/junto/work/state-schema.ts:142-208,360-440`).
- Transport: one SSH link per machine, closed channel set, `rows` windowed at
  1 MiB with credit (`src/main/junto/link/protocol.ts:6-10`). A build
  mismatch closes the link.

## Model: seats propose, the editing machine rules

Rule 4 stays. Universal resources are built on it, not around it.

1. **Every write is a command to the editing machine.** A seat's CLI call
   reaches its own core. If that core is the editing machine it applies the
   command; otherwise it forwards it over the link and waits for the ruling.
   The caller gets the same success or typed error it would get locally.
2. **The editing machine is the only writer of resource state.** It checks
   reach (01) against its canvas, applies the domain rules (task state
   machine, stamps, artifact versions), and writes the result as its own
   immutable fact rows.
3. **Facts replicate to every machine** on the existing `rows` channel.
   Every machine holds the full resource state for the canvas and reads it
   locally, so reads never wait on the link.
4. **Idempotence.** Every command carries an `opId` minted by the CLI
   process, not by main: a seat that retries after a timeout must resend the
   same opId or the command applies twice. A `Timeout` error returns the
   opId, and commands accept `--op-id` so a retry reuses it (cli-lead). The
   editing machine keeps a ruling per opId; a repeated command returns the
   first ruling and writes nothing. The opId is a bare ULID (an
   `OperationId` is at most 64 characters with no `:`,
   `src/shared/failure.ts:15`); rulings are keyed by (sending link's peer
   installation, opId), never by a prefix the sender wrote (remote-lead).
5. **Ordering.** The editing machine's fact sequence is the order. Concurrent
   commands are ruled one at a time; a command written against a stale view
   (artifact `baseVersion`, task transition from a state that has moved) is
   refused with a retryable `stale` error naming the current version.

No machine other than the editing one ever writes resource state, so there is
nothing to merge and no conflict rule beyond "first ruled wins".

Rule 4 holds under four conditions (remote-lead):

1. **Actor bound to the link.** The editing machine accepts a command for
   seat S only from the machine placement says S is on, as signals do
   (`src/main/junto/work/exchange/session.ts:326`), and accepts `operator`
   only from itself.
2. **opId as above**, keyed with the sending installation.
3. **One transaction** writes a ruling and its facts, and every fact carries
   its opId, so rulings can be rebuilt from facts if editing ever moves
   (`docs/machines.md:55`).
4. **The exchange filter opens.** Today it refuses any row with a
   predecessor and any kind outside mail and receipts
   (`src/shared/work-exchange.ts:54,72`). Resource facts chain on
   predecessors; that is safe because rows go per writer in seq order
   (`session.ts:227-257`) and every machine is entitled to all of them. It is
   a doctrine change (README).

**Replication is not access.** Every machine holds every resource, so each
core checks reach (01) on its own reads.

**Read your writes.** The ruling returns before its facts arrive on `rows`.
The CLI waits until its local cursor covers the ruling's facts before it
returns, so a `show` right after a write prints the new state.

## Contracts

```ts
// src/shared/resource-command.ts (new)
type ResourceCommand = {
  readonly opId: string;            // bare ULID, minted by the CLI process
  readonly canvasName: string;
  readonly actor: NodeId;           // the seat, or "operator"
  readonly target: ResourceRef;     // { kind, nodeId, itemId? }
  readonly op: ResourceOp;          // closed union per domain (04, 05, 07, 03)
};

type ResourceRuling =
  | { readonly kind: "applied"; readonly facts: ReadonlyArray<FactId>; readonly version: string }
  | { readonly kind: "refused"; readonly error: WorkErrorBody };
```

Errors use the existing closed `WorkErrorType` set
(`src/shared/work-control.ts:141-153`) with `details.reason` for sub-codes, so
the set grows by one (cli-lead):

| Case | Type | Details |
|---|---|---|
| Resource not in reach | `ScopeError` | |
| Transition not allowed | `InvalidTransition` | |
| Written against an old version | `Stale` (new), retryable | `expected`: the head version |
| Feature reserved, not built (webhook) | `InputError` | `reason` |

- Link: a new `Channel` literal on the existing request and response frames
  (`src/main/junto/link/protocol.ts:8,13-15`); no new frame type and no credit
  (only `rows` is windowed). Two bounds close the whole link if hit: more
  than 32 requests in flight (`src/main/junto/link/session.ts:32,281`), so the
  caller keeps a per-link bound and a queue, as seat input does since
  7fa64afb0; and a ruling slower than 30 s (`session.ts:284`), so a ruling
  never waits on content bytes. Expected round trip on LAN 20 to 150 ms,
  unmeasured until the channel exists.
- Routing: a direct link to the editing machine, no relaying. In v1 the
  editor opens every link, so every machine with a seat is already linked
  (inferred, not checked on a three machine canvas).
- **Size.** Row paging counts rows (64 per frame, `work-exchange.ts:29`)
  against a 1 MiB frame bound. Inline bodies or large notes would overflow a
  frame and close the link. Bodies travel as content refs; facts stay small.
- New fact kinds on `rows`, one family per domain: `task.*`, `artifact.*`,
  `thread.*`, `automation.*`. Each carries the editing machine as writer.
- Entitlement: every machine linked for a canvas receives every resource
  fact for it. The mail entitlement rule (sink seat lives on the machine,
  `work-exchange.ts:273-284`) is unchanged.
- Canvas copy carries every non-host node except notes to every machine as geometry and
  label only; bodies (note text, briefings) travel as facts or content refs,
  because the whole copy is one `CopyFrame` on `rows`
  (`src/shared/work-exchange.ts:113`) under the 1 MiB frame bound (canvas-lead).
  Region outlines gain only geometry and label: briefing, references, folder
  maps and environment sources still go only where a local seat is in the
  region (`docs/security-doctrine.md:119-121`). Pages travel as stubs (06).
- Seat occupancy facts start on the seat's own machine (it is their writer);
  the editing machine reads them for automations (07).
- Content (artifact files, attachments): facts carry content refs; bytes
  move on demand through the existing content transfer
  (`src/main/junto/content/machine-files.ts`). Signal attachments become refs
  and may cross.

## Editing machine away: writes queue

Operator decision 7: writes never fail because the editing machine is
unreachable. Written by canvas-lead and remote-lead; points marked
**(remote)** are remote-lead's to confirm or change.

### One path, not an offline mode

1. **A command is a row.** The seat's core writes every resource command as
   its own immutable `command.queued` row `(writer, seq)` carrying the opId,
   the actor, the op and the basis: the editing machine's fact seq the core
   had applied when the command was written. The row goes to the editing
   machine on `rows` like any other row. The editing machine rules it and
   writes `ruling.applied` or `ruling.refused` with its facts in one
   transaction (condition 3), keyed by (writer, opId).
2. **The same path whether the link is up or not.** With the link up, the
   ruling comes back in milliseconds and the queue is invisible. With it
   down, the row waits, as mail waits (`docs/machines.md:82-85`). No branch
   decides "offline".
3. **(remote)** This replaces the request and ruling channel proposed under
   Contracts. A machine that does not edit the canvas offers only its own
   rows, and only to the editing machine
   (`src/main/junto/work/exchange/session.ts:273-276`). Cursors, catch up
   and credit drain the backlog after a return, so the 32-in-flight and 30 s
   bounds (`session.ts:32,281,284`) no longer apply to commands. Command rows
   are not resource state, so Rule 4 holds. The exchange filter admits
   `command.queued` only from the machine that placement says the actor is
   on (condition 1), the same rule as mail. `operator` commands are written
   on the editing machine itself, so the operator never queues.
4. **The CLI says which happened**, as mail does. It waits briefly for the
   ruling (**(remote)**: about 2 s) and then returns `applied`, `refused`
   (the typed error) or `queued` with the opId. `queued` is a success. A
   later `junto task show` or `junto queue list` shows the outcome.

### Pending state

- The writing machine reads **last ruled state plus its own pending
  commands**, applied in seq order by the same pure domain reducer that the
  editing machine rules with (`src/shared/`, one function for both). Pending
  items are marked `pending: true` with their opId in CLI output, and drawn
  dashed in the UI. The overlay is computed at read time. It is never a row
  and never state.
- Pending commands are visible only on the machine that wrote them. In v1
  every link runs between the editing machine and one other machine, so no
  other machine receives them before they are ruled. **(remote)**: this
  stays true if machines ever link to each other directly. Pending rows are
  for the editing machine only and are never relayed for display.
- Ids are minted by the writer and never change at ruling: task ids are
  already ULIDs (`src/main/junto/work/service.ts:213`), and artifact ids and
  thread ids follow the same pattern. A mention written against a pending
  task uses the id link form (03) and stays valid after the task is ruled.

### What happens only at ruling

Nothing derived from a resource command leaves the writing machine before it
is ruled:

- **Mail derived from a resource command:** mention mail, assignment
  notices, stamp requests and comment delivery to a resource's people. The
  applied ruling names the recipients. The actor's own machine then writes
  that mail when its cursor covers the ruling, so mail is still written by
  the machine of the seat it is from (`docs/security-doctrine.md:245`), and a
  refused command never leaves delivered mail behind. Plain seat-to-seat
  mail on a `messages` edge is not a resource command and works as today.
- **Derived transitions:** stamps met moves the task to `done`, a task sent
  on arrives at the next node, an unassign returns the task to `backlog`.
  Locally a pending approve that would meet the count shows as
  `in-review, 2 of 2 approvals pending`, never as `done`.
- **Automations** fire only on ruled facts, run only on the editing machine,
  and resume when it returns (07). On return a schedule fires once for its
  latest missed slot, with its `when` conditions rechecked. Earlier missed
  slots are recorded as skipped, as today's cron coalesces them
  (`src/main/junto/kernel/cycle.ts:406`).
- **Short task numbers** (`T-42`) are minted only by the editing machine,
  from a per-canvas counter, when it rules the create. A pending task has no
  number; it is named by id. `#T-42` resolves only ruled numbers.

### Invariants under partition

Every invariant is checked twice, with the same code. On the writing
machine, against its pending view, the check refuses at once a command that
is already wrong there; that refusal comes from the domain, not from the
editing machine being away. At ruling, against the editing machine's state,
the check is the only one that counts.

How much the local check is worth depends on whose actions it covers.
All of a seat's own pending work is on its own machine, so a check on the
seat's own actions is reliable unless another machine acted on the same
seat or task meanwhile. A check on what others do (assigning another seat,
stamps, dependencies across nodes) runs against ruled state that may be
old, so it is advisory and the ruling decides (remote-lead).

| Invariant | Local check | Ruled | When the two disagree |
|---|---|---|---|
| Ids unique | By construction (ULID) | Yes | Cannot collide |
| Task numbers | Not minted | Minted | Nothing to disagree |
| One open task per seat (04 inv. 2), own start or self-assign | Reliable | Yes | First ruled wins |
| One open task per seat, assigned by another seat | Advisory | Yes | First ruled wins |
| One assignee per task (04 inv. 1) | Advisory | Yes | First ruled wins |
| Only the assignee transitions (04 inv. 3) | Reliable | Yes, against the ruled assignee | Refused, dependents refused |
| Reach (01) | On the local copy | Yes, at the ruling seq (01 rule 3) | Refused, except the assignee's own transitions (01) |
| Stamp counts at current epoch | Advisory | Yes | Refused `Stale`, `expected` is the epoch |
| Assignee cannot stamp its own task | Reliable | Yes | Refused |
| Dependencies stay a DAG | Advisory | Yes | Refused (a cycle can form only across machines) |
| Finish checks pass for this epoch | Run in the seat's environment, as today | Epoch compared | Refused `Stale` when the epoch moved |
| Artifact `replace` on `baseVersion` | Advisory | Yes | Refused `Stale` with the head; the body is kept |
| Artifact `patch` | Advisory | Rebased onto the head (05) | Refused only when the rebase conflicts; the patch is kept |

**First ruled wins** is the honest rule for one open task per seat. Seat S
on a machine that is away starts task X; meanwhile, on the editing machine,
the operator assigns Z to S. When S's machine returns, S's start of X is
refused, and S's pending work on X rolls back in Junto's record (not in git:
commits and files are the seat's, and Junto never touches them). The refusal
tells S exactly what to do: unassign Z or ask for it to move, then start X
again. Ruling order puts nothing above "first": the operator, the seat's own
machine and wall-clock time get no priority, because clocks across machines
are not trusted and a priority rule would only move the surprise elsewhere.

### Ruling order

- **Within one writer:** strictly in seq order, which is the order that
  writer's seats saw.
- **Across writers:** the order rows reach the editing machine. A machine's
  backlog drains in its seq order while live commands from other machines
  interleave with it. There is no fairness promise and no wall-clock merge.
- Each command is ruled against the **current** ruled state, not against
  its basis. An old basis alone is never a refusal; a domain rule that fails
  now is. The basis is recorded so a refusal can say what changed since.

### Refusal and rollback

1. **Cascade within a queue.** When the overlay applies a pending command
   that touches an entity created or changed by an earlier pending command
   of the same writer, the command records that opId as its `after`. When
   the editing machine refuses a command, it refuses every later command of
   that writer whose `after` chain reaches it, with
   `details.reason: "depends_on_refused"` and the root opId. Unrelated
   pending commands from the same queue are still ruled on their own merits.
2. **Rollback is the ruling arriving.** Pending rows are immutable and never
   deleted. The overlay drops a pending command once the writer's cursor
   covers its ruling: if applied, the ruled facts take its place; if
   refused, it disappears. No other machine ever showed it, so there is
   nothing to undo anywhere else. Rulings, applied or refused, are editing
   machine facts keyed by (writer installation, opId) and go to every
   machine.
3. **Nothing written is lost.** A refused artifact edit keeps its body or
   patch as a content ref, named in the refusal, so the seat can rebase and
   send it again (remote-lead).
4. **The seat is told.** For each refused command, and for the root of each
   chain of refused dependents, the seat's own machine writes one notice to
   the actor seat in the resource's thread (03), from the ruling fact. That
   means no new mail author crosses machines. The notice carries the typed
   error, what changed since the basis (who assigned what, the new epoch or
   head), the opIds of the refused dependents and a `next_step`.
   `junto queue list` shows the pending and refused commands of the seat's
   own machine.
5. **Bounded.** **(remote)** The pending queue per machine and canvas has
   a count and byte bound, as every buffer must
   (`docs/security-doctrine.md:194-196`). Size it so no realistic absence
   reaches it. Hitting it is the only write refusal related to the editing
   machine being away, and it is typed and retryable.

### Moving the editing machine

**(remote)** A queued command names the canvas, not a machine, so it
drains to whichever machine edits when a link exists. Rulings rebuild from
facts (condition 3), so an opId ruled before the move is answered from
facts and is not ruled twice.

## Kept, reshaped, deleted

| | |
|---|---|
| Kept | Editing machine authority, Rule 4, `rows` channel, cursors and catch up, content transfer, mail relay |
| Reshaped | `canvas-copy.ts` cut (all non-host nodes everywhere), `entity_home` on tasks and artifacts (always the editing machine; the per-machine lane key goes), entitlement for resource facts, signal attachments as refs |
| Deleted | Host fields on cron and relay (07), page host selection (06) |
| New | `commands` link channel, `resource-command.ts`, ruling table keyed by opId, fact families per domain |

## Questions

- **remote**: A request and ruling channel on the link: any reason it cannot
  sit beside `rows` with its own credit? Expected round trip over the SSH
  link for a ruling?
- **remote**: v1 lets only the editing machine open links
  (`docs/machines.md:88-91`). Does a seat machine that is not linked to the
  editor directly route commands through it, or is a direct link required?
- **remote**: Windowless machines (`scripts/build-machine.ts:137`): any
  resource store that would pull Electron into the core?
- ~~**canvas**: copy size~~ Answered: geometry and labels in the copy,
  bodies as facts or refs (Contracts).
- ~~**cli**: error contract~~ Answered: mapped onto `WorkErrorType` above.
