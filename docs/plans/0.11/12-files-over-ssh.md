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
  already has (`src/core/files/service.ts`), so realpath scoping, the
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
  and the node says its machine is offline and when it was last reached. A save in flight when the link drops is refused,
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

## X3, the bytes (design, remote-core, for remote-security)

X3 lands behind `filesRemote`, for 0.12.1. It closes three gaps that X1 and X2
left:

- a remote node's `junto-file:` bytes, refused `elsewhere` today;
- an editor read over one frame, about 900 KB, read `too-large` today;
- a Finder drop onto a remote node, refused today.

A write over one frame stays `too-large`, as the plan names reads and drops
only.

**A channel of its own, `file-bytes`.** Bytes do not ride on `files`, so a
listing, a save or a change event never waits behind a chunk. The channel is a
contract channel of requests, closed like `files`. Its ops:

- `ReadOpen {canvas, node, path}` answers `{stream, size, stamp}`. The host
  opens the file through `FilesService.bytes`, so realpath scoping and the
  deny list hold, and keeps the handle under a random stream id held by that
  link session.
- `ReadChunk {stream, offset, length}` answers at most 48 KiB, as base64, so
  one frame stays under about 64 KiB.
- `ReadClose {stream}`.
- `ImportOpen {canvas, node, into, name, size}` answers `{upload}`. The host
  makes a private stage, `mkdtemp`, 0700, outside the root and outside
  Junto's home, because `importInto` refuses sources under its home. `name` is
  one path part and must pass the same name check as `rename`.
- `ImportChunk {upload, offset, data}`, in order. `offset` must equal the
  bytes already written, and data is at most 48 KiB.
- `ImportEnd {upload, sha256}`. The host checks the size and the hash, then
  runs `FilesService.import` with the staged file, so the import's own
  numbered names and refusals hold. The stage is then removed.

**The window.** A request is the credit. Each end keeps at most 2 byte
requests in flight per link, so at most about 128 KiB of file bytes is ever
out on one link. The host enforces it: a third concurrent byte request from a
peer, or a chunk over 48 KiB, is refused `denied`, logged, and the stream is
closed. The link stays up. This is the bound remote-security reads instead of
the event credit window. The event window is push, and ranges and a cancel
from pdf.js are pull: a viewer that aborts just stops asking.

**Behind everything else in the write queue.** The session writes a
`file-bytes` frame only when no frame of another channel is waiting, so a
seat start, a rows event or a save never queues behind a chunk. Inside the
session this is the only change: one bulk lane beside the FIFO, used only by
`file-bytes`. A bulk frame already handed to the stream is not taken back, so
the most a seat start waits is one chunk frame.

**Bounds per link session.**

- At most 8 open read streams and 4 open uploads. More are refused `denied`.
- A stream or upload idle for 60 s is closed, and its stage removed.
- An upload is at most 512 MiB, checked at open against `size`, and again on
  every chunk.
- The link closing closes every stream and removes every stage.
- Ids are random, 128 bits, and good only on the session that made them.
- Every message runs `admitFilesPeer` again, against the canvas and node the
  stream was opened for. A stream id never names a path.

**What crosses and what is logged.** Bytes and the dropped file's name cross
to the other machine and nowhere else. A log line holds op, node and outcome,
with no path, name, size or hash.

**The window machine's side.**

- The router sends `FilesBytesOpen` for another host's node to the link
  client, whose reader's `read(offset, length)` asks `ReadChunk`, and whose
  `close` asks `ReadClose`. `junto-file:` and its range handling are
  unchanged.
- An editor read answered `too-large` under `FILE_TEXT_MAX_BYTES`, 5 MiB, is
  read through a stream, decoded as UTF-8, and checked against the stamp the
  open named.
- A drop reads only a source the preload saw dropped, as today, files only. A
  dropped folder on another machine's node is refused `is-dir`; folders are a
  follow-up.
- `unreachable` is made from the link, as in X1.

**Tests.**

- The closed decode of every op.
- The window bound, with a third request refused and the stream closed.
- The bulk lane: a seat request sent after 16 chunks are queued is written
  first.
- The stage is removed on end, refusal, idle and link close.
- A hash mismatch writes nothing into the root.
- A 25 MB PDF read by ranges beside a typing seat, with the seat's frames
  never behind more than one chunk.

## X6, a Files node on another machine (design, remote-core, for remote-security)

remote-verify found the gap: `requireFilesPlace` (`src/core/model/records.ts`)
refuses any host but this machine's own, on Add and on an Edit that changes
the host or the root. With `filesRemote` on, nothing can make the node the
feature serves.

**The rule, behind `filesRemote`.** A Files node's `host` is this machine's
name, or the name of a machine pinned in this machine's list and not removed
(`machine_peers`, `retired_at IS NULL`), the same set `requireSeatHost` reads.
`UNNAMED_MACHINE`, a name not in the list, and a removed machine still refuse,
each with its own sentence. The root is absolute, as today, and is checked
only for being absolute: this machine never resolves or stats a folder on
another machine. With the flag off, the gate is today's, byte for byte.

**Who may name another machine.** The operator only. An Add or an Edit from
any other source (a seat, an overseer, the runtime) that names a host other
than this machine is refused, whatever the flag says. This follows Decided 2,
"operator surface only". A seat cannot point the operator's window at a
folder on another machine. The node stays on its canvas like any other, and
a seat may still move or relabel it, since neither changes the host or the
root.

**The far copy.** `installCopy` does not run `requireFilesPlace`, today or
after this change. A copy carries every machine's nodes, and gating it would
refuse a copy that names a third machine the far has not pinned. The far's
gate is where it serves. `rootOf` (`src/core/files/service.ts`) serves a node
only when its `host` is the far's own name, then takes the realpath of the
root its own copy names and applies its deny list. Every op runs
`admitFilesPeer` (pinned id, editor of the canvas). A node that names a
machine other than the far is refused `elsewhere` there. The far's own name
cannot change under such a node: `configureName` refuses once a peer is
pinned or a canvas is authored (`src/core/machines/repository.ts`).

**A machine removed later.** Its nodes stay on the canvas. The router
(`src/core/files/router.ts`) sends a node whose host is not this machine to
the link client. With no link to that name, every op answers `unreachable`,
with the last reached time. The card and the modal show its machine as
offline, and no tree. A node never falls back to this machine: the router
goes to the local service only when `host` equals this machine's name, and
that name is fixed once a peer is pinned, so a removed machine's name can
never become this machine's. Editing such a node's root or host refuses, as
the machine is no longer in the list. Its label and position still change.

**For remote-window, the add and edit UI.**
- The machine choice lists this machine first, then each pinned machine by
  name, from `machine.list` (rows that are not removed).
- The choice shows only with `filesRemote` on.
- The folder picker opens this machine's dialog, so it is offered only when
  the choice is this machine. For another machine the root is typed as an
  absolute path, and the field says it is a folder on that machine.
- A refusal shows the core's sentence as given.

**Tests.**
- With the flag on: the operator adds and edits a node on a pinned machine,
  and each refusal is checked (unnamed, unknown, removed, relative root, and
  a non-operator naming another machine).
- With the flag off, today's refusal for another machine.
- A removed machine's node answers `unreachable` through the router, and
  never reaches the local service.
- On the far, a copy whose node names a third machine is installed, and that
  node is refused `elsewhere`.

## Decided (product-lead, 2026-10-29)

1. **No offline view.** A node whose machine is unreachable says that its
   machine is offline and when it was last reached. No stale tree is shown.
2. **Operator surface only.** Seats get no access to another machine's Files
   node in 0.12.
