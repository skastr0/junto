# How Junto works

## The canvas

A canvas is a named place. Nodes are agents, terminals, notes, labels, git cards, and regions. Edges are relationships. You author it in the app; agents do not write it unless you make one an overseer.

## Seats

An agent node bound to a harness gets a managed terminal: a PTY running that harness's own binary in the folder you chose. Junto pins or captures the harness's session id and stores it, so the seat resumes that session, never "whatever ran last".

Each harness has a template in `src/shared/managed-terminal-templates.ts` that records how it launches, how its session is named and resumed, and which settings it exposes (model, effort, permission mode). Fidelity varies by harness and version. Inside a seat, `junto capabilities` lists every harness Junto knows and whether it is installed on your machine.

Supported: Claude Code, Codex, Grok, Pi, Devin, Cursor Agent, Antigravity, fx, Prime Agent, Hermes, Kimi Code, Muse, Amp, and Oh My Pi.

## Sessions

A seat is one continuous agent. Its sessions are internal to it: Junto resumes the same session across restarts and wakes, and no screen shows session history, records, journals, or transcripts. That data lives in the seat's own store and CLI.

Every session a seat runs is in its history: which harness, which session id, where the harness keeps its transcript, and when it started and ended.

### Three kinds of record

A past session is known through three kinds of record. They are not interchangeable, and Junto keeps them apart.

- **Record**: Junto's observation. Every time a session ends, Junto writes what it observed while the session ran, from facts, with no model and no agent turn: how the session ended and who ended it, the mail it received (when each was read, and whether it was answered) and the mail it sent, the signals it raised or had answered and their answers, and the moves of the tasks it held. That holds for every end: the agent's own offboard, a cut from outside by the operator, an overseer or Junto, a move to another harness or binding, and a changed session id. The record lives at `~/.junto/seats/<seat>/sessions/<session>.record.json`. Each source gets a few seconds; one that cannot be read is marked unread, with why, which is not the same as there being none. A list keeps its latest 50 items and counts the rest, and each text is cut to 280 characters.
- **Journal**: the seat's own words. The agent writes it when it ends its session with `junto offboard` (below): what happened, what is relevant, and why it matters. Junto saves it beside the record as `~/.junto/seats/<seat>/sessions/<session>.md`. A seat can only write the journal of its own current session, and a session ended from outside it has none.
- **Transcript**: the harness's full record of the session, where the harness keeps it. Junto saves that path at every end; when there is none, onboard says why: the harness has none under that id, or Junto does not know where that harness keeps its sessions.

Each deserves its own weight. The record is facts Junto saw, and can be taken as what happened, within what Junto sees: mail, signals, tasks, and the end. A source marked unread says nothing either way. The journal is one session's view of its own work, useful for intent and reasons but low in trust: check what it claims against the record or the transcript before building on it. The transcript is the full account, and settles what the other two leave open.

### Ending a session

The agent chooses its stopping point, and one of two modes:

- **Offboard** (`junto offboard "<notes>"`), at a stopping point. The notes are the session's journal. The seat rests. Its next wake starts a fresh session that onboards with them.
- **Offboard and continue** (`junto offboard "<notes>" --continue "<note>"`), mid-work. The continuation is a note for the next session: what to pick up and why. Junto starts a fresh session right away, telling it in one line to read its handoff. Its onboard leads with the note as a `handoff`, left for it by its previous session together with that session's journal, and it carries on.

In both modes the seat moves on the moment `junto offboard` returns, so the agent runs it last. The old session is not cut: its process is taken off the seat and left to finish what it is saying, so its transcript is whole. From that moment nothing reaches it: no mail, no prompt, no keystroke, and its `junto` commands are refused. Mail that arrives goes to the fresh session. Junto stops the old process once it goes idle, or after ten minutes, and records how it ended.

Offboarding is self-service: the agent decides when, and `junto docs doctrine` tells it how. Junto does estimate a session's size in tokens (`src/main/junto/term/session-size.ts`): from the harness's own usage counts in its transcript where it writes them, otherwise from the transcript's size on disk, which overcounts a session whose harness has shortened its own context. The operator sees the estimate in the seat's offboard status, and it feeds one guard: Junto's own cut of a session whose cache has gone cold leaves alone a session too small to be worth cutting. It never decides for the agent when to offboard.

The seat's **Offboard** and **Offboard and continue** buttons in Customize send the agent the offboard prompt for that mode, delivered between turns like any mail, and show the progress: asked, notes saved, then the session closed or the new session started. The notes are always the agent's own.

### What onboard shows

When the next session runs `junto onboard`, it gets the seat's past sessions, newest first, up to 30. Onboard marks them as past sessions: context for continuity, not work to resume unless the agent's current instructions or mail ask for it. `sessions.provenance` names the three kinds once, and each past session carries each kind under its own key, never blended into one account:

- `record`: Junto's record in full for the session just before this one; each older session points at its file as `record_path`. A session with no record, such as one that ended before records were kept, shows `record: null`.
- `journal`: present only when the session wrote one, with its `gist` (the first line) and `path`. The latest five come with their `text` in full (`--past-notes` changes the count, up to 20). A journal the handoff already carries is marked `in: "handoff"` instead of printed twice.
- `transcript_path`, or `transcript_missing` with the reason there is none.

`sessions.current.journal_path` is where the current session's own journal will be saved.

When the session just before this one ended without a journal, onboard says so first (`previous_session_without_notes`): how it ended, who ended it when that was recorded, and where its transcript is. Junto's record of it leads the past sessions. To look further back, the agent opens the listed files itself.

The continuation is the one exception to past sessions being context: only the session right after the one that continued sees it, and it is meant to be picked up.

## Lines and access

An edge compiles into grants. A `messages` edge between two agents gives each one mail, prompt, wait, and read access to the other (`msg.send`, `msg.list`, `msg.prompt`, `seat.wait`, `seat.read`). No edge, no grant: the CLI refuses with a `ScopeError` that names the missing edge.

## The CLI

The `junto` CLI talks to the app over a local socket, `~/.junto/work/control.sock` (mode 600). Main mints a generation credential into `JUNTO_WORK_TOKEN` when the seat starts, and the CLI presents that value. There is no token file and nothing to paste.

| command | what it does |
| --- | --- |
| `junto capabilities` | this seat's lines, grants, and the harnesses on this machine |
| `junto onboard` | seat orientation: node, edges, co-members, and this seat's past sessions |
| `junto offboard "<notes>"` | end this session with notes; the seat rests until its next wake |
| `junto offboard "<notes>" --continue "<note>"` | end this session with notes and a note for a fresh session that starts right away |
| `junto msg send '{"target":"<seat>","text":"…"}'` | mail a connected seat; a short line lands in its input |
| `junto msg send --prompt '{"target":"<seat>","text":"…"}'` | mail a connected seat; the full text lands in its input |
| `junto msg list` | read this seat's inbox (marks listed mail read) |
| `junto msg read <id>` | read one message and mark it read |
| `junto msg reply` / `junto msg react` | answer or acknowledge a message |
| `junto seat wait <seat> --until idle` | wait for a connected seat to reach a state |
| `junto seat read <seat>` | read a connected seat's terminal |
| `junto doctor` | socket, token, and protocol checks |

Every command prints JSON. `junto schema` and `junto examples` describe the inputs.

In 0.3.2, `junto msg send`, `junto seat wait`, and `junto seat read` stop with "Missing required flag" unless you pass `--no-prompt`, `--no-any`, or `--no-follow`.

## Mail

`junto msg send` stores the message and types it into the receiving seat's input at once, as steering. While a turn is running, that harness's follow-up contract says how many Enters that takes: Cursor and Devin send two, and the others send one. An idle seat gets one Enter. A plain send types one short line naming the sender and `junto msg read <id>`. With `--prompt`, the full text is typed instead. Nothing is refused and nothing needs a retry: a seat that is not running gets its mail when it starts, and the command answers `delivered` or `waiting`.

## State

Everything Junto owns lives in `~/.junto/`. Product state is one SQLite file, `~/.junto/state/junto.db`, opened only by the app. Junto writes no canvas file and watches none.

## Play and pause

A new canvas starts paused, and a paused canvas starts nothing on its own. Press play to let seats run; after that the canvas comes back playing at every launch, and a seat starts when mail or work arrives for it. Local terminal processes belong to the app and stop when it quits.

## Overseer

A switch you flip on one seat. That agent may author the canvas and use every node command without edges. It cannot delete its own seat or move your view, and only you can grant or revoke it. See [the security doctrine](security-doctrine.md).

## What Junto changes in your setup

- Junto never writes to `~/.claude`, `~/.codex`, `~/.grok`, `~/.hermes`, or any other harness config.
- A seat runs the same binary you run by hand. Junto passes only the settings you chose on the seat plus its own instructions, through the harness's system-prompt flag or as the first typed message.
- Inside a seat's process, and only there, Junto puts the `junto` CLI first on `PATH` and sets a few `JUNTO_*` variables.
- Delete the app and `~/.junto/` and Junto is gone.

## Further reading

- [Security doctrine](security-doctrine.md): the trust model, one operator with trusted but fallible agents
- [macOS privacy audit](macos-privacy.md)
- [Building from source](building.md)
