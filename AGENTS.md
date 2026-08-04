# AGENTS.md — Vellum Command

**Vellum Command** is a desktop station (Electron + Effect + React) that
renders a **portfolio canvas**: agents, work surfaces, notes, and regions as
spatial nodes; dependencies/blockers/relationships as edges; named regions as
geography. The current canvas serialization is a
[JSON Canvas 1.0](https://jsoncanvas.org) document extended with a namespaced
`ether` key.

## Product brand — hard invariant

**The product name is Vellum Command. Never the short form without Command.**

A different product owns the short one-word name. This app, brand, and every
public or user-facing string must use the full name **Vellum Command** only.

| Surface | Rule |
|---|---|
| UI, dialogs, toasts, recovery HTML | `Vellum Command` |
| CLI hints, doctor, next_step copy | `Vellum Command` |
| README, PRODUCT, marketing, store | `Vellum Command` |
| Agent docs (this file, CLAUDE.md) | `Vellum Command` |
| macOS app / executable | `Vellum Command.app` |
| Release artifacts | `Vellum-Command-…` |
| Code identifiers / paths / bins | unchanged — not brand |

**Not brand (keep as-is):** `VellumApi`, `resolveVellumHome`, `~/.vellum/`,
`vellum.db`, `dist/vellum`, `vellum://`, `VELLUM_*` env keys, npm package name,
appId.

**Enforcement:** `bun run lint:product-name` — capital-V product token not
followed by ` Command` or `-Command` is a lint error. Wired into `bun run verify`.
Constant: `src/shared/product-name.ts` (`PRODUCT_NAME`).

**PR test:** would a stranger reading only this string think the product is the
short one-word name? If yes, rewrite to **Vellum Command**.

## Security doctrine — read first

[`docs/security-doctrine.md`](docs/security-doctrine.md) is the governing
product trust model. It defines Vellum Command as a single-operator factory,
attached agents as trusted but fallible, edges as enforceable operator intent
inside Vellum Command, and Stations as single-home executors of Command Center
intent. If a review, backlog item, test, or older architecture note conflicts
with it, the conflict is migration work. Compatibility exists only at the two
proven external boundaries: installed SQLite state and independently updated
Station wire peers. It must not preserve an obsolete internal domain or file
store.

[`docs/vellum-protocol.md`](docs/vellum-protocol.md) is the canonical
multi-installation contract: identity, complete intent projection, sink/item
authority, synchronous CC-home task claims, offline Remote execution, logical
event convergence, the five Station verbs, and transport adapters.

**Normative direction:** the protected document is the product; compiled
projections and capability-bound tools are the agent API. **Sole product
store** is `~/.vellum/state/vellum.db` — canvases, work, content manifests,
station, settings, and every other product durable fact. That law is about
**product** durability, not process-internal bookkeeping: install-local
internals (e.g. backfill ledgers in `~/.vellum/state/install-ops.db`, content
object files under `~/.vellum/content/`) may use separate on-disk stores
owned by the same app runtime. Do not fold migration/backfill completeness
markers into product rows so seeds and installs cannot lie about local
walks. Each installation has one sole app runtime process as the normal
opener of product and install-ops databases, and one `StateEngine`
connection for `vellum.db`: Electron main on Command Center, or the
displayless packaged Node Remote process on Remote. Renderers, CLIs,
helpers, and remote callers use IPC/control APIs and never open product or
install-ops databases. Every app version has one role-independent product
schema; independently updated installations may temporarily run different
recognized versions.
Command Center holds authorial canvases and fleet coordination; a Remote holds
its replace-only projection and installation-homed work. Both event and entity
homes are `InstallationId` values; `HostId` is placement, not durable work
authority. Single-home rows and route-local
`(event_home, entity_home, seq)` Work identities make station clocks irrelevant
to correctness.
JSON Canvas exports and agent sidecars (`*.digest.txt`, `*.svg`) are outputs,
not durability or input watched by the app.

Install/update stages and cutovers without a sealed clone preflight.
Schema+data migration runs on normal app open; failures surface in the normal
startup recovery flow. There is no second database opener for update proofs.

**SQLite evolution law:** version 1 is the frozen durable baseline; version 5
is current through immutable `1 → 2`, `2 → 3`, `3 → 4`, and `4 → 5` steps.
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
is protocol 4 with `4/4/4`. No overlap means explicit `update required` while
the Remote continues locally under its last projection; it never means partial
down-conversion. Do not add separate session/API/Work/projection version
negotiation or capability arrays. A codec retires only after every enrolled
Station using it is upgraded or explicitly retired and its pending records are
reconciled.

## The agent surface (headless — no GUI needed)

**Agents never write the canvas.** The canvas is human-authored (Command Center). Agents consume compiled projections and local Vellum Command tools.

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

While Vellum Command is running, agents talk to the **local** work control socket, not
to an exported document or the database:

| surface | detail |
|---|---|
| CLI | `dist/vellum` (`bun run cli:build`) — `ping`, `doctor`, `capabilities`, `onboard`, `tasks`, `msg`, `request`, `artifact`, board ops |
| Socket | `~/.vellum/work/control.sock` + bearer token `~/.vellum/work/token` |
| Identity | **process-bind** — CLI must run as a descendant of a live Vellum Command agent (ACP) or herdr pane process. Main registers those PIDs; control admits via Unix peer PID (+ PPID walk). No client-supplied nodeRef / `VELLUM_NODE_REF` identity claim. |
| Authz | **edges** — agent only acts on connected nodes (kernel-enforced ScopeError otherwise); board ports are distinct (`board.create_topic` vs `board.post`) |

**How to use:** open the agent chat (or refresh local herdr pane meta) in Vellum Command so the process is registered, then run `dist/vellum` from that agent/tooling tree. `onboard` / `capabilities` report the live edge contract for the admitted principal.

Browser control (`vellum browser`, with `vellum-browser` / `bun run browser`
as compatibility and repo-dev entrypoints) uses the same process-bind identity
on protected routes. There is **no enable-grant ceremony** and no client
capability secret — only a live registered process + human-drawn edges to page
nodes.

Ops go through WorkService (tasks/messages/requests/artifacts/board). That is the agent write path; freeform canvas authoring remains human/Command Center.

**Board residency:** board is a **Command Center-homed global sink** (same residency class as actor mailboxes). Sink definition is in the fleet projection; material topics/posts live only on CC. Remote agents enqueue `board.topic.create` / `board.post.append`; Remotes store applied dispositions/events and do **not** rematerialize board rows. List/read the full board on Command Center. `board.mark_read` is install-local. Operator megaphone / edge `notify` is CC UI only; agent posts never wake.

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
    "entity": { "kind": "agent", "name": "local:worker" },  // open vocab; well-known product: agent|terminal|herdr|task|requests|artifacts|page|cron|relay (+ dormant watcher/gauge; timer aliases cron)
    "flags": ["blocker"],                                    // blocker|parked|attention
    "workRole": "frontend"                                   // optional claim-routing label (not physics role)
  } }
```

Edges: `{ "id", "fromNode", "toNode", "ether": { "criteria"?: EdgeCriteria, "ports"?: Port[] } }`.

**Edge product (criteria-only for stoppage; ports for capability):**
- No `criteria` → soft **relates** (capability/ocap only; never generates stoppage).
- `criteria.mode: "tasks"` → **blocking is worker-state, not a queue cascade.** `submitted`/`working` never block — an open queue is a factory humming. Stoppage is attention only: `input-required` on the source task/requests sink generates **blocks** on the **connected actor** (`toNode`). No automatic fan-out. Opt-in actor↔actor relay is `ether.relayState: true` on the edge (default off) — copies blocked reasons multi-hop. (Blockability is `role === "actor"` only — see [`architecture-factory-physics.md`](docs/architecture-factory-physics.md) §2a.)
- `criteria.mode: "proof"` / `"approval"` → blocks until matching runtime stamp / human grant (trust plane).
- **Retired (rejected by strict decode):** `glyphs`/`wip` criteria modes; glyph watcher kinds (`glyphs_done`/`glyphs_entered_state`); private-source watchers; `ether.view` project slices; `depends` phase; dependency cascade/relay. `project` is no longer well-known, though the open `entity.kind` vocabulary still permits it as inert furniture.
- Live **phase** is only `blocks` | `relates` (derived). Optional `ether.kind` is a phase mirror for offline JSON Canvas readers — never authorial input.

**Two invariants** (enforced on every app/CLI write):
1. **Graceful degradation** — strip every `ether` key and the file is still valid, readable JSON Canvas 1.0.
2. **Mirror law** — extension semantics mirror into native fields (blocker → red `color`; derived phase may project to edge `label`/`color`).

Derived state (blocked seats, group membership, live phase) is **recomputed** from the document (+ live sources). Phase may be mirrored onto `ether.kind` for offline readability; it is not the authoring surface.

**Vocabulary vs live plane:** `entity.kind` remains an open string, so unknown
kinds are inert furniture. Watch sources are closed to `hermes`; retired
private-source bindings and excess document fields fail strict decode rather
than being rewritten.

## Kernel: cron, relay (+ dormant gauge) — wires

Region pulse inject is **retired**. Edges are **wires**: configuration only,
never runtime state. Closed families: `access | watch | trigger | effect`.
Only schedulers push; actors pull. Connect refused for sink–sink and geography.

**Product scheduler plane:**

| Kind | How it binds | Fire |
|---|---|---|
| **cron** | `ether.timer` expression | Durable due → effect wires (`does`) |
| **relay** | **input wire** sink→relay carries `when`; **output wire** relay→target carries `does` | Rising edge on watch → apply effects |

**Not a product peer:** hermes **gauge** (`watcher`) is palette-hidden / dormant.

**Wire areas (v2):** `ports` · `stops` · `wake` · `slot` · `when` · `does`. Legacy
`criteria`/`notify`/`effect` still decode (dual-read). No `relayState` cascade.

**Effects (v1):** `enqueue_task` · `set_flag`. Claim assignment stays the factory tick.

**Scheduler laws**: (1) Sensor truth is derived. (2) Single-home evaluation.
(3) Interval catch-up ≤1 due tick. (4) **Automate only when station role is
configured and the canvas is playing** — otherwise project status/`nextFire`
but do not consume rising-edge memory or durable cron firing slots.
(5) **`set_flag` / `flagOnUnsatisfied` are Command Center only** (Remote refuses
authorial canvas mutate; fail closed, no silent success).

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
| `document` | ~760px, resizable | session-shaped readers when present |
| `terminal` | ~140 mono cells @ 13px (~1100px) | herdr agent PTY |
| `workspace` | ~1280px immersive | focused browser / multi-pane still framed |
| `form` | ~448px fit | wizards |

Techniques baked in: dim+blur backdrop, titlebar-aware padding, enter animation (respects `prefers-reduced-motion`), portal to `document.body`, layer (`detail` vs `work` z-index). Dock/split remains available for multi-surface work; focus is the default for one subject.

## Design system

The renderer has one visual language — **deep-field**: warm near-black ground (never pure black), ink text, ~95% amber with sparse accents, crimson reserved for blockers, hairline ink strokes, mono instrument type + condensed display for titles. Two projections of one palette, never a second source:

- **Tokens** — the `@theme` block at the top of `src/renderer/styles.css` registers the palette as Tailwind v4 utilities (`text-ink`, `text-dim`, `text-faint`, `bg-ground/raise/raise-2/inset/well`, `border-stroke`, `text-amber/cyan/violet/crimson/…`, `font-mono`, `font-display`). `src/renderer/lib/theme.ts` is the TS mirror for runtime consumers (canvas paint, inline styles) — same values.
- **Primitives** — `src/renderer/components/ui/`: `Button` (chrome/primary/subtle/danger · xs/sm/md), `IconButton`, `Eyebrow`, `StatusDot`, `Chip`, `Input`/`Select`/`FieldLabel`, `OverlayHeader` (eyebrow/title/status/actions chrome header for every work-surface panel), `ToolbarPill` (floating node toolbar), `Kbd` (hotkey/gesture chip), `HelpMap` + `HelpMapGroup` / `HelpMapKeys` / `HelpMapPrimer` / `HelpMapPrimerBlock` (protocol & interaction maps — compose anywhere; canvas fill lives in `components/help/CanvasInteractionMap.tsx`). New surfaces compose these; do not hand-roll buttons, headers, status dots, or help chrome.
- **Canvas card law — no action buttons on nodes.** Cards are glance + identity only. Open via double-click or RTS kind-strip keys; config via kind-strip pops; flags/delete/pause live on the selection toolbar / RTS command card. The only on-card controls allowed are pure instrumentation (enqueue + on tasks glance, activity marks). Never put "open" / "stop" / "detach" / form CTAs on the card body.
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

**Vellum Command must never threaten the user's machine.** Host-destructive power is not
“handled carefully in tests” — it is made **unrepresentable** without a capability
Vellum Command mints when it owns the resource.

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
  Vellum Command-spawned template terminal. A raw user-opened terminal is
  `geography/"terminal"`; `worker` is reserved for a future native agent UI and
  must not appear as a kind. Geography holds no seat, no ports, no inbox, and no
  work claim — but it *may* display agent state, because display is not a factory
  power. Placement (`Cc | Station{hostId}`) is data: it never gates a port.
- **PR test:** no host capability without connected edge + port + process-bind.
- **Full doctrine:** [`docs/architecture-factory-physics.md`](docs/architecture-factory-physics.md).
- **Cement:** [`tests/factory-physics-architecture.test.ts`](tests/factory-physics-architecture.test.ts)
  holds the three invariants no type can hold.

## Discipline

- `~/.vellum/state/vellum.db` is the only **product** state store. Do not add
  parallel product JSON stores, manifests, seals, pointer files, drop-file
  protocols, dual product reads/writes, legacy imports, or rollback paths.
  Install-local internals (backfill ledgers, content object files) are not
  product state: they must not live as product tables that get seeded or
  projected as operator truth.
- The installation's sole app runtime process is the only normal database
  opener (product + install-ops): Electron main on Command Center or the
  displayless packaged Node Remote process on Remote. Other headless and
  remote surfaces must use app-owned IPC/control/Station APIs.
- Adapters are read-only. The operator authors intent through Command Center;
  agents mutate only the work plane through `WorkService`.
- Board/source IDs and tokens never leak into committed source.
- `bun run typecheck && bun run test` gate every change.
- Host-touching code follows Machine safety (above) — fail closed, capability-first.
- Agent reach follows Factory physics (above) — edges + ports + process-bind; no ambient region grants.

## State migrations — hard law

Two kinds of migration exist and they never mix:

1. **Schema evolution** — expand-only DDL steps in
   `src/main/vellum/state/migrations.ts`: versioned (`user_version` N→N+1),
   identity-witnessed, one startup transaction, authorizer-guarded. A schema
   step adds tables/columns/triggers; it never rewrites rows.
2. **Data backfills** — marker-gated, idempotent walks that run after
   StateEngine is up (e.g. `content/inline-media-migration.ts`). Completeness
   markers live in install-ops (`install-ops.db` / `InstallOpsService`), not
   in product tables. Dev seeds may copy `vellum.db` + content files; they
   must never copy install-ops ledgers.

Backfill laws (each one broke, or nearly broke, a real release):

- **Immutable logs are immutable to migrations too.** `work_events`,
  `work_facts`, `work_commands`, `work_dispositions`, `work_proposal_events`
  are never UPDATEd or DELETEd — not even to "modernize" old payloads. History
  is served as written; decode paths admit historical shapes
  (decode-admits-history). Backfills rewrite material projections only.
- **A backfill never gates boot.** Failure = log it, leave the marker pending,
  retry next boot. The app always opens; a half-done backfill is a deferred
  walk, not a startup error.
- **Idempotent by construction.** Content-addressed ingest, per-row
  transactions, safe resume from any interruption.
- **Install-local ledger.** Backfill completeness is install-local
  bookkeeping, not product state — separate Effect layer/service and
  separate on-disk store from `vellum.db`.
- **Proven against the real schema before it ships.** Every migration or
  backfill ships with a test that runs it on the production DDL — triggers
  active — seeded with historical-shaped rows *including rows in the immutable
  log tables*. A migration proven only on empty or convenient fixtures is
  unproven.

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
