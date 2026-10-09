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
   link, or held. Between two machines a wire admits mail and nothing else
   (`physics/admit.ts`, reason `other_machine`); which machine edits the
   canvas or opened the link never enters that check.
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
    without a window. Update is the same copy. The owner reports copied and
    total archive bytes during the transfer; the window shows them before
    the installation steps. After 30 seconds without another byte accepted
    by SSH's input, it says there is no progress and resumes when bytes move.
    That status never retries or interrupts the operation, and copied bytes
    do not prove that the receiving machine installed or started Junto.
    A release app first downloads the target's archive from its compiled
    release origin. Its own build pins the exact archive size and digest
    and the manifest digest. Admission finishes before the current link is
    disconnected or anything is sent. The window shows download bytes as
    a separate step. Offline or failed checks leave the machine as it was.
    Archives are cached under the Junto home, verified on each use, and old
    builds are pruned while active users keep their inputs. Source and
    Preview builds use local bundles only and never download.
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
  has never had a peer and no canvas on it has changed. A name once pinned
  stays bound to its installation: the same machine can be removed and added
  again, another installation under that name is refused. What the operator
  reads is the label in the machine list, which stays editable.
- One source each: a machine's own name and its pinned peers live in the core
  (`machines/`); the machine list (`hosts/`) holds routes and presentation.
- Who is at the other end. The trust unit is the OS account. The end that
  opens a link trusts the SSH route the operator chose and the installation id
  pinned for it, which it learns from the first checked hello and never from
  anything else. The end that receives a link is told its peer by the owner's
  setup command, run over that SSH account before any hello; it admits no
  channel until a hello matches that pin exactly. A hello never enrolls itself
  or picks an existing peer, and a changed id or name is refused. That id is
  an assertion by an account allowed to log in, not proof of an installation.
  The first version adds no keys of its own, and the link runs with SSH agent,
  X11 and port forwarding off. Before a second machine may open links, this is
  revisited: a link-only key bound to its opener is the candidate.
- Owners: `remote-send` the SSH side, the relay command and the link session
  (hello, frames, the channel registry with a closed decoder per channel);
  `remote-core` the windowless root (`src/main/headless.ts`), the owner
  socket and the socket the relay connects to; `remote-work` the `rows`
  channel; `remote-seats` the `seats` channel; `remote-send` the `status`
  channel. Nothing received over a link is used before its closed decode.

## Not carried

Tasks, board, pad, sheet, requests, artifacts, cron and relay are off. They get
no cross-machine design and no support work here; if one returns it is
redesigned. Browser pages are not placed on other machines at all.

## Later, and not to be blocked

- A signal's file attachments. Its words and detail cross to the editing
  machine; attached files stay on the machine that raised it.
- Browser control by a seat. Its socket admission was cut when the peer
  process read was removed and answers "not available in this build"; it
  comes back on the generation credential when the browser is enabled.
- A briefing or an app-wide reference taken with a copy replaces the taking
  machine's own of the same name. Harmless while a machine that takes copies
  edits no canvas of its own; to be decided before one does both.
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
| `remote-window` | the Machines window's structure, data and actions, the machine picker on seats and regions, unreachable and missing-harness states, and the copy |
| `remote-design` | how a machine looks: the machine figure in three dimensions and its states, and the look of the Machines window. No dithering |
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
  Build that patch from main's copy plus your edit, never from the tree's
  difference: another seat may have written into the file since you looked.
- If `update-ref` fails, main moved: run again from the `PARENT=` line. Never
  force.
- The `git reset` line is not optional: it brings the shared index up to date
  for those paths without touching working files.
- The last line must list your files and only yours.

## Progress

**Where we stopped, 9 October.** The operator closed the day here. Read this
first.

Proven on real machines (the Preview on this Mac, the Mac mini, Linux), each
with a receipt under `~/junto-receipts/resume-20261009/`: the Preview build
with both bundles inside; send, update, resend, uninstall and reinstall on
three successive builds; a failed start that stops and recovers; a canvas
copy and a mail row across the link; a seat on the mini with its briefing
from this Mac; a real Amp seat on the mini answering mail from this Mac
with nobody touching the mini; the Preview quit while seats on the mini
kept mailing, and the held mail delivered on return; copy progress on a
real transfer. The whole suite is green on `a31b6359d` (8,665 tests).

On main, tested, not yet proven on a real machine. This is the owed
validation, in order:
1. Signals cross machines (`806373f23`, `a3a8e7a6e`): repeat run D with a
   feedback written while this Mac is away showing in the Preview's feed on
   return, and an answer reaching `junto signal list` on the mini.
2. The Mac service in the graphical session (`688920ba7`): the mini's
   existing background install updated from the Preview lands in
   `gui/<uid>`, the keychain reads usable from a seat there, then the
   standing cycle.
3. The quit fix (`a31b6359d`): the Preview quits cleanly with a link open.
   A forced close fails the run.
4. The mail drive fix (`70aa48ac4`) and the step wording (`666e7d92c`) ride
   the same build.

Landed at the close on focused tests only, no full suite, no review, no
real machine: the late-login repair (`a32615924`), the keychain and sign-in
status (`59409daf5`) and its window lines (`878a47646`).

Open, not finished:
- One full-suite gate on current main, and a security read of `a32615924`.
- Release 0.7.0 is held for size, the operator's decision. The signed,
  notarized and qualified candidate from `77b24fb3c` is 332 MB against
  175 MB for 0.6.0, over the 300 MB limit of the upload route. Nothing was
  published; the feed serves 0.6.0. Measured: the two machine bundles are
  451 MB installed, and `node_modules` ships whole in the app (119 MB).
  Ordered: the bundles leave the app and are fetched per target when a
  machine needs one, checked against a hash compiled into the app
  (`remote-send`, `remote-core`); main and preload bundle their
  dependencies (`remote-cut`). Later: the `junto` CLI on the bundle's own
  Node, not a second runtime. 0.7.0 ships when the first is proven on a
  signed candidate with a real send to the mini.
- Leftovers of the old unit: `publishSystemdGenerationReadiness` has no
  caller, `supervision/systemd-user.ts` and `systemctl-runner.ts` still
  describe it.
- Install fault cases not yet run: a transfer cut midway, a full disk, a
  wrong SSH target.
- The operator's own: sign in again to Codex and Claude Code on the mini;
  then a run on the real Factory canvas with a build we hand over.


| Slice | Owner | State |
|---|---|---|
| Review and contract | `remote-lead` | done: `959ec0e98`, `83b1badb7` |
| The exercise | `remote-verify` | boot exercise passes on the Mac mini and Linux: `db140e741`; install and update driver landed and proven on a clean export: `677138943`, `d52657417`; its live run on the mini waits for the common entry and `machine.status` |
| One core, two entries | `remote-core` | old protocol and entry points cut: `d47e566d2`; role gates gone: `e6258f951`; the machine repository, names and pins: `a28e2261c`, `7bcc31345`; settings without roles: `0534318ee`; now the windowless root, the owner socket with `machine.setup` and `machine.status`, the link socket |
| The row exchange and the copy | `remote-work` | work plane cut; rows exchanged between three databases: `4aecb797b` through `a4fc42a73`; a machine takes a copy in one transaction: `ff6aeec8a`; every machine named, schema 21: `6388df555`; next the rest of the copy, the copy frame, three send outcomes |
| Putting Junto on a machine | `remote-send` | installer with receipts and uninstall: `06a6077a6`, `082270965`; pinned SSH routes: `65aa52716`; bundle copy over SSH: `e223244a9`; the machine list by name: `35a7a69f9`; the closed owner machine commands, reviewed: `9c9f68561`, `e12463eef`; next their handler in the core, setup, the link relay |
| Leaf cuts, stale documents, the guide | `remote-cut` | cut closed at `9e80c1edc`; guide rewritten: `6dfa819ae`; e2e sweep: `8bedc47ef`, `9c2e11dda`; the browser and the tests by machine name: `1f45473c3`, `a1331dfc7`; then the ship gate lane by lane and the words left in code |
| Security review and the doctrine | `remote-security` | doctrine agreed by every seat, current at `18341a52b`; reviews each landing at the boundary |
| A seat on another machine | `remote-seats` | the session pin has its own store: `d281981a7`; sessions routed by this machine's name: `a27e4bb1f`; the field leaves the seat row next |
| The Machines window | `remote-window` | the renderer reads machines by name, no roles: `69884279f` through `c8a212a7e`; the window's two channels: `493286c44`; now the window itself |
| How a machine looks | `remote-design` | printed solids, approved by the operator on the proof: `f21d698ce`, `fb43aac74`; nothing mounts it yet |

**The cut.** Closed at `9e80c1edc` with typecheck and the whole unit suite
green on a clean export of that commit (8,485 passed, none failed). Since the
baseline `0e6e55434`: 100,000 lines out, 8,000 in. From here every landing
typechecks and adds no failure.

**The name window.** Open since `35a7a69f9`. The switch from `local` to real
machine names lands as six parts, each seat its own files, and typecheck on
main may be red from that change only. All six have landed their main part:
the machine list (`remote-send`), `machines/` and settings (`remote-core`),
the name step, schema 21 (`remote-work`), the browser, the fleet components
and the tests (`remote-cut`), `term/` and `seat-sessions/` (`remote-seats`),
the renderer (`remote-window`). Leftovers are being closed. It closes when
`remote-verify` has typecheck and the whole unit suite green on a clean
export. Until then nobody packages or runs main.

**Resumed with three seats, one task.** `remote-core`, `remote-send` and
`remote-verify` are running; every other seat stays paused. The task is a
Preview build of Junto on this Mac and a Junto on the Mac mini, tested
together, from one commit of main. `remote-verify` holds the receipts:

1. `scripts/preview.sh` builds the Preview app with the machines UI on, in
   its fresh home `~/.junto-preview`.
2. `scripts/build-machine.ts` builds the `darwin-arm64` and `linux-x64`
   bundles with the peer helper inside.
3. From the Preview app: add the mini, send Junto, the link opens, status
   says the mini is ready on the same build; by `junto machine` commands and
   by a picture of the Machines window.
4. The same against a Linux sandbox.
5. A new commit, a rebuild and a second send put the mini on the new build.
6. Uninstall leaves the mini as it was.

Then run B on the same two machines. No review gate before a run;
`remote-security` reads the link after the first receipt.

**On a Mac, the service runs in the graphical session. Operator's decision.**
Measured on the mini: a process in `gui/<uid>` can use the login keychain,
the background service in `user/<uid>` and its seats cannot, so a harness
that keeps its sign-in there (Claude Code) is signed out for every seat on
a Mac machine. The service moves to `gui/<uid>` when the account has a
graphical session; with none it installs as before and the machine's status
says the keychain is not available. A send or an update moves an existing
install, uninstall finds it in either place. A job in `gui/<uid>` ends with
that session and starts again with it. Linux is unchanged. `remote-send`
the lifecycle, `remote-core` the status fact.

**Run D, `3363f44bd`: mail passed, signals failed.** With the Preview quit
on this Mac, a seat on the mini onboarded and mailed the real Amp seat
there, and Amp mailed this Mac; on return the held mail was delivered and
Amp's process and generation were unchanged
(`preview-3363f44bd/live/receipt-d.json`). What failed: Amp's
`junto feedback` never reached the operator's feed, because a signal lives
only in the store of the machine where it was written. Ruled: a signal is a
row like mail, written by the seat's machine and taken by the editing
machine, and the operator's answer is a row the other way. `remote-work`
has it; run D repeats with it.

**Run C with a real agent, `3363f44bd`.** A real Amp seat on the Mac mini,
placed and started from the Preview on this Mac, received mail from a seat
here with nobody touching the mini, and answered it from the mini with its
own hostname and folder. Receipt:
`preview-3363f44bd/live/receipt-c-real.json`. What it took after the
stand-in run: mail delivery had been configured only by the window, so a
windowless machine stored mail and never typed it into its seat (fixed in
`ba625745c`, `7160fcf2a`, `3363f44bd`). Found on the way, not ours to fix:
the mini's stored Codex login was revoked, and Claude Code there says its
login expired. Open: whether a background service on macOS can use the
login keychain at all; one status from the service's own context decides.

**The name window is closed, at `a8de71787`.** Typecheck and the whole unit
suite, both lanes, are green on a clean export (8,633 tests), checked by
`remote-verify`. Main may be built and run again by any seat, in a home of
its own. Every machine has a real name, no row says `local`, the old remote
runtime is deleted. What stays skipped: the browser socket admission tests,
with the browser cut under Later.

**Run C with the stand-in harness, `88e9a5465`.** A seat placed on the Mac
mini in the Preview started there from this Mac's window, in its own folder
on the mini. Its `junto onboard` on the mini returned the guidance, soul and
instructions written here, and its only grant, `msg.send`. It mailed a seat
on this Mac and that seat mailed it; each inbox holds the other's message.
Receipt: `preview-88e9a5465/live/receipt-c-standin.json`. Linux was sent,
updated and uninstalled on the same build. Known wrong: the mini's sender
was told `waiting` though its mail arrived. Next: the same with a real
harness installed on the mini, then run D.

**Receipts so far, all on real machines, build `98eb6c150`** (under
`~/junto-receipts/resume-20261009/`): the Preview app builds with both
bundles inside (1, 2); it sent Junto to the Mac mini and the Machines window
showed it Ready (3, on `4d6ba0e51`); it updated the running mini to a build
with no helper and no Python (5); uninstall left the mini clean (6, on
`d83193aed`). Run B passed: a canvas made in the Preview with a seat on the
mini reached the mini at the same count, and one mail row was sent here and
taken there (`preview-98eb6c150/live/receipt-b.json`). Open: Linux (4),
stopped before activation three times by transfer defects only Linux shows;
the install fault cases; run C, a seat on the mini with mail both ways, for
which `remote-seats` and `remote-work` are resumed; run D.

**Standing rule: real machines.** Nothing about machines is done on tests
alone. A change to the root, the link, the exchange, a seat on another
machine, the bundle or the install is done when `remote-verify` holds a
receipt from real machines on a build cut from main: this Mac's Preview and
the Mac mini always, a Linux machine whenever the change can differ there.
Every cohort repeats the plain send, the update over a running build and the
uninstall before anything new is tried on it.

**No Python, anywhere. Operator's order, not open to argument.** A seat is
its generation credential: one token per occupant generation, issued by main,
in `JUNTO_WORK_TOKEN` (`docs/cli-harness-identity-qualification.md`). Reading
a socket's peer process through `scripts/unix-peer-pid.py` was a residue of
the older model, and the machines work had carried it to every machine. It
goes everywhere: the script, the readers in `process-identity.ts`, their
callers, the packaging entries and the install preflight. Owner sockets are
owner-only files and the account is their boundary; `junto` refuses owner
and machine commands when a seat's token is in its environment. Owners:
`remote-cut` the desktop app, `remote-core` the core, `remote-send` the
bundle and preflight, `remote-security` the review and the doctrine's words.

**First real link, `d83193aed`.** Run A passed without a window: a core on
this Mac sent Junto to the Mac mini, the mini started it under launchd, the
link opened and status came back over it. Two installations, one build, the
mini's form and harnesses read on the mini. Receipt:
`~/junto-receipts/resume-20261009/a-NYly48/receipt.json`. The first attempt
failed live on file modes changed by extraction; fixed in `d83193aed` and
`5c2e8abe7`. The same run from the Preview app is receipt 3 and still open.

**Paused.** The operator paused all work with the name window still open.
All nine seats confirmed: finished work committed, the rest left in the tree,
nothing running, waiting for the word resume. Main is at `4b6fe6e13`.

**On resume, the live run comes first.** 220 commits landed before any
program had started on a second machine, because the one piece every live
run needs was last in the order. That order is reversed:

- `remote-core`, `remote-send` and `remote-verify` do nothing but run A until
  `remote-verify` holds a receipt from the mini: land the root with its
  helper in the bundle, land the session, build the bundle, start it on this
  Mac in a home of its own, then send it to the mini.
- A defect that a run finds is fixed where it is found. Review of the link
  follows the first receipt and comes before any build is handed to the
  operator.
- Every other seat works the list below and starts nothing new until run A
  has its receipt.
- After A, each of B, C and D gets the same treatment: the shortest path to
  a receipt from two machines, then the hardening.

The rest, for the other seats:

1. Done while pausing: `remote-core` committed the kernel fix (`4b6fe6e13`),
   the only two typecheck errors on a clean export of `db8e06871`.
2. The unit failures from `remote-verify`'s gate on that commit (8,541 passed,
   17 failed in 11 files; receipts under `/tmp/junto-name-gate-axvfubvv/`,
   which may not survive a restart):
   - a fixture still says `local` for a machine, in `companion-model-inputs`,
     `managed-terminal-injection`, `digest`, `region-rollup-store`,
     `seat-card`; and `overseer-control`, `overseer-live-repository` (the old
     installation table): `remote-cut`
   - `lint-design-tokens`, three font sizes in `machine-figure/machines.css`:
     `remote-design`
   - `model-legacy-row`, `scheduler-repository`: `remote-work`
   - `prime-agent-two-seat.integration`, machine name not loaded:
     `remote-seats`
3. `remote-verify` reruns the gate; a green run closes the name window.
4. Rule 9 still has no test at the seats start payload (`remote-seats`); the
   rows channel got one in `969e945c5`.
5. The seats start handler (`remote-seats`) is in the tree, uncommitted and
   unverified; it waits for run B.

What blocks run A, read on the paused tree at `a90cc6891`:

- The windowless program is not on main. `scripts/build-machine.ts` builds
  the bundle from `src/main/headless.ts`, which is uncommitted, so no bundle
  can be built from main. Main plus the uncommitted root, link service and
  link session typechecks clean and the session's ten tests pass. Nothing has
  ever started it; no test covers the root, the listener or the link service.
- The bundle does not carry `scripts/unix-peer-pid.py`. Both sockets admit a
  caller only after that helper names its process, and the root looks for it
  in the bundle's `bin`. Read, not run: a bundle built as things stand would
  refuse every command and every link.
- `remote-core`'s own list, not checked by the lead: the schema probe on a
  fresh home, and closing the SSH process when a link ends.

Run A does not wait for the whole unit suite. It needs typecheck clean on a
clean export (true at `a90cc6891`) and the link, owner and install tests
green; none of the 17 failures is on its path, and both ends use a home of
their own. The name window still closes only on the full gate, and until
then nothing built from main touches a home that holds data.

Left on the mini: an empty `~/.junto` with empty `locks` and `machine`
directories from an install attempt. No service, no process, no sandbox.

**The path to two machines talking.** Nothing has crossed a real link yet.
Work is ordered by four live runs on this Mac and the mini, each a receipt
from `remote-verify`:

| Run | What it proves | State |
|---|---|---|
| A. Send and hello | Junto is sent to the mini, its core runs under the per-user service, a link opens, `machine.status` answers over it | waits on the windowless root; relay landed: `c837a3a30` |
| B. A copy and a row | a canvas copy lands on the mini, one row crosses each way | waits on A, the copy frame and the admission law |
| C. A seat there | the MacBook starts a seat on the mini, it onboards, mail goes both ways | waits on B and the seats channel |
| D. The MacBook quits | the seat keeps running, held mail arrives on return | waits on C |

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
