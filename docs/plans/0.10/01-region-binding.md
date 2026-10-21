# 01 Region binding

Proposed owner: canvas. Reviewers: cli, product.

## Target

A seat may use every resource node in **reach**: its own region, every
region below it, and every region above it. Never a sibling or a cousin.
Reach needs no edge. Edges survive for three things only: seat to seat mail
(`messages`), seat to page automation (`navigates`), and task to task flow.

Resource nodes: tasks, artifacts, automations. Notes are untouched by 0.10
(operator decision 10). The browser page is a resource for
comments and stays edge-bound for automation (06). Seats and terminals are
not resources.

**Region is a scope, not a wall** (canvas-lead). Reach mints mail: mentions,
stamp requests, assignment notices and automation mail reach seats with no
`messages` edge, so two sibling seats can always reach each other through a
shared ancestor resource, the canvas root at least. "Never siblings" scopes
what a seat sees and edits by default; it does not isolate. "Mail still
requires a granting edge" (`docs/security-doctrine.md:87`) no longer holds,
and "Region is geography, not a security domain"
(`architecture-canvas-physics.md:286`) stays and is stated plainly. The
edge rule only ever meant direct mail; this side effect is intended.
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

## Contract: `src/shared/region-reach.ts` (landed, pure)

```ts
/** Made only by positionsOf: Root, or the innermost regions wholly containing the node. */
type Positions = { _tag: "Root" } | { _tag: "Regions"; innermost: [RegionId, ...RegionId[]] };

positionsOf(canvas: ReachCanvas, nodeId: NodeId): Positions | undefined;

/** Some position of each is the same region or one wholly inside the other; Root is on every line. */
onOneLine(canvas, a: Positions, b: Positions): boolean;
/** Some position of `lower` is at or below some position of `upper`. Not transitive across two positions, by design. */
atOrBelow(canvas, upper: Positions, lower: Positions): boolean;

reaches(canvas, from: NodeId, to: NodeId): boolean;
/** Only an agent seat acts; a peer row, a region or a task node gets []. */
resourcesInReach(canvas, seatId: NodeId): ReadonlyArray<ReachNode>;
/** Agent and peer rows: reviewers, mention candidates, recipients. */
seatsInReach(canvas, nodeId: NodeId): ReadonlyArray<ReachNode>;
/** At or below the automation, and inside a seat author's reach; call at fire time (07). */
automationTargets(canvas, automationId: NodeId, author: AutomationAuthor): ReadonlyArray<ReachNode>;

RESOURCE_KINDS = ["task", "artifacts"]   // "automations" joins with its kind (C5)
COMMENTABLE_KINDS = [...RESOURCE_KINDS, "page"]
SEAT_KINDS = ["agent", "peer"]
```

`ReachCanvas` is any `{ nodes }` map of framed nodes, which a `Canvas` already is.
Nothing is cached. A region that is gone fails closed: it is on no line.
The assignee exemption (rule 6) is the task domain's `reachExempt`
(`src/shared/task-model.ts`), which the ruler asks before it refuses for reach.

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
5. **A node can sit in several regions.** Its positions are every innermost
   region that fully contains it (regions that only partially overlap are
   unrelated, neither parent nor child). A seat reaches a resource when any
   of the seat's paths and any of the resource's paths are on one line. No
   ambiguity remains, so nothing fails open or closed.
6. **Assignment outlives a move.** The assignee's own transitions on its
   assigned task are admitted by the assignment, not by reach, so a seat
   moved away from its task is never stuck holding it. Reach governs
   everything else. The canvas shows the reach change while the operator
   drags.
7. **Overseers** carry the operator's authority and are not blocked from
   moving their own seat. (Operator decision 9.)

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

Partial overlap is not refused and means nothing for reach. A region is the
parent of another only when it fully contains it; partially overlapping
regions are unrelated. A node inside two unrelated regions belongs to both
(rule 5). Geometry stays the one source of truth; no explicit parent.
(Operator decision 1.) The live `factory` canvas has 45 such sliver pairs;
none changes any seat's reach.

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
