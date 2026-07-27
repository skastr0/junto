<p align="center">
  <img src="assets/brand/icon-candidates/round4-hero-lozenge/vellum-icon-r4-hero-fullbleed-amber.png" alt="Vellum Command" width="160" height="160" />
</p>

<h1 align="center">Vellum Command</h1>

<p align="center"><strong>Run your agent fleet from one spatial board.</strong></p>

<p align="center">
  Managing agents on macOS is overwhelming — terminals stay opaque, the fleet spreads across panes and hosts, and status lives nowhere you can trust.<br />
  <strong>Vellum Command</strong> puts the whole station on one deep-field canvas.
</p>

<p align="center">
  <a href="https://github.com/skastr0/vellum/releases/latest"><strong>Download for macOS</strong></a>
  ·
  <a href="https://vellumcommand.com">vellumcommand.com</a>
</p>

---

## Table of contents

- [The pain](#the-pain)
- [The station](#the-station)
- [Download](#download)
- [Quick start](#quick-start)
- [Canvas & document](#canvas--document)
- [Node types](#node-types)
- [Edges & criteria](#edges--criteria)
- [Work plane & CLI](#work-plane--cli)
- [Browser automation](#browser-automation)
- [Herdr terminals](#herdr-terminals)
- [Kernel: regions, pulse, watchers, timers](#kernel-regions-pulse-watchers-timers)
- [Station roles & multi-host fleet](#station-roles--multi-host-fleet)
- [Settings & install](#settings--install)
- [Headless tools](#headless-tools)
- [Configuration paths & env](#configuration-paths--env)
- [License](#license)
- [Security](#security)
- [Contributing](#contributing)

---

## The pain

Managing agents is overwhelming.

- **Terminals stay opaque** — signal buried in scrollback; hard to read, harder to operate at scale
- **The fleet scatters** — local and remote agents become an unmanageable pile of panes and hosts
- **Status lives nowhere** — running, blocked, waiting, and done never share one surface

## The station

**Vellum Command** lays your Hermes fleet, Herdr terminals, browser pages, and agent work on one portable spatial canvas — so **you author the board** and the fleet acts through a real work plane.

### Why operators choose it

- **One spatial board for the whole fleet** — agents, work, and regions as geography, not a pile of windows
- **Herdr terminals made legible** — operable on the canvas, not buried in a dock of tabs
- **Hermes multi-agent presence** — who is up, blocked, waiting, or done, live on the board
- **Multi-host / multi-fleet over SSH** — without a second remote tool to babysit
- **A2A work plane** — tasks, requests, input-required, messages, and artifacts with protocol, not chat chaos
- **Vellum CLI** — control surface agents use so work happens without freeform canvas thrash
- **Browser pages as first-class nodes** — same plane as agents and terminals
- **Regions, pulse, and watchers** — operational geography; the document is the product (portable JSON Canvas)

### Is / is not

| Vellum Command **is** | Vellum Command **is not** |
|---|---|
| A deep-field command station for agent fleets on macOS | Another chat app or prompt playground |
| A spatial canvas humans author; agents act through the work plane | A free-for-all where agents rewrite your board |
| A portable JSON Canvas document the app projects | A multi-platform toy chasing every OS |

## Download

**[Download the notarized macOS build →](https://github.com/skastr0/vellum/releases/latest)**

Requirements: **macOS 13+** (arm64 primary). Install **Hermes** and **Herdr** for live fleet and terminal features; browser nodes ship with the station.

Prefer source?

```bash
bun install
bun run app:build
bun run app:install:skip-build
```

## Quick start

1. Download and open **Vellum Command** from the [latest Release](https://github.com/skastr0/vellum/releases/latest).
2. Pick a **station role** (Command Center or Remote) on first run.
3. Author the board — drop agents, herdr panes, pages, tasks, regions.
4. Open an agent or herdr surface; drive work via the **Vellum CLI** or in-app chat.

---

## Canvas & document

Canvases live in the app-owned SQLite database at
`~/.vellum/state/vellum.db`. JSON Canvas is the explicit export and
interoperability format, not a watched source of live state.

Standard **JSON Canvas 1.0** (`text`, `file`, `link`, `group`) plus optional `ether` on nodes and edges.

**Two laws** on every save:

1. **Graceful degradation** — strip every `ether` key and the file is still valid JSON Canvas 1.0 (Obsidian opens it).
2. **Mirror law** — extension semantics project into native fields (blocker → red; derived phase may project to edge label/color).

Derived state (blocked seats, region membership, binding health, live phase) is **never stored** — recomputed from the document + live sources.

**Canonical serialize:** stable key order, 2-space indent, trailing newline.

---

## Node types

### Native JSON Canvas

| Node | What it is | Why it matters |
|---|---|---|
| **Text** | Free note; also the carrier for many ether entity kinds | Notes and typed entities share one geometry |
| **File** | Points at a filesystem path (`file`, optional `subpath`) | Board links to docs without embedding blobs |
| **Link** | URL card; becomes a **page** when browser binding is set | Same geometry for bookmarks vs live browser |
| **Group (region)** | Named geography; optional label/background | Operational regions that hold and pulse children |

### Entity kinds (open vocabulary, richer UI)

| Kind | Base | What it is | Why it matters |
|---|---|---|---|
| **agent** | text | Hermes profile card; key `<host>:<profile>`; ACP chat | Live agent presence, chat, and pulse target |
| **terminal** | text | Native Vellum PTY session (`ether.terminal`) | Default local terminal work surface |
| **herdr** | text | Optional legacy bound PTY pane | Compatibility with existing herdr fleets |
| **page** | link | Bound browser page + profile name | Browser as a first-class fleet surface |
| **task** | text | Address for a normalized SQLite task sink | Protocol tasks, not chat chaos |
| **requests** | text | Address for a normalized input-required shelf | Operator attention queue |
| **artifacts** | text | Address for a normalized artifact shelf | Shareable outputs on the board |
| **watcher** | text | Predicate over live data (`ether.watch`) | Edge-routed pulse when conditions hit |
| **timer** | text | Interval clock (`ether.timer.everyMinutes`) | Periodic edge-routed pulse |
| **project / orbit / plugin / station / skill** | text | Inert open-vocabulary labels | Portfolio geography without invented runtime authority |

### Structural stamps

| Stamp | What |
|---|---|
| **Flags** | `blocker` · `parked` · `attention` — visual + graph seed |
| **View slice** | `ether.view` — orbit / glyphQuery / states filter |
| **Host stamp** | `ether.host` — multi-fleet execution locality |
| **Region defaults** | Create-time defaults for herdr/page inside a region |
| **Region hold / instruction** | Structural container + briefing context; not an automatic delivery route |

Work contents never persist in authorial `ether`; task, request, message,
artifact, and transition rows belong to the SQLite Work plane and are projected
only for runtime rendering. Blockability derives from factory role. Only actor
nodes can receive stoppage.

### Native terminals

Native `terminal` nodes are the default terminal path. Vellum owns their local
processes through the app-scoped TermPlane and presents them with xterm. Quitting
Vellum kills every local native terminal session; detached local sessions do not
survive quit. Put durable work on a **Remote** station instead. Herdr remains
available as **Herdr (legacy)** for existing panes and is optional for a healthy
local station; quitting Vellum detaches its surfaces rather than deleting herdr.

---

## Edges & criteria

| Mode | Behavior |
|---|---|
| **No criteria** | Soft **relates** — never generates stoppage |
| **`tasks`** | Attention only: `input-required` / `auth-required` on the source task or requests sink blocks its connected actor. `submitted` / `working` never block |
| **`proof`** | Blocks the connected actor until the matching runtime proof stamp exists |
| **`approval`** | Blocks the connected actor until the matching human grant exists |

Live phase is **derived** (`blocks` \| `relates`). Optional `ether.kind` is only
an offline mirror — never author phase by hand. There is no actor-to-actor
relay or multi-hop stoppage cascade.

---

## Work plane & CLI

While Vellum Command is running, agents talk to the **local** work control socket:

| | |
|---|---|
| Socket | `~/.vellum/work/control.sock` |
| Token | `~/.vellum/work/token` |
| Protocol | `vellum-work/v1` (NDJSON) |
| Authz | **Edges** — an agent only acts on connected nodes |

### Vellum CLI

```bash
vellum ping              # is the station up?
vellum doctor            # socket / token / protocol health
vellum capabilities      # live edge contract for this principal
vellum onboard           # join the work plane
vellum schema            # machine contracts
vellum examples          # discoverability
vellum tasks list|claim|update
vellum msg list|send
vellum request create
vellum artifact publish
```

Build the CLI: `bun run cli:build` → `dist/vellum`.

**Process-bind:** the principal is the live ACP/herdr child PID — no freeform nodeRef identity claim. Draw edges from the agent to targets so authorization is spatial and honest.

**Task states:** `submitted` · `working` · `input-required` · `completed` · `canceled` · `failed` · `rejected` · `auth-required` — legal transitions enforced.

---

## Browser automation

Browser **page** nodes bind a URL to a profile. Cookies live in Electron partitions (`persist:vellum-profile-{id}`) under app userData and **survive quit**.

### Safety model (operator)

| Layer | Behavior |
|---|---|
| **You browsing** | Log in, navigate, use pages — cookies persist; quit does not wipe |
| **Agent automation** | Requires process-bind + **human Allow Access** + short-lived capability scoped to edges/origins |
| **Remote pages** | Sandboxed WebContents; no Node; permissions/downloads/devices denied; public http(s) only |
| **Profile wipe** | Explicit Settings action with typed confirmation — the only path that clears logins |

**Do not** grant browser automation on a profile that holds accounts you treat as primary vault material. Without that grant, the browser is a normal Chromium profile for testing and secondary accounts.

### Browser CLI (`vellum-browser`)

```bash
vellum-browser doctor
vellum-browser profiles
vellum-browser pages | sessions
vellum-browser open <vellum-ref>
vellum-browser goto | eval | shot | close | stop
```

App must be running. Control home: `~/.vellum/browser/` (override `VELLUM_BROWSER_HOME`). Packaged binary ships as `Contents/Resources/bin/vellum-browser`.

### Profiles

- Default seeds today: `personal` and `work` (generic cookie partitions — not hard-coded dual engines)
- Settings: max warm sessions / visible surfaces
- Wipe: Settings → type profile id to confirm; last profile cannot be wiped

---

## Herdr terminals

| | |
|---|---|
| **What** | Canvas cards bound to Herdr PTY panes (local or remote) |
| **Why** | Terminals become geography — legible status, multi-host, multi-pane |
| **Bind** | Herdr wizard: host → session → workspace → tab → pane |
| **Delete** | Default **detach** (panes survive); optional kill-pane |
| **Quit** | Detaches control streams only — fleet keeps running |
| **Hosts** | Settings → Hosts; registry rows live in `vellum.db`; local is seeded with herdr+hermes |

Connection states: connected · degraded · lost · failed · reconnect. Clipboard image paste supported (bounded).

---

## Kernel: regions, pulse, watchers, timers

| Piece | What it does |
|---|---|
| **Region** | Group node + `ether.region` — operational geography |
| **Membership** | Center-in-rect geometry (flat; no nested groups) — derived, never stored |
| **Watcher** | Predicate → pulse (`glyphs_done` · `glyphs_entered_state` · `stat_threshold`) |
| **Timer** | `everyMinutes` pulse |
| **Arming** | Per canvas::region switch in app-owned SQLite runtime state — **not in the document** |
| **Pulse** | Watcher/timer → edge-connected eligible agents; manual region pulse may target eligible members |
| **Host-scoped fire** | Remote stations only fire nodes on their hostId |

Settings → Kernel: pulse log retention, verbose debug. Arming faults and orphan armed keys surface in station chrome.

---

## Station roles & multi-host fleet

| Role | Meaning |
|---|---|
| **Command Center** | Human authors the canvas; manages the fleet registry |
| **Remote** | Capability host; applies complete projections; host-scoped execution only |

Role is **never inferred** — you pick it. `hostId` identifies this machine (default `local`).

| Config | Contract |
|---|---|
| Host registry | App-owned rows in `vellum.db` (max 32) |
| Local host | Auto-seeded with herdr + hermes |
| Remote host | SSH endpoint + capabilities; optional hermesId remap |
| Fleet sync | `pair` / `configure` / `project` / `report` / `status` through fixed `vellum-station` |
| Tailscale | Optional serve/peer catalog in Settings → Hosts |

Advanced local, multi-host, and offline-island proof:
[`docs/remote-station-checklist.md`](docs/remote-station-checklist.md).

---

## Settings & install

Preferences, station topology, and host enrollment live as normalized rows in
`~/.vellum/state/vellum.db`. The app is their only mutation path.

| Install | Command |
|---|---|
| Build + install | `bun run app:install` |
| Supervised (LaunchAgent, crash-only KeepAlive) | `bun run app:install:supervised` |
| Unload agent, keep app | `bun run app:uninstall-agent` |

App bundle: **Vellum Command.app** · protocol: `vellum://` node references.

---

## Headless tools

| Command | Who | What |
|---|---|---|
| `bun run digest [name]` | agents + operators | Text projection + live snapshots |
| `bun run render [name]` | agents + operators | SVG deep-field image of the board |
| `bun run canvas:ls` | agents + operators | List canvases (`--json`) |
| `bun run canvas:rm` | **operator only** | Delete canvases (`VELLUM_AUTHORIAL_WRITE=1`) |
| `bun run ref` | tooling | `vellum://` node-ref CLI |
| `bun run browser` | agents | Browser control CLI (app must be running) |
| `bun run cli` / `cli:build` | agents | Work-plane CLI |

---

## Work plane & CLI

```bash
vellum ping
vellum doctor
vellum capabilities
vellum onboard
vellum schema | examples
vellum tasks list|claim|update
vellum msg list|send
vellum request create
vellum artifact publish
```

| | |
|---|---|
| Socket | `~/.vellum/work/control.sock` |
| Token | `~/.vellum/work/token` |
| Authz | **Edges** — agent only acts on connected nodes |
| Identity | Process-bind (live ACP/herdr PID), not freeform node claims |

Build: `bun run cli:build` → `dist/vellum`.

---

## Browser automation

Page nodes bind a URL to a profile. Cookies live in `persist:vellum-profile-{id}` and **survive quit**.

| Layer | Behavior |
|---|---|
| **You browsing** | Normal Chromium profile; quit does not wipe |
| **Agent automation** | Process-bind + human **Allow Access** + short-lived capability scoped by edges/origins |
| **Remote pages** | Sandboxed; no Node; permissions/downloads/devices denied; public http(s) only |
| **Wipe** | Settings → typed confirm; last profile cannot be wiped |

Without granting automation, the browser is safe for testing and secondary accounts. **Do not** grant automation on profiles that hold primary credentials.

```bash
vellum-browser doctor | profiles | pages | sessions
vellum-browser open <vellum-ref>
vellum-browser goto | eval | shot | close | stop
```

---

## Herdr terminals

Canvas cards bind to Herdr PTY panes (local or remote). Wizard bind: host →
session → workspace → tab → pane. Default delete = **detach** (panes survive).
Quit detaches control streams only. Hosts are enrolled through Settings.

---

## Kernel: regions, pulse, watchers, timers

| Piece | Role |
|---|---|
| **Region** | Group + operational geography |
| **Membership** | Center-in-rect geometry (flat) — derived |
| **Watcher** | `glyphs_done` · `glyphs_entered_state` · `stat_threshold` → pulse |
| **Timer** | `everyMinutes` pulse |
| **Arming** | Per region switch in the app — **not stored in the document** |
| **Pulse** | Watcher/timer → edge-connected eligible agents; manual region pulse may target eligible members |
| **Host-scoped fire** | Remotes only fire nodes on their hostId |

---

## Station roles & multi-host fleet

| Role | Meaning |
|---|---|
| **Command Center** | Human authors the canvas; manages fleet registry |
| **Remote** | Capability host; applies complete projections; host-scoped execution |

Role is never inferred. The SQLite host registry seeds local and enrolls
Remotes by SSH endpoint. Optional Tailscale serve catalog lives in Settings →
Hosts.

---

## Settings & install

`~/.vellum/state/vellum.db` owns preferences, station topology, host
enrollment, canvases, work, and Station coordination.

| Install | Command |
|---|---|
| Build + install | `bun run app:install` |
| Supervised LaunchAgent | `bun run app:install:supervised` |
| Unload agent | `bun run app:uninstall-agent` |

Bundle: **Vellum Command.app** · scheme: `vellum://`

---

## Headless tools

| Command | Who | What |
|---|---|---|
| `bun run digest [name]` | agents + operators | Text projection + live snapshots |
| `bun run render [name]` | agents + operators | SVG deep-field image |
| `bun run canvas:ls` | agents + operators | List canvases |
| `bun run canvas:rm` | operator only | Delete (`VELLUM_AUTHORIAL_WRITE=1`) |
| `bun run ref` | tooling | `vellum://` node-ref CLI |
| `bun run browser` | agents | Browser control (app running) |
| `bun run cli` / `cli:build` | agents | Work-plane CLI |

---

## Work plane & CLI

```bash
vellum ping | doctor | capabilities | onboard
vellum schema | examples
vellum tasks list|claim|update
vellum msg list|send
vellum request create
vellum artifact publish
```

| | |
|---|---|
| Socket | `~/.vellum/work/control.sock` |
| Token | `~/.vellum/work/token` |
| Authz | Edges — act only on connected nodes |
| Identity | Process-bind (live ACP/herdr PID) |

---

## Browser automation

Page nodes bind URL + profile. Cookies in `persist:vellum-profile-{id}` **survive quit**.

| Layer | Behavior |
|---|---|
| You browsing | Normal Chromium profile |
| Agent automation | Process-bind + human **Allow Access** + edge-scoped capability |
| Remote pages | Sandboxed; no Node; permissions denied; public http(s) only |
| Wipe | Settings → typed confirm |

Without granting automation, use the browser freely for secondary accounts and testing.

```bash
vellum-browser doctor | profiles | pages | sessions
vellum-browser open <vellum-ref>
vellum-browser goto | eval | shot | close | stop
```

---

## Herdr terminals

Canvas cards bind to Herdr PTY panes (local or remote). Wizard: host → session
→ workspace → tab → pane. Default delete = **detach**. Quit detaches streams
only. Hosts are enrolled through Settings.

---

## Kernel: regions, pulse, watchers, timers

| Piece | Role |
|---|---|
| **Region** | Operational geography |
| **Membership** | Center-in-rect (flat) — derived |
| **Watcher** | `glyphs_done` · `glyphs_entered_state` · `stat_threshold` → pulse |
| **Timer** | `everyMinutes` pulse |
| **Arming** | App-owned SQLite runtime-state switch — **not in the document** |
| **Pulse** | Edge-routed watcher/timer delivery; manual region pulse may target eligible members |
| **Host-scoped fire** | Remotes fire only their hostId |

---

## Station roles & multi-host fleet

| Role | Meaning |
|---|---|
| **Command Center** | Human authors canvas; manages fleet |
| **Remote** | Capability host; applies complete projections; host-scoped execution |

Role is never inferred. Hosts are app-owned SQLite rows. Optional Tailscale
serve catalog lives in Settings.

---

## Configuration paths & env

| Path / env | What |
|---|---|
| `~/.vellum/state/vellum.db` | Sole durable product state |
| `~/.vellum/canvases/` | Digest and SVG sidecar outputs only |
| `~/.vellum/work/` | Work control sock + token |
| `~/.vellum/browser/` | Browser control + profiles + shots |
| `VELLUM_WORK_HOME` | Override work control dir |
| `VELLUM_BROWSER_HOME` | Override browser control home |
| `VELLUM_AUTHORIAL_WRITE` | Allow `canvas:rm` |
| `VELLUM_DEMO` | Demo mode; by default SQLite and sidecars live in a process-owned OS-temporary directory removed on shutdown |

---

## Node types (index)

| Kind | Role |
|---|---|
| **text / note** | Free note or entity carrier |
| **file** | Filesystem path card |
| **link / page** | URL; page = live browser binding |
| **group / region** | Operational geography + pulse |
| **agent** | Hermes profile + ACP chat |
| **terminal** | Native PTY session; local sessions end on app quit |
| **herdr** | Optional legacy bound PTY pane |
| **task / requests / artifacts** | A2A work stores |
| **watcher / timer** | Kernel pulse sources |

See [Node types](#node-types) detail in prior sections of this README (native types, entity kinds, flags, host stamps, region defaults).

### Node types (detail)

#### Native JSON Canvas

| Node | Role |
|---|---|
| **Text** | Free note; carrier for entity kinds |
| **File** | Filesystem path (`file`, optional `subpath`) |
| **Link** | URL card; becomes **page** with browser binding |
| **Group** | Region geography |

#### Entity kinds

| Kind | Role |
|---|---|
| **agent** | Hermes `<host>:<profile>` + ACP chat + pulse target |
| **terminal** | Native PTY binding; default terminal surface; onDelete detach \| kill |
| **herdr** | Legacy PTY pane binding; onDelete detach \| kill-pane |
| **page** | Browser page + profile; cookies persist |
| **task** | A2A task list |
| **requests** | Input-required shelf |
| **artifacts** | Published artifact shelf |
| **watcher** | `glyphs_done` · `glyphs_entered_state` · `stat_threshold` |
| **timer** | `everyMinutes` pulse |
| **project / orbit / plugin / station / skill** | Document vocabulary labels |

#### Edges

| Mode | Behavior |
|---|---|
| none | Soft relates |
| `tasks` | Attention-only stoppage on a connected actor |
| `proof` | Blocks until the matching runtime proof stamp |
| `approval` | Blocks until the matching human grant |

---

## Configuration paths & env

| Path / env | What |
|---|---|
| `~/.vellum/state/vellum.db` | Sole durable product state |
| `~/.vellum/canvases/` | Digest and SVG sidecar outputs only |
| `~/.vellum/work/` | Work control sock + token |
| `~/.vellum/browser/` | Browser control + profiles + shots |
| `VELLUM_WORK_HOME` | Override work control dir |
| `VELLUM_BROWSER_HOME` | Override browser control home |
| `VELLUM_AUTHORIAL_WRITE` | Allow `canvas:rm` |

---

## Work plane & CLI

```bash
vellum ping | doctor | capabilities | onboard
vellum schema | examples
vellum tasks list|claim|update
vellum msg list|send
vellum request create
vellum artifact publish
```

Socket `~/.vellum/work/control.sock` · token `~/.vellum/work/token` · authz by **edges** · identity by process-bind.

---

## Browser automation

Page nodes + profiles. Cookies in `persist:vellum-profile-{id}` **survive quit**. Agent automation requires process-bind + human **Allow Access** + edge-scoped capability. Remote pages: sandboxed, public http(s) only. Wipe only via Settings with typed confirm.

Without granting automation, use the browser freely for secondary accounts and testing.

```bash
vellum-browser doctor | profiles | pages | sessions
vellum-browser open <vellum-ref>
vellum-browser goto | eval | shot | close | stop
```

---

## Herdr · Kernel · Stations · Hosts

- **Herdr** — canvas cards bound to PTY panes; wizard bind; detach-on-quit; multi-host registry
- **Kernel** — regions, watchers, timers, arming (app-local, not in document), host-scoped pulse
- **Stations** — Command Center vs Remote (never inferred); complete Station API projections
- **Hosts** — app-owned SQLite registry; optional Tailscale serve catalog

---

## Configuration paths & env

| Path / env | What |
|---|---|
| `~/.vellum/state/vellum.db` | Sole durable product state |
| `~/.vellum/canvases/` | Digest and SVG sidecar outputs only |
| `~/.vellum/work/` | Work control sock + token |
| `~/.vellum/browser/` | Browser control + profiles + shots |
| `VELLUM_WORK_HOME` | Override work control dir |
| `VELLUM_BROWSER_HOME` | Override browser control home |
| `VELLUM_AUTHORIAL_WRITE` | Allow `canvas:rm` |

---

## License

Proprietary — © 2026 Guilherme Castro, all rights reserved. See [`LICENSE`](LICENSE).

## Security

Vellum's governing product trust model is documented in
[`docs/security-doctrine.md`](docs/security-doctrine.md). Report security issues
privately. See [`SECURITY.md`](SECURITY.md).

## Contributing

Issues welcome with enough context to reproduce. See [`CONTRIBUTING.md`](CONTRIBUTING.md).
