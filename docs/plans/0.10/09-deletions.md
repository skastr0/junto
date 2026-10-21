# 09 Deletions

Proposed owner: each area's owner deletes its own; canvas owns the migration.
Reviewers: everyone whose area a deletion touches.

Phase 0. A deletion is done when the code, its tables, its flags, its docs,
its tests and its CLI surface are gone and `bun run verify` passes.

## By feature

### Requests node
- Kind and ports: `src/shared/model/kinds.ts:128-133`,
  `src/shared/physics/schema.ts:99`, `src/shared/physics/kinds.ts:69-71`,
  `src/shared/physics/work-ports.ts:132-138`, `src/shared/work-sinks.ts`.
- Tables `work_requests`, `request_boards`; repository
  `src/main/junto/work/repository.ts:3393-3524`; `src/shared/work.ts:1123-1205`;
  overseer `request.*`; UI `RequestsCard`, `RequestInbox`.
- Hazard: the execution graph and attention treat requests as a stoppage
  source (`src/shared/execution-graph.ts:119-157`, `canvas-needs.ts:84`,
  `digest.ts:238`); `Ruling.sourceRequestId`. The `junto escalate` command is
  agent signals and stays.

### Bulletin board node
- Kind, `work-model.ts:468-550`, ports, verbs `messages` to board and
  `participates`; tables `work_board_topics`, `work_board_posts`,
  `work_board_read_cursors`; `board-wake.ts`, `board-delivery.ts`; UI
  `BoardCard`, `BoardDetail`; CLI `src/cli/commands/work.ts:439-529`.
- Hazard: pad uses `BoardAuthor` and `board-actors` (`src/shared/pad.ts:112-116`).
  Pad pins and posts move to threads (03, 05), which removes the dependency.
  Until then extract the author type.
- Not this: `TaskBoard`, `BoardSettings`, `task-board.css` are tasks.

### Reviews edge
- `verbs.ts:109,176,363`, wires CHECK, `features.ts` gate, edge authoring,
  onboarding and doctrine text.
- Hazard: it is the only grant of `verdict.post`. Delete it in the same
  change that moves reviewer eligibility onto the task (04), or tasks with a
  `requires-review` rule cannot finish.

### Hermes integration (keep the Hermes terminal harness)
- `src/main/junto/hermes/`, `src/main/junto/adapters/hermes.ts`,
  `src/main/junto/chat/` and `src/renderer/components/chat/`, chat state and
  chrome, `src/shared/legacy-surfaces.ts`, `snapshots.ts`, `entities.ts`,
  Providers card and `hermesHostSnapshots`, host identity `hermesId` and the
  host registry columns and capability bit.
- Hazards, in order: seat deletion goes through the chat service delete lease
  (`src/main/junto/overseer/native.ts:1354-1370`, `chat/node-delete.ts`); seat
  ring occupancy reads chat state (`occupancy-feed.ts:54`); the kernel
  subscribes to snapshots; the canvas-control wire has a `snapshots` field;
  host registry CHECKs need a table rebuild. Cut the seat deletion lease
  first.

### Pinning
- Renderer only: `surface-registry.ts` pinned zone, `dock-state.ts`,
  `WorkSurfaceDock.tsx` and CSS, `PinButton` in eight surfaces,
  `tests/surface-dock.test.ts`.
- Not this: ruling pins, session pins, pad pins.

### Factory and edge roles (04, 01)
- `factory-tick.ts`, `factory-claim-prompt.ts`, the kernel factory block,
  reclaim grace, `claimable`, task admission and promote, verbs `manages`,
  `contributes`, `works`, `publishes`, `participates`, `reads`, `edits`.

### Schedulers and legacy (07)
- `cron`, `relay`, `watcher`, `timer` kinds and tables, verbs `announces`,
  `fires`, `wakes`, `enqueues`, `chains`; Region Pulse tables and their
  repository, `PulseRecord`, `pulseLogRetention`; `LegacyEdgeEther` and
  `inferVerb`.
- `src/shared/model/from-legacy-row.ts` is needed only by migration 12 to 13
  (`src/main/junto/state/migrations.ts:513-530`). Deleting it raises the
  oldest database Junto can open to v13. (Operator decision 5.)

### Pad and sheet node kinds (05)
- Kinds, tables, `reads` and `edits` verbs. Domains and editors are kept and
  move under artifacts.

## Migrations (v26 to v29)

One step per phase, each landing with its code; canvas owns the chain and
reviews every step (canvas-lead): v26 phase 0 deletions; v27 phase 1
(collapse `entity_home`, ruling table, fact families); v28 task state remap;
v29 automations. Collapsing `entity_home` belongs to v27, not v26. Wires with
removed verbs go by a filtered copy forward (the guard allows row deletes
only in replaced or removed tables, `src/main/junto/state/migrations.ts:1089-1105`);
the live canvas has 420 wires, all `messages`. Pad and sheet: 0 exist, so
dropped. Steps use the `removesTables` precedent
(`src/main/junto/state/migrations.ts:394-401,515-518`):

1. Delete nodes and wires of removed kinds and verbs; rebuild the
   `wires.verb` CHECK (`src/main/junto/model/state-schema.ts:186`).
2. Drop the removed tables.
3. Rebuild the host registry without Hermes columns.
4. Collapse `entity_home` lanes on tasks and artifacts (02).
5. `bun run schema:identity`.

Peers on an older build cannot send copies with removed kinds: a build
mismatch already closes the link (`src/main/junto/link/protocol.ts:6`). The
companion protocol's kind list (`src/shared/wire/companion-protocol.ts:296-316`)
changes with it.

## Flags after 0.10

| Flag | After |
|---|---|
| `requests`, `board`, `reviews`, `hermesIntegration`, `pinning`, `cron`, `relay`, `pad`, `sheet` | Deleted with their features |
| `tasks`, `artifacts`, `browser` | Deleted; the features ship on |
| `automations` | None; ships on |
| `usage`, `helpMap`, `liveOverseer`, `seatAwareness` | Not in this plan; operator to decide |
| Harness gates that exist only as a way back off, `fleetUi`, `audio`, `harnessSettings` | Deleted, features stay (Operator decision 6) |
| `devTools` | Kept, never on in production |

## Questions

- ~~**canvas**: migrations~~ Answered above.
- ~~**pty**: chat delete lease~~ pty-lead owns it. Every seat deletion takes
  it today, from `src/main/junto/overseer/native.ts:1353-1365` and
  `src/renderer/lib/chat-state.ts:614-660`. After the cut, seat deletion goes
  through `term/node-delete.ts` only. Lands before the Hermes chat removal.
- ~~**remote**: hermesId on remotes~~ Answered: no link frame carries it,
  but every core reads and writes it: `machine configure` on the remote
  (`src/main/junto/machines/repository.ts:127`), `machine.add` hardcoding
  `["terminal","hermes"]` (`src/main/junto/hosts/machine-owner.ts:94-95`),
  registry hydrate and upsert (`hosts/registry.ts:281,292-311`), the eager
  identity in `HermesPlaneLive` on every core (`hermes/plane.ts:420-424`), and
  the settings channel's `hermesHostSnapshots`
  (`src/main/junto/settings/link-wire.ts:34,68-69`). Cut those writers and the
  settings field in the same change as the `host_registry` rebuild, which
  lands in canvas's v26 migration with remote's column and CHECK spec.
