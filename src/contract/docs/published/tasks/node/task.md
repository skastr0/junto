# Node kind: task

**Role:** sink

Tasks: assigned to a seat in the node's reach, worked and finished with junto task.

## Ports offered
- (none: reach admits; a seat with this node in its reach holds every command below)

## Data model
_Task node: each task has a stable TaskId and a number (#42) and moves backlog, assigned, working, in-review, done. dependsOn holds TaskIds only, and a task cannot finish until each is done. Every rule in force needs a claim on the finish; stamps decide in-review. When a task closes done on a board that derives into others, each of those gets a new backlog task with the same title and no assignee; task show names it derivedFrom on the new task and lists it under derived on the origin._

- `kind`: string
- `id`: string
- `x`: number
- `y`: number
- `width`: number
- `height`: number
- `z`: integer
- `color`: string
- `name`: string
- `contract`: object

## Events
- task.create — a task starts in backlog with a stable TaskId and its number (#42)
- task.assign, task.start, task.pause, task.resume — assigned, working, input-required and back
- task.finish — in-review while it waits on stamps, then done or sent on to the next node; refused rules-unmet while a rule in force has no claim
- task.stamp — approve counts at the current epoch; changes sends the task back to working on a new epoch
- content.* — ContentRef materialization events for task media

## Contract

`junto onboard` compiles the commands a seat holds on this kind. The full contract:

A seat with this node in its reach holds all of these.
```
### Contract — tasks (target `<task-node-id>`)

| intent | command |
|---|---|
| list queue | `junto task list --node <task-node-id>` |
| my tasks | `junto task list --assignee me` |
| reviews I owe | `junto task list --reviewer me` |
| read a task and its layers | `junto task show #<n>` |
| wait for task state | `junto task wait #<n> --until done --timeout 30s` — also input-required, in-review or canceled |
| author a task | `junto task create "<title>" --body "..."` |
| start or hand off | `junto task start #<n>, junto task assign #<n> @<seat>` |
| rules + readiness | `junto task rules #<n>` |
| report this move's checks | `junto task check #<n> --outgoing <checkId>=<exitCode>` — run each yourself first; --incoming for the next node's, --next <node> when there are several |
| progress, finish, ask for input | `junto task comment|finish|pause|resume #<n>` — finish --note leaves a handoff note; reviewers stamp with junto task stamp #<n> approve|changes |

A task moves backlog, assigned, working, in-review, done. `task finish` is ruled, not declared: a task that needs stamps waits in `in-review` until its reviewers approve with `task stamp <task> approve`, and `changes` sends it back to `working` with what to change. A refusal names what is missing: read it, fix, retry with the same `--op-id`.

### Rules in force

A board carries **rules**: operator-authored statements the work must satisfy, inherited from the regions it sits in, from the board itself, and from rules the raiser addressed to it. The server does not judge them; it only checks that each is answered.

- Read them with `task rules`: each one names where it came from, and naming a task shows which are still unanswered.
- Answer each when you finish: `task finish <task> --claim "<ruleId>=<how this work meets it>"`, one --claim per rule. A finish that leaves a rule in force unanswered is refused `rules-unmet`.
- Only a claim answers a rule. A rule that no longer fits is the operator's to change; ask, do not skip it.

### Path, one node at a time

Where the operator drew a task path, finishing does not close the task: it hands it to the next node.

- With one next node, `task finish` sends the task on; with more than one, name it with `--next <node>`.
- Cite the work on the finish: `--commit <sha>` and `--artifact <node id>/<artifactId>`, repeated for several.
- **Checks** are the operator's deterministic gates for that move. `task rules <task>` lists each with its command and status. Run each in your own shell, then report it: `task check <task> --outgoing <checkId>=<exitCode>`, `--incoming` for the next node's, or `--results @file` with each output's tail. A finish with a required check red or not run at this epoch is refused checks-unmet, naming them.
- The next node sees your layer as stamps, comments and cited refs, never your interior work.
- `task stamp <task> changes --text "<what to change>"` sends the task back to `working` on a new epoch: earlier stamps stop counting and check results are stale, so answer the rules again and re-run the checks.
```