# Canvas test locks for 0.10

Owner: canvas-verifier. The doctrine moves from "region membership is not a
grant" to reach (01). Every line below asserts the old law today. The commit
that changes the behaviour flips its lock in the same commit, to an assertion
of the new law. A lock is never deleted bare, skipped, or weakened to an
assertion that holds under both laws. Review refuses any canvas commit that
leaves one of these red, skipped, or asserting nothing.

## Locks that must flip with C1 (reach)

| Lock | Old law it asserts | New assertion |
|---|---|---|
| `tests/physics/physics.test.ts:107` | region co-members get `not_connected`, through `view.regionPeers` | Keep for the page (06: page automation stays edge-bound). Add beside it: co-member, ancestor and descendant seats admitted on a task, artifact and automation node with no edge; a sibling and a cousin refused. |
| `tests/physics/physics.test.ts:133` | no edge and no co-membership gives `invisible` | Holds for seats and pages. For a resource node, the refusal names reach, not a missing edge. |
| `tests/physics/physics.test.ts:342` | a task board on another editing machine refuses `tasks.claim` with `other_machine` | Resource ports skip the same machine check (01 Admission); the write is ruled on the editing machine (02). The lock asserts the ruling, not the refusal. |
| `tests/work-control-protocol.test.ts:224` | `ScopeError` always "names the missing edge" | Seat targets keep it. Resource targets name reach and say how to list what is in reach. |
| `tests/git-review.test.ts:194` | "never outsiders": a seat outside every region is not a candidate | Under rule 2 a loose seat reaches every resource, so `seatsInReach` includes it. Decide with canvas-lead whether review candidates move to `seatsInReach` (01 Reshaped); the lock follows that decision. |
| `tests/work-task-policy-store.test.ts:36` | dependency scope by edge topology and innermost region | `task-dep-scope` uses reach (01 Reshaped). Add region cases: an ancestor's and a descendant's tasks in scope, a sibling's not. |

## Doctrine text that must change with the C1 doc rewrite

Not tests, but the text the tests and reviewers read.

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
