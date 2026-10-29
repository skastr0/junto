# Files over SSH

Owner: product-lead. Asked by the operator 2026-10-28. Plan: remote-lead,
2026-10-29, for 0.12.0, after fleet state and N5.

## Target

A Files node opened from another machine reaches its folder over SSH, the way
seats on other machines work. 0.11 shows other machines a stub card only.

The operator on the MacBook opens a Files node whose host is the Mac mini. The
modal shows the mini's folder: the tree, quick open, the editor, preview,
create, rename, move, trash, drops from Finder, and changes made on the mini
as they happen. With the mini unreachable, the modal says so and shows
nothing stale.

## Shape

**The folder stays on its machine, and the window asks that machine's Junto.**
"As seats do" means the way a seat on the mini runs: through the mini's own
core, over the link (`machines.md`, The link), not through a second SSH
session that reads the disk. No sftp, no mount, and no shell command built
from a path. That keeps Rule 1 (one program: the mini runs today's Files
service on its own folder) and Rule 9 (a folder belongs to its machine).

- **A new link channel, `files`.** The channel's ops are the Files service's
  own, closed: `open`, `close`, `count`, `list`, `read`, `write`, `create`,
  `rename`, `move`, `trash`, `import`, `search`. Each names the Files node by
  id and a path relative to its root, and nothing else. The host takes the
  root from its own copy of the node and runs the call through the service it
  already has (`src/main/junto/files/service.ts`), so realpath scoping, the
  deny list and stale-save stamps hold unchanged. A peer never sends a root,
  an absolute path or a command. `elsewhere` stays the refusal for a node
  that is not on the answering machine.
- **Events.** An `open` from a peer is a session like a window's: the host
  sends `paths`, `missing`, `back` and `closed` as `files` events, and drops
  the session when the link closes. The window machine opens it again when
  the link comes back.
- **Bytes.** File reads for the editor and preview, and Finder drops into the
  folder, go in chunks under the link's credit window (the one `rows` uses)
  and have a window of their own, so a 25 MB PDF never queues ahead of
  terminal bytes or a seat start. The `junto-file:` protocol on the window
  machine resolves a remote node's bytes through the channel, with ranges, so
  a PDF pages in without being copied whole.
- **The window side.** One router in main picks by the node's `host`: this
  machine goes to the local service, as today; another goes to the `files`
  channel on that machine's link. The renderer and the preload are unchanged
  apart from the refusals below. Open in default app and Reveal in Finder act
  on the machine whose screen shows them, so on another machine's node they
  are refused `elsewhere` and the menu hides them.
- **Not reachable.** No link to the host: every op is refused `unreachable`,
  named with the machine and how long it has been unreachable, the way a
  seat's card says it. A save in flight when the link drops is refused,
  never queued: the editor keeps the text and offers to save again. Nothing
  is cached on the window machine.

## Who may ask

The `files` channel is an operator surface. A seat on any machine reaches its
own machine's folder with its own shell; it gets nothing new here.

- Admitted only from a machine that may send operator commands for the
  canvas that holds the node: today the machine that edits it, and under
  fleet state any machine on its authority list (06, section 5). It is
  checked on every message against the host's own copy, with the sender's
  identity from the link's opener frame (`security-doctrine.md`, Links).
- The host serves only a Files node whose `host` is itself, on a canvas it
  holds, within the root its own copy names.
- Listings, names and file bytes cross to the window machine for display.
  They are never written into rows, the copy, logs or the link log, which
  records op, node and outcome only.

## Rule 13

`junto files <op> --node <id>` (owner command) runs each op through the same
router, so an agent drives a remote Files node with no window. The exercise
adds one step: on the mini, from the MacBook's core, create, write, read,
rename, move and trash a file, see a change made on the mini arrive as an
event, cut the link and get `unreachable`.

## Slices

| Slice | What | Owner (proposed) | Size | Risk |
|---|---|---|---|---|
| X1 | `files` channel: closed decoder, ops, events, admission per message | remote-send (link), tech (Files service) | M | medium |
| X2 | Router in main by `host`; `unreachable` and `elsewhere` in the modal and on the card | remote-window, product-shell | S | low |
| X3 | Bytes: chunked reads and imports under their own credit window; `junto-file:` ranges over the link | remote-send | M | medium |
| X4 | `junto files` owner commands and the exercise step | remote-verify, cli-lead | S | low |
| X5 | Doctrine: `machines.md` Rule 2 (a Files node is served by its host, not a stub) and The link (`files`); `security-doctrine.md` Links | remote-lead, remote-security | S | low |

Order: X1, X2, X4, X3, X5 with each landing. Behind a `files-remote` feature,
off in ship until remote-verify walks it on the mini and a Linux machine:
link cut mid-save, host asleep, a 25 MB PDF beside a typing seat.

## Questions for product-lead

1. Is any offline view wanted, such as the last tree seen, marked stale?
   The plan shows none, which is simplest and never wrong.
2. Should seats get a remote Files node too, so a seat on the MacBook reads
   the mini's folder? The plan says no: an operator surface only.
