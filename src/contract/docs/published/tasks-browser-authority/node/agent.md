# Node kind: agent

**Role:** actor

The actor role: takes work from its reach and its mail, holds a mailbox, runs a harness.

## Ports offered
- `msg.list` — List messages on the connected node's mailbox.
- `msg.prompt` — Mail the peer as a prompt: the full text is typed into its input at once, idle or mid-turn.
- `msg.send` — Mail the connected node: it is typed whole into its input, up to 2,500 characters, and mail sent together arrives as one turn.
- `seat.wait` — Wait for a connected peer state with a bounded timeout.
- `terminal.read` — Read settled terminal output from a connected peer; no input, resize or signal authority.
- `threads.read` — List and read a connected peer's threads with the operator; sends nothing and marks nothing read.

## Data model
_Actor seat: the node holds identity, harness and launch settings. Mail is separately stored and paged per seat; terminal sessions are runtime facts. Identity is the seat credential._

- `kind`: string
- `id`: string
- `x`: number
- `y`: number
- `width`: number
- `height`: number
- `z`: integer
- `color`: string
- `agentKey`: string
- `label`: string
- `host`: string
- `overseer`: boolean
- `bindingId`: string
- `harness`: string
- `launch`: object

## Events
- msg.append — operator or peer messages land in the seat mailbox
- msg.list — own inbox marks listed mail read; sent shows peer readAt
- msg.react / msg.reply — ack without a reply, or reply
- seat.state — working, idle, waiting-on-operator, blocked, ready-for-review or done; mail reaches every connected seat

## Contract

`junto onboard` compiles the commands a seat holds on this kind. The full contract:

These examples cover the offered ports; your live edge may grant fewer.
```
### Contract — messages (target `<agent-node-id>`)

| intent | command |
|---|---|
| read target thread | `junto msg list '{"target":"<agent-node-id>"}'` |
| send mail | `junto msg send '{"target":"<agent-node-id>","text":"..."}'` — it lands in their input whole, under a `mail from <you>` header with the reply command; mail sent together arrives as one turn |
| reply | `junto msg reply '{"target":"<agent-node-id>","text":"...","inReplyTo":"<msgId>"}'` |
| prompt | `junto msg send --prompt '{"target":"<agent-node-id>","text":"..."}'` — the full text lands in their input at once as steering, as its own turn, idle or mid-turn. A running turn uses that harness's follow-up contract |
| wait | `junto seat wait <agent-node-id> --until idle --timeout 30s` — also supports attention, working, or gone |
| observe | `junto seat read <agent-node-id> --lines 40` — settled grid, with state, reason, confidence and generation; output activity alone is not readiness |
| read their threads | `junto thread list --seat <agent-node-id>` — their threads, newest first; junto thread show <threadId> --seat <seat> reads one. Marks nothing read |

A mail target is a seat's name or its node id; a name two of your seats share is refused, listing each one's id and regions. Own inbox: `junto msg list` marks listed mail read; `junto msg react '{"messageId":"<msgId>"}'` acknowledges without a reply. Mail is never refused and never needs a retry: it is typed into the recipient's input within seconds, whatever the recipient is doing, and a recipient whose seat is not up gets it when the seat starts. The one wait is the input box: mail is never typed over a message the operator is composing in that seat, into a dialog, or onto a screen Junto cannot read, and goes in once the box is free. Kinds are `notice`, `prompt`, and `receipt`. A notice is typed whole, up to 2,500 characters, under one header: `mail from <seat> (<regions>)`, its id, its thread when it is a reply, and the `junto msg reply` that answers it; longer mail is cut there with a pointer to `junto msg read <id>` for the rest. Mail for one seat that arrives together is typed as one turn: a count line, then each mail under its own header, oldest first. It waits 2 seconds for more, never past 10 seconds after the first; past 6,000 characters in one turn, each further mail is one line with its id and stays unread; past 20 of those, one last line counts the rest with the `junto msg list` that lists them. A prompt is typed whole, as its own turn. Mail typed whole is marked read as it is typed; cut mail stays unread until you read it. The header adds a pointer to `junto onboard` when the recipient has not onboarded yet. Threads: every mail names its `threadId`, the id of the mail that started it; `junto msg reply` joins the parent's thread, `junto msg send` joins one with `threadId`, `junto msg list '{"threadId":"<id>"}'` reads one, `junto thread list` and `junto thread show <threadId>` page your threads and mark nothing (see Threads), and a reply with target `operator` answers mail the operator sent you. Filter a list with `from`, `unread`, `since` (ISO time or message id) and `text`, alone or with `threadId`; `"peek":true` lists without marking anything read. A mailbox list is one page, newest first (a task's thread is read whole, in order): `limit` (default 50, at most 200), and `more` and `remaining` say what is older; `before` with the last id listed reads the next page; sent mail in your own list pages alone, with `sentMore`, `sentRemaining` and `sentBefore`. Only listed mail is marked read, so unread mail past a page stays unread and `"unread":true` still reaches it. Avoid acknowledgement loops.

Seat wait and seat read require a local peer, and are unavailable for Remote seats.

`junto seat read <peer>` names the peer (name, regions), its state and since when, and when its terminal last printed, beside its screen tail.
It carries the peer's own last `junto preamble` while that is live, kept in memory only.
It lists the 5 newest mails between you and the peer, both ways, with their threads and receipts, and marks none of them read.
`junto seat wait <peer> --until replied [--after <msgId>]` returns when the peer mails you after that message, or after the wait began; your own mail never ends it.
`junto seat read --brief` gives all of that for every peer you may read, without screens, and says how many connected seats were left out for lack of the grant.

A send answers `delivered` (typed into their input) or `waiting` (their seat is not up yet, or its input box is not free: the operator is composing, or a dialog is up). Inspect delivered, read and reply facts with `junto msg sent`; each is separate evidence.
```