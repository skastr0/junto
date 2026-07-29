# AGENTS.md — vellum

vellum is a desktop station (Electron + Effect + React) that renders a **portfolio canvas**: agents, work surfaces, notes, and regions as spatial nodes; dependencies/blockers/relationships as edges; named regions as geography. The current canvas serialization is a [JSON Canvas 1.0](https://jsoncanvas.org) document extended with a namespaced `ether` key.

## Security doctrine — read first

[`docs/security-doctrine.md`](docs/security-doctrine.md) is the governing
product trust model. It defines Vellum as a single-operator factory, attached
agents as trusted but fallible, edges as enforceable operator intent inside
Vellum, and Stations as single-home executors of Command Center intent. If a
review, backlog item, test, or older architecture note conflicts with it, the
conflict is migration work. Compatibility exists only at the two proven
external boundaries: installed SQLite state and independently updated Station
wire peers. It must not preserve an obsolete internal domain or file store.

[`docs/vellum-protocol.md`](docs/vellum-protocol.md) is the canonical
multi-installation contract: identity, complete intent projection, sink/item
authority, synchronous CC-home task claims, offline Remote execution, logical
event convergence, the five Station verbs, and transport adapters.

**Normative direction:** the protected document is the product; compiled
projections and capability-bound tools are the agent API. **Sole durable store**
is `~/.vellum/state/vellum.db`. The Electron main process owns its one
`StateEngine` connection; renderers, CLIs, helpers, and remote callers use
IPC/control APIs and never open the database. Every app version has one
role-independent schema; independently updated installations may temporarily
run different recognized versions. Command Center holds authorial canvases and
fleet coordination; a Remote holds its replace-only projection and
installation-homed work. Both event and entity homes are `InstallationId`
values; `HostId` is placement, not durable work authority. Single-home rows and
route-local
`(event_home, entity_home, seq)` Work identities make station clocks irrelevant
to correctness.
JSON Canvas exports and agent sidecars (`*.digest.txt`, `*.svg`) are outputs,
not durability or input watched by the app.

The only product exception to normal-runtime database ownership is the exact
signed packaged candidate running `--vellum-state-preflight` after the
installer has fully quiesced the incumbent. That process may open the fixed
canonical path read-only long enough to mint a verified retained backup; it
migrates and decodes only a disposable clone, starts no product runtime plane,
and accepts no database-path redirect. It is an update proof, not a second
store or general helper access path.

**SQLite evolution law:** version 1 is the frozen durable baseline; version 3
is current through immutable `1 → 2` and `2 → 3` steps.
`PRAGMA user_version` selects a contiguous forward-only migration chain, and
`state_schema_identity` proves the exact shape expected at each step. Every
schema edit must increment the current version, append an atomic `N → N+1`
migration, and prove old rows survive. Shipped migration history is immutable:
never edit, delete, reorder, or renumber a released step.

Routine migrations are **expand → preserve → deprecate**:

- add new tables, columns, indexes, triggers, or representations beside the
  old shape;
- copy forward without deleting rows, overwriting old column values, renaming,
  dropping, tightening, or reusing an existing durable name or meaning;
- stop using the old representation only after the new one is verified, while
  retaining the old bytes in the schema.

Physical retirement is not a startup migration. It requires a separate
reviewed compaction, a verified coherent backup, replacement-parity proof,
fleet compatibility evidence, and explicit operator approval. Never ask an
installed system to delete `vellum.db`; never add a downgrade, old-schema
runtime reader, dual write, or file-store compatibility path.

**Station skew law:** app release, local SQLite schema, and Station protocol
are distinct facts. Only the one Station protocol integer selects wire
behavior. Each release advertises
`{ preferred, compatibleFrom, warnBelow }`; peers choose the highest common
exact codec and warn when the result is below either threshold. Current policy
is protocol 2 with `2/2/2`. No overlap means explicit `update required` while
the Remote continues locally under its last projection; it never means partial
down-conversion. Do not add separate session/API/Work/projection version
negotiation or capability arrays. A codec retires only after every enrolled
Station using it is upgraded or explicitly retired and its pending records are
reconciled.

## The agent surface (headless — no GUI needed)

**Agents never write the canvas.** The canvas is human-authored (Command Center). Agents consume compiled projections and local Vellum tools.

Headless CLIs reach `CanvasesService` through the running app's owner-local
canvas control socket. They do not open `vellum.db`. Agents remain strictly
read-only for authorial intent. Current headless CLIs:

| command | who | what it does |
|---|---|---|
| `bun run digest [name]` | agents + operators | print (and write `<name>.digest.txt`) a deterministic text projection of the board + live hermes snapshot data. |
| `bun run render [name]` | agents + operators | write `<name>.svg` — a deep-field image of the board, for multimodal reading. |
| `bun run canvas:ls [--json]` | agents + operators | list canvases with node/edge counts. |

To **read the board as an agent**: `bun run digest` (text) or `bun run render` then view the SVG (image).

### Work plane (agent mutations)

While Vellum is running, agents talk to the **local** work control socket, not
to an exported document or the database:

| surface | detail |
|---|---|
| CLI | `dist/vellum` (`bun run cli:build`) — `ping`, `doctor`, `capabilities`, `onboard`, `tasks`, `msg`, `request`, `artifact` |
| Socket | `~/.vellum/work/control.sock` + bearer token `~/.vellum/work/token` |
| Identity | **process-bind** — CLI must run as a descendant of a live Vellum agent (ACP) or herdr pane process. Main registers those PIDs; control admits via Unix peer PID (+ PPID walk). No client-supplied nodeRef / `VELLUM_NODE_REF` identity claim. |
| Authz | **edges** — agent only acts on connected nodes (kernel-enforced ScopeError otherwise) |

**How to use:** open the agent chat (or refresh local herdr pane meta) in Vellum so the process is registered, then run `dist/vellum` from that agent/tooling tree. `onboard` / `capabilities` report the live edge contract for the admitted principal.

Browser control (`vellum browser`, with `vellum-browser` / `bun run browser`
as compatibility and repo-dev entrypoints) uses the same process-bind identity
on protected routes. There is **no enable-grant ceremony** and no client
capability secret — only a live registered process + human-drawn edges to page
nodes.

Ops go through WorkService (tasks/messages/requests/artifacts). That is the agent write path; freeform canvas authoring remains human/Command Center.

### Station roles

- **Command Center** — user-selected. Human authors the canvas; fleet management via host registry.
- **Remote** — user-selected. Capability host for that machine; applies complete Command Center projections and executes host-local rows.
- Role is never inferred from hardware or open windows.
- Doctor service `station` reports role, installation identity, database/work/simulation readiness, projection, and logical cursor state.

## The document contract

Standard JSON Canvas 1.0 (`nodes` of type `text`/`file`/`link`/`group`, `edges`) plus an optional `ether` key on nodes and edges:

```jsonc
{ "id": "n1", "type": "text", "x": 0, "y": 0, "width": 220, "height": 84, "text": "worker",
  "ether": {
    "entity": { "kind": "agent", "name": "local:worker" },  // open vocab; well-known: agent|terminal|herdr|task|requests|artifacts|page|watcher|timer
    "flags": ["blocker"],                                    // blocker|parked|attention
    "workRole": "frontend"                                   // optional claim-routing label (not physics role)
  } }
```

Edges: `{ "id", "fromNode", "toNode", "ether": { "criteria"?: EdgeCriteria, "ports"?: Port[] } }`.

**Edge product (criteria-only for stoppage; ports for capability):**
- No `criteria` → soft **relates** (capability/ocap only; never generates stoppage).
- `criteria.mode: "tasks"` → **blocking is worker-state, not a queue cascade.** `submitted`/`working` never block — an open queue is a factory humming. Stoppage is attention only: `input-required` / `auth-required` on the source task/requests sink generates **blocks** on the **connected actor** (`toNode`). No fan-out, no actor→actor relay, no multi-hop cascade. (Blockability is `role === "actor"` only — see [`architecture-factory-physics.md`](docs/architecture-factory-physics.md) §2a.)
- `criteria.mode: "proof"` / `"approval"` → blocks until matching runtime stamp / human grant (trust plane).
- **Retired (rejected by strict decode):** `glyphs`, `wip` criteria modes; `depends` phase; dependency cascade/relay. `project` is no longer well-known, though the open `entity.kind` vocabulary still permits it as inert furniture.
- Live **phase** is only `blocks` | `relates` (derived). Optional `ether.kind` is a phase mirror for offline JSON Canvas readers — never authorial input.

**Two invariants** (enforced on every app/CLI write):
1. **Graceful degradation** — strip every `ether` key and the file is still valid, readable JSON Canvas 1.0.
2. **Mirror law** — extension semantics mirror into native fields (blocker → red `color`; derived phase may project to edge `label`/`color`).

Derived state (blocked seats, group membership, live phase) is **recomputed** from the document (+ live sources). Phase may be mirrored onto `ether.kind` for offline readability; it is not the authoring surface.

**Vocabulary vs live plane:** `entity.kind` remains an open string, so unknown
kinds are inert furniture. Watch sources are closed to `hermes`; retired
private-source bindings and excess document fields fail strict decode rather
than being rewritten.

## Kernel: watchers, timers, region pulse

Region activation gated by three structures (`src/shared/canvas.ts`):

**EtherWatch** (102–118): `{ kind, project, orbit, glyphIds, state, source, key, stat, op, value, flagOnUnsatisfied }`. Predicate on live data. Kinds: `glyphs_done` | `glyphs_entered_state` | `stat_threshold`. Edge-detection fires when a glyph enters `state` between polls.

**EtherTimer** (123–126): `{ everyMinutes }`. Bare pulse on interval.

**EtherRegion** (88–92): `{ hold, instruction }` on group nodes. `hold: true` = structural container. `instruction` is briefing context appended to a pulse. Watchers/timers deliver only to edge-connected eligible agents; a manual region pulse may target eligible agents inside.

**Scheduler laws**: (1) Watcher truth is derived, never authorial document
state. (2) A watcher or timer executes only on its single home installation.
(3) `everyMinutes` catch-up coalesces missed intervals into at most one firing;
future timer kinds must declare a catch-up policy explicitly. (4) Arming is
runtime control, not authored canvas intent. Wall-clock timestamps are display
and due-time metadata only; fleet ordering uses route-local
`(event_home, entity_home, seq)` Work identities.

## Sources (read-only adapters)

`src/main/vellum/adapters/` — live: **hermes** (+ exec helpers). A down hermes degrades to a stale badge; it never touches the document. hermes enumerates profiles on the local machine + remote hosts over ssh.

## In-app planes

**Attached agent chat** — one live ACP session per agent node (`<host>:<profile>`); resumable across app sessions (channels: `chatOpen`, `chatPrompt`, `chatPermission`, `chatSetModel`, `chatClose`). Main process owns the `hermes acp` child; renders in the canvas as inline composition. Under the target security doctrine, agents consume runtime projections and tools rather than the authorial document.

**Native terminals** — `terminal` is the default terminal entity. TermPlane owns
local sessions and app quit stops local sessions only through the sealed
process-signal capability plane (never bare `process.kill(pid)`); use a Remote
station when work must survive Command Center quit. Herdr is an optional legacy
bridge for existing panes and must not be required for local health.

**Focus surfaces** — centered, measure-constrained overlays for single-subject work (one agent, one herdr pane, one page). Prefer these over full-bleed or stage-split when the interaction is deep and solitary. Shell: `FocusSurface` (`src/renderer/components/FocusSurface.tsx`); measures + math: `src/renderer/lib/focus-measure.ts`.

| measure | width intent | use |
|---|---|---|
| `prose` | ~65ch reading line | long copy |
| `document` | ~760px, resizable | glyph/session-shaped readers when present |
| `terminal` | ~140 mono cells @ 13px (~1100px) | herdr agent PTY |
| `workspace` | ~1280px immersive | focused browser / multi-pane still framed |
| `form` | ~448px fit | wizards |

Techniques baked in: dim+blur backdrop, titlebar-aware padding, enter animation (respects `prefers-reduced-motion`), portal to `document.body`, layer (`detail` vs `work` z-index). Dock/split remains available for multi-surface work; focus is the default for one subject.

## Design system

The renderer has one visual language — **deep-field**: warm near-black ground (never pure black), ink text, ~95% amber with sparse accents, crimson reserved for blockers, hairline ink strokes, mono instrument type + condensed display for titles. Two projections of one palette, never a second source:

- **Tokens** — the `@theme` block at the top of `src/renderer/styles.css` registers the palette as Tailwind v4 utilities (`text-ink`, `text-dim`, `text-faint`, `bg-ground/raise/raise-2/inset/well`, `border-stroke`, `text-amber/cyan/violet/crimson/…`, `font-mono`, `font-display`). `src/renderer/lib/theme.ts` is the TS mirror for runtime consumers (canvas paint, inline styles) — same values.
- **Primitives** — `src/renderer/components/ui/`: `Button` (chrome/primary/subtle/danger · xs/sm/md), `IconButton`, `Eyebrow`, `StatusDot`, `Chip`, `Input`/`Select`/`FieldLabel`, `OverlayHeader` (eyebrow/title/status/actions chrome header for every work-surface panel), `ToolbarPill` (floating node toolbar), `Kbd` (hotkey/gesture chip), `HelpMap` + `HelpMapGroup` / `HelpMapKeys` / `HelpMapPrimer` / `HelpMapPrimerBlock` (protocol & interaction maps — compose anywhere; canvas fill lives in `components/help/CanvasInteractionMap.tsx`). New surfaces compose these; do not hand-roll buttons, headers, status dots, or help chrome.
- **Terminal look** — `src/renderer/lib/terminal-theme.ts` (`VELLUM_XTERM_THEME`, font family/size) is the one xterm theme for every terminal surface (native + herdr).
- **Overlays** — one backdrop recipe everywhere: `rgba(0,0,0,0.72)` + `blur(2px)`. New single-subject overlays go through `FocusSurface`; panel headers go through `OverlayHeader`.

The **E2E design-audit loop** (`e2e/scenarios/design-audit.spec.ts`) drives every reachable surface with seeded fixtures + fake herdr/hermes/codexbar and screenshots them to `test-results/design-audit/` — run it after any visual change and read the frames.

## Structure

- `src/shared/` — **frozen contracts**: `canvas.ts` (document schema), `entities.ts` (snapshots), `graph.ts` (derived), `region-rollup.ts` (derived region severity rollups), `digest.ts`, `portfolio.ts`, `svg.ts`. Change deliberately; much depends on them.
- `src/main/vellum/state/` — the one SQLite engine and composed current schema.
- `src/main/vellum/` — document/work/station services, data adapters, and IPC/control boundaries.
- `src/renderer/` — the canvas surface.
- `scripts/` — the headless CLIs above.

## Machine safety (architecture north star)

**Vellum must never threaten the user's machine.** Host-destructive power is not
“handled carefully in tests” — it is made **unrepresentable** without a capability
Vellum mints when it owns the resource.

- **Law:** no ambient `kill(pid)` / open host wipe APIs. Domain types + Effect
  Schema + branded handles only.
- **Process signals:** `src/main/vellum/process-signal.ts` — sole site for
  `process.kill(-pid)`. Flow: `admitSpawnedProcess` → `OwnedProcess` (unique
  symbol + WeakMap authority) → `signalOwned` / `releaseOwned`.
- **Full doctrine:** [`docs/architecture-machine-safety.md`](docs/architecture-machine-safety.md).

PR test: *Can a confused agent or bad test pass a bare pid/path into a
host-destructive call? If yes, the change is not done.*

## Factory physics (architecture north star)

**The canvas is a factory floor, not an ACL spreadsheet.** Edges are ocaps
(mint by draw, attenuate via ports, revoke by delete); process-bind wields the
seat. Roles derive from entity kind — never authorial `ether.role`. Capability,
phase, and attention/occupancy are separate planes.

- **The law:** four roles, and **exactly one actor kind — `agent`**, the
  Vellum-spawned template terminal. A raw user-opened terminal is
  `geography/"terminal"`; `worker` is reserved for a future native agent UI and
  must not appear as a kind. Geography holds no seat, no ports, no inbox, and no
  work claim — but it *may* display agent state, because display is not a factory
  power. Placement (`Cc | Station{hostId}`) is data: it never gates a port.
- **PR test:** no host capability without connected edge + port + process-bind.
- **Full doctrine:** [`docs/architecture-factory-physics.md`](docs/architecture-factory-physics.md).
- **Cement:** [`tests/factory-physics-architecture.test.ts`](tests/factory-physics-architecture.test.ts)
  holds the three invariants no type can hold.

## Discipline

- `~/.vellum/state/vellum.db` is the only product state store. Do not add JSON
  stores, manifests, seals, pointer files, drop-file protocols, dual
  reads/writes, legacy imports, or rollback paths.
- The normal app main process is the only runtime database opener. Headless and
  remote surfaces must use app-owned IPC/control/Station APIs. The sole update
  exception is the quiesced, sealed, read-only candidate preflight above.
- Adapters are read-only. The operator authors intent through Command Center;
  agents mutate only the work plane through `WorkService`.
- Board/source IDs and tokens never leak into committed source.
- `bun run typecheck && bun run test` gate every change.
- Host-touching code follows Machine safety (above) — fail closed, capability-first.
- Agent reach follows Factory physics (above) — edges + ports + process-bind; no ambient region grants.

## Multi-agent tree (for builders)

At any time, multiple agents are working this codebase concurrently — the
worktree is shared, and unfamiliar uncommitted changes belong to another
agent.

- Never stash, revert, delete, or "clean up" code you did not write. Assume it
  is another agent's in-progress work and leave it alone.
- Commit your own work aggressively: as soon as a change is done and gated,
  stage only your own files and commit immediately. Do not leave your work
  unstaged.
- No conciliation or consolidation passes. Write your code, commit it, move on.
