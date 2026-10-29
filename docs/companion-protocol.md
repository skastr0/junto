# Junto Companion protocol, v1

Status: contract for the free mobile companion. Authored 2026-09-26.
Protocol id: `junto-companion/1`.

The companion is a phone app that shows the operator's needs-you feed, lets
the operator answer or dismiss agent signals, and send mail to agent seats. It
talks **directly to the operator's Mac**; there is no Junto server in v1.
Push notifications while the phone is locked are out of scope (they need a
server; that is a later, separate product).

This document is the contract between the desktop app (this repo) and the
mobile app (separate repo). The machine source of truth is
`src/shared/companion-protocol.ts` (Effect Schema); where the two disagree the
schema wins and this document is fixed.

## 1. Shape of the connection

```
phone ──(Tailscale or LAN: reachability only)──▶ Mac sshd (macOS Remote Login)
      ──(OpenSSH, per-device key, forced command)──▶ junto companion-stdio
      ──(owner-only Unix socket)──▶ running Junto app (operator control)
```

- **Reachability** is the network's job: Tailscale (MagicDNS name or 100.x
  address) or the local network. Junto never opens a network port.
- **Authentication** is OpenSSH with one key per paired phone. macOS Remote
  Login must be on. (Tailscale SSH is not supported: it does not honour the
  forced command below.)
- **Authority**: each phone key is installed in `~/.ssh/authorized_keys` with
  a forced command and every forwarding disabled, so the key can do nothing
  except run the companion protocol:

  ```
  command="/Users/<you>/.local/bin/junto companion-stdio --device dev_<id>",restrict ecdsa-sha2-nistp256 AAAA... junto-companion:dev_<id>
  ```

  Junto only ever adds, rewrites, or removes lines carrying its own
  `junto-companion:` comment; it never touches any other line.
- `junto companion-stdio` checks the device id against the paired-device
  registry on every start (revoked or unknown: it writes one `error` frame with
  `code: "revoked"` and exits), then relays frames to the running app over the
  owner-only operator control socket. The app must be running; if it is not,
  the first frame is an `error` with `code: "app-not-running"`.

## 2. Framing

- stdin/stdout of the SSH exec channel (no PTY), UTF-8, **NDJSON**: one JSON
  object per line, `\n` terminated.
- Max frame: 16 KiB phone to Mac (288 KiB for `content.stage` alone), 512 KiB
  Mac to phone. A larger frame is a protocol error; the Mac replies `error`
  `too-large` and closes. The Mac stops reading a line at 288 KiB.
- stderr carries nothing the phone should parse.
- Every frame carries `"v": "junto-companion/1"`. A frame with another `v` gets
  `error` `unsupported-version` and the channel closes.

Three frame types:

```jsonc
// phone -> Mac: request. id is chosen by the phone, unique per connection.
{ "v": "junto-companion/1", "type": "request", "id": "r1", "op": "feed.get", "args": { } }

// Mac -> phone: response to exactly one request.
{ "v": "junto-companion/1", "type": "response", "id": "r1", "ok": true, "result": { } }
{ "v": "junto-companion/1", "type": "response", "id": "r1", "ok": false,
  "error": { "code": "not-found", "message": "No signal sig_123." } }

// Mac -> phone: unsolicited event (only after a subscribe).
{ "v": "junto-companion/1", "type": "event", "event": "feed.changed", "data": { } }
```

A connection-level error that answers no request (`revoked`,
`app-not-running`, `too-large`, `unsupported-version` before an id is known)
is a response frame with `"id": ""` and `ok: false`; when the offending frame
carried a readable id, that id is used instead. "One error frame" elsewhere in
this document means exactly this frame:

```json
{ "v": "junto-companion/1", "type": "response", "id": "", "ok": false,
  "error": { "code": "revoked", "message": "This phone was removed from Junto." } }
```

The Mac sends a `hello` event first, before any request is read:

```json
{ "v": "junto-companion/1", "type": "event", "event": "hello",
  "data": { "appVersion": "0.3.4", "deviceId": "dev_01J...", "deviceName": "Guilherme's iPhone",
            "station": "Guilherme's MacBook Pro", "serverTime": 1790000000000,
            "hosts": ["guilhermes-mbp.tail1234.ts.net", "100.101.102.103", "guilhermes-mbp.local"],
            "features": ["artifacts/1"] } }
```

`features` (optional, at most 16) names what this Mac serves beyond the base
ops, each `<name>/<n>`. The phone shows a surface only when its feature is
listed, so a Mac that predates it is never sent an op it refuses; absent, the
phone assumes none. A feature is named in the same change that adds its ops.
`artifacts/1` is the artifacts surface (reads, writes and comments on
artifacts, `content.get` for their bodies).

`hosts` (optional, at most 8) is where this Mac answers now, in the pairing
QR's order, MagicDNS name first. On every hello that carries it the phone
merges it into its stored list: the new list first, then the stored entries
it lacks, and the MagicDNS name it paired with always kept. So a changed
address or name heals without pairing again, and a hello taken while
Tailscale is down (LAN addresses only) cannot lose the name the phone needs
off the LAN. When it is absent the phone keeps its own list. Every host
matches a host-name or address pattern (no leading `-`, whitespace, `@` or
`/`), and a hello with any other fails to decode. It never
carries or changes the host key: a different host key still needs the
operator.

Requests may be pipelined; responses may arrive out of order and are matched
by `id`. Heartbeat: the phone sends `ping` at most every 30 s while in the
foreground; the Mac closes a channel silent for 120 s.

## 3. Operations (closed set)

All times are epoch milliseconds. All text is plain UTF-8; `detail` fields
are Markdown. Names below match `src/shared/companion-protocol.ts`.

| op | args | result |
|---|---|---|
| `pair.complete` | `{ "publicKey": string, "deviceName": string }` (pairing connection only, see section 6) | `{ "deviceId": string }` |
| `ping` | `{}` | `{ "serverTime": number }` |
| `canvases.list` | `{}` | `{ "canvases": Canvas[] }` |
| `feed.get` | `{ "canvasName"?: string }` | `{ "feeds": OperatorFeed[] }` (one per canvas; all canvases when omitted) |
| `feed.subscribe` | `{ "canvasName"?: string }` | `{ "feeds": OperatorFeed[] }`, then `feed.changed` events |
| `feed.unsubscribe` | `{}` | `{}` |
| `seats.list` | `{ "canvasName": string }` | `{ "seats": Seat[] }` |
| `seat.get` | `{ "canvasName": string, "nodeId": string }` | `{ "seat": SeatDetail }`; the phone then receives `preamble`, `signal.changed`, `mail.changed` and `seat.changed` events for this seat until it requests another `seat.get` or disconnects |
| `signal.answer` | `{ "signalId": string, "text": string, "quiet"?: true, "attachments"?: ContentRef[] }` (1 to 8000 chars; 0 to 8000 with `quiet` or with files; at most 10 files) | `{ "signal": AgentSignal }` |
| `signal.dismiss` | `{ "signalId": string }` | `{ "signal": AgentSignal }` |
| `mail.list` | `{ "canvasName": string, "nodeId": string, "limit"?: number }` (default 50, max 200) | `{ "messages": Mail[] }` newest first |
| `mail.send` | `{ "canvasName": string, "nodeId": string, "text": string, "threadId"?: ULID, "inReplyTo"?: ULID, "mentions"?: string[], "attachments"?: ContentRef[] }` (text 1 to 8000 chars, 0 to 8000 with files; at most 10 files; `mentions`, at most 32, is read and kept nowhere; closed: any other key is `invalid`) | `{ "message": Mail }` |
| `quickReplies.get` | `{}` | `{ "replies": string[], "quietNotes"?: string[], "attachments"?: { "maxCount": number, "maxBytes": number, "chunkBytes": number, "thumbnailTypes": string[] } }` (the operator's quick replies and quiet notes from desktop Settings; `attachments` is the files gate, below) |
| `portrait.get` | `{ "portraitIdentity": string, "size": number, "theme": "bright" \| "dark", "format"?: "svg" \| "png" }` | `{ "svg": string }`, or with `format: "png"` `{ "png": string }` |
| `content.get` | `{ "sha256": string, "offset": number, "length": number }` (closed: any other key is `invalid`) | `{ "sha256": string, "offset": number, "length": number, "byteLength": number, "data": string }` |
| `content.stage` | `{ "canvasName": string, "sha256": string, "byteLength": number, "mediaType": string, "displayName"?: string, "offset": number, "data": string }` (closed) | `{ "received": number }` while pieces remain, `{ "ref": ContentRef }` after the last |
| `machines.list` | `{}` | `{ "machines": Machine[] }` (at most 32) |
| `machine.get` | `{ "name": string, "minLevel"?: "trace" \| "debug" \| "info" \| "warn" \| "error" \| "fatal" }` | `{ "machine": Machine, "status": MachineStatus, "logs": MachineLogs }` |
| `tailnet.peers` | `{}` | `{ "available": boolean, "peers": TailnetPeer[] }` (at most 128) |
| `threads.list` | `{ "canvasName": string, "nodeId": string, "limit"?: 1..200, "after"?: string (1 to 256) }` (closed) | `{ "threads": ThreadSummary[], "next"?: string, "cut": boolean }` the operator's own first, then the rest, newest activity first in each, at most 200 |
| `thread.get` | `{ "canvasName": string, "nodeId": string, "threadId": ULID, "limit"?: 1..200, "before"?: string (1 to 256) }` (closed) | `{ "messages": ThreadMessage[], "older"?: string, "cut": boolean }` oldest first, at most 200 |
| `threads.read` | `{ "canvasName": string, "nodeId": string, "threadId": ULID, "through"?: ULID }` (closed) | `{ "thread": ThreadSummary }` as it reads after the mark |
| `canvas.open` | `{ "canvasName": string }` (closed) | `{ "seq": number, "nodes": CanvasNode[], "wires": CanvasWire[] }`, then `canvas.changed` events |
| `canvas.close` | `{ "canvasName": string }` (closed) | `{}` |
| `artifacts.nodes` | `{ "canvasName": string }` (closed; needs `features` to list `artifacts/1`) | `{ "nodes": ArtifactNode[], "inboxNodeId"?: string }` every Artifacts node of the canvas (at most 200) |
| `artifacts.list` | `{ "canvasName": string, "nodeId"?: string, "type"?: ArtifactType, "labels"?: string[], "archived"?: boolean, "query"?: string (1 to 256), "limit"?: 1..200, "before"?: string (1 to 256) }` (closed; needs `artifacts/1`) | `{ "artifacts": ArtifactListItem[], "more": boolean, "next"?: string }` |
| `artifact.get` | `{ "canvasName": string, "artifactId": ULID, "version"?: number }` (closed; needs `artifacts/1`) | `{ "artifact": Artifact, "version": number, "bodyRef": ContentRef, "body"?: ArtifactBody, "labelColours"?: {...}, "pending"?: true }` |
| `artifact.history` | `{ "canvasName": string, "artifactId": ULID, "before"?: number, "limit"?: 1..200 }` (closed; needs `artifacts/1`) | `{ "versions": ArtifactVersion[], "moves": ArtifactMove[], "more": boolean }` |
| `artifact.pending` | `{ "canvasName": string, "nodeId": string }` (closed; needs `artifacts/1`) | `{ "writes": PendingWrite[] }` |
| `artifact.moveCheck` | `{ "canvasName": string, "artifactIds": ULID[] (1 to 100), "to": string }` (closed; needs `artifacts/1`) | `{ "warning"?: string }` |
| `inbox.set` | `{ "canvasName": string, "nodeId": string }` (closed; counts as a write) | `{ "inboxNodeId": string }` |
| `comments.list` | `{ "canvasName": string, "subject": CommentSubject, "limit"?: 1..200, "before"?: string (1 to 256) }` (closed; needs `features` to list `artifacts/1`) | `{ "threads": CommentThread[], "cut": boolean, "next"?: string }`, newest thread first, at most 200 |
| `comment.post` | `{ "canvasName": string, "subject": CommentSubject, "opId": ULID, "text": string (1 to 8000), "anchor"?: ArtifactPlaceAnchor, "threadId"?: ULID }` (closed; counts as a write) | `{ "threadId": ULID, "messageId": ULID, "unlinked"?: { "token": string, "nearest": string[] }[] }` |
| `mentions.candidates` | `{ "canvasName": string, "from": string, "trigger": "@" \| "#" \| "[[", "query"?: string (0 to 100), "limit"?: 1..50 }` (closed; needs `artifacts/1`) | `{ "candidates": MentionCandidate[] }` (at most 50) |
| `mentions.resolve` | `{ "canvasName": string, "hrefs": string[] (1 to 64, each 1 to 2048) }` (closed; needs `artifacts/1`) | `{ "faces": Face[] }`, one per href in order |
| `mentions.linkedFrom` | `{ "canvasName": string, "target": MentionRef, "before"?: string (1 to 256) }` (closed; needs `artifacts/1`) | `{ "bodies": LinkedFromBody[], "mail": MentionedIn[], "next"?: string }` |
| `artifacts.subscribe` | `{ "canvasName": string }` (closed; needs `artifacts/1`) | `{}`, then `artifact.changed` for that canvas until `artifacts.unsubscribe` or another subscribe |
| `artifacts.unsubscribe` | `{}` (closed) | `{}` |
| `artifacts.subscribe` | `{ "canvasName": string }` (closed; needs `artifacts/1`) | `{}`, then `artifact.changed` for that canvas until `artifacts.unsubscribe` or another subscribe |
| `artifacts.unsubscribe` | `{}` (closed) | `{}` |
| `artifacts.subscribe` | `{ "canvasName": string }` (closed; needs `artifacts/1`) | `{}`, then `artifact.changed` for that canvas until `artifacts.unsubscribe` or another subscribe |
| `artifacts.unsubscribe` | `{}` (closed) | `{}` |

Artifacts (feature `artifacts/1`, section 2). `ArtifactNode` is
`{ "nodeId", "title", "region": FeedRegion, "live": number, "archived": number,
"labelColours": { [label]: "red" | "orange" | "yellow" | "green" | "teal" | "blue" | "purple" | "pink" } }`:
`live` and `archived` count the artifacts the node holds, and a label with no
colour is absent. `inboxNodeId` is this Mac's own Inbox, the node the
desktop's quick capture (Cmd+T) lands in, and only while it is still one of
`nodes`; absent, none is set here. `inbox.set` writes that same setting
through the path the desktop's Settings page uses, so it is `invalid` for a
node that is not one of the canvas's Artifacts nodes, and the desktop's next
Cmd+T uses what the phone chose. The phone cannot make a node.

`mentions.candidates` is the desktop's own picker rule (`mentionableNodesFrom` for the scope, `filterCandidates` for the query, `shared/mention-candidates.ts`): a seat's `@` names the seats wired to it and the pages in its reach; from a resource, `@` names that resource's reach. `#` names the tasks on the boards and the artifacts in the Artifacts nodes in reach; `[[` the same artifacts by title. A `MentionCandidate` is `{ ref, kind, label, title, subtitle?, note? }`: `title` is the bare name, `subtitle` where it sits, `note` its state in words.

`mentions.resolve` draws what each href names, as the desktop's own card does: a seat face carries `state` (the seat ring's word) and the seat's `ring`; a task face its number, title and state; an artifact face its type, title, version, two lines of its body and `movedTo` when it has moved; a page face its url, resting; a `missing` face the label and why. `mentions.linkedFrom` lists the artifacts whose bodies link the target (`LinkedFromBody`: `{ nodeId, artifactId, title, type, line, at }`) and the mail and comments that mention it (`MentionedIn`), a page at a time by `next`.

`artifacts.list` covers the whole canvas when `nodeId` is absent (browse and
quick add) and one Artifacts node when it is named, which must be one of the
canvas's (`not-found` otherwise). `labels` must all match, each by equality or
by sitting under it (`a` matches `a/b`); `archived: true` lists archived
artifacts instead of live ones. Without `query` the rows run newest change
first; with it they are ranked by the desktop's quick-capture search (the title
first, then the type, the labels and a document's words), best first. An
`ArtifactListItem` is `{ artifactId, nodeId, type, title, version, updatedAt,
archived, labels, snippet?, pending? }`: `snippet` is the first 200 characters
of the artifact's text (absent while the body is not on this Mac yet) and
`pending: true` says one of this Mac's queued writes touches it. A page that
would pass the frame's byte budget carries fewer rows than `limit`; `more` and
`next` say so, and `before: next` resumes after the last row sent. A cursor
this list did not give is `invalid`.

`artifact.get` answers one artifact by id, wherever it sits now. `artifact` is
the head record and `version` the version whose body this is: the head's, or
the older one `version` asked for. `bodyRef` is always there and `content.get`
reads it. `body` is the body itself, and is sent only when the whole encoded
result fits 480 KiB, counted in bytes as it encodes (JSON escaping and UTF-8
make a document under its 512,000-character cap pass a frame); otherwise read
`bodyRef`. A version that is not on this Mac yet answers `unavailable` while it
is brought from the machine that edits the canvas: ask again. An artifact or
version this canvas does not hold is `not-found`.

`artifact.history` lists versions newest first, 50 by default; `before` is the
last version of the page before and `more` says older ones remain. A version is
`{ version, author: ResourceActor, at, change }` where `change` is `create`
(version 1), `replace`, `patch` or `unrecorded` (it arrived without its edit).
`moves` is every move of the artifact, oldest first, `{ from, to, by, at }`
(the newest 200 of a longer run), for the phone to interleave by `at`.

`artifact.pending` lists this Mac's writes to the node's artifacts that the
machine editing the canvas has not ruled yet, in queue order, each
`{ opId, artifactId, op, wouldRefuse?, waiting? }`: `wouldRefuse` is the
sentence the ruler would answer with as things stand, `waiting: true` says its
base is not on this Mac yet so there is no preview. `artifact.moveCheck` gives
the desktop's reach-change sentence for moving those artifacts to the node
`to` ("Seats in X will no longer reach this"); absent, no seat's reach changes.
Neither op changes anything.
Semantics:

- `signal.answer` does exactly what the desktop reply does: the answer is
  typed into the seat as operator mail and the signal becomes `answered`.
  With `quiet: true` it does what the desktop quiet send does: the answer is
  recorded on the signal, which becomes `answered`, with no mail, so the seat
  is not woken and reads it later through `signal list`. An empty quiet answer
  is recorded as "Acknowledged, no note". Send `quiet` only when
  `quickReplies.get` returned `quietNotes`: their presence says this Mac takes
  quiet answers. An older Mac would drop the key and send the answer as mail.
  Answering a signal that is no longer `open` returns `error` `conflict` with
  the current signal in `error.signal`.
- `mail.send` is operator mail to that seat, through the same delivery path as
  desktop (a stopped seat on a playing canvas is started to receive it). It
  goes to that seat and no one else. With neither id it starts a thread (its
  own id is the thread); with `inReplyTo`, it is a reply in that mail's
  thread; with `threadId` alone, a mail into that thread. Either must be one
  of this seat's threads (`not-found` otherwise; `invalid` when the two
  disagree). A mention is the link in the text: seats wired to this one by an
  edge (`SeatDetail.connected`), kept nowhere beside the text; they are sent
  nothing. A linked seat not wired here is `invalid`, "A mentioned seat is
  not connected to this one." A `mentions` list from an older phone is read
  and kept nowhere. Every refusal is a fixed sentence.
- `threads.list` and `thread.get` are the desktop's Threads: the mail that
  hangs off one root, between the operator and a seat or between seats, and a
  seat's replies to the operator. A summary's `last.text` is a preview of at
  most 280 characters (`textCut: true` when cut); one mail's text is cut at
  32,000. Both read a page at a time: `threads.list` lists the threads the
  operator wrote in (`owned`) first, then the rest, each group newest
  activity first, the thread id descending breaking a tie; `thread.get`
  gives the newest page of a thread, oldest first within it. A page's `next`
  (or `older`) is an opaque cursor: send it back as `after` (or `before`) for
  the page that follows, and stop when it is absent. A cursor names a place in
  the order, so mail arriving meanwhile never repeats or skips what the phone
  has yet to see; one the Mac cannot read starts at the top. With no `limit`
  a page holds up to 200, what a phone before paging always got. A page that
  would not fit one frame leaves out its oldest threads or messages, says
  `cut: true`, and its cursor resumes just past the last one sent. Bodies, titles and names are the
  operator's and the seats' own words, sent as stored: show them as plain
  text, never as markup or links that act.
- A thread has one read point, the operator's, kept on the Mac and shared
  with the desktop: a thread between two seats read under either reads under
  both. `threads.read` marks it through `through`, or through the newest mail
  when absent; the point only moves forward, so a read of older mail, or the
  same read twice, changes nothing and answers the thread as it stands.
  `not-found` for a thread that is not the seat's, `invalid` for a `through`
  not in the thread. A summary's `unread` counts the mail the operator did
  not write past the point, all of it when never read; `readAt` is when it was
  last read, on the Mac's clock, absent when never read.
- After a `threads.list` or `thread.get` for a seat, the phone receives
  `thread.changed` for that seat's newest 200 threads whenever one changes:
  new mail, a read on any surface (the desktop, another phone, this one
  through another seat), a new title or subject. It is an upsert by
  `threadId`. The phone's own `threads.read` answers in its response and is
  not repeated as an event. Threads are followed for the 8 seats listed or
  opened most recently on the connection.
- `portrait.get` returns the seat's portrait as the desktop draws it,
  including any customisation, as a self-contained SVG. Cache it by
  `(portraitIdentity, size, theme)`; it changes only when the operator edits
  the character. With `format: "png"` it is that SVG drawn as a `size` x
  `size` PNG, standard padded base64, so a native view never parses SVG.
  The Mac draws on demand and keeps what it drew; `internal` if a drawing
  fails.
- `canvas.open` is the canvas as the desktop draws it, read only, for the
  phone's map: every node's kind, rectangle, paint order, title and colour,
  and every wire's ends and drawn route. A whitelist, built field by field:
  no other node field crosses (not a region's environment, instruction or
  contract, nor a seat's agent key, host, binding or launch), and a seat,
  peer or git card with no label of its own carries none rather than a
  title made from those. A seat node's `nodeId` is its `Seat.nodeId`; live
  state stays on `seats.list` and `seat.changed`. One canvas is open per
  connection: opening another replaces it. `not-found` for no such canvas.
  There is no paging: a scene past the 512 KiB frame answers `internal`
  ("The reply was too large to send.").
  - A wire's `path` is the route the desktop draws for that one wire (its
    authored sides, else the sides that face, past every card but a
    region), as waypoints in canvas units, start to end; round its corners
    with `radius` (8). The desktop also lanes fans of three or more wires off
    one socket; the phone's routes do not, so those share a line.
  - `seq` counts per connection: the open's, then one more per
    `canvas.changed`. Any other number is a gap: open again.
- Files from the phone. Attach only when `quickReplies.get` returned
  `attachments`: an older Mac drops the unknown key and the file would vanish
  without a word. Today it is `{ maxCount: 10, maxBytes: 26214400, chunkBytes:
  196608, thumbnailTypes: ["image/png", "image/jpeg", "image/gif",
  "image/webp", "image/heic"] }`; read the numbers, do not assume them. A
  thumbnail type is drawn as a thumbnail, anything else as a file chip.
  - `content.stage` puts one file into the Mac content store, in order, one
    piece at a time, for a mail or an answer on `canvasName`. `sha256` (64
    lower-case hex) and `byteLength` (1 to `maxBytes`) name the whole file;
    `data` is standard padded base64 of 1 to `chunkBytes` bytes starting at
    `offset`. Offset 0 starts the file, and starts it over when one with the
    same canvas, sha256 and byteLength is already open; each later piece
    starts at the `received` the last one answered. When the last byte lands
    the Mac hashes the file and answers `{ ref }`; attach that ref.
  - Errors: `invalid` for a piece out of order, past `byteLength`, or not
    base64 (start the file again at offset 0); `not-found` for a canvas that
    is not on the Mac; `disk-low` at offset 0 when the Mac cannot hold
    `byteLength` (say so, do not retry); `mismatch` when the bytes did not
    hash to `sha256` and `byteLength` (nothing is kept; send it again);
    `rate-limited` for a third piece in flight, or an eleventh file open at
    once (finish one first); `internal` once, then show the error.
  - `mail.send` and `signal.answer` name the files by those refs, at most
    `maxCount`; with files, the text may be empty. The Mac reads only
    `sha256` and `byteLength` from each, takes a file only once and only from
    the uploads staged as the operator on that canvas, and records its type
    from the stored bytes and its name as staged. A ref that was never
    staged, already sent, or expired is `invalid` ("Attach it again"). The
    seat reads one line per file, with its name, type, size and a path it
    can open; the phone's `Mail` and `ThreadMessage` carry the refs back as
    `attachments`, and `content.get` serves them.
  - A file staged and never sent is let go after an hour; unpairing the phone
    lets go of its uploads at once. Nothing in a file is ever run or opened by
    Junto.
- `content.get` returns the bytes of a file a Needs you item or a mail carries,
  or, with `artifacts/1`, of an artifact on any canvas (a version's `bodyRef`, a
  file or link's content, a pad's image), in
  chunks. `sha256` is 64 lower-case hex; `offset` is a safe integer from 0;
  `length` is 1 to 262144 (256 KiB, which as base64 keeps a response under
  the 512 KiB frame). `data` is standard padded base64 of the bytes
  `[offset, offset + length)`; the result's `length` is what was returned,
  shorter than asked only on the last chunk, and `byteLength` is the whole
  file's size, the same as its ref's. The request names no path, canvas,
  signal or item.
  - Scope, checked on every request and never cached: the digest must be
    named by a content ref in an attachment of an item in the current feeds
    of every canvas (as `feed.get` with no canvas returns them): a file
    attachment's `ref`, or a compare's `before` or `after`. Commit and link
    attachments carry no bytes. Or it is a file a mail carries in its
    `attachments`, read as `thread.get` reads that seat's threads, or a file
    an answer carries in its signal's `response.attachments`; the size is the
    Mac's record of it.
  - Errors, in this order: `invalid` for arguments the schema refuses;
    `not-found` ("That file is no longer in your feed or your mail.") for a
    digest in neither, whatever the Mac stores, so the store cannot be probed;
    `invalid` for an `offset` at or past `byteLength` (an empty file answers
    offset 0 with length 0 and `data` ""); `unavailable` when the feed names
    the file but its bytes are absent, damaged or another size than the ref
    on this Mac (do not retry); `rate-limited` when this phone already has 4
    `content.get` unanswered (wait for one, then send); `internal` once, then
    show the error.
  - The Mac reads the object it holds a receipt for, through a confined open,
    and does not rehash each chunk. The phone hashes what it assembled and
    checks `sha256` and `byteLength` against the ref before showing it; on a
    mismatch it discards the bytes. A `not-found` mid-download means the file
    left the feed: discard the partial download.
  - The bytes, `mediaType` and display name are the agent's. Show them as
    inert data: never run script from them, and never open them in a handler
    chosen from `mediaType` without the operator's tap.
  - Nothing about these requests is logged.
- `machines.list`, `machine.get` and `tailnet.peers` are the machines tab,
  read only: they relay the owner commands the desktop's Machines view uses
  and its cached `tailscale status`, and never run a shell or change a
  machine. No SSH endpoint, path, key, host-key pin, installation id, pid or
  tailnet address reaches the phone.
  - `machine.get` reads the machine now, across its link for another
    machine. An unreachable machine is an answer (`reachable: false` with its
    `failure`), not an error. Unknown `name`: `not-found`. At most 2
    `machine.get` unanswered per phone; a third is `rate-limited`. `logs` is
    the newest 50 rows at or above `minLevel` (every level when omitted),
    oldest first, or `{ "unavailable": string }`, one fixed sentence when the
    machine is not set up, unreachable, or its log could not be read.
  - `Machine.tailnet` is the matching tailnet device's own online flag, not
    Junto reachability; `"unknown"` when Tailscale is absent or no device
    matches. `lastCheck.checkedAgoMs` is how long ago this Mac last read the
    machine for a phone, a duration, never a time: age it on the phone's
    clock from when the frame arrived. A check older than 7 days is not sent.
  - `tailnet.peers` lists every device on the tailnet but this Mac, with the
    Junto machine it is when it is one. `available: false` when Tailscale is
    absent or could not be read; never an error.
  - Every string here (labels, messages, details, failures, and above all
    the tailnet's names, chosen by whoever runs each device) is plain text on
    the phone: no markup, links, data detectors or tap-to-run.
- Nothing in v1 creates, deletes, moves, connects, starts, or stops seats.

Events:

| event | data |
|---|---|
| `hello` | see section 2 |
| `feed.changed` | `{ "feed": OperatorFeed }`: the whole feed of one canvas, replacing the previous one (feeds are small; no diffs in v1) |
| `seat.changed` | `{ "canvasName": string, "seat": Seat }` (only while a `seats.list` for that canvas was requested in this connection) |
| `signal.changed` | `{ "signal": AgentSignal }` (upsert by `signalId`) |
| `seat.removed` | `{ "canvasName": string, "nodeId": string }` (same subscription rule as `seat.changed`; the seat was deleted or stopped being an agent seat) |
| `canvases.changed` | `{ "canvases": Canvas[] }`: the whole list, replacing the previous one, after a `canvases.list` in this connection (a canvas added, renamed, removed, or its `playing`/`needsYou`/`active` changed). A canvas missing from the list is gone: drop its feed and seats |
| `mail.changed` | `{ "canvasName": string, "nodeId": string, "message": Mail }` (upsert by `messageId`; new mail either direction and delivery changes, only for the seat of the last `mail.list` or `seat.get`) |
| `thread.changed` | `{ "canvasName": string, "nodeId": string, "thread": ThreadSummary }` (upsert by `threadId`; new mail, a read from any surface, a title or subject change, for a seat this connection listed or opened threads of) |
| `machines.changed` | `{ "machines": Machine[] }`: the whole list, replacing the previous one, after a `machines.list` in this connection (a machine added, removed, set up, sent or updated, a link learning its build, or a newer check). A check's age growing is not a change |
| `preamble` | `{ "canvasName": string, "nodeId": string, "preamble": Preamble }` (only for the seat of the last `seat.get`) |
| `canvas.changed` | `{ "canvasName": string, "seq": number, "nodes": CanvasNode[], "wires": CanvasWire[], "removedNodes": string[], "removedWires": string[] }`: whole nodes and wires added or changed since `seq - 1`, and the ids gone, for the canvas of the last `canvas.open` until `canvas.close` |
| `comments.changed` | `{ "canvasName": string, "subject": CommentSubject }`: a comment landed on the subject of the last `comments.list`, by anyone; list it again |
| `artifact.changed` | `{ "canvasName": string, "artifact": ArtifactListItem, "author": ResourceActor, "at": number, "edit"?: ArtifactEdit, "bodyRef"?: ContentRef }`: one artifact changed on the subscribed canvas, by anyone who wrote through that Mac; `edit` rides along when it fits (at most 32 KiB), else read the artifact again. An archive or move is the same event with the new head |
| `artifact.changed` | `{ "canvasName": string, "artifact": ArtifactListItem, "author": ResourceActor, "at": number, "edit"?: ArtifactEdit, "bodyRef"?: ContentRef }`: one artifact changed on the subscribed canvas, by anyone who wrote through that Mac; `edit` rides along when it fits (at most 32 KiB), else read the artifact again. An archive or move is the same event with the new head |
| `artifact.changed` | `{ "canvasName": string, "artifact": ArtifactListItem, "author": ResourceActor, "at": number, "edit"?: ArtifactEdit, "bodyRef"?: ContentRef }`: one artifact changed on the subscribed canvas, by anyone who wrote through that Mac; `edit` rides along when it fits (at most 32 KiB), else read the artifact again. An archive or move is the same event with the new head |

Event origin: `signal.changed`, `feed.changed` and `seat.changed` fire for
every change no matter who made it: the phone, the desktop, or the agent
itself (an agent raising or withdrawing a signal, a seat changing state). A
subscribed phone never needs to poll.

## 4. Data shapes

`OperatorFeed`, `FeedSection`, `FeedItem`, `FeedSeat`, `FeedRegion` and
`FeedHealth` are exactly the desktop shapes in `src/shared/operator-feed.ts`
(`version: 3`). `AgentSignal` is exactly `src/shared/agent-signals.ts`, with
one cut: an automation source's `step` never leaves the Mac, on any frame
(`companionSignal`), since its raised values alone run to 32 KB. Summarised:

```ts
type OperatorFeed = { version: 3; canvasName: string; generatedAt: number; count: number; sections: FeedSection[] };
type FeedSection  = { region: FeedRegion; items: FeedItem[]; worstUrgency: number };
type FeedRegion   = { regionId: string | null; label: string; path: string[]; color?: string }; // color: preset "1".."6" or #hex
type FeedItem = {
  itemId: string;
  kind: "blocked" | "attention" | "stopped" | "escalate" | "feedback" | "health";
  urgency: number;             // the need ladder: 6 blocked and attention, 5 stopped, 4 escalate and health, 3 feedback
  canvasName: string;
  seat: { nodeId: string; name: string; portraitIdentity: string; harness?: string };
  region: FeedRegion;
  text: string;                // one short sentence
  detail?: string;             // markdown
  since: number; ageMs: number;
  signalId?: string;           // present for declared signals: answer or dismiss with it
  signalKind?: "escalate" | "blocked" | "feedback";
  health?: { value: ThreadHealthValue; tone: "trouble" | "waiting" | "steady" | "good";
             label: string; confidence: number; observedAt: number; stale: boolean };
};
type AgentSignal = {
  signalId: string; canvasName: string; nodeId: string;
  kind: "escalate" | "blocked" | "feedback";
  text: string; detail?: string; createdAt: number;
  state: "open" | "answered" | "dismissed" | "withdrawn";
  response?: { text: string; at: number }; closedAt?: number;
};
```

Companion-only shapes:

```ts
type Canvas = { canvasName: string; title: string; active: boolean; playing: boolean; needsYou: number };

type Seat = {
  nodeId: string; name: string; portraitIdentity: string; harness?: string;
  region: FeedRegion;
  // What the seat ring shows, in the desktop's words.
  state: "working" | "waiting_on_you" | "needs_input" | "blocked" | "trouble"
       | "done_unread" | "resting" | "starting" | "stopped" | "offline";
  line: string;                // the seat's label line, e.g. "waiting on you" or "AI reads: going well"
  signal?: { kind: "escalate" | "blocked" | "feedback"; signalId: string; openCount: number };
  health?: FeedItem["health"];
  lastActivityAt?: number;
  // The ring the desktop card draws now (ringState, src/shared/wire/rings.ts).
  ring?: { ring: RingForm; hue: "amber" | "cyan" | "green" | "crimson" | "steel";
           glow?: "amber" | "crimson"; halo?: "good" | "exceeding"; stale: boolean;
           flag?: "escalate" | "blocked" | "feedback" };
  stateStartedAt?: number;     // when the shown status began, Mac clock; a done ring lands from here
  // The seat's level on the urgency ladder (seatLevel, src/shared/wire/seat-level.ts),
  // sent with ring. The desktop palette groups by it (Palette, src/shared/wire/urgency.ts).
  level?: "blocked" | "stopped" | "waiting" | "escalated" | "review" | "done"
        | "degraded" | "working" | "resting" | "offline";
  levelSince?: number;         // when the seat took that level, Mac clock; the palette's order within a group
};

// Loops turn on the shared clock: phase = (now + Mac offset) % MARK_PHASE_MS.
type RingForm = "work" | "reverse" | "snake" | "call" | "wait" | "halt" | "glint" | "fracture"
              | "dot" | "live" | "rest" | "off" | "done";

type CanvasNode = {
  nodeId: string;
  kind: "agent" | "peer" | "terminal" | "page" | "task" | "artifacts" | "automations"
      | "note" | "label" | "file" | "link" | "git" | "region";
  frame: { x: number; y: number; width: number; height: number };   // canvas units
  z: number;                   // paint order, lowest first
  label?: string;              // the card's title, at most 256 characters
  color?: string;              // a preset "1" to "6" or a hex
};

type CanvasWire = { wireId: string; from: string; to: string; path: { x: number; y: number }[]; radius: number };

// A file in the Mac content store: what content.get reads and attachments name.
type ContentRef = { sha256: string; byteLength: number; mediaType: string; displayName?: string };

type Mail = {
  messageId: string; canvasName: string; nodeId: string;
  direction: "to_seat" | "from_seat";
  from: { kind: "operator" } | { kind: "seat"; nodeId: string; name: string };
  text: string; at: number;
  delivery: "delivered" | "waiting_for_seat" | "failed";
  threadId?: string;                          // its thread: the root mail's id, its own when it starts one
  inReplyTo?: string;
  attachments?: ContentRef[];                 // files the mail carries; content.get serves them
};

// ResourceSubject is exactly src/shared/wire/thread-subject.ts: a task, artifact, file or page.
type ThreadParty = { kind: "operator" } | { kind: "seat"; nodeId: string; name: string };
type ThreadMessage = {
  messageId: string; threadId: string; inReplyTo?: string;
  from: ThreadParty; to: ThreadParty[];       // to: always the one recipient
  mine: boolean;                              // the operator wrote it
  text: string; textCut?: true; at: number;
  attachments?: ContentRef[];                 // files the mail carries; content.get serves them
  subject?: ResourceSubject;                  // what the thread is about; absent for a mailbox thread
};
type ThreadSummary = {
  threadId: string;
  title: string;                              // the root's first line, at most 280 characters
  participants: ThreadParty[];                // in order of first appearance, at most 64
  startedAt: number; lastAt: number;
  last: ThreadMessage;                        // its text a preview, at most 280 characters
  messageCount: number;
  canReply: boolean;                          // the operator wrote in it, or mail in it is to the operator
  owned?: boolean;                            // the operator wrote at least one mail in it; absent from an older Mac
  readAt?: number;                            // when the operator last read it, Mac clock; absent when never read
  unread?: number;                            // mail the operator did not write past the read point; absent from an older Mac
  subject?: ResourceSubject;                  // what the thread is about; absent for a mailbox thread
};
```

```ts
// A preamble is the agent's (or Junto's) short live note about what it is doing.
// Preambles are ephemeral by design: never stored, gone after expiresAt.
type Preamble = {
  preambleId: string; text: string;          // one short sentence
  source: "agent" | "ai" | "junto" | "operator";
  at: number; expiresAt: number;
};

type SeatDetail = Seat & {
  briefing?: string;                          // the seat's region briefing, markdown, when it has one
  preambles: Preamble[];                      // only the ones still live; newest first
  signals: AgentSignal[];                     // every state, newest first, last 50
  activity: Activity[];                       // the seat sidebar's Activity list, newest first, last 50
  connected?: { nodeId: string; name: string }[];  // agent seats wired to this one: who a mail may mention (at most 64)
};

type Activity = {
  at: number;
  label: string;                              // plain words, as the desktop shows it, e.g. "sent mail"
  kind: "mail" | "signal" | "state" | "work" | "other";
  targetName?: string;                        // the other seat or surface, when there is one
};
```

History on the phone is `seat.get` (signals and activity) plus `mail.list`.

Machines (`src/shared/wire/companion-protocol.ts` holds the bounds):

```ts
type Machine = {
  name: string; label: string; thisMachine: boolean;
  form?: "macbook" | "mac-mini" | "mac-studio" | "mac" | "linux";
  setUp: boolean;
  needsUpdate: boolean;                       // its build differs from this Mac's
  tailnet: "online" | "offline" | "unknown";
  lastCheck?: { checkedAgoMs: number; reachable: boolean; failure?: MachineFailure };
};
type MachineFailure = { tag: string; message: string };   // the typed failure's tag and scrubbed sentence
type MachineStatus = {
  reachable: boolean;
  build?: string;                             // 12 hex, this Mac only
  keychain?: "available" | "unavailable" | "not-applicable";
  harnesses: { harness: string; installed: boolean; signIn?: "not-installed" | "sign-in-unverified" | "keychain-login-unavailable" }[];
  missingSecrets: string[];                   // environment names only, never values
  detail?: string;
  failure?: MachineFailure;
};
type MachineLogs =
  | { rows: { time: string; level: string; area: string; message: string; canvas?: string; seat?: string; failure?: MachineFailure }[]; cut: boolean }
  | { unavailable: string };
type TailnetPeer = { name: string; dnsName?: string; os?: string; online: boolean; machine?: string };
```

Presentation notes for the phone (not protocol): "health" items and every
`health` field are an AI reading; show them as "AI reads: <label>", never as
the agent's own words. Regions carry the region's colour; group the feed by
section as delivered, most urgent section first.

### Shared wire modules

Every schema a phone needs lives in modules whose import closure is only
`effect`, so the mobile repo can copy them without the rest of the app:
`src/shared/wire/operator-feed.ts` (OperatorFeed and its parts),
`src/shared/wire/agent-signals.ts` and the `src/shared/wire/content-ref.ts` its
attachments use, `src/shared/wire/thread-health.ts`,
`src/shared/wire/mail-threads.ts` (MailParty, MailThreadMessage,
MailThreadSummary) and the `src/shared/wire/thread-subject.ts` its subjects
use (Anchor and the resource subjects), `src/shared/wire/rings.ts` (the ring rule and its
timing), `src/shared/wire/seat-activity.ts` (the seat grammar,
`terminalActivity`, and the seat states it reads),
`src/shared/wire/seat-ring.ts` (`companionSeatRing`, the ring a seat
carries, and `companionSeatLevel`, its level), `src/shared/wire/seat-level.ts`
(`seatLevel` and `seatLevelSince`, the level rule the desktop palette ranks
by), `src/shared/wire/urgency.ts` (the one urgency ladder, its views,
kind maps and predicates), `src/shared/wire/companion-protocol.ts`. The desktop's builders import these;
the wire modules never import the builders. A test fails the build if any
wire module's closure grows past `effect`.

## 5. Errors

`error.code` is one of:

| code | meaning | phone should |
|---|---|---|
| `app-not-running` | Junto is not open on the Mac | show "Open Junto on your Mac", retry later |
| `revoked` | this phone was unpaired | forget the Mac, offer to pair again |
| `unsupported-version` | the Mac speaks another protocol | show "Update Junto or the app" |
| `invalid` | args failed validation | bug; show a generic error |
| `not-found` | canvas, seat, or signal is gone | refresh the feed |
| `conflict` | signal no longer open (`error.signal` holds its current state) | replace the item |
| `too-large` | frame over the limit | bug; channel closes |
| `mismatch` | a staged file did not hash to what the phone named (`content.stage` only) | send the file again |
| `disk-low` | the Mac cannot hold the file (`content.stage` only) | say so; do not retry |
| `rate-limited` | more than 20 writes per 10 s | back off and retry |
| `internal` | unexpected failure | retry once, then show error |
| `unavailable` | a file the feed names is not stored on this Mac (`content.get` only) | show "not available", do not retry |

`message` is a short plain-language sentence safe to show. Errors never
contain secrets, tokens, or terminal contents.

## 6. Pairing

Desktop: Settings > Companion > Pair a phone.

1. The Mac creates a device record `dev_<ulid>` and a one-time pairing key
   pair (ed25519), installs the public half with the forced command above, and
   shows a QR code. The QR expires after 10 minutes; an unused device is
   removed on expiry.
2. QR payload (JSON, base64url in a `junto-companion://pair?d=` URL):

   ```json
   { "v": "junto-companion/1", "deviceId": "dev_01J...", "station": "Guilherme's MacBook Pro",
     "hosts": ["guilhermes-mbp.tail1234.ts.net", "100.101.102.103", "guilhermes-mbp.local"],
     "port": 22, "user": "guilhermecastro",
     "hostKey": "ssh-ed25519 AAAA...", "pairingKey": "-----BEGIN OPENSSH PRIVATE KEY-----...",
     "expiresAt": 1790000600000 }
   ```

   Next to the QR, **Copy link** copies the same `junto-companion://pair?d=`
   URL, for pasting on the phone (Universal Clipboard) when scanning is not
   possible. It carries the same one-time key with the same expiry. Junto
   clears the clipboard when that pairing completes or expires, if the
   clipboard still holds the link.
3. The phone tries `hosts` in order, pins `hostKey` (it must match exactly,
   no trust-on-first-use), and authenticates with `pairingKey`.
4. First request on that connection must be `pair.complete`
   `{ "publicKey": "ecdsa-sha2-nistp256 AAAA...", "deviceName": "..." }` with a key
   the phone generated in its Secure Enclave. The Mac swaps the one-time key
   for this key in `authorized_keys`, marks the device paired, and responds
   `{ "deviceId": "dev_..." }`. The phone discards `pairingKey`. From then on
   only the Secure Enclave key works.
5. Revocation: Settings > Companion lists paired phones with last-seen time;
   Remove deletes the `authorized_keys` line and the record. `pair.complete`
   is the only op accepted while a device is in the pairing state, and it is
   refused afterwards.

## 7. Development without a Mac

`junto companion-stdio --demo` speaks the full protocol from stdin/stdout
against a built-in, deterministic demo canvas (three regions, eight seats,
every feed kind, mail history) and never touches the app or `~/.ssh`. Writes
succeed and change the demo state for that process only. Its canvas has
three wires, one routed round a card; a mail sent to a seat brings that
card to the front, the demo's one `canvas.changed`. The mobile repo can
drive it over a local pipe or `ssh localhost` for tests.

## 8. Versioning

`junto-companion/1` is additive-only: new ops, new optional fields, and new
event types may appear; the phone must ignore unknown fields and events.
Removing or changing the meaning of anything is `junto-companion/2`.
