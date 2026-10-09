# Machines

The build contract for one canvas across many machines. Decided with the
operator on 2026-10-09. It replaces the Remote station design; the reasons are
in [remote-station-review.md](remote-station-review.md).

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
   may change it. Every other machine holds a read-only copy as ordinary rows.
   There is no merging of concurrent edits. Nothing may assume a second editor
   can never exist: ids stay global, and a canvas travels as rows.
3. **A seat lives on one machine.** That machine starts it, holds its terminal,
   mints its token, and stores its mail, signals and sessions. The seat's
   `junto` CLI talks only to its own machine.
4. **Synced rows are immutable and have one writer.** Sync between two machines
   is: send the other side what it lacks and is entitled to. No claims, no
   transfer of authority, no conflict handling. Applying a row twice changes
   nothing.
5. **Entitlement.** Every machine on a canvas gets the canvas rows. A machine
   gets the mail addressed to its seats. A machine that keeps the whole canvas
   gets everything. In the first version that machine is the MacBook.
6. **Mail waits.** Mail to a seat whose machine is unreachable is accepted and
   held, the way mail to a stopped seat is held. It is delivered when a path
   exists. The sender is told which of the two happened.
7. **Links are symmetric.** A link is one SSH session to the other machine's
   Junto. Either end may open one and it behaves the same once open. No code
   knows a "this side" and a "that side". In the first version only the
   MacBook opens links.
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

## Not carried

Tasks, board, pad, sheet, requests, artifacts, cron and relay are off. They get
no cross-machine design and no support work here; if one returns it is
redesigned. Browser pages are not placed on other machines at all.

## Later, and not to be blocked

- An always-on machine as the hub: it opens the links, and the phone app pairs
  with it, so nothing waits for the MacBook.
- Moving which machine edits a canvas, and editing from another window by
  sending the edit to that machine.
- Boat (boat.dev, formerly Box): a provider that creates a machine and sends
  Junto to it. The old provider code leaves the tree and is kept intact at the
  tag `archive/box-provider`.

## Cutting

Nothing is kept by default. Each piece earns its place against the rules above
or goes. Known to go: the document projection, the task and claim protocol,
roles, the three boot modes and two doors, version negotiation and its frozen
fixtures, the reduced runtime, the Remote screen, Box, the fleet update
executor, the Linux Remote deploy and release tooling, the qualification
tooling, the browser's remote pieces, and the documents and tests that describe
them.

Tables from the old design may be dropped in a migration; the operator approved
that for this work. The migration chain stays forward-only, so an installed
database must still open.

## Seats

| Seat | Owns |
|---|---|
| `remote-lead` | this contract, the order of work, review and integration |
| `remote-core` | boot and runtime: remove roles, doors and the old protocol, then split the main process into a windowless core and a window shell |
| `remote-work` | the work plane: strip multi-machine task convergence and the rule that pins mail to one machine, drop dead tables, then build the row exchange |
| `remote-send` | putting Junto on a machine: the windowless bundle for Mac and Linux, the copy, the per-user service, the build check, update, harness detection, and the SSH plane review |
| `remote-cut` | everything on the cut list outside those three areas, with its tests and documents |
| `remote-seats` | a seat on another machine: its terminal, state, folder, secrets, onboard and mail delivery |
| `remote-window` | the Machines window, the machine picker on seats and regions, unreachable and missing-harness states, and the copy |
| `remote-verify` | the two-machine rig and the acceptance run |

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
| Baseline and the two-machine rig | `remote-verify` | baseline taken at `0e6e55434`; rig in design |
| Delete the old protocol, then roles, then the split | `remote-core` | in progress |
| Work plane cut, then the row exchange | `remote-work` | in progress |
| SSH review, then send to the Mac mini | `remote-send` | in progress |
| Leaf cuts, stale documents, the guide | `remote-cut` | in progress: `915e9c33a`, `3a50b10f6` |
| A seat on another machine | `remote-seats` | not staffed; when the mini runs Junto |
| The Machines window | `remote-window` | not staffed; when the mini runs Junto |

**Baseline** (`0e6e55434`): typecheck clean; unit suite 9,204 passed, 3 failed,
59 skipped. A landing adds no failure beyond those three:
`effect-runpromise-boundary` (being fixed by `remote-core`) and two cases in
`packaged-runtime-smoke` (being attributed).

**Found by running:** the old windowless entry cannot boot. It exits at once
because an Electron import reaches it through `term/ensure-managed-seat.ts`.
Fixing that is the first step of the split.

## Test machine

The Mac mini: `ssh mac-mini`, macOS on Apple Silicon, with the Claude Code,
Codex, Grok, Pi and Amp CLIs installed. It has no Junto on it. Install under
the home directory only.
