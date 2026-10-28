# 0.11 View state survives a restart

Owner: product-lead. Ordered by the operator 2026-10-28, rejecting the
labels hand-off where picks were "kept for the life of the window". Part of
0.11.0.

## Target

How the operator arranges Junto is their work, and a restart never loses it.
Command groups, each node's filters, the item a node had open, a sidebar
collapsed, a modal resized: all of it comes back after a quit, a crash or an
update, exactly as it was left. It lives in `junto.db`, in tables shaped like
the data.

## Decisions (operator, 2026-10-28)

- **Kept in SQLite, as proper tables.** One table per kind of state, typed
  columns with `CHECK`s, `STRICT`, a row per thing (a slot, a member, a
  picked label). No JSON body column and no key-value blob: the
  `settings_preferences.body` shape (`src/main/junto/settings/state-schema.ts:36`)
  is what this is not. No `localStorage`, no files.
- **Nothing the operator arranges is session-only.** Every
  "remembered for the session" in the renderer that holds an operator choice
  moves to the store. Caches, measurements and drafts are not choices and
  stay where they are (Files drafts already ask before a quit).

## Decisions (product-lead)

- **Machine-local.** View state is this machine's: it is not a fact, not
  journalled, does not cross to other machines and is not in a canvas copy.
  Labels and their colours are artifact data and do cross; how they are
  arranged on screen does not. Revisit if the operator wants an arrangement
  to follow them.
- **Written as it changes, read once at window load.** The renderer sends
  each change to main over `trustedRendererIpc`; main writes it in one
  transaction, last write wins per row. A window reads a snapshot at load and
  every window hears a change pushed, as Files changes are.
- **Rows go with their node and canvas.** A node or canvas deleted takes its
  view rows in the same transaction (a delete step on the same seam, or a
  foreign key with cascade where the parent is in `junto.db`). A command group
  member whose node is gone leaves on read, as it does today.
- **Expand-only schema step**, numbered when it lands.

## What is kept (the inventory)

| State | Today | Owner |
|---|---|---|
| Command groups: slots 1 to 9 (fixed or group, members in order) and the groups beyond nine, per canvas | `command-groups.ts:372` "never written to disk", `state.ts:61` | V2 |
| Artifacts node: type filter, picked labels, archived toggle | `artifacts-filter-kept.ts:19`, `ArtifactsNode.tsx:114` | V3 |
| Tasks node: state filter | `TasksNode.tsx:101` | V3 |
| Each node's open item: artifact, task, automation, Files path (relative) | `ArtifactsNode.tsx:107`, `TasksNode.tsx:98`, `FilesNode.tsx:96` | V3 |
| Files node: expanded folders in the tree | `@pierre/trees` state | V3 |
| Sidebar collapsed, per node | `TwoPane.tsx:15` "session memory" | V3 |
| A resized modal's size, per surface | `FocusSurface.tsx:284` | V3 |
| Comments rail shown or hidden | `artifact-comments-rail.ts:7` | V3 |
| Seat sidebar: which sections are open | `sidebar-sections.ts` | V3 |
| The actor rail | `actor-rail.ts` | V3 |

Search text typed into a filter box is not kept. Any other operator choice a
seat finds held only in memory joins this table: mail product-lead with the
file and line.

## Tracks

| Track | Owner | Reviewer |
|---|---|---|
| V1 store: the tables, the step, the service in main, IPC snapshot and push, deletion with the node and canvas | product-feed | product-shell, tech-lead |
| V2 command groups and hotbar operator slots read and write the store | product-modals | product-shell, product-keyboard |
| V3 node surfaces: Artifacts and Tasks filters, open item, Files tree, TwoPane collapse, FocusSurface size, comments rail | product-shell | product-sheet, product-typography (shared ui) |
| Verify: arrange, quit, relaunch, all back; dark and bright | product-verify | |

V2 and V3 build on a stand-in of V1's renderer interface and switch when V1
lands. The proof for every row of the inventory is the same: set it, quit
Junto (not close the window), relaunch, and it is there.
