# Brief: remove the canvas document

From the Performance region to the Canvas region, 2026-10-07, at the operator's
direction. This is a problem statement with evidence and the operator's
decisions. The design is the Canvas team's.

## The operator's decision

Junto is no longer a canvas file with extensions. The app has a real shape:
seats, regions, wires, mail, sessions, harness launches. It is to be modelled
as that, directly.

- **No canvas document.** Nothing reads, writes, compares or reloads "the
  canvas" as one value.
- **No `ether`.** No extension bag on a generic node.
- **No generic canvas node types** standing in for domain things. A seat is a
  seat, not a `text` node.
- **The remote station protocol is not a constraint.** It will be rebuilt later
  on the real model. Until then it may be adapted or switched off.

The operator's reason: as long as a bag exists on a document that everything
re-reads, someone will put one more thing in it, and every reader pays on every
change. The only durable fix is that there is nowhere to put it.

## What it costs today, measured

Performance finding 1. Lab build beside the installed app; full method and
runs are on branch `perf-lab` (worktree `~/Projects/junto-perf-lab`),
`docs/performance-findings-report.md`.

**One mail to one seat, nothing else happening:**

| Canvas | Document size | Worst window frame gap per mail |
|---|---|---|
| 10 cards | 4 KB | 10 to 15 ms, same as quiet |
| 46 cards | 18 to 26 KB | 32 to 53 ms |
| 46 cards, mail piled up | 1.4 MB | 42 to 49 ms |
| 46 cards, mail piled up | 4.1 MB | 56 to 73 ms |

- Ten mails in one tick on the 4.1 MB document: a 144 ms gap, ten full reads,
  none cancelled.
- 20 seats woken by mail: 2,565 ms of window frame gaps in the first 10 seconds
  on a canvas carrying 4 MB of mail, and none on a clean canvas. One run each.
- Per work notification main served about 5.7 canvas read calls (1,084 for
  190). Some reuse a cache; main's cost at 4 MB was not measured.

**The operator's real canvas** (read from a copy of the installed database):
3,204 mails for the 65 nodes on the factory canvas, 4.06 MB, oldest from
July 31. Nothing is pruned.

**What happens on every work change**, in order:

1. Work commits; `canvases.subscribeChanges` broadcasts `canvasChanged` with no
   coalescing (`src/main/junto/ipc.ts:1751`).
2. The window calls `readCanvas` for the whole canvas (`src/renderer/App.tsx`,
   `externalCanvasReload`).
3. Main returns the document with every seat's work copied onto it
   (`projectWorkSnapshots`, `src/main/junto/canvases.ts:465`). The inbox query
   has no limit (`src/main/junto/work/repository.ts:3841`).
4. The window stringifies both documents in full to compare them
   (`src/renderer/lib/canvas-external-reload.ts:82`). They always differ,
   because the mail is inside the document.
5. `loadDoc` re-applies it: two structural rebuilds and seven React commits.
   29 window files subscribe to the whole document with `use$(state$.doc)`.

Cards are not remounted by this; that was checked.

## Where the document lives

**Types** (`src/shared/canvas.ts`). The node union is `TextNode`, `FileNode`,
`LinkNode`, `GroupNode` (line 533). A node's domain data is
`EtherNodeExtension` (line 438), whose fields today are: `entity`, `overseer`,
`region`, `watch`, `timer`, `tasks`, `requests`, `artifacts`, `messages`,
`board`, `pad`, `sheet`, `terminal`, `browser`, `git`, `host`. An edge's is
`EtherEdgeExtension` (line 485): `verb`, `mask`. `CanvasDoc` is line 550.

**Storage** (`src/main/junto/canvas/state-schema.ts`).

- `canvas_nodes.type` is limited to `text`, `file`, `link`, `group`. A seat is
  a `text` row.
- Position, size, z-order and colour are typed columns.
- Everything else is `ether_json`, which the schema calls "the single stored
  truth for extension data". Edges carry their verb the same way.
- `canvas_entities` is a separate registry for entity queries.
- No whole-document body is stored. The document is assembled on read.
- Work data (mail, tasks, requests, board, pad) is already proper rows in the
  `work_*` tables.

**Main.** The active portfolio is read whole and cached as one snapshot
(`src/main/junto/canvases.ts:366`). The architecture document still requires
that "every authorial commit is a full-map transaction"
(`docs/state-architecture.md:229`).

**Window.** The whole document is the working state. An edit changes it in
memory and saving sends the entire document back with a revision
(`src/renderer/lib/mutations.ts:363`).

**Reach, by files that name each concept:**

| Area | `ether` | `CanvasDoc` |
|---|---|---|
| Window | 95 | 36 |
| Main | 52 | 49 |
| Shared | 50 | 41 |
| CLI | 2 | 0 |
| Tests and e2e | 206 | 160 |

In main, `ether` is named in work (9 files), overseer (9), term (7), kernel
(4), canvas (4), station (3), seat-sessions (3), browser (3) and six
single-file uses. `state$.doc` appears in 70 window files. `readCanvas` and
`writeCanvas` appear in 15 source files and 43 test files.

## History, so it is not repeated

- **July 27** (`a9397161e`): the work plane moved from the JSON file to SQLite.
- **July 28** (`c1376d758`): the window began reloading on work-only changes,
  so projections would not go stale. This is the reload measured above.
- **August 18** (`1f771377c`): the canvas read was batched; a 1,000-node read
  went from 169,016 SQL statements to one per sink.
- **August 18** (`8d02df15e`): a structure-only node read was added for callers
  that ask one question of one node. Its comment calls the full read "the
  entire factory for one `nodes.find`" (`src/main/junto/canvases.ts:134`).

Each of these made the document cheaper to produce. None removed it. No commit
was found that narrowed what the window receives; that search covered commit
messages and the current code, not every intermediate change.

## One way through, offered not prescribed

Performance's view, for the Canvas team to accept or replace: take one concept
at a time out of the document, and end each step by deleting its field from
the type so it cannot return.

1. Mail. It already has its table. It needs its own paged query and its own
   change event naming the seat. This step alone removes the measured cost.
2. Seat: identity, harness, launch, terminal binding, session.
3. Region and wire.
4. What remains is position and size; those become fields on seats and
   regions, and `CanvasDoc`, `ether`, `readCanvas`, `writeCanvas`, document
   revisions and the full-map rule go.

A typed layer can sit in front of `ether_json` while readers move, with the
storage migration last.

## Not checked

- How much of `tasks`, `requests`, `artifacts`, `board`, `pad` and `sheet` is
  still live.
- What `canvas_entities` already covers.
- What the station wire carries, beyond the architecture document's statement
  that projections are complete portfolio envelopes.
- Main's own cost for a canvas read at the real document size.

## How to measure it again

On branch `perf-lab`: `scripts/perf-lab.sh build` and `launch` start an
isolated build with debug ports; `scripts/perf-lab-work-changes.ts` measures
one work change at a time and with a growing mailbox;
`scripts/perf-lab-ballast.ts` with `scripts/perf-lab-wake.ts --mode mail`
reproduces the combined run. The lab is stopped now. Runs take the machine-wide
app-run lock.
