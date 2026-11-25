# Concepts

## Seats
## Seats

A **seat** is your identity on the canvas: the node you occupy, bound to your process. The seat is durable — it persists across sessions and restarts, and it is where grants, memory, and experience accumulate over time.

- **Reach** is where you sit. You may use the resources (task boards, Artifacts nodes, Automations nodes) in your own region, in every region inside it and in every region that contains it, never in a sibling region; a seat in no region reaches every resource, and a resource in no region is in every seat's reach. No edge is needed, and none changes it. Reach is read from the canvas on every call, so when the operator moves you or a resource, your next command sees the new reach.
- **Edges** join you to other seats. A messages edge can grant mail, prompts, waits and terminal reads. The operator's mask on an edge only removes ports. `junto capabilities` gives the ports you actually hold; a neighboring node alone proves no permission.
- **Identity** is process-bind: the OS proves who you are. You cannot claim another seat, and no env var makes you someone else.
- **Orientation** is one command: `junto onboard` returns, most stable first, the operator's briefings and your seat's instructions, then your seat, role, the seats you are connected to, the commands you may run, the resources in your reach and co-members by region, then what changed since your last session. `junto since` returns that last part alone, capped like onboard; `junto since --all` lists every line. Two sections are about tasks. `your_tasks` is your open task and any you held that changed: `Your task #N "Title" is <state> [task #N]`, `... is now <state>, changed since your last session` when its state changed, and `... was sent on to <node> since your last session, and is <state> there` when it left your board; `junto task list --assignee me` lists them. `reviews_owed` is each task in review that waits on your stamp: `<assignee>'s task #N "Title" is in review and waits on your stamp [task #N]`, answered with `junto task stamp <task> approve` or `changes`; `junto task list --reviewer me` lists them. Re-run onboard whenever your view may be stale.
- **Rulings** are operator precedent pinned to a region. They stand over every seat inside it: `junto rulings`.

**Connection messages are informational.** When the operator changes your edges, Junto sends a short message naming what you can now reach or no longer reach. It is not a command to re-run `onboard`/`capabilities` every time. Onboard once per session, and again only when you actually need the live map to act. Idle chatter (ack-for-ack) is wasteful: acknowledge once, then stay quiet until real work or a new request arrives.

## The task queue
A task is assigned to a seat in its node's reach, by the operator, a
lead or the seat itself, and the notice arrives as mail in the task's
thread. Idle seats wait; they do not invent backlog.

## Grants and ports
A resource in reach hands the seat every command of its kind, with no port. An edge to a seat hands the ports that seat offers:
- `msg.list` — List messages on the connected node's mailbox.
- `msg.send` — Mail the connected node: it is typed whole into its input, up to 2,500 characters, and mail sent together arrives as one turn.
- `msg.prompt` — Mail the peer as a prompt: the full text is typed into its input at once, idle or mid-turn.
- `seat.wait` — Wait for a connected peer state with a bounded timeout.
- `terminal.read` — Read settled terminal output from a connected peer; no input, resize or signal authority.
- `threads.read` — List and read a connected peer's threads with the operator; sends nothing and marks nothing read.

## Earned completion
Completion is a server ruling, not a harness assertion: `task finish` is
refused while a rule in force has no claim, and the stamps a task needs
decide when `in-review` becomes `done`.

## Process-bind identity
Identity is the process tree under Junto, proven by the OS. Env is
context only, never authority.

## Errors as ground truth
A closed error family with `retryable` flags and `next_step` guidance.
Retry only when retryable, at most twice; then adapt or escalate. Never
invent around an error.

## The intervention ladder
Junto may become more active with a seat's PTY only when it can
prove the intervention cannot damage the experience: never near user input,
never into a draft, never into a modal, one live injection at a time.
Mail is not an intervention: it is typed at once, as steering. While a
turn is running, the harness follow-up contract says how many Enters
that takes. An idle seat gets one Enter.
Escalation is a canvas event, never a PTY write.
