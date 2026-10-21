# 01 Region binding

Proposed owner: canvas. Reviewers: cli, product.

## Target

A seat may use every resource node in **reach**: its own region, every
region below it, and every region above it. Never a sibling or a cousin.
Reach needs no edge. Edges survive for three things only: seat to seat mail
(`messages`), seat to page automation (`navigates`), and task to task flow.

Resource nodes: tasks, artifacts, automations, notes. The browser page is a
resource for comments and stays edge-bound for automation (06). Seats and
terminals are not resources.

## Today

- Edges are the only grant. `admitPure` checks, in order: nodes exist,
  caller is not a peer, connected, same machine, role law, port
  (`src/shared/physics/admit.ts:168-282`). A region co-member who is not wired
  fails `not_connected` at `admit.ts:201-212`.
- Edges carry more than ports: `claimable` (factory claiming), `wake` (board
  megaphone), `flow`/`feeds` (task boards), scheduler `when`/`does`/`chain`
  (`src/shared/physics/view.ts:123-177`).
- Regions have no parent field. Membership is geometric: a node is inside
  when its whole rectangle is (`src/shared/model/canvas.ts:89-96`). Regions
  may overlap; `regionStack` returns every container sorted by area
  (`canvas.ts:108-115`).
- Region scoped reads already exist without edges: references
  (`src/main/junto/references/seat-reads.ts:17-52`), region environment, task
  dependency scope (innermost region only, `src/shared/task-dep-scope.ts:18-31`),
  git review candidates (`src/shared/review-candidates.ts:12-37`).
- Blocked detection is computed per actor to task wire
  (`src/shared/execution-graph.ts:183-203`).

## Contract: `src/shared/region-reach.ts` (new, pure)

```ts
/** Root first, innermost last. The canvas root is the empty path. */
type RegionPath = ReadonlyArray<RegionId>;

/** The path of the innermost region containing a node. */
regionPathOf(canvas: Canvas, nodeId: NodeId): RegionPath;

/** Same path, or one is a prefix of the other. */
inReach(seat: RegionPath, resource: RegionPath): boolean;

/** Resource nodes a seat reaches, by kind. */
resourcesInReach(canvas: Canvas, seatId: NodeId): ReadonlyArray<NodeRef>;

/** Seats that reach a resource. Reviewers, mention candidates, recipients. */
seatsInReach(canvas: Canvas, resourceId: NodeId): ReadonlyArray<NodeRef>;

/** Downward only: what an automation may target (07). */
targetsBelow(canvas: Canvas, automationId: NodeId): ReadonlyArray<NodeRef>;
```

Rules:

1. A seat's position is its **innermost** region. Using the whole stack would
   leak sibling contents (`regionCoMemberIds`, `src/main/junto/work/authz.ts:73-86`,
   does exactly that today for visibility; it is not reused).
2. A node outside every region sits at the canvas root, so every seat on the
   canvas reaches it. (Operator decision 2.)
3. Reach is evaluated against the editing machine's canvas at the sequence
   the write is ruled at (02). Moving a node or a region changes reach on the
   next write; nothing is cached on the node.
4. Peers (seats of other machines shown in a copy) never act through a copy;
   the seat acts from its own machine and the editing machine rules (02).

## Admission

- `admitPure` gains a reach branch before the edge branch: caller is an
  actor, target is a resource kind, `inReach` holds, so every port of that
  kind is admitted. The same machine check does not apply to resource ports:
  the write travels to the editing machine (02).
- "Full access" means every item operation inside the resource: create,
  edit, comment, assign, archive. Adding, moving, renaming or deleting the
  **node** stays canvas authoring (operator and overseer only), per
  `docs/security-doctrine.md`.
- Onboard: `connected` keeps seats only. A new `reach` section lists
  resources in reach with a count and the command that lists each (08).

## Overlap

Reach needs a tree. Proposal: canvas authoring refuses a region that
partially overlaps another (full nesting or full separation only). The task
plane already refuses ambiguous overlap (`src/main/junto/work/repository.ts:637-641`).
Existing canvases with partial overlap: the migration reports them and the
operator fixes them; reach treats an ambiguous node as root-level until then.
(Operator decision 1.)

## Kept, reshaped, deleted

| | |
|---|---|
| Kept | `messages` and `navigates` edges, `admitPure` structure, `regionStack`, `regionMembers`, region instructions joined outer to inner |
| Reshaped | `admitPure` (reach branch), `canvasToCapabilityView` (no per-resource masks), `connectedCapabilities` (seats only), execution graph blocked derivation reads task assignment, not wires (04), `task-dep-scope` uses reach |
| Deleted | Verbs `manages`, `contributes`, `works`, `publishes`, `participates`, `reads`, `edits`, `announces`, `fires`, `wakes`, `enqueues`, `chains`, `reviews`; `claimable`; board `wake`; the port bundles and `OPS_BY_SINK` entries for deleted kinds; `LegacyEdgeEther` and `inferVerb` (`verbs.ts:404-520`) |
| New | `region-reach.ts`; task to task verb (04 names it); a migration deleting wires with removed verbs and rebuilding the `wires.verb` CHECK (`src/main/junto/model/state-schema.ts:174-179`) |

## Questions

- **canvas**: Does refusing partial overlap break any canvas you know of? Is
  geometry the right source of truth for reach, or do regions get an explicit
  parent at authoring time?
- **canvas**: The execution graph's blocked state per wire: agree it moves to
  "assignee of a task in input-required"?
- **cli**: Name resolution (`authz.ts:703-756`) searches wired nodes only.
  Extend it to resources in reach, with ambiguity reported as today?
