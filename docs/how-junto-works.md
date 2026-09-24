# How Junto works

## The canvas

A canvas is a [JSON Canvas](https://jsoncanvas.org) document. Nodes are agents, terminals, notes, labels, git cards, and regions. Edges are relationships. You author it in the app; agents do not write it unless you make one an overseer.

## Seats

An agent node bound to a harness gets a managed terminal: a PTY running that harness's own binary in the folder you chose. Junto pins or captures the harness's session id and stores it, so the seat resumes that session, never "whatever ran last".

Each harness has a template in `src/shared/managed-terminal-templates.ts` that records how it launches, how its session is named and resumed, and which settings it exposes (model, effort, permission mode). Fidelity varies by harness and version. Inside a seat, `junto capabilities` lists every harness Junto knows and whether it is installed on your machine.

Supported: Claude Code, Codex, Grok, Pi, Devin, Cursor Agent, Antigravity, fx, Prime Agent, Hermes, Kimi Code, Muse, Amp, and Oh My Pi.

## Lines and access

An edge compiles into grants. A `messages` edge between two agents gives each one mail, prompt, wait, and read access to the other (`msg.send`, `msg.list`, `msg.prompt`, `seat.wait`, `seat.read`). No edge, no grant: the CLI refuses with a `ScopeError` that names the missing edge.

## The CLI

The `junto` CLI talks to the app over a local socket, `~/.junto/work/control.sock` (mode 600). Identity comes from the process: the app reads the caller's PID from the socket and admits it only if it descends from a seat the app started. There is no token to paste.

| command | what it does |
| --- | --- |
| `junto capabilities` | this seat's lines, grants, and the harnesses on this machine |
| `junto onboard` | seat orientation: node, edges, co-members |
| `junto msg send '{"target":"<seat>","text":"…"}'` | durable mail to a connected seat |
| `junto msg list` | read this seat's inbox (marks listed mail read) |
| `junto msg read <id>` | read one message and mark it read |
| `junto msg reply` / `junto msg react` | answer or acknowledge a message |
| `junto seat wait <seat> --until idle` | wait for a connected seat to reach a state |
| `junto seat read <seat>` | read a connected seat's terminal |
| `junto doctor` | socket, token, and protocol checks |

Every command prints JSON. `junto schema` and `junto examples` describe the inputs.

In 0.3.2, `junto msg send`, `junto seat wait`, and `junto seat read` stop with "Missing required flag" unless you pass `--no-prompt`, `--no-any`, or `--no-follow`. The next release makes those flags optional.

## Mail

`junto msg send` stores the message. The receiving seat gets one short typed line in its terminal naming the sender and the command that reads it (`junto msg read <id>`, or `junto msg list` when several are waiting). The agent reads the mail when it reaches a turn boundary. Nothing is injected mid-thought, and mail stays until it is read. The notice line is typed into the harness's terminal; how reliably each harness accepts it varies.

## State

Everything Junto owns lives in `~/.junto/`. Product state is one SQLite file, `~/.junto/state/junto.db`, opened only by the app. JSON Canvas exports are outputs, never inputs the app watches.

## Play and pause

Every launch comes back paused, and a paused canvas starts nothing on its own. Press play to let seats run. Local terminal processes belong to the app and stop when it quits.

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
