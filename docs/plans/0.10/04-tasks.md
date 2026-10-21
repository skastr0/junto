# 04 Tasks

Proposed owner: product (UI), canvas (model and pipeline), cli (commands).
Reviewers: pty.

## Target

Tasks are the record of who is doing what and who has looked at it. A task
node is a list of tasks in a region. Any seat in reach creates tasks, assigns
them (to itself or another seat), adds dependencies and reviews. A seat holds
at most one task and works it by hand. Finishing collects review stamps. Task
nodes connect to other task nodes in one direction to form pipelines, and a
task carries its layers (one per node it passed through) as it flows.

## Today

- States `submitted, working, input-required, completed, canceled, failed,
  rejected, auth-required, archived` (`src/shared/work-model.ts:115-123`),
  transitions at `src/shared/task.ts:67-121`.
- Edge roles `manages`, `contributes` (agent to task) and `works` (task to
  agent) grant ports and claimability (`src/shared/physics/verbs.ts:177-187,280-299`).
- Automatic assignment: `selectFactoryClaims` gives each open task the first
  free `works` seat (`src/shared/factory-tick.ts:73-157`), driven by the
  kernel (`src/main/junto/kernel/service.ts`, about :600-1090) with a claim
  prompt (`src/shared/factory-claim-prompt.ts`, 324 lines).
- Tasks a seat creates wait for operator approval (`admissionOmitted:
  "approval"`, `src/main/junto/work/control.ts:1628-1629`; promote at
  `src/main/junto/work/service.ts:1642-1660`; board setting "Who starts
  tasks").
- Pipelines: `feeds` wires between task nodes form a DAG
  (`src/shared/flow-graph.ts:31-152`); `sendTaskOn` closes a visit and opens a
  row at the next node with the same task id (`repository.ts:6160`);
  `sendTaskBack` files a defect and bumps the epoch (`repository.ts:6390`).
- Layers: region rules, then node rules, then the task's rules for this node
  (`src/shared/rules.ts:71-97`). Seats see earlier visits as handoff note plus
  cited refs (`service.ts:1718-1760`); the UI draws the visit timeline
  (`src/renderer/components/work/task-visits.ts`).
- Review: `ReviewVerdict` green or blocking, bound to epoch and subject hash
  (`src/shared/crew.ts:170-212`); `requires-review` rule gates completion
  (`src/main/junto/work/reviews.ts:482-560`); reviewers come from an agent to
  agent `reviews` edge (`reviews.ts:565-627`).
- Tests are thin: no tests found for factory tick, rules or flow graph.

## States

```
backlog ──assign──▶ assigned ──start──▶ working ──finish──▶ in-review ──stamps met──▶ done
   ▲                   │                   │  ▲                 │                     │
   └────unassign───────┴───────────────────┘  └──changes asked──┘                 sent on
                                   working ◀─▶ input-required                  (next node)
any state ──cancel──▶ canceled          done, canceled ──archive──▶ archived
```

- `backlog`: no assignee. `assigned`: assignee set, not started.
- Only the assignee moves `assigned` to `working`, `working` to
  `input-required` and back, and `working` to finish. Unassign from any open
  state returns the task to `backlog` and clears the assignee.
- `finish` with no stamps required goes straight to `done` (or sent on).
  With stamps required it goes to `in-review` and stamp requests go out.
- `failed`, `rejected` and `auth-required` go. A rejection is a review asking
  for changes; a failure is a comment and an unassign or a cancel.

Invariants, enforced by the editing machine (02):

1. A task has at most one assignee.
2. A seat is the assignee of at most one open task (`assigned`, `working`,
   `input-required`, `in-review`) across the canvas. Reviews do not count.
3. Only the assignee transitions its task; anyone in reach may assign an
   unassigned task, unassign, comment, review, cancel.

## Review stamps

```ts
type StampPolicy = { readonly required: number };          // 0 means none
type Stamp = {
  readonly reviewer: NodeId;
  readonly verdict: "approve" | "changes";
  readonly epoch: number;
  readonly subjectHash?: string;    // existing review-subject-hash, when the work has commits
  readonly text?: string;
  readonly at: number;
};
```

- A task sets `required` at creation or later; a task node may set a default.
- Reviewers: any seat in reach adds itself or is added by anyone in reach.
  The assignee cannot stamp its own task.
- On `finish`, every reviewer without a current stamp receives a stamp
  request: one mail in the task's thread (03), carrying the task as an
  association.
- `approve` counts when its epoch is the task's current epoch. `changes`
  moves the task back to `working`, files a defect and bumps the epoch, as
  `sendTaskBack` does today; every earlier stamp stops counting.
- `required` approvals at the current epoch moves `in-review` to `done` (or
  sends it on).
- Built on the existing verdict tables and gate: reviewer eligibility moves
  from the `reviews` edge to the task's reviewer list.

## Pipelines and layers

- One verb between task nodes, from upstream to downstream. Proposed name:
  `flows` (replacing `feeds`). DAG, as today.
- Finishing on a node with downstream nodes sends the task on; with several,
  the assignee names the next one, as today.
- Sending on closes the layer: its assignee, stamps, checks, handoff note and
  comments thread stay on that layer. The task arrives at the next node in
  `backlog` with no assignee and that node's stamp default.
- A seat sees earlier layers as handoff note, stamps and cited refs; the
  operator sees everything. Unchanged from today's onion.
- Rules and checks: unchanged in 0.10, reviewed after.

## CLI (`junto task`, seats need no edge)

`list`, `show`, `create`, `edit`, `assign <task> [seat]`, `unassign`,
`start`, `pause` (input-required), `resume`, `finish [--next <node>]`,
`cancel`, `depend <task> --on <task>`, `reviewer add|remove`,
`stamp <task> approve|changes`, `comment`, `check`, `rules`, `wait`.

Deleted: `claim`, `promote`, operator-only respond paths that the needs-you
feed replaced, `verdict post` (now `stamp`).

Assigning a task to a seat mails that seat a short assignment notice in the
task's thread. That replaces the factory claim prompt.

## Kept, reshaped, deleted

| | |
|---|---|
| Kept | Task rows and history, dependencies (`task-deps.ts`), flow DAG, visits and epochs, defects, rules and checks, verdict tables, `TaskBoard` as the base of the UI |
| Reshaped | State set, transitions, owner (assignee, stored), comments as threads, verdicts as stamps, blocked derivation from assignee and state |
| Deleted | `manages`, `contributes`, `works`, `reviews`; `factory-tick.ts`, `factory-claim-prompt.ts`, the kernel factory block, reclaim grace; admission and approval (`TaskAdmission`, promote, "Who starts tasks", `clampRequestedAdmission`); the operator "Me" board ownership rule |
| New | `assign`, `start`, reviewer list, `StampPolicy`, the one open task invariant, tests for the state machine, stamps and flow |

## Questions

- **canvas**: The one open task per seat invariant across the canvas: any
  reason it must be per region instead?
- **canvas**: Pipelines across regions: a `flows` edge between task nodes in
  different regions. Allow only when the downstream node is in reach of the
  upstream one?
- **pty**: Assignment and stamp request mails: delivered like any mail, or
  does an assignment need to wake a sleeping seat the way the factory did?
- **cli**: `junto task` (singular) replacing `junto tasks`: rename now, or
  keep the group name?
