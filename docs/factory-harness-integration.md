# Factory harness integration — product vision

**Status:** product vision + grounded research + build sequence. Design settled
2026-07-24. Subordinate to [`security-doctrine.md`](security-doctrine.md) and
[`architecture-factory-physics.md`](architecture-factory-physics.md); serves the
factory work model in the simulation memory (tasks as a pull queue, blocking as
worker-state, on-fire/on-ice).

**One sentence:** a factory worker is an *owned agent session the factory
drives* — and because the factory creates and owns the session, the "how do we
wake a dormant agent" problem never exists on the critical path.

Everything below is grounded in code that already runs. Anchors are given so any
claim is verifiable, not asserted.

---

## 0 · The core realization

The naïve integration is "wrap the Vellum CLI as tools an agent calls." That is
trivial and **does not need Prism or a real integration at all** — the CLI is
already installed. It is also not the product.

The real integration is: **the factory owns its workers' sessions.** When the
tick claims a task for a seat, the factory *spawns* the worker and holds its
session handle. From that one fact, everything follows:

- there is no dormant agent to nudge — the factory holds the turn cadence;
- "wake" is just "the tick runs the next turn";
- autonomy vs manual is not a toggle — it is *who holds the prompt cadence*;
- remote is solved by an existing transport;
- expanding harness support is mostly reusing adapters that already exist.

The naïve tool-wrapper layer still exists, but it is the *thin* layer riding
inside the real one.

---

## 1 · The runtime model — a factory worker is an owned session

A **factory worker** = a coding-harness session the factory created, owns, and
drives turn-by-turn. Two proven drive modes, both already implemented elsewhere:

### Mode A — native ACP (live)

A persistent JSON-RPC session Vellum drives as the client.

- Grounded: `src/main/vellum/chat/acp-client.ts` — client→agent
  `session/new` (create + own the id), `session/load` (resume), `session/prompt`
  (drive a turn), `session/set_model`; agent→client `session/request_permission`
  (**blocked arrives natively — no scraping**) and `session/update` (streaming).
- Best mode: streaming, low per-turn latency, native blocked/permission signal.
- Requires the harness to speak ACP (hermes today; Claude/Gemini/others expose
  ACP modes).

### Mode B — headless capture-resume (spawn-per-turn)

Universal. Works for any harness with a headless run + resumable session.

- Grounded: prism's `src/workflow-{claude,grok,codex,amp,antigravity,devin}-worker.ts`
  + `src/harnesses.ts` registry already drive **six harnesses** this way:
  `claude --print` → capture `session_id` from the stream-json init event →
  resume with `resumeSessionId`; `grok -r <id>`; etc. Each `--print` invocation
  runs **one full agentic turn** and returns. (Prism explicitly refuses
  interactive mode: "Spawning without --print blocks the process indefinitely.")
- Higher per-turn overhead (fresh process, context reload) but requires nothing
  of the harness beyond headless + resume.

**Vellum picks per-harness:** ACP if the harness speaks it, headless-resume
otherwise. Both yield an owned, resumable, promptable session.

### The seat state — the (task, sessionId) pair

On an actor seat, the worker is exactly `(claimedTask?, sessionId?)`:

| state | meaning |
|-------|---------|
| `(none, none)` | **empty** seat — no work, no session |
| `(task, sessionId)` | **live, owned** — factory spawned it, holds the id, fully drivable |
| `(task, none)` | **transitional / error** — claimed but `session/new` (or headless spawn) pending or failed → retry |
| `(none, sessionId)` | **impossible** — no task ⇒ no session; if seen, stale → clear |

The tick's claim is what creates the session, so the id is owned **by
construction** — never "we hope we started it."

---

## 2 · The wake question — resolved by ownership, not by a wake system

The problem that felt fatal: a blocked/finished agent ends its turn and stops
pulling; how do we resume it, especially one we did not start?

**It dissolves for factory workers**, because a factory worker does not own its
own loop — the tick does:

- **Headless:** the process *exits after each turn*. There is nothing dormant.
  A wake-reason fires → the tick runs the next turn:
  `claude --resume <id> --print "<reason>"`.
- **ACP:** the session persists but *Vellum is the client driving
  `session/prompt`*. A wake-reason fires → send the next turn.

"Wake" = "the tick initiates the next turn on a session it already owns." No
nudge channel, no relaunch-detection, no scraping — for factory workers.

### Wake-reasons (what makes the tick run the next turn)

Narrow, and only the things that change whether the worker can proceed:

- a task claimed for this seat,
- a request answered (unblocks the worker),
- input-required resolved (unblocks the worker),
- an a2a message arrived.

(Artifact events are a *soft* nudge at most — artifacts never block — and are not
a wake trigger. Artifact comments remain a floated idea, not built.)

### Autonomy vs manual is not a toggle — it is who holds the cadence

The chat surface (operator prompting an agent) and the factory (tick prompting a
worker) use the **same** `session/prompt`. The difference is only *who is
driving*:

- tick drives → **autonomous** (a seat the factory spawned for a task),
- operator drives → **manual** (a seat the operator is prompting live, e.g. an
  agent chat).

There is one driver at a time, so they never collide. The operator can **take
over** an owned session and hand it back. The "what if I'm mid-thought and it
gets yanked" fear vanishes: the factory only auto-prompts sessions it spawned
that the operator is not currently driving.

### The three cases (answers "what if I open a terminal elsewhere")

1. **Factory-spawned worker** (claim → ACP `session/new` or headless spawn):
   owned, autonomous, tick-driven. The factory path.
2. **Operator-driven Vellum node** (you opened an agent/terminal node, or you
   are chatting live): process-bound seat, observable, but no session spawned
   for a task → *you* drive, manual. No auto-wake.
3. **Raw OS terminal, outside Vellum:** invisible. Not the factory's problem and
   should not be.

The factory owns only what it created; everything else is observed-or-invisible,
never pretended-owned.

### Herdr / interactive terminal is the *wrong tool* for factory workers

Herdr's value is the interactive TUI pane — a human watching an agent. A factory
worker wants an owned headless/ACP session, which means bypassing the
interactive pane entirely. So **Herdr and raw terminals are the manual-assistant
runtime, not factory workers.** Consequence: the hard herdr-wake /
terminal-scrape problem **drops off the factory's critical path** — we do not
have to solve it to ship the autonomous factory.

---

## 3 · Deployment and tiers — no middle layer

From the security-doctrine tier table, refined:

| tier | agent location | identity | capability |
|------|----------------|----------|------------|
| **2** | on the CC or station (local app) | **process-bind** (peer PID) | **full**, including host-local (browser, terminal, PTY) |
| **3** | no local app, configured remote route | **route-token** (operator-configured) | **work plane** (onboard, tasks, request, artifact, msg) — **no host-local** |

**There is no middle layer.** Either the full station app is installed locally
(Tier 2, process-bound, rich) or the client holds a remote route to the CC/
station (Tier 3, route-identified, work-plane only). **Onboarding a station is a
full app install** — nothing in between. Do not build a fake "half-integration."

The precise Tier-3 statement is not "can't do much" — it is *"can run the whole
factory work loop remotely, but cannot touch a host it isn't on."*

### Remote is already solved — ACP over SSH

Grounded: `src/main/vellum/hermes/plane.ts` runs hermes in **ACP mode over an
`SshLease`** (`acpArgs → ["acp"]` / `["-p", profile, "acp"]`;
`src/main/vellum/hermes/transport.ts`; `source: hermes-acp:${profile}`; remote
ACP teardown receipts). Remote factory workers ride this exact pattern.
Headless-resume rides SSH just as trivially: `ssh station "claude --resume <id>
--print '…'"`.

### The two rails

- **`prism refresh --plugin vellum --harness <all>`** compiles the plugin per
  harness via the lowerers (`src/compile/lowerers/{claude-code,grok,kimi,codex,
  amp,antigravity,cursor,devin,omp,pi}.ts`). These lower **`mcpServers`,
  `hooks`, and `permissionMode`** — so the plugin installs tools *and hooks*
  into nine harnesses' native configs. This is why the integration needs Prism:
  CLI-wrappers don't, cross-harness hooks do.
- **The fleet deploy** (`src/main/vellum/hosts/deploy-linux.ts`) ships the app
  as a signed bundle to `/usr/libexec/vellum-release-installer` → systemd unit.
  The CLI binary rides that bundle.

---

## 4 · The integration surface — three layers, not "a pile of hooks"

### Layer 1 — the CLI (the agent protocol)

Already built: `src/cli/main.ts`, JSON, daemon-first. Talks to the running app
over a **Unix socket + token** (`src/cli/core/socket.ts`:
`~/.vellum/work/control.sock` + `~/.vellum/work/token`, `WORK_HOME_ENV`
override), admitted by **peer PID → seat** then `physics.admit`. Commands:
`onboard · tasks · msg · request · artifact · capabilities · doctor · ping ·
schema`. Compiles to `dist/vellum` (`bun run cli:build`).

**Decoupling (design decision):** the plugin **owns its transport** and does not
require a separately-installed CLI binary (unlike the quasar plugin, which shells
to quasar-cli — here the *plugin* is the product). The transport self-selects:
local station app present → local socket (process-bound); no local app → remote
CC/station route (route-token). The standalone `vellum` CLI stays a *separate,
optional* human/script shell surface.

### Layer 2 — the plugin membrane (Prism)

Not "many hooks." Three mechanisms, and only one is a real hook:

1. **Auto-onboard on session start** — the one genuine hook. Fire `onboard` as
   early as the harness allows so the worker boots already oriented: its seat,
   its claimed task, the task's files/skills (tag→context), and the reachable
   map. This is also the anti-compaction mechanism (re-onboard beats remember).
2. **In-band notifications while working** — *no hook needed.* A working agent
   is calling tools, so the **tool result carries the news**: "you hit the
   browser but lost that edge," "your task is now input-required." The CLI
   response is the notification channel while the loop is live. Free.
3. **The wake system** — for factory workers this is just §2 (the tick runs the
   next turn on an owned session). No separate mechanism.

**Pattern to follow:** the quasar plugin (`~/Projects/prism-plugins/quasar`):
`plugin.json` `targets` (rules/skills/tools per harness) + `tools/*.tool.ts`
(typed input/output schema + `handle`) + `rules/` + `skills/`. The vellum plugin
is the same shape, plus its own transport and the boot-onboard hook.

### Layer 3 — context injection (the "onboard handles the data connection")

Herdr injects `HERDR_WORKSPACE_ID/TAB_ID/PANE_ID` into each managed pane's env
(inherited by the process tree). Vellum already injects `VELLUM_BROWSER_*` via
`environmentOverlay` (`src/main/vellum/chat/acp-client.ts`). Extend it: at
spawn, inject `VELLUM_SEAT / VELLUM_TASK / VELLUM_THREAD` so the worker's
`onboard` reads its own context instantly.

**Authority caveat (doctrine):** env is *context, not identity*. A process could
fake env. **Process-bind (peer PID) stays the security identity**; the env only
tells the worker who it is so it can onboard fast. Consistent with "no
client-supplied identity."

---

## 5 · Telemetry / occupancy — how live state is read

Feeds the occupancy plane (the S5 `ActivityFeed` seam, currently null/partial).

- **Factory workers (ACP):** state is native — `session/request_permission` =
  blocked, turn in flight = working, turn ended = idle. No scraping.
- **Factory workers (headless):** state is the turn lifecycle — spawned = working,
  returned = idle/done, result carries input-required/failed. No scraping.
- **Manual assistants (herdr / terminal):** herdr's approach — scrape per-harness
  TOML rules (`~/Playground/herdr/website/agent-detection/*.toml`, versioned) +
  per-harness hook assets (`run_claude_hook`/`run_codex_hook`/… in
  `tests/cli/hooks.rs`) + env-inject. States: `idle/working/blocked/done/unknown`.
  **Learn from, do not fork** (herdr is third-party; now Apache, so reading the
  detection approach is sanctioned).

Occupancy → the on-fire/on-ice visual layer: blocked/attention = fire,
idle/empty = ice, working = calm.

---

## 6 · Research results (grounded inventory)

Everything the design rests on, with anchors — all confirmed present in running
code:

| finding | anchor |
|---|---|
| Vellum CLI: JSON, daemon-first, socket + token, process-bind, onboard/tasks/msg/request/artifact | `src/cli/main.ts`, `src/cli/core/socket.ts` |
| ACP client: session new/load/prompt/set_model + request_permission/update + env overlay | `src/main/vellum/chat/acp-client.ts` |
| ACP over SSH in production (hermes) | `src/main/vellum/hermes/plane.ts`, `hermes/transport.ts` |
| Prism plugin = CLI-wrapping tools + rules + skills, per-harness targets | `~/Projects/prism-plugins/quasar/{plugin.json,tools,rules,skills}` |
| Prism lowerers install mcpServers + **hooks** + permissionMode across 9 harnesses | `~/Projects/prism/src/compile/lowerers/*.ts` |
| Prism drives 6 harnesses headless with capture-resume | `~/Projects/prism/src/{harnesses.ts,workflow-*-worker.ts}` |
| Herdr detection: scrape TOMLs + hook assets + env-inject; states idle/working/blocked/done/unknown | `~/Playground/herdr/{website/agent-detection/*.toml,tests/cli/hooks.rs,SKILL.md}` |
| Fleet deploy: signed bundle → release-installer → systemd | `src/main/vellum/hosts/deploy-linux.ts` |
| Tier model (1–4) | `docs/security-doctrine.md` |

---

## 7 · What's built vs what's to build

**Built (assembly, not invention):**
- the CLI + socket + process-bind protocol,
- the ACP client (create/own/resume/prompt/permission) + env overlay,
- ACP over SSH (hermes),
- the prism plugin pattern + per-harness lowerers (tools + hooks),
- the headless capture-resume adapters for 6 harnesses (prism),
- the fleet deploy rail.

**To build:**
1. the **vellum prism plugin** — thin: tools + boot-onboard hook + owned
   transport (local-socket-or-remote-route). Quasar-shaped.
2. **`onboard` enrichment** — claimed-task context + tag→context injection +
   `VELLUM_SEAT/TASK/THREAD` env.
3. the **factory tick / claiming + turn-driver** — the sim loop that claims
   role-matched tasks, spawns the owned session (ACP or headless), and runs the
   next turn on wake-reasons. *This is the real new work.*
4. **role routing** — operator-authored node work-role + the tick's claim match.
5. **occupancy feed** — wire ACP/headless lifecycle (and, for manual, herdr-style
   detection) into the `ActivityFeed` seam.
6. **Tier-3 route-token transport** — the plugin's remote mode + identity.

---

## 8 · Build sequence

Hard constraint: **not while the app is unusable.** The app-salvage (fire/ice
UI, worker-state blocking, noise cuts) lands first; designing the tick against a
broken surface is wasted. Then:

1. **`onboard` enrichment + env-inject** — the worker can boot oriented (works
   for hand-driven demo before the tick exists).
2. **ACP-first factory worker** — the tick claims → `session/new` → drives turns
   → wakes via `session/prompt`. Prove the whole loop on the clean protocol.
3. **occupancy feed from ACP lifecycle** — the board finally shows real state.
4. **the vellum prism plugin** — package the tools + boot-onboard hook + owned
   transport; `prism refresh` into the harness fleet.
5. **headless-resume workers** — reuse/lift prism's per-harness adapters to add
   the harnesses that don't speak ACP.
6. **Tier-3 remote route** — the remote-client transport + route-token identity.
7. **role routing** at the tick — the pull-queue match.

Terminal/herdr manual-assistant detection is a *later, optional* lap — off the
factory critical path.

---

## 9 · Boundaries (do not drift)

- **No fake middle layer** between full-station-app and remote-route-client.
- **Herdr/terminal are manual assistants**, not factory workers — do not sink
  weeks into terminal-wake for the factory.
- **Env is context, not identity** — process-bind stays the security authority.
- **The factory owns only sessions it spawned** — never pretend to own or wake
  an operator's or an external session.
- **Artifacts never block** — no artifact event is a wake trigger.
- **Do not fork herdr** — learn from its now-Apache detection approach only.
- **Full autonomy needs this whole stack** — the tick, the owned session, the
  onboard injection, the plugin. A CLI wrapper alone is not the factory.
