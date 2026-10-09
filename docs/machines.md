# Machines

The build contract for one canvas across many machines. Decided with the
operator on 2026-10-09. It replaced the Remote station design.

When a rule here changes, change this file in the same commit. Write no other
design document for this work.

## What we are building

Junto you can send to any machine you can reach over SSH, and one canvas that
spans all of them. A seat's machine is a property of the seat, like its harness.

**The acceptance run.** On the Factory canvas, in the Remote region:

1. Add a seat `remote-peer` beside `remote-lead` and choose the Mac mini as its
   machine. It gets the region's folder for that machine.
2. Wire the two seats for mail.
3. Start it. Its terminal shows on its card like any other seat.
4. `remote-peer` runs `junto onboard` on the mini and gets the same briefing
   and connections it would get locally.
5. The two seats exchange mail in both directions.
6. Quit Junto on the MacBook. `remote-peer` keeps running, its `junto` calls
   keep working, mail to seats on the mini arrives, mail to `remote-lead` is
   accepted and held.
7. Open Junto on the MacBook. The held mail and any signals arrive.

## Words

- **Machine**: a computer running Junto. The operator-facing word.
- There is no Command Center, Remote, station or fleet, in code or in copy.
  Code keeps the installation id it already has.

## Rules

1. **One program.** Every machine runs the same Junto core. A window is a shell
   on top of it. There is no second runtime and no reduced set of services. A
   feature that works for a local seat works for a seat on any machine, or it
   is not done.
2. **One canvas, one editing machine.** Each canvas names the one machine that
   may change it, by installation id. Every other machine holds a read-only
   copy as ordinary rows. The copy travels whole, as one snapshot, and replaces
   the old one when it is newer. It is cut for its destination. Every machine
   gets the structure needed to resolve seats, machines, regions and wires,
   the app briefing, app-wide references, and play or pause. A machine gets a
   seat's soul and instructions only for its own seats, and a region's
   briefing, references, folders and environment only for regions that hold
   one of its seats. Another machine's seat arrives as a peer: its id, label,
   machine and place on the canvas, and nothing it could be started from. A
   peer can be addressed and never started. A plain terminal goes only to its
   own machine. Notes, labels, files, links and every kind that is off stay on
   the editing machine. The editing machine keeps everything. Whatever a machine
   once received it may still hold; removal does not take it back. There is
   no merging of concurrent edits.
   Nothing may assume a second editor can never exist: ids stay global, and a
   canvas travels as rows. A changed or removed wire takes effect on a machine
   when that machine has the new copy; mail written before then still arrives.
3. **A seat lives on one machine.** That machine starts it, holds its terminal,
   mints its token, and stores its mail, signals and sessions. The seat's
   `junto` CLI talks only to its own machine. A seat names its machine by the
   machine's real short name. No row says `local`: that word would mean a
   different machine on every copy, and tying it to the editing machine would
   move seats when editing moves. One function answers "is this seat mine".
4. **Synced rows are immutable and have one writer.** Sync between two machines
   is: send the other side what it lacks and is entitled to. No claims, no
   transfer of authority, no conflict handling. Applying a row twice changes
   nothing. A machine writes only for its own seats: mail from a seat, and a
   receipt or signal for a seat, are valid only from the machine that seat is
   on; an answer to a signal only from the machine that edits the canvas. A
   row that breaks this, or that arrives twice with different content, closes
   the link. Only mail, receipts, signals and session facts are exchanged;
   the exchange has its own closed list and admits nothing else. The editing
   machine remembers which machine each seat was on and when, so mail written
   before a seat moved or was removed is still judged against where the seat
   was.
5. **Entitlement.** Every machine on a canvas gets the canvas rows. A machine
   gets the mail addressed to its seats. A machine that keeps the whole canvas
   gets everything. In the first version that is the editing machine. Passing
   on another machine's rows, and saying how far a peer is caught up, is
   scoped to one canvas: only the machine that keeps that canvas may do it,
   and never for another canvas.
6. **Mail waits.** Mail to a seat whose machine is unreachable is accepted and
   held, the way mail to a stopped seat is held. It is delivered when a path
   exists. The sender is told which happened: delivered here, handed to a
   link, or held.
7. **Links are symmetric.** A link is one SSH session to the other machine's
   Junto. Either end may open one and it behaves the same once open. No code
   knows a "this side" and a "that side". In the first version only the
   editing machine opens links.
8. **Same build everywhere.** Checked when a link opens. On a mismatch the link
   refuses and names the machine to update. No negotiation, no versioned wire
   formats.
9. **Folders and secrets belong to the machine.** A region names a folder per
   machine. A secret's value lives only on the machine it was set on, and Junto
   never sends one between machines. The canvas shows which machines lack one.
10. **Install without privileges.** Sending Junto to a machine is a copy over
    SSH into the user's home directory plus a per-user service. No admin
    account, no logged-in screen, no `/Applications`, no Electron on a machine
    without a window. Update is the same copy.
11. **Seat control addresses the machine.** Start, stop and attach go to the
    seat's machine directly.
12. **Harnesses are the operator's.** Junto reports which harness CLIs exist on
    each machine. It installs none and logs in to none.
13. **An agent can exercise all of it, alone.** Every operation in this feature
    has a command an agent can run and a result it can read: add, send, update
    and remove a machine; place a seat on a machine, wire it, start and stop
    it; read a terminal, mail, signals and a machine's state. The window calls
    the same commands. Nothing needs the operator, a click, or the operator's
    running Junto. A slice that can only be exercised by hand is not done.

## Trust

Junto shares the authority of the OS account it runs in. A seat with a shell
can reach that account's files, credentials and other local mechanisms outside
Junto. Seat tokens, wires and the check that keeps a seat's process tree off
the owner-only sockets say who made a Junto call and stop confused use. They
are not a sandbox. The real boundaries are other users, content an agent
reads, and another machine at the far end of a link.

A wire you remove is not withdrawn everywhere at once. A machine acts on its
own copy, and a machine that has been taken over can keep sending mail from
the seats it hosts, or once hosted, as if the change had not reached it. The
receiver still refuses a row from the wrong machine or for a seat that
machine never held. Taking the machine off the canvas is what stops it.

Junto never sends a value from its secret store between machines. Text the
operator writes into a briefing, a note or a launch setting is ordinary canvas
content and travels with the copy.

## The exercise

How an agent proves the feature without the operator.

- One script runs the whole acceptance run from fresh homes and prints a
  receipt. Smaller scripts run each step alone, so a builder can iterate on
  its own part.
- Two targets, same script: the Mac mini, which is the real one and comes
  first, and a Linux machine. Nothing logs in to the operator's own Mac over
  SSH. Each run uses its own home and install location on the target, so
  several seats can exercise the mini at once.
- Both ends are windowless cores driven by commands. The editing machine in
  the exercise is a windowless core on this Mac in its own home. The window is
  tested apart, on top of commands that already work.
- Seats in the exercise run a scripted stand-in for a harness that does what
  it is told: onboard, send mail, raise a signal. A run is repeatable and
  costs nothing. A pass with a real harness is a separate step.
- A machine's home and install location are parameters, so several machines
  can live on one host.
- `remote-verify` owns the scripts and the stand-in. Each builder owns making
  its part drivable.

## The link

The one interface three seats build against.

- A link joins two running cores. One side runs `ssh <machine> <junto> link`.
  That command only relays its input and output to the core's owner-only
  socket on that machine, the way the phone relay does. It never opens the
  database.
- Hello first, both ways: build, installation id, machine name. A build
  mismatch closes the link and names the machine to update.
- After hello, framed messages on named channels, each frame bounded. The
  first channels:
  - `rows`: the row exchange (rules 4 to 6).
  - `seats`: start, stop and attach for seats on that machine, and their
    terminal bytes. Only the machine that edits the canvas may ask. It names
    the seat and nothing else: the machine starts the seat from its own copy
    of the canvas and never takes a command line, an environment or a process
    id from a peer.
  - `status`: reachable or not, harness CLIs present, the names of missing
    secrets. Never a value, a path or anything a caller chose to probe.
- The same code runs at both ends. Nothing above the transport knows which end
  opened the link.
- Terminal bytes ride the link. If running shows that hurts typing,
  `remote-seats` says so and we add a second session, never a second protocol.
- A machine is known by the short name the operator gives it, the `host` on a
  seat. The machine list maps that name to its SSH target. Its installation id
  is learned at the first hello, and from then on neither the name nor the id
  changes, at either end. Setup names a machine that receives Junto; a machine
  that starts on its own takes its hostname, and may change that only while it
  has never had a peer and no row names it. A name once pinned stays bound to
  its installation: the same machine can be removed and added again, another
  installation under that name is refused. What the operator reads is the
  label in the machine list, which stays editable.
- One source each: a machine's own name and its pinned peers live in the core
  (`machines/`); the machine list (`hosts/`) holds routes and presentation.
- Who is at the other end. The trust unit is the OS account. The end that
  opens a link trusts the SSH route the operator chose and the installation id
  pinned for it. The end that receives one accepts a first peer id only while
  the machine is being set up; a hello never enrolls itself or picks an
  existing peer, and a changed id or name is refused. That id is an assertion
  by an account allowed to log in, not proof of an installation. The first
  version adds no keys of its own, and the link runs with SSH agent, X11 and
  port forwarding off. Before a second machine may open links, this is
  revisited: a link-only key bound to its opener is the candidate.
- Owners: `remote-send` the SSH side and the relay command; `remote-core` the
  socket and the channels inside the core; `remote-work` the `rows` channel;
  `remote-seats` the `seats` channel; `remote-send` the `status` channel.

## Not carried

Tasks, board, pad, sheet, requests, artifacts, cron and relay are off. They get
no cross-machine design and no support work here; if one returns it is
redesigned. Browser pages are not placed on other machines at all.

## Later, and not to be blocked

- An always-on machine as the hub: it opens the links, and the phone app pairs
  with it, so nothing waits for the operator's own computer.
- Moving which machine edits a canvas, and editing from another window by
  sending the edit to that machine.
- Renaming an established machine, and replacing a machine under the same
  name. One design, with the placement history.
- A seat reaching past mail to a seat on another machine: reading its
  terminal, waiting on it, prompting it. In the first version these are
  refused with a plain reason when the other seat is on another machine.
- Boat (boat.dev, formerly Box): a provider that creates a machine and sends
  Junto to it. The old provider code leaves the tree and is kept intact at the
  tag `archive/box-provider`.

## Cutting

Nothing is kept by default. Each piece earns its place against the rules above
or goes. The old design is out: the document projection, the task and claim
protocol, the boot modes and doors, version negotiation, the reduced runtime,
the Remote screen, Box, the host deployment protocol and the qualification
tooling, with their tables, documents and tests. Still to go: what is left of
the two roles' configuration, the second entry file, and what the Machines
window does not keep of the old overlay.

Tables may be dropped in a migration; the operator approved that for this
work. The migration chain stays forward-only, so an installed database must
still open.

## Seats

| Seat | Owns |
|---|---|
| `remote-lead` | this contract, the order of work, review and integration |
| `remote-core` | boot and runtime: remove roles, doors and the old protocol, then split the main process into a windowless core and a window shell |
| `remote-work` | the work plane: strip multi-machine task convergence and the rule that pins mail to one machine, drop dead tables, then build the row exchange |
| `remote-send` | putting Junto on a machine: the windowless bundle for Mac and Linux, the copy, the per-user service, the build check, update, harness detection, and the SSH plane review |
| `remote-cut` | everything on the cut list outside those three areas, with its tests and documents |
| `remote-seats` | a seat on another machine: `term/`, `seat-sessions/`, `region-env/` and the seats channel of the link |
| `remote-window` | the Machines window, the machine picker on seats and regions, unreachable and missing-harness states, and the copy |
| `remote-verify` | the exercise scripts, the stand-in harness and the acceptance run |
| `remote-security` | independent review of the security model; the security doctrine |

## How we work

- One shared checkout, branch main. No worktrees and no branches: seams break
  early while conflicts are cheap, and main stays integrated.
- Commit only your own files, small and often, with the method below. A cut
  that breaks the build for the others is on main within minutes.
- Run typecheck and the unit tests your change touches before landing; the
  full suite before a large landing.
- A slice is done when `remote-verify` has run it on two real machines. A
  passing test of code that nothing runs is not evidence.
- Cut first. Read the real thing before deciding, and keep the receipt.
- Stay inside what you own. If your work needs a change in another seat's
  area, mail that seat.
- Keep it tidy: tests go with the code they test, no stray files, temp files
  removed. Mail `remote-lead` each landed commit; the ledger below is kept
  from those.

### Committing in the shared checkout

The private index method, from the repository root. Never a bare
`git commit`, `git commit -a` or `git add -A`.

```text
PATHS=(path/to/one.ts path/to/two.ts)
MSG='type(scope): subject'

BRANCH=$(git symbolic-ref HEAD)
PARENT=$(git rev-parse HEAD)
IDX=$(mktemp -u "${TMPDIR:-/tmp}/idx.XXXXXX")

GIT_INDEX_FILE=$IDX git read-tree "$PARENT"
GIT_INDEX_FILE=$IDX git add -- "${PATHS[@]}"
TREE=$(GIT_INDEX_FILE=$IDX git write-tree)
NEW=$(printf '%s\n' "$MSG" | git commit-tree "$TREE" -p "$PARENT")

git update-ref -m "commit: $MSG" "$BRANCH" "$NEW" "$PARENT"
git reset -q HEAD -- "${PATHS[@]}"
git show --stat --oneline HEAD
```

- Remove the temporary index file afterwards.
- For a deletion, name the deleted paths or their directory.
- For only your lines of a shared file: write a patch with just your hunks
  and use `git apply --cached` on the private index in place of `git add`.
- If `update-ref` fails, main moved: run again from the `PARENT=` line. Never
  force.
- The `git reset` line is not optional: it brings the shared index up to date
  for those paths without touching working files.
- The last line must list your files and only yours.

## Progress

| Slice | Owner | State |
|---|---|---|
| Review and contract | `remote-lead` | done: `959ec0e98`, `83b1badb7` |
| The exercise | `remote-verify` | boot exercise passes on the Mac mini and Linux: `db140e741`; install and update driver landed and proven on a clean export: `677138943`, `d52657417`; its live run on the mini waits for the common entry and `machine.status` |
| One core, two entries | `remote-core` | old protocol and entry points cut: `d47e566d2`; machine name and identity: `6b5c9a21b`, `ef396b505`; role gates gone: `e6258f951`; now the machine repository, the windowless entry, the owner socket with `machine.setup` and `machine.status`, the link socket |
| The row exchange and the copy | `remote-work` | work plane cut, schema 14 to 19; rows exchanged between three databases: `4aecb797b` through `a4fc42a73`; a machine takes a copy in one transaction: `ff6aeec8a`; next the rest of the copy, the copy frame, the name step (schema 20), three send outcomes |
| Putting Junto on a machine | `remote-send` | installer with receipts and uninstall: `06a6077a6`, `082270965`; pinned SSH routes: `0486ca08f`, `65aa52716`; bundle copy over SSH: `e223244a9`; next the machine list by name, the owner machine commands, the link relay |
| Leaf cuts, stale documents, the guide | `remote-cut` | cut closed at `9e80c1edc`; guide rewritten: `6dfa819ae`; e2e sweep under way: `8bedc47ef`; then the ship gate lane by lane and the words left in code |
| Security review and the doctrine | `remote-security` | doctrine rewritten and agreed by every seat: `fef22553a`, `03cb81f71`; reviews each landing at the boundary |
| A seat on another machine | `remote-seats` | first slice in progress: the session pin leaves the seat row |
| The Machines window | `remote-window` | staffed; first slice: the renderer reads machines by name |

**The cut.** Closed at `9e80c1edc` with typecheck and the whole unit suite
green on a clean export of that commit (8,485 passed, none failed). Since the
baseline `0e6e55434`: 100,000 lines out, 8,000 in. From here every landing
typechecks and adds no failure.

**The name window.** Open since `35a7a69f9`. The switch from `local` to real
machine names lands as six parts, each seat its own files, and typecheck on
main may be red from that change only: the machine list (`remote-send`,
landed), `machines/` and its readers (`remote-core`), the name step, schema 20
(`remote-work`), the browser and the fleet components (`remote-cut`), `term/`
and `seat-sessions/` (`remote-seats`), the other renderer consumers
(`remote-window`). It closes when `remote-verify` has typecheck and the whole
unit suite green on a clean export. Until then nobody packages or runs main.

## Test machines

The Mac mini: `ssh mac-mini`, macOS on Apple Silicon, with the Claude Code,
Codex, Grok, Pi and Amp CLIs installed. It has no Junto on it. Install under
the home directory only.

Linux: sandboxes on Boat, which the operator opened to us for testing. They
are native machines, so they replace the emulated one for anything that
needs a real Linux.

- Create with `boat new --no-env --no-snapshots --ttl 1800 --type small
  --json --no-update`, so a sandbox never carries the operator's stored
  secrets, leaves no snapshot behind, and a forgotten one becomes eligible
  for cleanup. A longer limit or a larger size only for a run known to need
  it. Never `--from`, a secret passed as an environment value, or a setup
  script that provisions an account.
- Put only built artifacts on a sandbox: a bundle, a package, a bundled test
  script. Never a checkout of the source, a harness login or a forwarded
  credential. Build here or in the local Linux machine, then copy the result.
- Touch only a sandbox you created. Record its id in your receipt.
- Delete it when the run ends; the time limit is not a guarantee. Time is
  billed while it runs.
- Use only: `new`, `list`, `info`, `ssh`, `exec`, `scp`, `stop`, `resume`,
  `delete`, `usage`. No sharing, public URLs, keys, webhooks, billing or
  organization commands.
- What the CLI prints can contain sign-in links. Strip the link fields before
  anything is logged; they never go into mail, a commit, a log or a receipt.
