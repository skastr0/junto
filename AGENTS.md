# AGENTS.md — Junto

**Junto** is a desktop app (Electron + Effect + React) that
renders a **portfolio canvas**: agents, work surfaces, notes, and regions as
spatial nodes; dependencies/blockers/relationships as edges; named regions as
geography.

**There is no canvas document.** Junto began as a JSON Canvas file with an
`ether` extension bag and has outgrown it: it is a workspace of many agents
exchanging mail, and the app is modelled as that. Seats, regions, wires and
every other kind are their own schemas with their own tables
(`src/shared/model/`). `CanvasDoc`, `ether`, the generic
text/file/link/group node, `readCanvas`/`writeCanvas` and document revisions
are gone, and `bun run lint:no-canvas-document` keeps their names out. Do not
treat any older note that calls the document the product as current. See
[The model](#the-model).

## Product name: Junto

**The product name is Junto.**

Every public, user-facing, and runtime string uses the name **Junto**.

**Enforcement:** `bun run lint:product-name` — verifies product name usage across the codebase. Wired into `bun run verify`. Constant: `src/shared/product-name.ts` (`PRODUCT_NAME`).

## Security doctrine — read first

[`docs/security-doctrine.md`](docs/security-doctrine.md) governs Junto trust
boundaries. Read it alongside [`docs/machines.md`](docs/machines.md), the
build contract for one canvas across machines; its summary is under
[Machines](#machines).

**Normative direction:** the app is its model: typed rows changed by
commands, followed by events. Capability-bound tools are the agent API. **Sole
product store** is `~/.junto/state/junto.db` — canvases, work, content manifests,
settings, and every other product durable fact. That law is about
**product** durability, not process-internal bookkeeping: install-local
internals (e.g. backfill ledgers in `~/.junto/state/install-ops.db`, content
object files under `~/.junto/content/`) may use separate on-disk stores
owned by the same app runtime. Do not fold migration/backfill completeness
markers into product rows so seeds and installs cannot lie about local
walks. Each installation has one sole app runtime process as the normal
opener of product and install-ops databases, and one `StateEngine`
connection for `junto.db`: the Junto core on that machine. Renderers, CLIs,
helpers, and other machines use IPC, control APIs or a link and never open
product or install-ops databases.
Junto writes no canvas file: there is no JSON Canvas export or import, and no
digest or SVG file beside a canvas.

**SQLite evolution law:** Version 1 is the baseline Junto schema, and
`CURRENT_STATE_SCHEMA_VERSION` in `src/main/junto/state/migrations.ts` names
the head. `PRAGMA user_version` selects a contiguous forward-only migration
chain, and `state_schema_identity` proves the exact shape expected at each
step. Every schema edit must increment the current version, append an atomic
`N → N+1` migration, and prove existing rows survive.
Shipped migration history is immutable: never edit, delete, reorder, or renumber
a released step.

Routine migrations are **expand → preserve → deprecate**:

- add new tables, columns, indexes, triggers, or representations beside the
  old shape;
- copy forward without deleting rows, overwriting old column values, renaming,
  dropping, tightening, or reusing an existing durable name or meaning;
- stop using the old representation only after the new one is verified, while
  retaining the old bytes in the schema.

Dropping a table or rebuilding one is a consolidate step, and it needs the
operator's approval for that work. The step names every table it drops and
every table it rebuilds, copies each kept row, and proves on the shipped
fixtures and on a disposable copy of an installed database that no kept row
changed. Two steps have done this: `12 → 13` replaced the canvas tables, and
`14 → 15` dropped the tables that carried tasks between machines and rebuilt
the work log without its links to them. Never ask an installed system to
delete `junto.db`; never add a downgrade, an old-schema runtime reader, a dual
write, or a file-store compatibility path.

An older binary that finds `PRAGMA user_version` ahead of its
`CURRENT_STATE_SCHEMA_VERSION` refuses deterministically before opening
`junto.db` for write: the read-only `schema-version-probe` reports
`newer-than-supported`, and `startup-schema-recovery` surfaces a plain
"Update required" path (quit, or install the newer feed build). It never
opens, migrates, downgrades, or partially decodes advanced state.

---

## Dependencies

Bleeding-edge and unstable dependency versions are permitted. Retain Legend
State v3; its prerelease status is not a reason to downgrade it.

## Seat philosophy

- A seat is a permanent agent. To the operator it is one continuous agent,
  never a list of sessions.
- Sessions are internal to the seat. The operator never goes back to, picks,
  or switches sessions in a seat, and no UI surface shows session history,
  notes or transcripts. That data lives in the seat's own store and CLI only.
- Continuity is Junto's job: a seat resumes its same session across restarts
  and wakes.
- Offboarding is self-service. The agent runs `junto offboard` (or
  `--continue`) at its own stopping points; `junto onboard` names the command
  and `junto docs doctrine` says how and when.
  Past notes come back at onboard as context, never as ongoing tasks.
- Junto does not gauge an agent's context to press it. It estimates a session's size from its transcript for one purpose: deciding whether an idle session is worth cutting by the automatic offboard rules.

## Attention

- The UI exists to show what needs the operator: the seat's state ring and
  halo, the inbox, notifications and sound cues.
- Anything that doesn't need the operator stays out of the UI. Seat internals
  (sessions, notes, transcripts, plumbing) are not surfaced, because every
  extra surface competes for attention.

## The agent surface (headless — no GUI needed)

**Ordinary agents never write the canvas.** The canvas is human-authored.
Ordinary agents use Junto tools under edge-scoped work control.

**Overseer exception (narrow).** A human may toggle overseer on an existing
managed agent seat. That seat keeps the `agent` kind, gains a distinctive UI,
and may use closed `junto overseer` commands for operator-equivalent
canvas, node, and work operations without connecting edges. The machine that
edits the canvas validates the live grant and makes the change. Only humans
grant or revoke; overseers cannot propagate authority. Pause and play have no
bearing on administration. An overseer cannot delete its own seat or move the
operator viewport. It does not receive the operator socket or credentials.

See [`docs/overseer-coverage-matrix.md`](docs/overseer-coverage-matrix.md).

Headless CLIs reach `CanvasesService` through the running app's owner-local
canvas control socket. They do not open `junto.db`. Ordinary agents
remain strictly read-only for authorial intent. Current headless CLIs:

| command | who | what it does |
|---|---|---|
| `bun run digest [name]` | agents + operators | print a deterministic text digest of the board + live hermes snapshot data. Writes no file. |
| `bun run canvas:ls [--json]` | agents + operators | list canvases with node/edge counts. |

To **read the board as an agent**: `bun run digest` (text).

### Work plane (agent mutations)

While Junto is running, agents talk to the **local** work control socket, not
to an exported document or the database:

| surface | detail |
|---|---|
| CLI | `dist/junto` (`bun run cli:build`) — `ping`, `doctor`, `capabilities`, `onboard`, `tasks`, `msg`, `request`, `artifact`, board ops; overseer seats also `overseer` |
| Socket | `~/.junto/work/control.sock` (mode 0600). The seat presents `JUNTO_WORK_TOKEN`. |
| Identity | **generation credential** — main mints one value per occupant generation, injects it at spawn, and admits by registry lookup of the frame token. No token file, no token on argv, no client-supplied nodeRef / `JUNTO_NODE_REF`. `overseer.live` still reads the Unix peer PID once per connection. Browser-protected routes still admit by peer PID. |
| Authz | **edges** — ordinary agents only act on connected nodes (kernel-enforced ScopeError otherwise); board ports are distinct (`board.create_topic` vs `board.post`). An overseer bypasses edge scope for closed `overseer` ops after live grant admission; pause/blocked do not deny those ops. |

**How to use:** open the agent chat in Junto so the seat is spawned with `JUNTO_WORK_TOKEN`, then run `dist/junto` from that agent tree. `onboard` / `capabilities` report the live edge contract for the admitted principal.

**How a seat learns Junto: `junto onboard`, and nothing before it.** Junto
sends nothing to a harness at session start, on any harness: no doctrine by
system-prompt flag, agent file, rules directory, argv prompt, or typed first
message. There are no injection tiers. A fresh seat opens to the harness's own
empty composer.

- `junto onboard` is the one loader. Its output stays short: a few lines of
  guidance, the seat's facts (seat, region briefing, connections), the
  operator's soul and standing instructions for the seat, and the commands
  each connection allows, compiled from the ports held on that edge
  (`src/shared/seat-onboarding.ts`). A seat is never taught a command its
  edges do not grant.
- Reference stays behind `junto docs`, `junto schema show` and
  `junto examples show` (`src/shared/junto-doctrine.ts`, `junto-docs.ts`).
  Do not grow onboard to carry it.
- Onboarded means the seat's own process ran `junto onboard` in this harness
  session. Mail to a seat that has not onboarded carries the pointer on its
  own line ("new to this seat? run `junto onboard` first"), never as a
  separate message. The one-sentence nudge and its cadence live in the
  supervisor (`term/injection-supervisor.ts`).
- No harness config is written, and no plugin or hook is installed, to make a
  seat aware of Junto.

Browser control (`junto browser` / `bun run browser`) uses the same process-bind
identity on protected routes. There is **no enable-grant ceremony** and no client
capability secret — only a live registered process + human-drawn edges to page
nodes. Content transfer is `junto content-transfer …`. Packaged installs ship
**one** CLI binary (`bin/junto`) only.

Ops go through WorkService (tasks/messages/requests/artifacts/board). That is
the ordinary agent write path. Freeform canvas authoring remains human,
except closed overseer commands from a live granted seat.

**Board:** `board.mark_read` is install-local. Operator megaphone / edge `wake` is UI only; agent posts never wake.

**Pad (shared page):** a work-plane sink (same class as board). Ordinary agents read a picture + IR and patch named boxes and pins. They never write the canvas. Ports are `pad.read` and `pad.patch` only. Ordinary agent ink or image upserts are refused. Mentions must be inbound actor node ids. An overseer uses closed `overseer` pad/canvas ops, not a pad-plane canvas write.

- Contract and guide: [`docs/pad.md`](docs/pad.md)
- CLI: `junto pad read`, `patch`, `digest`, `svg`, `look-here`, `get`, `tagged`

### Machines

[`docs/machines.md`](docs/machines.md) is the contract. In short:

- **One program.** Every machine runs the same Junto core; a window is a shell
  on top. A feature that works for a local seat works for a seat on any
  machine, or it is not done.
- **One canvas, one editing machine.** Other machines hold a read-only copy as
  ordinary rows. There is no merging of concurrent edits.
- **A seat lives on one machine**, which starts it, holds its terminal, mints
  its token and stores its mail, signals and sessions. Its `junto` CLI talks
  only to its own machine.
- **Mail waits** for a machine that is out of reach and is delivered when a
  path exists.
- **An agent can exercise all of it, alone.** Every operation has a command an
  agent can run and a result it can read, and the window calls the same
  commands. A slice that can only be exercised by hand is not done. The
  exercise in `docs/machines.md` is the proof, run on real machines.
- There is no Command Center, Remote, station or fleet, in code or in copy.
  The word is machine.

## The model

`src/shared/model/` is the contract. Import from `@shared/model`.

- **Node** — a closed union on `kind`: `agent` (a seat), `terminal`, `page`,
  `task`, `requests`, `artifacts`, `board`, `pad`, `sheet`, `cron`, `relay`,
  `watcher`, `note`, `label`, `file`, `link`, `git`, `region`. Each kind has
  exactly its own fields. A new kind is a new member with its own table, never
  a string and a bag, and decoding refuses a field a kind does not have.
- **Wire** — `from`, `to`, `verb`, an optional `mask`, and the sides it
  attaches to.
- **Command** — how anything changes: `Add`, `Remove`, `Move`, `Restack`,
  `Recolor`, `Edit`, `Rewire`, and the canvas ones. A command names the rows it
  touches. Nothing sends a canvas back to be saved.
- **Changed** — what main emits after a commit: the canvas, a running `seq`,
  and exactly the rows that changed. A listener applies it and does not read
  again. `Opened` is the one read, when a canvas is opened.

Live work is never on a node. Mail, tasks, requests, artifacts, board posts
and pad shapes are rows of their own, read in pages by the id of the node they
belong to, each with its own change event.

The measure of this design is the window: thousands of mails between hundreds
of seats must not cost it a frame, and one command must change one row.

**`verb` is the one authored fact on a wire** — what the relationship *is*. Everything else (ports, claimability, board wake, watch predicates, scheduler fire actions, task-path flow, scheduler chaining) is **compiled** from the verb plus the two endpoint kinds (`src/shared/physics/verbs.ts`, `compileVerb`) — never stored on the edge, never mirrored back. `fromNode` is always the verb's semantic source end, whichever way the operator drew it (`task --works--> agent`, never the reverse).

**The verb table** — at most two verbs per ordered kind pair; a pair absent from the table refuses connect:

| source → target | verbs | compiled |
|---|---|---|
| agent → agent | `messages` \| `reviews` | msg ports; or directed `verdict.post` |
| agent → task | `manages` \| `contributes` | task ports (`contributes` adds `tasks.claim`) |
| agent → artifacts | `publishes` | `artifact.publish` |
| agent → board | `messages` \| `participates` | board ports; `wake` false / true |
| agent → pad | `reads` \| `edits` | `pad.read` (`edits` adds `pad.patch`) |
| agent → page | `navigates` | `browser.automate` |
| agent → relay | `fires` \| `announces` | `relay.trigger`; or a watch on the seat's raised hand (an open `junto blocked` / `junto escalate` signal) |
| task → agent | `works` | task ports; `claimable: true` — the claim selector reads this |
| task → task | `feeds` | no ports; `flow: true`, DAG-guarded task-path hop |
| {task,requests,artifacts,board,page} → relay | `announces` | watch on that sink's own headline event |
| {relay,clock} → agent | `wakes` | `inject_prompt` |
| {relay,clock} → task | `enqueues` | `enqueue_task` |
| {relay,clock} → {relay,clock} | `chains` | `chain: true`, cycle-guarded |
| terminal (either side) | — | no verb reaches it yet |

`clock` is the shared row for the non-relay schedulers (`cron`, `timer`, `watcher`) — they push identically; only `relay` also takes `announces` inbound (the only scheduler that evaluates a watch predicate). Plain connect (no picker) defaults to the fuller relationship on a two-verb pair: `contributes`, `participates`, `edits`, `fires`, `enqueues`, `wakes`.

**Stoppage is still derived, not authored** — an actor holding a claimed item in `input-required` / `auth-required` on a connected task/requests sink generates **blocks** on that actor seat only. Open queue (`submitted`/`working`) never blocks. No automatic multi-hop fan-out — multi-hop stoppage is an explicit **relay** node (`announces` in, an effect verb out). (Blockability is `role === "actor"` only — see [`architecture-canvas-physics.md`](docs/architecture-canvas-physics.md) §2a.) Lexicon word **stops** may appear in wire sentences when derived stoppage applies — speech, never a document field.

There is **no edge dialog**. Edges are authored and read from the RTS bottom bar (`EdgeCommandCard`, `src/renderer/components/rts/RtsControls.tsx`) as a plain sentence ("Planner manages Backlog"), painted in a fixed per-verb hue (`--wire-verb-*` custom properties, [`factory-grammar.css`](src/renderer/styles/factory-grammar.css)) — solid strokes only; no dash, width, or arrowhead carries meaning.

Live **phase** is only `blocks` | `relates`, and it is derived, never stored.
Derived state (blocked seats, region membership, live phase) is recomputed from
the model and live work.

## Copy law: no middle dots, ever

The middle dot (U+00B7) is banned from every surface: product copy, UI strings,
generated sheets, docs, artifacts, commit-facing summaries. Separate with
commas, em dashes, or plain spaces. Derived wire sentences are spoken compounds
("access stops", "watch completes") — never dotted. This is an operator hard
invariant; reintroducing a middot is a defect.

**No mechanics in operator copy.** Operator-facing UI never exposes kernel,
physics, or capability jargon: ports, grants, masks, compiles, wire families,
stoppage, or wires explained as a mechanism. Say what the operator can do, in
plain words, or say nothing. A connection card names its peer; the edge card
reads as a sentence ("Planner manages Backlog"). Explainers that restate the
physics on every surface are removed, not reworded. Agent-facing docs and CLI
output (`junto-docs.ts`, `capabilities`, `onboard`) are exempt: agents need
the contract.

## Kernel: cron, relay (+ dormant gauge) — verbs

An edge into or out of a scheduler authors only a **verb**; the watch predicate and fire action it produces are compiled,
never stored. Only schedulers push; actors pull. Connect refused for any pair
absent from the verb table (sink–sink, geography).

**Product scheduler plane:**

| Kind | How it binds | Fire |
|---|---|---|
| **cron** | its `expression` | Durable due → the outbound verb's compiled effect (`enqueues` / `wakes`) |
| **relay** | inbound `announces` edges (watch, OR-combined across parallel edges); outbound `enqueues` / `wakes` edges (effects) | Rising edge on watch → apply the outbound edges' effects |

**Not a product peer:** hermes **gauge** (`watcher`) is palette-hidden / dormant; it shares the `clock` scheduler row with `cron`/`timer` but has no palette entry.

**Effects (v1):** `enqueue_task` - `inject_prompt` — the compiled facets of
`enqueues` / `wakes`. Task claiming stays in the workspace
tick (`works`'s compiled `claimable` grant, not an effect). No `relayState`
cascade — multi-hop stoppage is a **relay** node, `announces` in and an
effect verb out, only.

**Scheduler laws**: (1) Sensor truth is derived. (2) Single-home evaluation.
(3) Interval catch-up ≤1 due tick. (4) **Automate only while the canvas is
playing** — otherwise show status/`nextFire` but do not consume rising-edge
memory or durable cron firing slots.

**No operator flags.** A seat raises its own hand (`junto blocked`,
`junto escalate`); stoppage is derived. Pause is canvas-wide only: there is
no node or region pause.

## Sources (read-only adapters)

`src/main/junto/adapters/` — live: **hermes** (+ exec helpers). A down hermes degrades to a stale badge; it never touches the model. hermes enumerates profiles on this machine and on other hosts over ssh.

## In-app planes

**Attached agent chat** — one live ACP session per agent node (`<host>:<profile>`); resumable across app sessions (channels: `chatOpen`, `chatPrompt`, `chatPermission`, `chatSetModel`, `chatClose`). Main process owns the `hermes acp` child; renders in the canvas as inline composition.

**Native terminals** — `terminal` is the default terminal entity. TermPlane owns
local sessions and app quit stops local sessions only through the sealed
process-signal capability plane (never bare `process.kill(pid)`).

**Seat occupancy law** — occupancy is independent of process liveness.
- A seat is vacant or occupied.
- Occupying a vacant seat and activating an occupied seat are different command families. Create is occupy. Create on an occupied seat is a bug.
- Stopping still occupies the seat. Exited / missing / unknown is vacant.
- Resumable / crashed / stalled / paused belong to the occupant process, not the seat.
- A seat on any machine shares this contract. Its machine selects the process Layer. It does not change occupancy.
- Pin / unpin / remount must not occupy. They activate (or just keep the view).
- Code: `src/shared/terminal-seat-occupancy.ts`, `src/main/junto/term/seat-process.ts`.

**Named session resume law** — a seat resumes one explicit harness session id,
or it starts fresh. There is no "continue whatever was last." Harness
`--continue`, bare `--resume`, and latest-session pickers are not a
Junto feature and must never be emitted. (`junto offboard --continue` is
unrelated: the agent hands off to a fresh session of its own seat.) Code:
`src/shared/managed-terminal-launch.ts`.

**Focus surfaces** — centered, measure-constrained overlays for single-subject work (one agent, one terminal, one page). Prefer these over full-bleed or stage-split when the interaction is deep and solitary. Shell: `FocusSurface` (`src/renderer/components/FocusSurface.tsx`); measures + math: `src/renderer/lib/focus-measure.ts`.

| measure | width intent | use |
|---|---|---|
| `prose` | ~65ch reading line | long copy |
| `document` | ~760px, resizable | session-shaped readers when present |
| `terminal` | ~140 mono cells @ 13px (~1100px) | agent PTY |
| `workspace` | ~1280px immersive | focused browser / multi-pane still framed |
| `form` | ~448px fit | wizards |

Techniques baked in: dim+blur backdrop, titlebar-aware padding, enter animation (respects `prefers-reduced-motion`), portal to `document.body`, layer (`detail` vs `work` z-index). Dock/split remains available for multi-surface work; focus is the default for one subject.

## Design system

The renderer has one visual language with two modes — `dark` (default) and `bright`, a designed daylight edition, never a mechanical inversion. Shared traits: warm ground (never pure black, never pure white), ink text, ~95% amber with sparse accents, crimson reserved for blockers, hairline ink strokes, mono instrument type + condensed display for titles. One token source, several projections, never a second palette:

- **Tokens** — `src/shared/theme/` is the single source of truth: OKLCH primitives (`primitives.ts`) assigned meaning per mode in the semantic layer (`semantic.ts`). `bun run theme:build` projects it to `src/renderer/styles/theme.generated.css`, which registers the palette as Tailwind v4 utilities (`text-ink`, `text-dim`, `text-faint`, `bg-ground/raise/raise-2/inset/well`, `border-stroke`, `text-amber/cyan/violet/crimson/…`, `font-mono`, `font-display`) plus `html[data-theme="bright"]` overrides. `src/renderer/lib/theme.ts` re-exports the same source for runtime consumers (canvas paint, inline styles); `src/shared/svg.ts` imports it for the SVG export. Never hardcode palette hex/rgba — edit the source and regenerate.
- **Primitives** — `src/renderer/components/ui/`: `Button` (chrome/primary/subtle/danger - xs/sm/md), `IconButton`, `Eyebrow`, `StatusDot`, `Chip`, `Input`/`Select`/`FieldLabel`, `OverlayHeader` (eyebrow/title/status/actions chrome header for every work-surface panel), `ToolbarPill` (floating node toolbar), `Kbd` (hotkey/gesture chip), `HelpMap` + `HelpMapGroup` / `HelpMapKeys` (interaction maps — compose anywhere; canvas fill lives in `components/help/CanvasInteractionMap.tsx`). New surfaces compose these; do not hand-roll buttons, headers, status dots, or help chrome.
- **Canvas card law — no action buttons on nodes.** Cards are glance + identity only. Open via double-click or RTS kind-strip keys; config via kind-strip pops; delete and Stop live on the selection toolbar / RTS command card. The only on-card controls allowed are pure instrumentation (enqueue + on tasks glance, activity marks). Never put "open" / "stop" / "detach" / form CTAs on the card body.
- **Terminal look** — `src/renderer/lib/terminal-theme.ts` (`JUNTO_XTERM_THEME`, font family/size) is the one xterm theme for every terminal surface.
- **Focus law** — focus is operator-owned. `src/renderer/lib/focus-ownership.ts` is the only place that calls `focus()`, `blur()`, or `select()`: use `claimFocus(el, "gesture" | "open" | "async")`, `releaseFocus`, and `claimFocusOnMount` (never JSX `autoFocus`). While the operator types in a field (input, textarea, select, contenteditable, xterm), only a pointer press outside it or a Cmd/Ctrl chord licenses a claim elsewhere; async work never takes or drops it, and background canvas flushes never blur. Global key listeners return early on `isOperatorTyping(event.target)` or carry a `// focus-law:` note. Gate: `bun run lint:focus-law` (in `verify`).
- **Sound** — `src/renderer/lib/sound/` is the only sound path: synthesized on Web Audio, with no audio files and no HTMLMediaElement (that path raises the macOS media library prompt). Callers name what happened (`playCue`, `playNotificationCue`); the cue catalog picks the sound and the mixer decides whether it plays. Louder means more urgent: `bun scripts/sound-demo/render.ts` renders every cue to a WAV and fails if measured loudness stops following urgency.
- **Layers** — the app stacks in three systems and every overlay belongs to exactly one: **base** (the canvas, pinned tabs, the dock, the bars), **working modals** (terminals, the agent focus view, grids, readers, settings), and **operator modals** (search `cmd+K`, the needs-you feed `cmd+I`, the agent switcher), which sit above everything and open from anywhere. One source for app-level z-index: `src/renderer/styles/layers.css` (`--layer-working`, `--layer-working-dialog`, `--layer-popover`, `--layer-flyout`, `--layer-operator`, `--layer-operator-popover`, `--layer-tooltip`). A z-index of 100 or more must be one of those tokens (gate: `bun run lint:layers`).
- **Shells** — an overlay renders through its layer's shell, never a hand-rolled portal: `FocusSurface` for a working modal, `Dialog` / `ConfirmDialog` (`components/ui/`) for a short decision or form above it, `Popover` and `Dropdown` for anchored panels, `OperatorModalShell` (`components/operator-modal/`) for operator modals. A shell owns the backdrop (one recipe, the `[data-layer-backdrop]` rule in `layers.css`), the focus trap, focus restore, and Escape, which `src/renderer/lib/modal-stack.ts` sends to the topmost modal only. Do not add a backdrop, a window Escape listener or a z-index number to a surface; give the shell an `onKeyDown` for body keys. Panel headers go through `OverlayHeader`.

The **E2E design-audit loop** (`e2e/scenarios/design-audit.spec.ts`) drives every reachable surface with seeded fixtures + fake hermes/codexbar and screenshots them to `test-results/design-audit/`. It is an explicit capture tool (`bun run test:e2e:audit`), not a routine gate: a local visual change needs the relevant surface spec's screenshots, not every surface; broad theme/shell changes can justify the full audit. Screenshots are disposable test output and must never be committed.

On Linux, `bun run dev` and `scripts/run-e2e.sh` use an existing X11 or
Wayland session. In Amp orbs they attach to the active orb Desktop even though
the agent shell does not inherit its display variables. E2E falls back to
Xvfb only when no desktop is active; retain that path for CI, OrbStack, and
other headless Linux hosts.

## Structure

- `src/shared/model/` — **the contract**: kinds, wires, commands, events. Change deliberately; everything depends on it.
- `src/shared/` — shared pure logic: `entities.ts` (snapshots), `graph.ts` (derived), `region-rollup.ts` (derived region severity rollups), `digest.ts`, `svg.ts`.
- `src/main/junto/state/` — the one SQLite engine and composed current schema.
- `src/main/junto/` — model/work services, data adapters, and IPC/control boundaries.
- `src/renderer/` — the canvas surface.
- `scripts/` — the headless CLIs above.

## Machine safety (architecture north star)

**Junto must never threaten the user's machine.** Host-destructive power is not
“handled carefully in tests” — it is made **unrepresentable** without a capability
Junto mints when it owns the resource.

- **Law:** no ambient `kill(pid)` / open host wipe APIs. Domain types + Effect
  Schema + branded handles only.
- **Process signals:** `src/main/junto/process-signal.ts` — sole site for
  `process.kill(-pid)`. Flow: `admitSpawnedProcess` → `OwnedProcess` (unique
  symbol + WeakMap authority) → `signalOwned` / `releaseOwned`.
- **Full doctrine:** [`docs/architecture-machine-safety.md`](docs/architecture-machine-safety.md).

PR test: *Can a confused agent or bad test pass a bare pid/path into a
host-destructive call? If yes, the change is not done.*

## Canvas physics (architecture north star)

**The canvas is a workspace, not an ACL spreadsheet.** Edges are ocaps
(mint by draw, attenuate via ports, revoke by delete); process-bind wields the
seat. Roles derive from kind. Capability,
phase, and attention/occupancy are separate planes.

- **The law:** four derived physics roles, and **exactly one actor kind — `agent`**, the
  Junto-spawned template terminal. A raw user-opened terminal is
  `geography/"terminal"`; `worker` is reserved for a future native agent UI and
  must not appear as a kind. Geography holds no seat, no ports, no inbox, and no
  work claim — but it *may* display agent state, because display is not a canvas
  power. A seat's machine is data: it never gates a port.
- **PR test:** no ordinary work capability without a connected edge, a matching port, and a live generation credential. Browser-protected ops still also require peer process-bind.
- **Full doctrine:** [`docs/architecture-canvas-physics.md`](docs/architecture-canvas-physics.md).

## Discipline

- `~/.junto/state/junto.db` is the only **product** state store. Do not add
  parallel product JSON stores, manifests, seals, pointer files, drop-file
  protocols, dual product reads/writes, legacy imports, or rollback paths.
  Install-local internals (backfill ledgers, content object files) are not
  product state: they must not live as product tables that get seeded or
  projected as operator truth.
- The installation's sole app runtime process is the only normal database
  opener (product + install-ops): the Junto core on that machine. Other
  headless surfaces and other machines use app-owned IPC, control APIs or a
  link.
- Adapters are read-only. The operator authors intent; agents mutate only the
  work plane through `WorkService`.
- Board/source IDs and tokens never leak into committed source.
- `bun run typecheck && bun run test` gate every change.
- Host-touching code follows Machine safety (above) — fail closed, capability-first.
- Agent reach follows Canvas physics (above): edges, ports, and a live generation credential. No ambient region grants. Browser-protected ops still also require peer process-bind.

## Testing

No test waits on a real clock for product time to pass. Rules that depend on
time are tested through an injected clock or as pure functions. A spec that
needs minutes of wall time is deleted, not skipped.

## State migrations — hard law

Two kinds of migration exist and they never mix:

1. **Schema evolution** — DDL steps in
   `src/main/junto/state/migrations.ts`: versioned (`user_version` N→N+1),
   identity-witnessed, one startup transaction, authorizer-guarded. An
   expand-only step adds tables/columns/triggers and never rewrites rows; a
   consolidate step may also drop exactly the tables it names in
   `removesTables` (1 -> 2 retired the mail delivery ledger this way) and
   rename exactly the ones in `renamesTables` (20 -> 21 gave the identity
   tables their plain names).
2. **Data backfills** — marker-gated, idempotent walks that run after
   StateEngine is up (e.g. `content/inline-media-migration.ts`). Completeness
   markers live in install-ops (`install-ops.db` / `InstallOpsService`), not
   in product tables. Dev seeds may copy `junto.db` + content files; they
   must never copy install-ops ledgers.

Backfill laws (each one broke, or nearly broke, a real release):

- **The work log is immutable to backfills.** `work_events` and `work_facts`
  are never UPDATEd or DELETEd, not even to "modernize" old payloads. History
  is served as written; decode paths admit historical shapes. Backfills
  rewrite materialized rows only.
- **A backfill never gates boot.** Failure = log it, leave the marker pending,
  retry next boot. The app always opens; a half-done backfill is a deferred
  walk, not a startup error.
- **Idempotent by construction.** Content-addressed ingest, per-row
  transactions, safe resume from any interruption.
- **Install-local ledger.** Backfill completeness is install-local
  bookkeeping, not product state — separate Effect layer/service and
  separate on-disk store from `junto.db`.
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
