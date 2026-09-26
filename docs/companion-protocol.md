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
- Max frame: 16 KiB phone to Mac, 512 KiB Mac to phone. A larger frame is a
  protocol error; the Mac replies `error` `too-large` and closes.
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
            "station": "Guilherme's MacBook Pro", "serverTime": 1790000000000 } }
```

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
| `signal.answer` | `{ "signalId": string, "text": string }` (1 to 8000 chars) | `{ "signal": AgentSignal }` |
| `signal.dismiss` | `{ "signalId": string }` | `{ "signal": AgentSignal }` |
| `mail.list` | `{ "canvasName": string, "nodeId": string, "limit"?: number }` (default 50, max 200) | `{ "messages": Mail[] }` newest first |
| `mail.send` | `{ "canvasName": string, "nodeId": string, "text": string }` (1 to 8000 chars) | `{ "message": Mail }` |
| `quickReplies.get` | `{}` | `{ "replies": string[] }` (the operator's quick replies from desktop Settings) |
| `portrait.get` | `{ "portraitIdentity": string, "size": number, "theme": "bright" \| "dark" }` | `{ "svg": string }` |

Semantics:

- `signal.answer` does exactly what the desktop reply does: the answer is
  typed into the seat as operator mail and the signal becomes `answered`.
  Answering a signal that is no longer `open` returns `error` `conflict` with
  the current signal in `error.signal`.
- `mail.send` is operator mail to that seat, through the same delivery path as
  desktop (a stopped seat on a playing canvas is started to receive it).
- `portrait.get` returns the seat's portrait as the desktop draws it,
  including any customisation, as a self-contained SVG. Cache it by
  `(portraitIdentity, size, theme)`; it changes only when the operator edits
  the character.
- Nothing in v1 creates, deletes, moves, connects, starts, or stops seats.

Events:

| event | data |
|---|---|
| `hello` | see section 2 |
| `feed.changed` | `{ "feed": OperatorFeed }`: the whole feed of one canvas, replacing the previous one (feeds are small; no diffs in v1) |
| `seat.changed` | `{ "canvasName": string, "seat": Seat }` (only while a `seats.list` for that canvas was requested in this connection) |
| `signal.changed` | `{ "signal": AgentSignal }` (upsert by `signalId`) |

## 4. Data shapes

`OperatorFeed`, `FeedSection`, `FeedItem`, `FeedSeat`, `FeedRegion` and
`FeedHealth` are exactly the desktop shapes in `src/shared/operator-feed.ts`
(`version: 1`). `AgentSignal` is exactly `src/shared/agent-signals.ts`.
Summarised:

```ts
type OperatorFeed = { version: 1; canvasName: string; generatedAt: number; count: number; sections: FeedSection[] };
type FeedSection  = { region: FeedRegion; items: FeedItem[]; worstUrgency: number };
type FeedRegion   = { regionId: string | null; label: string; path: string[]; color?: string }; // color: JSON Canvas preset "1".."6" or #hex
type FeedItem = {
  itemId: string;
  kind: "blocked" | "attention" | "escalate" | "feedback" | "health";
  urgency: number;             // 5 blocked, 4 attention, 3 escalate, 2 feedback, 1 health
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
};

type Mail = {
  messageId: string; canvasName: string; nodeId: string;
  direction: "to_seat" | "from_seat";
  from: { kind: "operator" } | { kind: "seat"; nodeId: string; name: string };
  text: string; at: number;
  delivery: "delivered" | "waiting_for_seat" | "failed";
};
```

Presentation notes for the phone (not protocol): "health" items and every
`health` field are an AI reading; show them as "AI reads: <label>", never as
the agent's own words. Regions carry the region's colour; group the feed by
section as delivered, most urgent section first.

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
| `rate-limited` | more than 20 writes per 10 s | back off and retry |
| `internal` | unexpected failure | retry once, then show error |

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
succeed and change the demo state for that process only. The mobile repo can
drive it over a local pipe or `ssh localhost` for tests.

## 8. Versioning

`junto-companion/1` is additive-only: new ops, new optional fields, and new
event types may appear; the phone must ignore unknown fields and events.
Removing or changing the meaning of anything is `junto-companion/2`.
