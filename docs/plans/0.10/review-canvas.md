# 0.10 plan, canvas review

Reviewer: canvas. Against commit 8ed40f8cf. Data figures come from a copy of
this machine's `junto.db` (schema v25, one canvas, `factory`); other machines
are unverified.

## Ownership

Confirmed: 01 region reach, 04 model and pipeline, 07 runner and model, the
physics doctrine rewrite. Corrected for 09: canvas owns the migration chain
and reviews every step, but each phase writes its own step with its code (see
09 below). The cross-machine half of the doctrine rewrite
(`security-doctrine.md`, `machines.md`) is shared with remote.

## What rewriting "region membership is not a grant" breaks

1. **Reach mints mail, not only resource access.** A mention in a resource
   thread mails the seat (03:62-75), and so do stamp requests (04:88-90),
   assignment notices (04:122-123) and automation `mail` (07:60). None of
   them needs a `messages` edge. "Mail still requires a granting edge"
   (`docs/security-doctrine.md:87`) no longer holds, and edges stop gating
   seat to seat contact. Two sibling seats can always mail each other through
   any ancestor resource, root at least. So "never siblings" scopes what a
   seat sees by default. It does not wall siblings off. Keep
   `architecture-canvas-physics.md:286` "Region is geography, not a security
   domain" and say it plainly.
2. **The ambiguous-node fallback fails open** (01:89-90). The root path is a
   prefix of every path, so an ambiguous *seat* placed at root reaches every
   resource on the canvas, and an ambiguous resource is reachable by every
   seat. It has to fail closed: an ambiguous seat reaches only its own
   assigned task, and no seat reaches an ambiguous resource until the overlap
   is fixed.
3. **Automations plus upward reach let a seat act on siblings.** A seat in
   R1 reaches an Automations node in parent P (upward), creates an
   automation, and `targetsBelow(P)` covers sibling R2. Fix, adopted for 07:
   targets are `targetsBelow(node) ∩ reach(author)`, rechecked at fire time
   against the author's current position. An automation the operator wrote
   gets all of `targetsBelow`.
4. **Moving a node now grants and revokes.** Reach is re-read on every write
   (01:65-67). Under the whole-rectangle rule (`src/shared/model/canvas.ts:89-96`),
   a seat card nudged over a border silently drops to its parent's reach. A
   seat moved out of reach of its assigned task holds an open task it cannot
   move and cannot take another one (04 invariant 2), so it is stuck.
   Proposal: the assignment admits the assignee's own transitions on that
   task; reach governs everything else. The canvas must show the reach change
   while the operator drags.
5. **Overseer moves become grants.** `node.move` and `node.resize` are closed
   overseer commands (`src/main/junto/overseer/canvas.ts:83-84`), so an
   overseer can now widen its own reach by moving its own seat. The doctrine
   must decide whether moving its own seat is refused, as deleting it is
   (`security-doctrine.md:98`).
6. **Notes as resources** (01:12) conflict with existing law. Notes are
   furniture with no ocap wield (`architecture-canvas-physics.md:84`), and
   note text is a canvas row, so a seat editing a note is a seat writing the
   canonical canvas (`security-doctrine.md:91`). Proposal: in 0.10, seats in
   reach can read notes and only the operator writes them.
7. **A seat outside every region reaches every resource on the canvas.**
   This follows from operator decision 2 plus "regions below". It is not a
   reopening, but the operator should see it stated. There are 0 such seats
   today (127 seats, all inside regions). Every new seat dropped loose on the
   canvas gets reach over the whole canvas.
8. **The doctrine table (README:52-57) is missing laws that this plan
   breaks.** `security-doctrine.md:84-89` (across machines only `msg.send`),
   `:87` (mail needs an edge), `:119-127` (region briefing goes only where a
   local seat is; notes, labels, files and links stay on the editing
   machine), `:236-241` (closed exchange operations), the PR test
   `architecture-canvas-physics.md:264-266`, the impact cone `:242`,
   `machines.md:85-87` (rule 6), and `AGENTS.md:463`. `security-doctrine.md:6`
   requires both documents to change together. Tests that lock today's law:
   `tests/physics/physics.test.ts:107`, `tests/work-control-protocol.test.ts:149-225`.
9. Citation fix: the `wires.verb` CHECK is at `src/main/junto/model/state-schema.ts:186`.

## Answers

**01, partial overlap.** This breaks the live canvas. `factory` has 80
regions and 45 partially overlapping pairs. Every one is a sliver: at most
4.1% of the smaller region and 15 px deep. No seat or note sits in a sliver,
and all 127 seats have cleanly nested stacks, at most two deep. So no seat's
reach is ambiguous today, but authoring would refuse any edit to those 45
regions until they are fixed. Recommendation: refuse partial overlap on
region create, move and resize, have the migration report the pairs, and let
the operator fix them once, either by hand or with a one-time operator
`separate` command. The migration never moves geometry (a migration that
rewrites the document is refused, `architecture-canvas-physics.md:357`).
Also refuse regions with identical frames, since each contains the other
(0 today).

**01, geometry or explicit parent.** Geometry. Membership has one rule
(`canvas.ts:89-90`) and "what an agent can do is what you drew"
(`architecture-canvas-physics.md:336`). An explicit parent is a second truth
that can disagree with the picture. The cost is items 4 and 5 above.

**01, blocked per wire.** Agree. Law 2a already defines blocked as actor
state (`architecture-canvas-physics.md:101`). Breaks: `blockedEdgeIds` and
per-edge paint (`src/shared/execution-graph.ts:183-210`) lose their edge, so
the mark moves to the seat ring. `auth-required` and requests stop being
sources. `in-review` is not blocked, because the assignee has nothing to
answer; reviewers get mail.

**02, size of carrying every non-host node.** Yes, there is a hard limit.
The whole copy travels as one `CopyFrame` event on `rows`
(`src/shared/work-exchange.ts:113`), and a frame is at most 1 MiB
(`src/main/junto/link/protocol.ts:9-10`). Today's content is small (10 notes,
37 KB of text; region instructions, 12 KB), but carrying everything to every
machine moves toward that limit, and the only failure mode is a canvas that
stops syncing. Recommendation: the copy carries geometry and labels, and
bodies (note text, briefings) travel as facts or content refs. Also, "region
outlines become full regions" (02:87-88) must mean geometry and label only:
briefing, references, folder maps and environment sources still go only
where a local seat is in the region (`security-doctrine.md:119-121`).
Miss: `ResourceCommand.actor` (02:69) is only the forwarding machine's claim.
The editing machine must check that the actor is a seat placed on that
machine at the stated count (`security-doctrine.md:243-248,256-262`), and it
must admit `actor: "operator"` only from its own owner path. Otherwise any
linked machine can forge operator acts: stamps, assignments, cancels.

**03, backlinks.** Use a projection table, written in the same transaction
as the fact that carries the text, rebuildable from facts and never read for
authority. Rebuilt from the text, it cannot disagree with the text.
Computing on read means parsing every thread each time a resource opens.
Miss: the mention encoding embeds the canvas name
(`junto://canvas/factory?...`, 03:47-48), but `canvas_name` is a mutable key
(`ON UPDATE CASCADE`, `state-schema.ts:3`). A rename breaks every stored
link. Use node ids, which are unique per canvas, and take the canvas from
context.

**04, one open task per seat across the canvas.** Canvas-wide is right. A
seat is one occupant, and physics already says one actor has at most one
active task (`architecture-canvas-physics.md:193`). Per region would let a
nested seat hold one task per level. No seat holds more than one open task
today (12 submitted, unassigned; 1 working), so the invariant holds at
migration.

**04, flows across regions.** Allow every `flows` edge the operator draws;
don't require reach. The edge is operator authoring and the last
task to task capability. Sending a task on places it in the downstream
backlog and gives the sender nothing there. Requiring reach would forbid
handoff between sibling regions, which is the main team handoff.
Miss: a state remap belongs in the migration. On this machine there are 59
`rejected` rows and 1 `failed` row, and 363 task rows sit on 18 task nodes
that no longer exist on the canvas (0 `task_boards`). Proposal:
`submitted` becomes `backlog`, or `assigned` when it has an actor;
`completed` becomes `done`; `rejected` and `failed` become `canceled`.
Entitlement follows live nodes, so orphan rows stay local and are not
replicated.

**05, existing pad and sheet nodes.** There are 0 pads and 0 sheets here.
Drop them.

**06, page on a canvas edited elsewhere.** Use a stub shaped like a `peer`
row: id, geometry, label, machine, and no host fields. Reach, region paths,
mention candidates and comment subjects need it, and without it the
operator's picture has a hole. Also: only the editing machine authors nodes,
so "lives on the machine that created it" (06:37) means pages live on the
editing machine. If that machine has no window, there are no pages; state
this.

**07, runner only on the editing machine.** Nothing has to *run* where a
seat lives, but seat facts have to *start* there. Occupancy is live state on
the seat's own machine (`architecture-canvas-physics.md:170-180`), and the
editing machine sees only its own seats. So each machine writes occupancy
transition facts for its own seats (it is their writer,
`security-doctrine.md:245`), and the runner stays single. Cost: when the
editing machine is a laptop with its lid closed, schedules stop for every
machine, where today a cron fires on its own host (07:20-21). Record missed
slots as skipped, with the reason, on wake; do not fire them in a burst.
Actions need an author: the automation node becomes a mail and ruling
principal (a principal must resolve to a node,
`architecture-canvas-physics.md:361`). Loop safety catches only direct
facts. A loop through a seat (automation mails a seat, the seat acts, its
fact fires the automation) is caught only by `limits`; say so.

**09, one migration or one per phase.** One per phase, each landing with its
code. Steps are a chain of +1 versions (`src/main/junto/state/migrations.ts:1200-1202`),
and "a phase is done when its old path is deleted" means each phase drops
its own tables. Proposal: v26 for phase 0 deletions; v27 for phase 1
(collapse `entity_home`, the ruling table, fact families); v28 for the task
state remap; v29 for automations. Collapsing `entity_home` belongs to phase
1, not v26 (09:86): before the commands channel exists, a non-editing
machine would still be writing into a lane rewritten under the editor's
identity. Each step is `consolidate` with `replacesTables` for the CHECK
changes. The guard allows row deletes only in replaced or removed tables
(`migrations.ts:1089-1105`), so wires with removed verbs are dropped by a
filtered copy forward. The live canvas has 420 wires, all `messages`, so no
rows are lost here.
