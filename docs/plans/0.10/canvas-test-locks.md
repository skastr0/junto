# Canvas test locks for 0.10

Owner: canvas-verifier. The doctrine moves from "region membership is not a
grant" to reach (01). Every line below asserts the old law today. The commit
that changes the behaviour flips its lock in the same commit, to an assertion
of the new law. A lock is never deleted bare, skipped, or weakened to an
assertion that holds under both laws. Review refuses any canvas commit that
leaves one of these red, skipped, or asserting nothing.

Review gate (operator, 2026-10-21): a small-tsconfig `tsc` over the
commit's files, the unit tests it touches, and the diff, run in the shared
checkout. Full verify and real-app runs are batched per milestone. The reach law is also locked in types: `region-reach.ts` carries a
type-level test where misuse of a ref or a path fails `tsc` (an expect-error).

## Locks that must flip with C1 (reach)

All six flip with canvas-edges' C1 work. Flipped means the lock now asserts the
new law.

| Lock | Old law it asserts | New assertion | State |
|---|---|---|---|
| `tests/physics/physics.test.ts:107` | region co-members get `not_connected`, through `view.regionPeers` | Keep for the page (06: page automation stays edge-bound). Add beside it: co-member, ancestor and descendant seats admitted on a task, artifact and automation node with no edge; a sibling and a cousin refused. | flipped, 73bf05d6d |
| `tests/physics/physics.test.ts:133` | no edge and no co-membership gives `invisible` | Holds for seats and pages. For a resource node, the refusal names reach, not a missing edge. | flipped, 73bf05d6d |
| `tests/physics/physics.test.ts:342` | a task board on another editing machine refuses `tasks.claim` with `other_machine` | Resource ports skip the same machine check (01 Admission); the write is ruled on the editing machine (02). The lock asserts the ruling, not the refusal. | flipped, 73bf05d6d |
| `tests/work-control-protocol.test.ts:224` | `ScopeError` always "names the missing edge" | Seat targets keep it. Resource targets name reach and say how to list what is in reach. | flipped, 73bf05d6d |
| `tests/git-review.test.ts:194` | "never outsiders": a seat outside every region is not a candidate | Decided (canvas-lead): candidates are `seatsInReach(anchor)`, one availability rule (03). A loose seat reaches everything (rule 2), so it is a candidate; a sibling region's seat is not. | flipped, 1c7d6483b |
| `tests/work-task-policy-store.test.ts:36` | dependency scope by edge topology and innermost region | `task-dep-scope` uses reach (01 Reshaped). Add region cases: an ancestor's and a descendant's tasks in scope, a sibling's not. | flipped, 67e063f19 (`tests/task-dep-scope.test.ts`) |

## Open regression

| Lock | Gap | Closes with | State |
|---|---|---|---|
| finish checks the node's rules | c1c13cc62 deleted the old complete path; d518e086b adds `rules-unmet` and the evidence field, but nothing produces it, so a finish with rules in force is not checked | canvas-writers' `finishRulesUnmet` env port (taskCanvasEnv: rulesInForce, evaluateRules, finish criteria), tested for an unanswered rule, an answered one, and requires-review left to stamps | open |

## Doctrine text that must change with the C1 doc rewrite

Not tests, but the text the tests and reviewers read. All rewritten in
50a67cd60 and dab3240b8.

| Line | Says |
|---|---|
| `docs/architecture-canvas-physics.md:257` | "Region membership alone: Not a grant" |
| `docs/architecture-canvas-physics.md:286` | "Ambient region grants" as a non-goal. 01 keeps "Region is geography, not a security domain" and states it plainly; the non-goal row goes. |
| `docs/architecture-canvas-physics.md:264` | PR test: no capability "without a connected edge" |
| `docs/security-doctrine.md:87` | "Mail still requires a granting edge" (01: no longer holds) |
| `AGENTS.md:161`, `:443`, `:463` | edges as the only grant, "No ambient region grants" |

`tests/overseer-coverage-matrix.test.ts:236` reads `AGENTS.md` and the
physics doc by substring. Its strings survive the rewrite; if one goes, the
test is updated in the same commit.

## Locks that go with C2 (deletions)

Tests on deleted verbs, `claimable`, board `wake`, scheduler and relay edges
are deleted with the code they cover, not kept green by stubs. Largest first:
`tests/region-settings-writers.test.ts`, `tests/region-writers-keep-fields.test.ts`,
`src/shared/scheduler-effects.test.ts`, `tests/overseer-canvas-commands.test.ts`,
`tests/model-wire-grant.test.ts`, `tests/physics/verbs.test.ts:80` (pair
matrix snapshot), `tests/main-authoring-gate.test.ts`. A test that only uses
a deleted verb as a fixture moves to a surviving verb (`messages`,
`navigates`, the task to task verb).

The deletions step keeps `reviews` in the `wires.verb` CHECK until the
reviewer list replaces the `reviews` edge (canvas-edges with canvas-writers).
It does not enter the chain while `reviews` is kept;
`tests/canvas-deletions-migration.test.ts` then asserts reviews wires go.

The step also stores `feeds` as `flows`, and its CHECK has no `feeds`. It
enters the chain in the same commit that makes physics write `flows` (today
`verbs.ts` still names `feeds`): the head CHECK has no `flows`, so neither can
land first, and apart, one side's task to task wire writes fail a CHECK.
`participates` stays in the CHECK while boards and request boards are live
kinds (133f7adbf).
