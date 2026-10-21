# 01 Region binding

Proposed owner: canvas. Reviewers: cli, product.

## Target

A seat may use every resource node in **reach**: its own region, every
region below it, and every region above it. Never a sibling or a cousin.
Reach needs no edge. Edges survive for three things only: seat to seat mail
(`messages`), seat to page automation (`navigates`), and task to task flow.

Resource nodes: tasks, artifacts, automations. Notes are read by seats in
reach and written only by the operator in 0.10: note text is a canvas row,
so a seat writing it would write the canonical canvas
(`docs/security-doctrine.md:91`, `architecture-canvas-physics.md:84`;
canvas-lead, operator decision 10). The browser page is a resource for
comments and stays edge-bound for automation (06). Seats and terminals are
not resources.

**Region is a scope, not a wall** (canvas-lead). Reach mints mail: mentions,
stamp requests, assignment notices and automation mail reach seats with no
`messages` edge, so two sibling seats can always reach each other through a
shared ancestor resource, the canvas root at least. "Never siblings" scopes
what a seat sees and edits by default; it does not isolate. "Mail still
requires a granting edge" (`docs/security-doctrine.md:87`) no longer holds,
and "Region is geography, not a security domain"
(`architecture-canvas-physics.md:286`) stays and is stated plainly.
(Operator decision 8.)

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

/** Downward only, and within the author's reach unless the author is the
 *  operator; rechecked at fire time against the author's current position (07). */
automationTargets(canvas: Canvas, automationId: NodeId, author: Actor): ReadonlyArray<NodeRef>;
```

Rules:

1. A seat's position is its **innermost** region. Using the whole stack would
   leak sibling contents (`regionCoMemberIds`, `src/main/junto/work/authz.ts:73-86`,
   does exactly that today for visibility; it is not reused).
2. A node outside every region sits at the canvas root, so every seat on the
   canvas reaches it, and a seat outside every region reaches every resource
   on the canvas. Today 0 of 127 seats are loose; any seat dropped loose
   later gets the whole canvas. (Operator decision 2.)
3. Reach is evaluated against the editing machine's canvas at the sequence
   the write is ruled at (02). Moving a node or a region changes reach on the
   next write; nothing is cached on the node.
4. Peers (seats of other machines shown in a copy) never act through a copy;
   the seat acts from its own machine and the editing machine rules (02).
5. **Ambiguity fails closed.** An ambiguous seat reaches only its own
   assigned task; no seat reaches an ambiguous resource until the overlap is
   fixed. (Root fallback would fail open: the root path is a prefix of every
   path.)
6. **Assignment outlives a move.** The assignee's own transitions on its
   assigned task are admitted by the assignment, not by reach, so a seat
   moved away from its task is never stuck holding it. Reach governs
   everything else. The canvas shows the reach change while the operator
   drags.
7. **Overseers and their own seat.** `node.move` and `node.resize` are
   closed overseer commands, so an overseer could widen its own reach by
   moving its own seat. Proposal: refused, as deleting its own seat is
   (`docs/security-doctrine.md:98`). (Operator decision 9.)

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

Reach needs a tree. Canvas authoring refuses a region that partially
overlaps another, or shares its exact frame, on create, move and resize (full
nesting or full separation only). The task plane already refuses ambiguous
overlap (`src/main/junto/work/repository.ts:637-641`). Geometry stays the one
source of truth; no explicit parent (canvas-lead).

The live `factory` canvas has 80 regions and 45 partially overlapping pairs,
every one a sliver (at most 4.1% of the smaller region, 15 px deep); no seat
or note sits in a sliver, and all 127 seats nest cleanly. The migration
reports the pairs and never moves geometry; the operator fixes them once, by
hand or with a one-time `separate` command. Until fixed, those regions refuse
edits. (Operator decision 1.)

## Kept, reshaped, deleted

| | |
|---|---|
| Kept | `messages` and `navigates` edges, `admitPure` structure, `regionStack`, `regionMembers`, region instructions joined outer to inner |
| Reshaped | `admitPure` (reach branch), `canvasToCapabilityView` (no per-resource masks), `connectedCapabilities` (seats only), execution graph blocked derivation reads task assignment, not wires (04), `task-dep-scope` uses reach |
| Deleted | Verbs `manages`, `contributes`, `works`, `publishes`, `participates`, `reads`, `edits`, `announces`, `fires`, `wakes`, `enqueues`, `chains`, `reviews`; `claimable`; board `wake`; the port bundles and `OPS_BY_SINK` entries for deleted kinds; `LegacyEdgeEther` and `inferVerb` (`verbs.ts:404-520`) |
| New | `region-reach.ts`; task to task verb (04 names it); a migration deleting wires with removed verbs and rebuilding the `wires.verb` CHECK (`src/main/junto/model/state-schema.ts:174-179`) |

## Questions

- ~~**canvas**: overlap, geometry~~ Answered in Overlap above.
- ~~**canvas**: blocked per wire~~ Answered: agreed; Law 2a already defines
  blocked as actor state (`architecture-canvas-physics.md:101`). The mark moves
  from the edge (`src/shared/execution-graph.ts:183-210`) to the seat ring.
  `auth-required` and requests stop being sources; `in-review` is not blocked.
- Full canvas review: [review-canvas.md](review-canvas.md).
- ~~**cli**: name resolution~~ Answered (cli-lead): `resolveWorkTarget`
  (`src/main/junto/work/authz.ts:703-746`) adds `resourcesInReach` for resource
  ops and keeps both refusals. The candidate list, typed as seats only
  (`details.seats`, `src/shared/work-control.ts:182`), becomes a general list of
  refs. Resolution also accepts `junto://` refs, not only ids and names
  (`authz.ts:709-710`).
