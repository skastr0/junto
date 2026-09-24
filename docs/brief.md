# Junto — brief

updated: 2026-09-24, version: 0.3.3 (0.3.2 on the download feed), maturity: usable-with-gaps

Maturity: the signed 0.3.2 build downloads and its core (seats, mail over lines, paused launch) passes its GUI specs; Linux is alpha and most of the source ships switched off.

## One line

Junto puts coding agents on one canvas and lets them talk.

## The pain

You have Claude Code in one terminal and Codex in another, plus three more agents in a tmux tab. Codex prints a report, and you copy it into the pane of the agent that needs it (`codex:c37535531aa92e909d2f0b01e68a5966` seq 3419). Past a handful of panes you lose track of who is stuck, who is done, and who is waiting on you. When you come back to a long task you have "forgotten what it was about" (`claude:7b3b83ad803cb42ae573ff2ff2c3e02c` seq 5), and a restart takes the sessions with it ("the computer shut down and I lost it", `prime:4a5ecb8548fcc87a36605ba3f4e345f0` seq 4).

## What changes

| before | with Junto |
| --- | --- |
| you copy one agent's output into another's terminal | agents mail each other: `junto msg send`, then `junto msg list` |
| any agent can be told to reach any other | only seats joined by a line you drew can talk; no line, no channel |
| a session ends with its tab | a seat keeps its harness, folder, and session, and resumes it after a restart |
| tabs | one canvas showing every seat as idle, working, or waiting for input |

## Where it fits

Junto is the shared workspace where agents work together. Each seat runs the harness you already use, with the tools that harness already has.

## See it run

Run on 2026-09-24, macOS, checkout `c9d4d5cac`.

**Two seats joined by a line mail each other; a seat with no line is refused.** Real `junto` CLI (source build) run from inside seats the app started, driven by the e2e crew fixture with a scripted harness:

```text
builder$ junto msg send '{"target":"reviewer","text":"auth refactor is up, please review src/auth"}'
{"ok":true,"command":"msg send","data":{"outcome":"succeeded","total":1,"success_count":1, …"messageId":"01M395YAEGXJ0JVC210CDH50CD", …}}
reviewer$ junto msg list
{"ok":true,"command":"msg list","data":{"target":"reviewer","items":[{"messageId":"01M395YAEGXJ0JVC210CDH50CD", …"text":"auth refactor is up, please review src/auth"}], …"senderName":"builder", …}}
docs$ junto msg send '{"target":"builder","text":"can I see your diff?"}'
{"ok":true,"command":"msg send","data":{"outcome":"failed", …"error":{"type":"ScopeError","message":"target \"builder\" is not visible from \"docs\" — no edge and not region co-members", …}}}
```

**An agent you did not start from the canvas cannot reach the others.** There is no token to paste; the app checks which process is calling.

```text
$ dist/junto capabilities
{"ok":false,"command":"capabilities","error":{"type":"AuthError","message":"connecting process is not a registered agent process — open the agent in Junto first", …}}
```

**Mail arrives, and erasing the line closes it.** GUI specs drive the built app with two seats and a scripted terminal harness.

```text
$ scripts/run-e2e.sh e2e/scenarios/crew-mail.spec.ts e2e/scenarios/launch-paused.spec.ts --reporter=line
[1/6] crew-mail.spec.ts:79  › sent mail projects notified delivery with one PTY paste
[2/6] launch-paused.spec.ts:46 › a canvas left playing comes back paused at launch
[3/6] crew-mail.spec.ts:181 › unacknowledged paste is unresolved and never re-pasted
[4/6] crew-mail.spec.ts:274 › read and reply state stay truthful across the pair
[5/6] crew-mail.spec.ts:356 › masking msg.send off the edge refuses the send
[6/6] crew-mail.spec.ts:398 › removing the edge mid-flight closes further sends
  6 passed (1.1m)
```

**The app you download is signed and notarized.**

```text
$ spctl -a -vv /Applications/Junto.app
/Applications/Junto.app: accepted
source=Notarized Developer ID
```

## How it works

Each seat is an agent node on a JSON Canvas document, running its harness in a managed PTY in the folder you chose. The harness templates in `src/shared/managed-terminal-templates.ts` (14, from Claude Code at :767 to Oh My Pi at :1719) record how each one launches and resumes its session. A `messages` line compiles into mail grants for the two seats (`MSG_OPS`, `src/main/junto/work/authz.ts:374-401`). The `junto` CLI calls the app over `~/.junto/work/control.sock`, and the app admits it only if the caller's process descends from a seat it started (`src/main/junto/process-identity.ts:12-13`). The receiving seat gets one typed line in its terminal naming the sender and `junto msg read <id>` (one message) or `junto msg list` (several) (`src/shared/message-delivery.ts:170-209`), and reads the mail when it is ready. Everything lives in `~/.junto/state/junto.db`; Junto writes nothing to `~/.claude`, `~/.codex`, or other harness config (`docs/how-junto-works.md`, "What Junto changes in your setup").

Diagram spec:

- nodes: `seat A (claude, ~/app)`, `seat B (codex, ~/app)`, `messages line`, `junto CLI`, `control.sock`, `Junto.app`, `junto.db`, `seat B terminal`
- edges: `seat A — messages line — seat B`; `seat A → junto CLI` (`junto msg send`); `junto CLI → control.sock → Junto.app` (caller checked against its seats); `Junto.app → junto.db` (mail stored); `Junto.app → seat B terminal` (one notice line); `seat B → junto CLI` (`junto msg list`)

## Who it is for / not for

For:
- one person running several coding-agent CLIs at once who is tired of relaying between them
- people who want agents to reach each other only through lines they drew, locally, with no account

Not for:
- teams sharing one canvas: it is built for one operator (`docs/security-doctrine.md`)
- Windows or Intel Macs
- task queues, boards, reviews, or schedulers: they are in the source but off in official builds
- installing agents: bring your own harness, installed and logged in

## Install

macOS 13+, Apple silicon: download from https://juntoagents.com/download (serves `Junto-0.3.2-arm64-mac.dmg`; HTTP 206 on 2026-09-24), drag to Applications, open, add a seat.

From source (Bun 1.3.13, Node 24.10+):

```sh
git clone https://github.com/skastr0/junto.git && cd junto
bun install --frozen-lockfile
bun run dev
```

Linux desktop: alpha, Ubuntu 24.04 x86-64 from source; the download page says the archive "is being prepared". No Windows.

## Proof

| fact | receipt |
| --- | --- |
| notarized Developer ID build | `spctl` output above |
| mail, reply, and line-removal refusal pass in the built app | 6/6 specs above |
| 5,308 of 5,331 unit tests pass in the shared lane (22 skipped) | `bun scripts/run-unit-tests.ts`, 2026-09-24 |
| 14 harness templates | `src/shared/managed-terminal-templates.ts` |
| 3,819 commits since 2026-07-12, one author | `git log --oneline \| wc -l` |
| Apache-2.0 | `LICENSE` |
| crews of up to nine agents | "There's nine total agents", `codex:c37535531aa92e909d2f0b01e68a5966` seq 7371, 2026-09-15 |

## Gaps

- Mail to a seat that is not running fails its spec twice today: `mail-wakes-cold-seat.spec.ts:118` → `Error: cold wake never receipted.` (`:225`). Mail to a running seat passes.
- Unit suite: 1 test fails in `tests/awareness-window-calibration.test.ts` (seat awareness, off in official builds), a different case on each of two runs; the runner stops there, so the isolated lane did not run.
- Timing: the first e2e run today had 4 of 7 specs time out (`Timeout 150000ms exceeded`); the three besides the cold-seat spec passed on an immediate rerun.
- In 0.3.2, `junto msg send '<json>'` stops at `Missing required flag: --prompt` (same for `seat wait --any`, `seat read --follow`); `--no-prompt` works. Effect CLI booleans are required unless defaulted. Fixed in source (`9bc3fd393`), not yet released.
- `junto --version` prints `v0.1.0` in 0.3.2 and 0.3.3 (`src/cli/core/constants.ts:4` fallback). Fixed in source (`d5e1ed032`), not yet released.
- `bun run digest` with no argument fails: `canvas "portfolio" is not in the active portfolio` (`scripts/digest.ts:23`).
- 0.3.3 is signed but not on the update feed; git tags stop at `v0.3.0` and the only GitHub release is 0.1.0, marked pre-release.
- Off in official builds: tasks, boards, pads, sheets, browser, requests, artifacts, schedulers, Fleet, Remote, seat awareness (`src/shared/feature-catalog.ts`). The GitHub About text still mentions "browser pages, and shared work".
- The mail notice is typed into the harness's terminal on a best-effort basis per harness (`src/shared/managed-terminal-injection.ts:382`); the specs above use a scripted harness, not a live Claude or Codex.

## Demo moments

1. **Two seats talk** (20s clip): draw a line between a Claude Code seat and a Codex seat; Claude sends mail; the notice appears in Codex's terminal; Codex reads and replies. Shows the agents talking without you in between.
2. **Erase the line** (10s): delete the line; the next send is refused. Shows that access is the line you drew.
3. **Quit and reopen** (15s): quit with seats running and reopen; the canvas comes back paused, and a seat resumes its same session. Shows that seats survive a restart.

## Copy bank

- tagline: Your agents, one canvas, talking.
- short description: A desktop canvas where every coding agent gets a permanent seat, and agents you connect with a line mail each other. Free, open source, macOS.
- page lede: Junto gives every coding agent you run a permanent seat on one canvas, with its own folder and a session that survives restarts. Draw a line between two seats and those agents mail each other, so you stop copying reports from one terminal to the next.
- X post: I kept pasting one agent's report into another agent's terminal. So I built Junto: every agent gets a seat on a canvas, and when I draw a line between two seats, they mail each other. No line, no channel.
