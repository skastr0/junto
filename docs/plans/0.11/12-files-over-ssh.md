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

## X6, a Files node on another machine (design, remote-core, under remote-security's F1 to F8)

remote-verify found the gap: `requireFilesPlace` (`src/core/model/records.ts`)
refuses any host but this machine's own, on Add and on an Edit that changes
the host or the root. With `filesRemote` on, nothing could make the node the
feature serves. With the flag off, every rule below is today's, unchanged.

**The gate at write (F1, F2).** `requireFilesPlace` takes the command's
source.
- A host other than this machine is admitted only from source `operator`.
  That source is the window's `ModelCommand` over main's trusted IPC
  (`src/core/ops/ipc-model.ts`), the only caller that sends it. Overseer,
  seat, CLI and automation commands keep this machine only.
- The host is this machine's name, or a pin in `machine_peers` with
  `retired_at IS NULL` whose name is not a Boat machine. A retired pin, a
  bare host record, a Boat machine, `UNNAMED_MACHINE` and an unknown name
  each refuse with their own sentence.
- The root is absolute.
- Add checks both the host and the root. An Edit that changes the host checks
  both, even when the root is unchanged. An Edit that changes only the root
  checks the root against the node's host.

**The far trusts nothing in the copy (F3).** `installCopy` stays ungated,
since a copy carries every machine's nodes. The far's checks are made where
it serves. Every op on the far, ReadChunk included, re-reads the node from
the far's own record. It then serves only when all of these hold:
- the host is the far's own name;
- the root is absolute and realpath'd;
- the root is not `/` and does not contain the far's Junto home;
- the root is not under the deny list.
The deny list holds on every path under the root, as it does today. These
are added to the far's service alone, the headless one
(`src/core/files/headless-service.ts`), so a local Files node on `~` keeps
working on its own machine. A copy that changes an existing node meets the
same checks at the next op.

**Admission (F4).** `admitFilesPeer` is unchanged: a pinned id, and the
editor of the canvas. A test shows a pinned peer that is not the editor is
denied.

**A node that changes or goes (F5).**
- An X3 stream or upload records the node's realpath'd root when it opens.
  Every later op compares it with the root the far resolves now. A
  different host or root, or a missing node, closes the stream or drops the
  upload, refused `no-node`.
- A peer's watch, the `files` channel's open session, is closed when the
  canvas changes the node's host or root or removes the node. The far
  listens to its own canvas changes, closes the session and sends `closed`.

**A machine removed (F6).** Its nodes stay on the canvas as data and open
nothing. The window router checks for an active pin before any request to
another machine. Without one, it answers the new window-side refusal
`not-set-up`, and no request goes to that name. The view says its machine is
not set up. This machine's name is fixed once a peer is pinned
(`configureName`), so a removed machine's name can never become this
machine's, and a node never falls back to the local service.

**A re-pin (F7).**
- The take-over preview also counts the Files nodes placed on that name.
- The new installation serves nothing until the editor's copy reaches it.
  This already holds: it holds no such canvas, so `admitFilesPeer` answers
  `no-node`.

**Logs (F8).** The far logs the op, the node and the outcome, with no root
or path. This is X1's rule, and a test now holds it for the new refusals.

**The copy carries the node to its own machine (found building X6).** A
copy sends every Files node to every other machine as a stub, with no host
and no root (`resourceOf`, `src/shared/canvas-copy.ts`). The machine the
folder is on gets that stub too, so its `nodeFacts` finds no Files node, and
every op of X1 and X3 there answers `no-node`. X1's and X3's tests seed the
far's model directly, so they never met this. Two changes, both behind
`filesRemote`:
- A copy cut for machine M carries each Files node whose `host` is M whole:
  kind, place, label, host and root. Every other machine still gets the stub,
  as today. The root crosses to the one machine whose folder it names, and
  that machine checks it at every op (F3).
- A Files node placed on M makes M hold the canvas, beside a seat or an
  automation, so M is sent a copy.

**The departure mark is in memory (remote-security, C2 disclosure).** The
editor marks, in memory, each canvas it last sent a machine a Files node of
whole, and sends that machine the departure copy once it has no reason left.
A restart of the editor loses the mark: a node moved away or deleted after
the restart stays on that machine, root included, until its next copy. It is
never asked of there: the window's router reads the node's host on every call
(`tests/files-router.test.ts`), and that machine serves only the editor. A
durable mark needs a state migration, and is a precondition for turning
`filesRemote` on by default: it is decided again then.

**For remote-window.**
- The add and edit choice shows only with `filesRemote` on, on the operator
  source. It lists this machine first, then each active, non-Boat pin.
- For another machine the root is typed, and the field says it is a folder
  on that machine.
- An Edit that moves a node to another machine sends the host and the root
  together.
- The `not-set-up` view is new.

## Decided (product-lead, 2026-10-29)

1. **No offline view.** A node whose machine is unreachable says that its
   machine is offline and when it was last reached. No stale tree is shown.
2. **Operator surface only.** Seats get no access to another machine's Files
   node in 0.12.
