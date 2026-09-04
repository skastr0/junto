# Tasks domain: rules and claims

Status: ruled by the operator on 2026-09-03, with the complete in-place
migration ruled on 2026-09-04. This document is the canonical
vocabulary for the Tasks node. Code identifiers, wire fields, CLI commands,
operator copy, and agent-facing docs all use these words and no others.
Where the code still uses older words, that is migration work tracked in
[`tasks-consolidation-plan.md`](tasks-consolidation-plan.md).

This is corrective removal of broken code, not accommodation of respected
legacy behavior. Corrected schema 21 rewrites an existing invalid version-21
database atomically on open, including current state and Work history,
recomputes correlated hashes, materializes proposal state as Tasks, and removes
the invalid storage and code. Fresh upgrades build the corrected shape
directly. Neither the schema version nor the disabled Remote wire protocol is
bumped. After repair the product carries no compatibility reader, old key, old
table, or retired Tasks vocabulary; only the isolated corrective converter can
recognize an invalid pre-fix version 21.

## Why this exists

The Tasks feature was built by several agents in sequence. Each one carried a
visualization analogy (a railway line with stations, arrivals, departures,
boarding, tickets, passages, journeys, bake time) into identifiers, schema
fields, and product copy. The analogy collided with the real Station concept
(remote installations in `docs/fleet-station-architecture.md`) and made the
feature unreadable. The operator's ruling is that product language stays
neutral and plain: a user must never have to ask what an arrival is.

The governing metaphor for the product at large is a factory with strict
contracts. That is a way of thinking, not a theme. Copy does not say
"factory" or "contract" unless the word is the plainest one available.

## The words

| Concept | Word | Notes |
|---|---|---|
| The node | **Tasks** | Physics role: sink. Default node name is `Tasks <short id>`. Never station, sink, stop, or stage in copy. |
| The node opened | **board** | It is a kanban board. Acceptable next to the message board because the sentence always disambiguates. |
| The node's settings | **Board settings** | One panel with two sections, **Incoming** and **Outgoing**. |
| Text agents read when they claim a task here | **Instructions** | Prose. Not validated. |
| A region's prose for agents inside it | **Brief** | Prose. Not validated. Stacks outer to inner. |
| A statement the work must satisfy | **Rule** | Authored by the operator on a region, a Tasks node, or a single task. Every rule must be answered. Rules have no severity. |
| Rules from enclosing regions, shown on a board | **Region rules** | Read only on the board. Edited on the region. |
| The set of rules in force at a board for a task | **Rules in force** | Region rules (outer to inner), then the board's rules, then the task's own rules addressed to this board. Concatenation. No override, no precedence, no dedupe. |
| An agent taking a task | **Claim** | `submitted` to `working`. Unchanged from the physics doc: claim is task start. Copy says claim, never assigned. |
| An agent's statement against one rule at completion | **Claim** | "The agent claims X is true about the work." Same word, different object; the sentence always names the object (claim a task, make a claim about the work). Stored per rule with optional references. |
| Skipping a task's rule because the chosen path no longer reaches its board | **Waiver** | Only this case. Requires a reason. Any defect cancels every waiver. |
| Sending a task back to an earlier board | **Defect** | Copy says **Send back**. Bumps the epoch. Claims recorded at the target board and after it no longer count. Claims before it stay valid. |
| A shell command run on entry or exit | **Check** | Exit 0 passes. The agent runs it, the work service records the result. |
| Prose the agent writes when sending a task onward | **Handoff note** | Required text when the outgoing contract asks for it. |
| Who may claim a new task | **Who starts tasks** | Values: **Immediate** (any agent right away), **Approval** (waits for the operator), **Me** (the operator works it). |
| A delay before any agent may claim | **Wait before starting** | Set on the board as a default, or on a task at creation. |
| Boards a task can move to | **Path** | The next board is **Next**. Tasks that left this board sit in **Sent on**. |
| The record of boards a task has been through | **Visits** | One entry per board entered, with how it left. |
| Operator precedent pinned after a request resolves | **Ruling** | Lives on the region beside its rules. Served to agents with the brief. |

## What the system validates and what it does not

Strict contract means the work service refuses a completion until the
structure is complete. It never judges content.

Validated (refused without it):

- every rule in force has a claim from the agent, or a waiver in the fork case;
- every check on exit passed for the current epoch against the command as
  currently authored;
- when the board has more than one Next, the agent named one.

Not validated, only shown:

- instructions, brief, handling text, board descriptions, handoff note
  content, rulings;
- the truth of any claim. Claims are checked by minds: the next board's agent,
  or the operator.

## Two kinds of data

Rules are **structure**: repeatable, visible, authored once, in force for
every task passing through their scope. Claims are **content**: one agent's
answers for one task in one epoch. They are separate records and must never be
stored in one list.

## The stack, read top down

```
region (outer)  brief, rules, rulings
  region (inner)  brief, rules, rulings
    Tasks node    instructions, rules, incoming (who starts, wait, handling, checks on entry),
                  outgoing (handoff note, checks on exit)
      task        its own rules, each addressed to one board on its path
        claims    the agent's answers, recorded at completion at each board
```

An agent sitting in a nested region reads three briefs and answers three
layers of rules. That is the point of nesting: geography is prompting.

## Open questions, with the current default

- **Region and board rules across several boards.** Once per epoch at the
  last board inside the rule's scope, or again at every board. Current
  default: once per epoch. The completion gate adopts this reading; today the
  gate and the readiness report disagree.
- **Proposals.** Merged into tasks with admission Approval. The leftover
  proposal tables, ops, and the Awaiting approval lane are retirement work.

## Words that are retired

station (for this node), stop, stage, sink (in copy), line, route, arrival,
departure, boarding, ticket, passage, journey, bake, emission, admission (in
copy), assigned, hard, soft, required, optional (as rule strengths), inherited
law, standing law, claim packet, pin (for a task's rule), copy existing.
