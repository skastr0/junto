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
| Code identifiers / source paths | unchanged — not brand |

**Renamed runtime surfaces:** `VellumCommandApi`, `resolveVellumCommandHome`, `~/.vellum-command/`,
`dist/vellum-command`, `bin/vellum-command`, `VELLUM_COMMAND_*` env keys,
`window.vellumCommand`, and `vellum-command-*` protocol/control prefixes.

**Implementation boundaries:** source paths under `src/main/vellum/`, the npm package name, the appId,
Context service identifiers, internal `@vellum/*` tags, checked-in helper source filenames, and Linux release
archive names remain implementation/release identities. They are not legacy readers or compatibility aliases.
The active product state and node-reference URI use the canonical `vellum-command` names above.

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
with it, the conflict is migration work. This fresh-app rename has no old-home
importers, dual writers, or internal runtime aliases. Station protocol
negotiation remains a product contract for independently updated peers when
those peers are deployed; newly emitted traffic has no legacy codec or
namespace. The sole historical decode exception is the portfolio body stored
inside frozen v1 SQLite fixtures, required by the immutable installed-state
proof and never emitted or negotiated.

[`docs/vellum-protocol.md`](docs/vellum-protocol.md) is the canonical
multi-installation contract: identity, complete intent projection, sink/item
authority, synchronous CC-home task claims, offline Remote execution, logical
event convergence, the five Station verbs, and transport adapters.

**Normative direction:** the protected document is the product; compiled
projections and capability-bound tools are the agent API. **Sole product
store** is `~/.vellum-command/state/vellum-command.db` — canvases, work, content manifests,
station, settings, and every other product durable fact. That law is about
**product** durability, not process-internal bookkeeping: install-local
internals (e.g. backfill ledgers in `~/.vellum-command/state/install-ops.db`, content
object files under `~/.vellum-command/content/`) may use separate on-disk stores
owned by the same app runtime. Do not fold migration/backfill completeness
markers into product rows so seeds and installs cannot lie about local
walks. Each installation has one sole app runtime process as the normal
opener of product and install-ops databases, and one `StateEngine`
connection for `vellum-command.db`: Electron main on Command Center, or the
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
Schema evolution runs on normal app open; failures surface in the normal
startup recovery flow. There is no second database opener for update proofs,
and the rename itself has no startup data-copy step.

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
installed system to delete `vellum-command.db`; never add a downgrade, old-schema
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

---

# ⛔ BIG BOLD INVARIANT — STOCK DEPENDENCIES ONLY

**ALL THIRD-PARTY DEPENDENCIES MUST BE STOCK / BASELINE / PRODUCTION VERSIONS.**

- **NO** Vellum Command feature may be developed on top of patched, nightly, fork, pin-to-PR, or unofficial branches of a dependency.
- **Always** consume the stable production release that normal users install (npm/registry tag, published CLI version, released binary — not a local checkout with private patches).
- If a capability exists only on a patched/nightly/unofficial line, **do not build the feature**. Cap the product at what stable production exposes. Wait for upstream stable, or drop the capability.

**Example — herdr:** Vellum Command’s herdr integration must target **stable production herdr only**. Do not design, implement, or ship browser/terminal/agent features against a custom fork, patched daemon, or nightly protocol surface. If stable herdr cannot do X, Vellum Command cannot do X via herdr until stable does.

This is non-negotiable for agents and humans. Violating it creates unshippable private-stack debt.

---

## The agent surface (headless — no GUI needed)

**Agents never write the canvas.** The canvas is human-authored (Command Center). Agents consume compiled projections and local Vellum Command tools.

Headless CLIs reach `CanvasesService` through the running app's owner-local
canvas control socket. They do not open `vellum-command.db`. Agents remain strictly
read-only for authorial intent. Current headless CLIs:

| command | who | what it does |
|---|---|---|
| `bun run digest [name]` | agents + operators | print (and write `<name>.digest.txt`) a deterministic text projection of the board + live hermes snapshot data. |
| `bun run render [name]` | agents + operators | write `<name>.svg` — an image of the board, for multimodal reading. |
| `bun run canvas:ls [--json]` | agents + operators | list canvases with node/edge counts. |

To **read the board as an agent**: `bun run digest` (text) or `bun run render` then view the SVG (image).

### Work plane (agent mutations)

While Vellum Command is running, agents talk to the **local** work control socket, not
to an exported document or the database:

| surface | detail |
|---|---|
| CLI | `dist/vellum-command` (`bun run cli:build`) — `ping`, `doctor`, `capabilities`, `onboard`, `tasks`, `msg`, `request`, `artifact`, board ops |
| Socket | `~/.vellum-command/work/control.sock` + bearer token `~/.vellum-command/work/token` |
| Identity | **process-bind** — CLI must run as a descendant of a live Vellum Command agent (ACP) or herdr pane process. Main registers those PIDs; control admits via Unix peer PID (+ PPID walk). No client-supplied nodeRef / `VELLUM_COMMAND_NODE_REF` identity claim. |
| Authz | **edges** — agent only acts on connected nodes (kernel-enforced ScopeError otherwise); board ports are distinct (`board.create_topic` vs `board.post`) |

**How to use:** open the agent chat (or refresh local herdr pane meta) in Vellum Command so the process is registered, then run `dist/vellum-command` from that agent/tooling tree. `onboard` / `capabilities` report the live edge contract for the admitted principal.

Browser control (`vellum-command browser` / `bun run browser`) uses the same process-bind
identity on protected routes. There is **no enable-grant ceremony** and no client
capability secret — only a live registered process + human-drawn edges to page
nodes. Station wire entry is `vellum-command station-stdio`; content transfer is
`vellum-command content-transfer …`. Packaged installs ship **one** CLI binary
(`bin/vellum-command`) only.

Ops go through WorkService (tasks/messages/requests/artifacts/board). That is the agent write path; freeform canvas authoring remains human/Command Center.

**Board residency:** board is a **Command Center-homed global sink** (same residency class as actor mailboxes). Sink definition is in the fleet projection; material topics/posts live only on CC. Remote agents enqueue `board.topic.create` / `board.post.append`; Remotes store applied dispositions/events and do **not** rematerialize board rows. List/read the full board on Command Center. `board.mark_read` is install-local. Operator megaphone / edge `wake` is CC UI only; agent posts never wake.

**Pad (shared page):** a Command Center-homed work-plane sink (same class as board). Agents read a picture + IR and patch named boxes and pins. They never write the factory canvas. Ports are `pad.read` and `pad.patch` only. Agent ink or image upserts are refused. Mentions must be inbound actor node ids.

- Contract: [`docs/pad-architecture.md`](docs/pad-architecture.md)
- Operator and agent guide: [`docs/pad.md`](docs/pad.md)
- CLI: `vellum-command pad read`, `patch`, `digest`, `svg`, `look-here`, `get`, `tagged`

### Station roles

- **Command Center** — user-selected. Human authors the canvas; fleet management via host registry.
- **Remote** — user-selected. Capability host for that machine; applies complete Command Center projections and executes host-local rows.
- Role is never inferred from hardware or open windows.
- Doctor service `station` reports role, installation identity, database/work/simulation readiness, projection, and logical cursor state.

**Station process mode — hard law:**

- Process mode is Unenrolled | Remote | Command Center. One mode.
- Enroll door and peer door are mutually exclusive.
- Unenrolled binds enroll only (`status` / `pair` / `configure`).
- Remote binds peer only (`status` / `project` / `report`).
- Command Center binds neither; it is the client.
- Never both sockets. Re-enroll tears the peer door down first (mode
  change). Not two live sessions. Not "pause peer."
- Updating a Remote replaces the package and stays Remote. It does not
  pass through Unenrolled.
- The macOS Remote UI is a station face (stats), not the Command Center
  canvas. No Fleet on Remote.
- Code: `src/shared/station-mode.ts`.

## The document contract

Standard JSON Canvas 1.0 (`nodes` of type `text`/`file`/`link`/`group`, `edges`) plus an optional `ether` key on nodes and edges:

```jsonc
{ "id": "n1", "type": "text", "x": 0, "y": 0, "width": 220, "height": 84, "text": "worker",
  "ether": {
    "entity": { "kind": "agent", "name": "local:worker" },  // open vocab; well-known product: agent|terminal|herdr|task|requests|artifacts|page|cron|relay (+ dormant watcher/gauge; timer aliases cron)
    "flags": ["blocker"]                                     // blocker|parked|attention
  } }
```

Edges: `{ "id", "fromNode", "toNode", "ether": { "ports"?: Port[], "wake"?: boolean, "slot"?: WireSlot, "when"?: WatchWhen, "does"?: EdgeEffect } }`.

Canonical edge ether words: **`ports`, `wake`, `does`, `when`, `slot`**. One word per area. Writers emit only these; decode may scrub old dual keys once (`criteria`/`stops` retired, `notify`→`wake`, `effect`→`does`) — migration hygiene, not product authoring.

**Edge product (ports for capability; wake/when/does/slot for wires; stoppage derived):**
- **Access** is ports (and board `wake`). No Hold control. No authorable stop-when / proof / approval on the wire sheet.
- **Stoppage is derived**, not authored on the edge: an access edge between an **actor** and **task|requests** plus a **claimed** item in `input-required` / `auth-required` on that sink generates **blocks** on that actor seat only. Open queue (`submitted`/`working`) never blocks. No automatic multi-hop fan-out. Multi-hop is an explicit **relay** node plus watch/effect wires only. (Blockability is `role === "actor"` only — see [`architecture-factory-physics.md`](docs/architecture-factory-physics.md) §2a.)
- Lexicon word **stops** may appear in wire sentences when that derived stoppage applies — it is speech, not a document field to set.
- `wake` on board-linked edges — default **ON** (absent/true); explicit `false` opts the seat out of operator megaphone. Agent posts never wake.
- `when` on sink→relay **input** wires (watch predicate: completes / flagged / any-OR).
- `does` on scheduler **output** wires (fire actions).
- `slot` assigns the wire end at the scheduler (`input` | `output` | `trigger` | `recipient`).
- **Retired (scrubbed / not product):** authorial `stops` / Hold UI; `proof` / `approval` edge modes; `criteria` / `notify` / `effect` dual keys; `ether.relayState` cascade; node-body `ether.relay`; `glyphs`/`wip` stop modes; glyph watcher kinds; private-source watchers; `ether.view` project slices; `depends` phase; automatic dependency cascade. `project` is no longer well-known, though the open `entity.kind` vocabulary still permits it as inert furniture.
- Live **phase** is only `blocks` | `relates` (derived). Optional `ether.kind` is a phase mirror for offline JSON Canvas readers — never authorial input.

**Two invariants** (enforced on every app/CLI write):
1. **Graceful degradation** — strip every `ether` key and the file is still valid, readable JSON Canvas 1.0.
2. **Mirror law** — extension semantics mirror into native fields (blocker → red `color`; derived phase may project to edge `label`/`color`).

Derived state (blocked seats, group membership, live phase) is **recomputed** from the document (+ live sources). Phase may be mirrored onto `ether.kind` for offline readability; it is not the authoring surface.

**Vocabulary vs live plane:** `entity.kind` remains an open string, so unknown
kinds are inert furniture. Watch sources are closed to `hermes`; retired
private-source bindings and excess document fields fail strict decode rather
than being rewritten.

## Copy law: no middle dots, ever

The middle dot (U+00B7) is banned from every surface: product copy, UI strings,
generated sheets, docs, artifacts, commit-facing summaries. Separate with
commas, em dashes, or plain spaces. Derived wire sentences are spoken compounds
("access stops", "watch completes") — never dotted. This is an operator hard
invariant; reintroducing a middot is a defect.

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

**Wire areas:** `ports` - `wake` - `slot` - `when` - `does`. Product shape is
one word per area (no dual-read product law). Stoppage is **derived** (not an
authorable `stops` field). Scrub may map old dual keys once on load. No
`relayState` cascade — multi-hop stoppage is a **relay** node + `when` /
`does` wires only.

**Effects (v1):** `enqueue_task` - `set_flag` - `inject_prompt`. Claim assignment
stays the factory tick.

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

**Seat occupancy law** — occupancy is independent of process liveness.
- A seat is vacant or occupied.
- Occupying a vacant seat and activating an occupied seat are different command families. Create is occupy. Create on an occupied seat is a bug.
- Stopping still occupies the seat. Exited / missing / unknown is vacant.
- Resumable / crashed / stalled / paused belong to the occupant process, not the seat.
- Local and remote share this contract. Placement (local | remote) selects the process Layer. It does not change occupancy.
- Pin / unpin / remount must not occupy. They activate (or just keep the view).
- Code: `src/shared/terminal-seat-occupancy.ts`, `src/main/vellum/term/seat-process.ts`.

**Named session resume law** — a seat resumes one explicit harness session id,
or it starts fresh. There is no "continue whatever was last." Harness
`--continue`, bare `--resume`, and latest-session pickers are not a Vellum
Command feature and must never be emitted. Code:
`src/shared/managed-terminal-launch.ts`.

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

The renderer has one visual language with two modes — `dark` (default) and `bright`, a designed daylight edition, never a mechanical inversion. Shared traits: warm ground (never pure black, never pure white), ink text, ~95% amber with sparse accents, crimson reserved for blockers, hairline ink strokes, mono instrument type + condensed display for titles. One token source, several projections, never a second palette:

- **Tokens** — `src/shared/theme/` is the single source of truth: OKLCH primitives (`primitives.ts`) assigned meaning per mode in the semantic layer (`semantic.ts`). `bun run theme:build` projects it to `src/renderer/styles/theme.generated.css`, which registers the palette as Tailwind v4 utilities (`text-ink`, `text-dim`, `text-faint`, `bg-ground/raise/raise-2/inset/well`, `border-stroke`, `text-amber/cyan/violet/crimson/…`, `font-mono`, `font-display`) plus `html[data-theme="bright"]` overrides. `src/renderer/lib/theme.ts` re-exports the same source for runtime consumers (canvas paint, inline styles); `src/shared/svg.ts` imports it for the SVG export. Never hardcode palette hex/rgba — edit the source and regenerate.
- **Primitives** — `src/renderer/components/ui/`: `Button` (chrome/primary/subtle/danger - xs/sm/md), `IconButton`, `Eyebrow`, `StatusDot`, `Chip`, `Input`/`Select`/`FieldLabel`, `OverlayHeader` (eyebrow/title/status/actions chrome header for every work-surface panel), `ToolbarPill` (floating node toolbar), `Kbd` (hotkey/gesture chip), `HelpMap` + `HelpMapGroup` / `HelpMapKeys` / `HelpMapPrimer` / `HelpMapPrimerBlock` (protocol & interaction maps — compose anywhere; canvas fill lives in `components/help/CanvasInteractionMap.tsx`). New surfaces compose these; do not hand-roll buttons, headers, status dots, or help chrome.
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

- **The law:** four derived physics roles, and **exactly one actor kind — `agent`**, the
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

- `~/.vellum-command/state/vellum-command.db` is the only **product** state store. Do not add
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
   in product tables. Dev seeds may copy `vellum-command.db` + content files; they
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
  separate on-disk store from `vellum-command.db`.
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
