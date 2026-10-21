# Junto 0.10 — plan

Status: draft for lead review. Owner: product-lead. Started 2026-10-21.
Nothing here is built yet. Each document states the target, the contracts,
what in the tree is kept, reshaped or deleted, and the open questions with
the lead who answers them.

## What 0.10 is

Junto moved from a factory (boards hand work to whichever seat is free) to a
team (seats collaborate, review each other, and the operator steers). The code
still carries the factory. 0.10 finishes the move:

1. **Who may touch a resource** is decided by regions, not edges.
   ([01-region-binding.md](01-region-binding.md))
2. **Where a resource lives** is every machine. Only seats, terminals and the
   browser stay on a host. ([02-universal-resources.md](02-universal-resources.md))
3. **How people talk about resources** is one mention system and one thread
   system, everywhere. ([03-mentions-threads.md](03-mentions-threads.md))
4. **Tasks** become a collaboration record: explicit assignment, review
   stamps, directed pipelines. The factory goes. ([04-tasks.md](04-tasks.md))
5. **Artifacts** absorb pad and sheet into one long-lived, commented,
   versioned resource. ([05-artifacts.md](05-artifacts.md))
6. **Browser** becomes local only, gets tabs and positional comments.
   ([06-browser.md](06-browser.md))
7. **Automations** replace cron and relay in one region-bound node.
   ([07-automations.md](07-automations.md))
8. **Continuity**: onboard carries state computed from records, so a fresh
   session moves on without reading transcripts. ([08-continuity.md](08-continuity.md))
9. **Deletions**: requests, bulletin board, the reviews edge, the Hermes
   integration, pinning, and the factory machinery. ([09-deletions.md](09-deletions.md))

## Principles

- **Delete over adapt.** A shape in the code that conflicts with the
  direction is replaced, not wrapped. Feature flags for removed surfaces go
  with them.
- **One meaning per concept.** One mention, one thread, one way to grant
  access to a resource, one assignment model.
- **Continuity comes from rows Junto already writes; notes stay what they
  are.**
- **Contracts first.** Every workstream starts from a shared type in
  `src/shared/` that the other layers build against.
- **The editing machine decides.** Every universal write is ordered and
  ruled by the canvas's editing machine; every other machine proposes.

## Doctrine this plan changes

These are written law today. 0.10 rewrites them; the rewrite lands with the
code, not before. `docs/security-doctrine.md:6` requires it and
`docs/architecture-canvas-physics.md` to change together; canvas and remote
share the cross-machine half.

| Law today | Where | 0.10 |
|---|---|---|
| "No 'same region ⇒ power'"; "Region membership alone: not a grant"; "Ambient region grants" is a non-goal | `docs/architecture-canvas-physics.md:57,242,257,286`; `src/shared/physics/admit.ts:11-13` | Region reach grants full access to resource nodes (01) |
| Synced rows are immutable with one writer and no conflict handling | `docs/machines.md:64-75` | Kept. Universal resources are built on it: seats propose, the editing machine rules (02) |
| Tasks, artifacts and other sinks are not carried to other machines | `docs/machines.md:368-372` | Carried everywhere (02) |
| Edges are capabilities for every sink | `src/shared/physics/verbs.ts`, `laws.ts:69-78` | Edges remain only for seat to seat mail, seat to page automation, and task to task flow (01) |
| Mail needs a granting edge; across machines only `msg.send`; closed exchange operations; region briefing only where a local seat is | `docs/security-doctrine.md:84-89,119-127,236-241`; `docs/machines.md:85-87` (rule 6); `AGENTS.md:463` | Reach mints mail (01); exchange opens (02); briefing rule kept |
| The PR test and impact cone | `docs/architecture-canvas-physics.md:242,264-266` | Rewritten for reach (01); locks in `tests/physics/physics.test.ts:107`, `tests/work-control-protocol.test.ts:149-225` change with it |
| Notes, labels, files and links stay on the editing machine | `docs/machines.md:51-52` | Carried everywhere (02) |
| The exchange is a closed list; a row stands alone | `docs/machines.md:71-72`; `src/shared/work-exchange.ts:54,72` | Opens to resource fact families that chain on predecessors (02) |
| Rule 5 entitlement | `docs/machines.md:76-81` | Every machine linked for a canvas is entitled to every resource fact (02) |
| Signal attachments stay where they were raised | `docs/machines.md:376-377` | Attachments as refs may cross (03) |
| Seat browser control "comes back" across machines | `docs/machines.md:378-380`; `docs/architecture-canvas-physics.md:189,194-195,268` | Browser is local only; seats on the page's own machine drive it (06) |

## Workstreams and who reviews what

Ownership is my proposal; each lead confirms or corrects it in their reply.

| Area | Proposed owner | Reviewers |
|---|---|---|
| Region reach, kinds, verbs, wires, migrations of the canvas model | canvas | cli, product |
| Universal resources, link channel, Linux surface | remote | canvas, cli |
| CLI surface, discovery, onboard output | cli | pty, product |
| Mail delivery for mentions, stamps, assignment; seat sessions and offboard | pty | cli, product |
| Composers, mention component, task, artifact, browser, automation and feed UI | product | canvas |

## Sequencing

Each phase lands on main behind nothing: a phase is done when its old path
is deleted, not when the new one works beside it.

0. **Deletions and doctrine.** 09 first. It shrinks every later diff.
1. **Foundations.** Region reach (01), the resource fact channel (02), the
   mention and thread core (03), continuity ledger v1 (08).
2. **Tasks** (04).
3. **Artifacts and feed associations** (05, 03 section 6).
4. **Automations** (07).
5. **Browser** (06).

Phases 2 to 5 can overlap once phase 1 contracts are frozen.

## Operator decisions already made

Recorded here so no lead reopens them.

- Region reach covers the seat's region, regions below and regions above,
  never siblings. Resource nodes carry no edges except task to task.
- Every non-host node is synchronized to every machine; tasks and artifacts
  no longer pick a host.
- Task edge roles (manages, contributes, works), automatic assignment and
  any seat creation limits are deleted. Assignment is explicit, by the
  operator or any seat. A seat holds at most one task and works one at a
  time; it moves only tasks assigned to it, and unassigning returns a task
  to backlog.
- Rules and checks stay as they are for now.
- Reviews are stamps: a task declares how many it needs, any seat in reach
  can review, a review is not an assignment, stamp requests go by mail when
  the owner tries to finish. The onion of layers stays.
- Artifacts absorb pad and sheet. Browser is local only and leaves Junto
  Remote. Automations replace cron and relay; webhooks are designed for, not
  built.
- Deleted end to end: requests, bulletin board, the reviews edge, the
  Hermes integration (not the Hermes terminal harness), pinning.
- 2026-10-21, on the draft: the doctrine rewrite is intended. Universal
  resources extend the single canvas owner's authority to resources.
  Mentions are three parts: a combobox component, availability components
  (seat connection, region reach), and side effect hooks chosen per
  composer, never one universal meaning. Continuity as drafted in 08.

## Open decisions for the operator

Collected from the documents; each has a recommendation. These go to the
operator as one signal after the leads have weighed in.

1. Regions that partially overlap: refuse them (recommended). `factory` has
   45 sliver overlaps to fix once, by hand or with a one-time `separate`
   command. (01)
2. Nodes outside every region: in reach of every seat on the canvas
   (recommended). The flip side: a seat dropped outside every region reaches
   every resource. (01)
3. (Settled 2026-10-21, see below.)
4. (Settled: 0 pads and 0 sheets exist; dropped.)
5. Oldest supported database: raise the migration floor to v13 so the
   legacy row reader can go (recommended). (09)
6. Harness gates that exist only as a way back off: delete them
   (recommended). (09)
7. Writes to universal resources while the link to the editing machine is
   down: refuse with a retryable error (recommended) or queue. Cost of
   refusing: while the desktop sleeps, remote seats cannot write resources
   and no automation fires. (02)
8. Region is a scope, not a wall: mentions, stamp requests, assignments and
   automations mail seats without a `messages` edge, so siblings can always
   reach each other through a shared ancestor resource. Accept (recommended).
   (01)
9. An overseer moving or resizing its own seat (which would change its
   reach): refuse, as deleting it is (recommended). (01)
10. Notes in 0.10: seats in reach read them, only the operator writes them
   (recommended). (01)
11. Flags this plan does not cover: `usage`, `helpMap`, `liveOverseer`,
   `seatAwareness`. Keep, ship or delete? (09)
