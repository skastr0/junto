# Junto 0.10 — plan

Status: approved 2026-10-21, in execution ([10-execution.md](10-execution.md)). Owner: product-lead. Started 2026-10-21.
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
| Notes, labels, files and links stay on the editing machine | `docs/machines.md:51-52` | Labels, files and links carried everywhere; notes unchanged (02) |
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

Superseded 2026-10-21: everything runs in parallel against shared contracts.
See [10-execution.md](10-execution.md) for tracks, owners and the tracker.

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

## Operator decisions, 2026-10-21

Answered on the needs-you feed; the documents follow them.

1. **Overlap.** Partial overlap means nothing for reach and is not refused.
   Only full containment makes a parent or a child. A node inside two
   regions that are not nested belongs to both. (01)
2. **Loose nodes and seats** at the canvas root reach and are reached by
   everything. Intentional, a feature. (01)
3. **Mentions** are combobox, availability and per-composer side effects. (03)
4. **Pad and sheet** content: none exists; dropped. (05)
5. **Migration floor** raised to v13; the legacy row reader goes. No users,
   so keep the tree clean. (09)
6. **Feature switches** all stay as they are for now, including the ones
   that only turn shipped features back off and `usage`, `helpMap`,
   `liveOverseer`, `seatAwareness`. (09)
7. **Writes never fail because the editing machine is away.** Remote seats
   keep writing; their writes queue and the editing machine rules the queue
   when it is back. Running an always-on machine as the editor, or not
   mixing machines in one region, is operating practice, not a product
   rule. (02, being redesigned by remote and canvas)
8. **Region is a scope, not a wall.** The edge rule only ever meant direct
   mail; reach-minted mail between siblings is intended, for collaboration.
   (01)
9. **Overseers** carry the operator's authority and are not blocked from
   moving their own seat. (01)
10. **Notes** are untouched by 0.10: not resources, no seat access, no sync
   change. (01, 02)
