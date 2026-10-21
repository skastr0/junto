# 02 Universal resources

Proposed owner: remote. Reviewers: canvas, cli.

## Target

Every node that does not need a host's runtime exists on every machine:
tasks, artifacts, automations, notes, labels, files, links, regions. Seats,
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
| Editing machine unreachable | `RuntimeDown`, retryable | `reason: "editor_unreachable"` |
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
- Canvas copy carries every non-host node to every machine as geometry and
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

## Link down

The editing machine unreachable means no ruling. Proposal: commands fail
with a retryable `editor_unreachable` error and the seat retries; reads keep
working from the last replicated state, marked with its age. No offline
queue in 0.10. (Operator decision 7.)

The cost, plainly: the editing machine is the operator's desktop. While it
sleeps, every remote seat's resource writes are refused and no automation
fires (07).

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
- **canvas**: Carrying every non-host node in the copy: size concerns for
  canvases with many notes and files?
- ~~**cli**: error contract~~ Answered: mapped onto `WorkErrorType` above.
