# AGENTS.md — Junto

**Junto** is a desktop station (Electron + Effect + React) that
renders a **portfolio canvas**: agents, work surfaces, notes, and regions as
spatial nodes; dependencies/blockers/relationships as edges; named regions as
geography. The current canvas serialization is a
[JSON Canvas 1.0](https://jsoncanvas.org) document extended with a namespaced
`ether` key.

## Product name: Junto

**The product name is Junto.**

Every public, user-facing, and runtime string uses the name **Junto**.

**Enforcement:** `bun run lint:product-name` — verifies product name usage across the codebase. Wired into `bun run verify`. Constant: `src/shared/product-name.ts` (`PRODUCT_NAME`).

## Security doctrine — read first

[`docs/security-doctrine.md`](docs/security-doctrine.md) is the governing
product trust model. It defines Junto as a single-operator station,
attached agents as trusted but fallible, edges as enforceable operator intent
inside Junto, and Stations as single-home executors of Command Center
intent. If a review, backlog item, test, or older architecture note conflicts
with it, the conflict is migration work. Newly emitted traffic has no legacy
codec or namespace.

[`docs/junto-protocol.md`](docs/junto-protocol.md) is the canonical
multi-installation contract: identity, complete intent projection, sink/item
authority, synchronous CC-home task claims, offline Remote execution, logical
event convergence, the closed Station operations, and transport adapters.
Protocol 1 remains prerelease. The closed operations are `pair`, `configure`,
`project`, `report`, `status`, and `overseer`. `overseer` is not an RPC tunnel.

**Normative direction:** the protected document is the product; compiled
projections and capability-bound tools are the agent API. **Sole product
store** is `~/.junto/state/junto.db` — canvases, work, content manifests,
station, settings, and every other product durable fact. That law is about
**product** durability, not process-internal bookkeeping: install-local
internals (e.g. backfill ledgers in `~/.junto/state/install-ops.db`, content
object files under `~/.junto/content/`) may use separate on-disk stores
owned by the same app runtime. Do not fold migration/backfill completeness
markers into product rows so seeds and installs cannot lie about local
walks. Each installation has one sole app runtime process as the normal
opener of product and install-ops databases, and one `StateEngine`
connection for `junto.db`: Electron main on Command Center, or the
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

**SQLite evolution law:** Version 1 is the baseline Junto schema, selected by
`CURRENT_STATE_SCHEMA_VERSION = 1` and declared in `src/main/junto/state/migrations.ts`.
`PRAGMA user_version` selects a contiguous forward-only migration chain, and
`state_schema_identity` proves the exact shape expected at each step. Every
subsequent schema edit must increment the current version, append an atomic
`N → N+1` migration (starting with `1 → 2`), and prove existing rows survive.
Shipped migration history is immutable: never edit, delete, reorder, or renumber
a released step.

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
installed system to delete `junto.db`; never add a downgrade, old-schema
runtime reader, dual write, or file-store compatibility path.

Authorial canvas writes persist one relational current graph
(`canvas_documents`, `canvas_objects`, `canvas_nodes`, `canvas_edges`),
content-addressed immutable `canvas_checkpoints` (reused when the serialized
body is unchanged), compact `canvas_generation_manifests`, and an append-only
`canvas_commit_envelopes` row in the same SQLite transaction as
`canvas_generations` / `canvas_head`. Automatic deletion of
`canvas_generation_documents` bodies is removed. Historical generation
document rows remain readable and are never rewritten. Future physical
compaction is a separately approved operation with backup, parity, fleet, and
Work-reference proofs.

**Station skew law:** app release, local SQLite schema, and Station protocol
are distinct facts. Only the one Station protocol integer selects wire
behavior. Each release advertises
`{ preferred, compatibleFrom, warnBelow }`; peers choose the highest common
exact codec and warn when the result is below either threshold. Remote Stations
are unreleased, so every Remote-specific contract remains version 1 and the
current Station policy is `1/1/1`; the release-state gate forbids a bump until
its exact sentinel declares release. No overlap means explicit `update required`
while the Remote continues locally under its last projection; it never means
partial down-conversion. Do not add separate session/API/Work/projection version
negotiation or capability arrays. After release, a codec retires only after every
enrolled Station using it is upgraded or explicitly retired and its pending
records are reconciled.

Semantic compatibility analysis (Exact / Restricted / Unsupported) is
diagnostic only. Operational admission accepts Exact alone; Restricted and
Unsupported fail closed without projection, Work, cursor, or ACK movement and
never widen grants, effects, transitions, operations, or acceptance. They may
explain what is withheld to the operator, but they are never a partial
down-conversion.

An older Command Center binary that finds `PRAGMA user_version` ahead of its
`CURRENT_STATE_SCHEMA_VERSION` refuses deterministically before opening
`junto.db` for write: the read-only `schema-version-probe` reports
`newer-than-supported`, and `startup-schema-recovery` surfaces a plain
"Update required" path (quit, or install the newer feed build). It never
opens, migrates, downgrades, or partially decodes advanced state.

---

## Dependencies

Bleeding-edge and unstable dependency versions are permitted. Retain Legend
State v3; its prerelease status is not a reason to downgrade it.

## The agent surface (headless — no GUI needed)

**Ordinary agents never write the canvas.** The canvas is human-authored in
Command Center. Ordinary agents consume compiled projections and local
Junto tools under edge-scoped work control.

**Overseer exception (narrow).** A human may toggle overseer on an existing
managed agent seat. That seat keeps the `agent` kind, gains a distinctive UI,
and may use closed `junto overseer` commands for operator-equivalent
canvas, node, and work operations without connecting edges. It may occupy
Command Center or Remote. Command Center validates the live grant and
authenticated source installation and performs authoring; a Remote does not
author projection. Only humans grant or revoke; overseers cannot propagate
authority. Factory pause and play have no bearing on administration. An
overseer cannot delete its own seat or move the operator viewport. It does
not receive the operator socket, fleet enrollment, or credentials.

See [`docs/overseer-plan.md`](docs/overseer-plan.md) and
[`docs/overseer-coverage-matrix.md`](docs/overseer-coverage-matrix.md).

Headless CLIs reach `CanvasesService` through the running app's owner-local
canvas control socket. They do not open `junto.db`. Ordinary agents
remain strictly read-only for authorial intent. Current headless CLIs:

| command | who | what it does |
|---|---|---|
| `bun run digest [name]` | agents + operators | print (and write `<name>.digest.txt`) a deterministic text projection of the board + live hermes snapshot data. |
| `bun run render [name]` | agents + operators | write `<name>.svg` — an image of the board, for multimodal reading. |
| `bun run canvas:ls [--json]` | agents + operators | list canvases with node/edge counts. |

To **read the board as an agent**: `bun run digest` (text) or `bun run render` then view the SVG (image).

### Work plane (agent mutations)

While Junto is running, agents talk to the **local** work control socket, not
to an exported document or the database:

| surface | detail |
|---|---|
| CLI | `dist/junto` (`bun run cli:build`) — `ping`, `doctor`, `capabilities`, `onboard`, `tasks`, `msg`, `request`, `artifact`, board ops; overseer seats also `overseer` |
| Socket | `~/.junto/work/control.sock` + bearer token `~/.junto/work/token` |
| Identity | **process-bind** — CLI must run as a descendant of a live Junto agent (ACP) process. Main registers those PIDs; control admits via Unix peer PID (+ PPID walk). No client-supplied nodeRef / `JUNTO_NODE_REF` identity claim. |
| Authz | **edges** — ordinary agents only act on connected nodes (kernel-enforced ScopeError otherwise); board ports are distinct (`board.create_topic` vs `board.post`). An overseer bypasses edge scope for closed `overseer` ops after live grant admission; pause/blocked do not deny those ops. |

**How to use:** open the agent chat in Junto so the process is registered, then run `dist/junto` from that agent/tooling tree. `onboard` / `capabilities` report the live edge contract for the admitted principal.

Browser control (`junto browser` / `bun run browser`) uses the same process-bind
identity on protected routes. There is **no enable-grant ceremony** and no client
capability secret — only a live registered process + human-drawn edges to page
nodes. Station wire entry is `junto station-stdio`; content transfer is
`junto content-transfer …`. Packaged installs ship **one** CLI binary
(`bin/junto`) only.

Ops go through WorkService (tasks/messages/requests/artifacts/board). That is
the ordinary agent write path. Freeform canvas authoring remains
human/Command Center except closed overseer commands from a live granted seat.

**Board residency:** board is a **Command Center-homed global sink** (same residency class as actor mailboxes). Sink definition is in the fleet projection; material topics/posts live only on CC. Remote agents enqueue `board.topic.create` / `board.post.append`; Remotes store applied dispositions/events and do **not** rematerialize board rows. List/read the full board on Command Center. `board.mark_read` is install-local. Operator megaphone / edge `wake` is CC UI only; agent posts never wake.

**Pad (shared page):** a Command Center-homed work-plane sink (same class as board). Ordinary agents read a picture + IR and patch named boxes and pins. They never write the canvas. Ports are `pad.read` and `pad.patch` only. Ordinary agent ink or image upserts are refused. Mentions must be inbound actor node ids. An overseer uses closed `overseer` pad/canvas ops, not a pad-plane canvas write.

- Contract: [`docs/pad-architecture.md`](docs/pad-architecture.md)
- Operator and agent guide: [`docs/pad.md`](docs/pad.md)
- CLI: `junto pad read`, `patch`, `digest`, `svg`, `look-here`, `get`, `tagged`

### Station roles

- **Command Center** — user-selected. Human authors the canvas; fleet management via host registry. Overseer mutations from any granted seat are authored here.
- **Remote** — user-selected. Capability host for that machine; applies complete Command Center projections and executes host-local rows. A Remote overseer occupant may send closed `overseer` on the existing Command Center-opened session; it does not author projection.
- Role is never inferred from hardware or open windows.
- Doctor service `station` reports role, installation identity, database/work/simulation readiness, projection, and logical cursor state.

**Station process mode — hard law:**

- Process mode is Unenrolled | Remote | Command Center. One mode.
- Enroll door and peer door are mutually exclusive.
- Unenrolled binds enroll only (`status` / `pair` / `configure`).
- Remote binds peer only (`status` / `project` / `report` / `overseer`).
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
    "entity": { "kind": "agent", "name": "local:worker" },  // open vocab; well-known product: agent|terminal|task|requests|artifacts|page|cron|relay (+ dormant watcher/gauge; timer aliases cron)
    "flags": ["blocker"]                                     // blocker|parked|attention
  } }
```

Edges: `{ "id", "fromNode", "toNode", "ether": { "verb": Verb } }`.

**`verb` is the one authored fact on an edge** — what the relationship *is*. Everything else (ports, claimability, board wake, watch predicates, scheduler fire actions, task-path flow, scheduler chaining) is **compiled** from the verb plus the two endpoint kinds (`src/shared/physics/verbs.ts`, `compileVerb`) — never stored on the edge, never mirrored back. `fromNode` is always the verb's semantic source end, whichever way the operator drew it (`task --works--> agent`, never the reverse).

**The verb table** — at most two verbs per ordered kind pair; a pair absent from the table refuses connect:

| source → target | verbs | compiled |
|---|---|---|
| agent → agent | `messages` \| `reviews` | msg ports; or directed `verdict.post` |
| agent → task | `manages` \| `contributes` | task ports (`contributes` adds `tasks.claim`) |
| agent → requests | `escalates` | msg ports (raising a hand is the universal `junto escalate`, `blocked`, `feedback`) |
| agent → artifacts | `publishes` | `artifact.publish` |
| agent → board | `messages` \| `participates` | board ports; `wake` false / true |
| agent → pad | `reads` \| `edits` | `pad.read` (`edits` adds `pad.patch`) |
| agent → page | `navigates` | `browser.automate` |
| agent → relay | `fires` \| `announces` | `relay.trigger`; or a watch on the agent's own attention flag |
| task → agent | `works` | task ports; `claimable: true` — the claim selector reads this |
| task → task | `feeds` | no ports; `flow: true`, DAG-guarded task-path hop |
| {task,requests,artifacts,board,pad,page} → relay | `announces` | watch on that sink's own headline event |
| {relay,clock} → agent | `wakes` \| `flags` | `inject_prompt` \| `set_flag` |
| {relay,clock} → task | `enqueues` \| `flags` | `enqueue_task` \| `set_flag` |
| {relay,clock} → other sinks | `flags` | `set_flag` |
| {relay,clock} → {relay,clock} | `chains` | `chain: true`, cycle-guarded |
| terminal (either side) | — | no verb reaches it yet |

`clock` is the shared row for the non-relay schedulers (`cron`, `timer`, `watcher`) — they push identically; only `relay` also takes `announces` inbound (the only scheduler that evaluates a watch predicate). Plain connect (no picker) defaults to the fuller relationship on a two-verb pair: `contributes`, `participates`, `edits`, `fires`, `enqueues`, `wakes`.

**Stoppage is still derived, not authored** — an actor holding a claimed item in `input-required` / `auth-required` on a connected task/requests sink generates **blocks** on that actor seat only. Open queue (`submitted`/`working`) never blocks. No automatic multi-hop fan-out — multi-hop stoppage is an explicit **relay** node (`announces` in, an effect verb out). (Blockability is `role === "actor"` only — see [`architecture-factory-physics.md`](docs/architecture-factory-physics.md) §2a.) Lexicon word **stops** may appear in wire sentences when derived stoppage applies — speech, never a document field.

There is **no edge dialog**. Edges are authored and read from the RTS bottom bar (`EdgeCommandCard`, `src/renderer/components/rts/RtsControls.tsx`) as a plain sentence ("Planner manages Backlog"), painted in a fixed per-verb hue (`--wire-verb-*` custom properties, [`factory-grammar.css`](src/renderer/styles/factory-grammar.css)) — solid strokes only; no dash, width, or arrowhead carries meaning.

**One-shot legacy conversion:** `scrubCanvasDocInput` (`src/shared/canvas.ts`) reads a legacy edge's retired wire fields (`ports`, `stops`, `wake`, `slot`, `when`, `does`, `flow`, the node-body `ether.relay`) exactly once on decode, infers the verb it always meant (`inferVerb`), and re-stores the edge as `{ verb }` in the verb's own semantic order — never both. An edge whose endpoints cannot hold any inferred verb (geography, unknown kind, a missing node, a pairing the grammar never admitted) is **dropped**, not defaulted; a hand-edited `verb` the pair cannot hold is dropped the same way. There are no users, so this is the only conversion the format ever gets.

**Retired (scrubbed on load, dead as product surface):** `ports` / `stops` / `wake` / `slot` / `when` / `does` / `flow` as authored edge fields; the derived `ether.kind` phase mirror on edges; the edge dialog / wire sheet; `criteria` / `notify` / `effect` dual keys; `proof` / `approval` edge modes and Hold UI; `ether.relayState` cascade; node-body `ether.relay`; `glyphs`/`wip` stop modes; glyph watcher kinds; private-source watchers; `ether.view` project slices; `depends` phase; automatic dependency cascade. `project` is no longer well-known, though the open `entity.kind` vocabulary still permits it as inert furniture.

Live **phase** is only `blocks` | `relates` (derived) — projected onto the edge's native `color`/`label`, never onto `ether`.

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

## Kernel: cron, relay (+ dormant gauge) — verbs

Region pulse inject is **retired**. An edge into or out of a scheduler authors
only a **verb**; the watch predicate and fire action it produces are compiled,
never stored. Only schedulers push; actors pull. Connect refused for any pair
absent from the verb table (sink–sink, geography).

**Product scheduler plane:**

| Kind | How it binds | Fire |
|---|---|---|
| **cron** | `ether.timer` expression | Durable due → the outbound verb's compiled effect (`enqueues` / `wakes` / `flags`) |
| **relay** | inbound `announces` edges (watch, OR-combined across parallel edges); outbound `enqueues` / `wakes` / `flags` edges (effects) | Rising edge on watch → apply the outbound edges' effects |

**Not a product peer:** hermes **gauge** (`watcher`) is palette-hidden / dormant; it shares the `clock` scheduler row with `cron`/`timer` but has no palette entry.

**Effects (v1):** `enqueue_task` - `set_flag` - `inject_prompt` — the compiled
facets of `enqueues` / `flags` / `wakes`. Task claiming stays in the workspace
tick (`works`'s compiled `claimable` grant, not an effect). No `relayState`
cascade — multi-hop stoppage is a **relay** node, `announces` in and an
effect verb out, only.

**Scheduler laws**: (1) Sensor truth is derived. (2) Single-home evaluation.
(3) Interval catch-up ≤1 due tick. (4) **Automate only when station role is
configured and the canvas is playing** — otherwise project status/`nextFire`
but do not consume rising-edge memory or durable cron firing slots.
(5) **`set_flag` effects / `flagOnUnsatisfied` are Command Center only**
(Remote refuses authorial canvas mutate; fail closed, no silent success).

## Sources (read-only adapters)

`src/main/junto/adapters/` — live: **hermes** (+ exec helpers). A down hermes degrades to a stale badge; it never touches the document. hermes enumerates profiles on the local machine + remote hosts over ssh.

## In-app planes

**Attached agent chat** — one live ACP session per agent node (`<host>:<profile>`); resumable across app sessions (channels: `chatOpen`, `chatPrompt`, `chatPermission`, `chatSetModel`, `chatClose`). Main process owns the `hermes acp` child; renders in the canvas as inline composition. Under the target security doctrine, agents consume runtime projections and tools rather than the authorial document.

**Native terminals** — `terminal` is the default terminal entity. TermPlane owns
local sessions and app quit stops local sessions only through the sealed
process-signal capability plane (never bare `process.kill(pid)`); use a Remote
station when work must survive Command Center quit.

**Seat occupancy law** — occupancy is independent of process liveness.
- A seat is vacant or occupied.
- Occupying a vacant seat and activating an occupied seat are different command families. Create is occupy. Create on an occupied seat is a bug.
- Stopping still occupies the seat. Exited / missing / unknown is vacant.
- Resumable / crashed / stalled / paused belong to the occupant process, not the seat.
- Local and remote share this contract. Placement (local | remote) selects the process Layer. It does not change occupancy.
- Pin / unpin / remount must not occupy. They activate (or just keep the view).
- Code: `src/shared/terminal-seat-occupancy.ts`, `src/main/junto/term/seat-process.ts`.

**Named session resume law** — a seat resumes one explicit harness session id,
or it starts fresh. There is no "continue whatever was last." Harness
`--continue`, bare `--resume`, and latest-session pickers are not a
Junto feature and must never be emitted. Code:
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
- **Primitives** — `src/renderer/components/ui/`: `Button` (chrome/primary/subtle/danger - xs/sm/md), `IconButton`, `Eyebrow`, `StatusDot`, `Chip`, `Input`/`Select`/`FieldLabel`, `OverlayHeader` (eyebrow/title/status/actions chrome header for every work-surface panel), `ToolbarPill` (floating node toolbar), `Kbd` (hotkey/gesture chip), `HelpMap` + `HelpMapGroup` / `HelpMapKeys` / `HelpMapPrimer` / `HelpMapPrimerBlock` (protocol & interaction maps — compose anywhere; canvas fill lives in `components/help/CanvasInteractionMap.tsx`). New surfaces compose these; do not hand-roll buttons, headers, status dots, or help chrome.
- **Canvas card law — no action buttons on nodes.** Cards are glance + identity only. Open via double-click or RTS kind-strip keys; config via kind-strip pops; flags/delete/pause live on the selection toolbar / RTS command card. The only on-card controls allowed are pure instrumentation (enqueue + on tasks glance, activity marks). Never put "open" / "stop" / "detach" / form CTAs on the card body.
- **Terminal look** — `src/renderer/lib/terminal-theme.ts` (`JUNTO_XTERM_THEME`, font family/size) is the one xterm theme for every terminal surface.
- **Focus law** — focus is operator-owned. `src/renderer/lib/focus-ownership.ts` is the only place that calls `focus()`, `blur()`, or `select()`: use `claimFocus(el, "gesture" | "open" | "async")`, `releaseFocus`, and `claimFocusOnMount` (never JSX `autoFocus`). While the operator types in a field (input, textarea, select, contenteditable, xterm), only a pointer press outside it or a Cmd/Ctrl chord licenses a claim elsewhere; async work never takes or drops it, and background canvas flushes never blur. Global key listeners return early on `isOperatorTyping(event.target)` or carry a `// focus-law:` note. Gate: `bun run lint:focus-law` (in `verify`).
- **Overlays** — one backdrop recipe everywhere: `rgba(0,0,0,0.72)` + `blur(2px)`. New single-subject overlays go through `FocusSurface`; panel headers go through `OverlayHeader`.

The **E2E design-audit loop** (`e2e/scenarios/design-audit.spec.ts`) drives every reachable surface with seeded fixtures + fake hermes/codexbar and screenshots them to `test-results/design-audit/`. It is an explicit capture tool (`bun run test:e2e:audit`), not a routine gate: a local visual change needs the relevant surface spec's screenshots, not every surface; broad theme/shell changes can justify the full audit. Screenshots are disposable test output and must never be committed.

The **T0 QA driver** (`bun run qa:t0`) drives the built app's GUI under the same harness and judges it with deterministic oracles instead of screenshots. It makes no model calls.

- **Registry.** `e2e/qa/registry.ts` lists the surfaces (every node kind, edge verb, the palette and settings), the actions that reach them, and the invariants each probe must hold. The context axes are theme, device scale and window size.
- **Sampling.** `e2e/qa/pairwise.ts` samples the space pairwise, never the full cross product.
- **Oracle.** `e2e/qa/oracle.ts` compares two witnesses: the screen, and the running app's own projection. The projection is the compiled canvas and digest, read through the sandbox's canvas control socket by `e2e/qa/witness.ts`. A mismatch is a finding.
- **Ledger.** Findings land in `test-results/qa-ledger.json`, one entry per fingerprint. The fingerprint is surface, action, invariant and a normalized signature; context is excluded.
- **Flake gate.** Any probe that saw a violation reruns twice in fresh launches. A finding is `confirmed` only if it reproduces in 2 of its 3 attempts; otherwise it is `flaky`. Evidence screenshots go under `test-results/qa-t0/`.
- **Filtering.** `bun scripts/qa-t0.ts --only <probe-id substring>` reuses the current build.
- **Gate status.** It is not part of `verify`. Findings never fail the command; only lost probes do.
- **Ledger lifetime.** Any Playwright e2e run empties `test-results/`, so the cross-run merge only survives between consecutive QA runs. Run artifacts (records, evidence) go to a per-run `/tmp/junto-qa-<tier>-*` directory for the same reason.

Two further tiers drive the **packaged** app through [Cua Driver](https://cua.ai/docs) and write to the same ledger.

- **Connection.** Both use one `cua-driver mcp` connection (`e2e/qa/cua.ts`) with the agent cursor off.
- **Isolation.** Each run launches through LaunchServices into a throwaway HOME under `/tmp` (`e2e/qa/packaged.ts`).
- **Target.** They target `release/mac-arm64/Junto.app` only when it is newer than HEAD, otherwise `/Applications/Junto.app`, read-only. They build nothing.
- **Desktop.** Clicks use foreground delivery, so the app window briefly comes to the front.
- **Setup.** Cua Driver must be installed and granted Accessibility and Screen Recording.

| Tier | Command | What it does |
|---|---|---|
| T1 | `bun run qa:t1` | Scripted, no model. Covers first launch into an empty home, the native menu bar (product-name spelling, no developer items), the About panel, macOS prompts that name Junto, View > Reload, quit + relaunch, and the first start of a Claude Code and a Hermes seat added with the default folder in a fresh home (harness screen within 45s, no "resuming", no stuck spinner, ended-card reason recorded; terminal rows read through Terminal > Screen reader mode). Each attempt also reads `/usr/bin/log` for TCC requests attributed to `com.skastr0.junto` at its own pids: non-preflight requests are findings, the full capture is `tcc-attempt-N.json` in the run directory. The app's control socket is the second witness. |
| Explore | `TYPESAFE_API_KEY=… bun run qa:explore --budget N` | Cua's jev-use pattern. Code builds a read-only candidate table from the registry and the live AX tree; Jev picks one id; the driver runs one action; the result is verified against the app's own document. A step with a violation is replayed twice for the flake gate. `--mock` runs without a key. |

On Linux, `bun run dev` and `scripts/run-e2e.sh` use an existing X11 or
Wayland session. In Amp orbs they attach to the active orb Desktop even though
the agent shell does not inherit its display variables. E2E falls back to
Xvfb only when no desktop is active; retain that path for CI, OrbStack, and
other headless Linux hosts. This does not change the packaged Node Remote:
Remote remains deliberately displayless.

## Structure

- `src/shared/` — **frozen contracts**: `canvas.ts` (document schema), `entities.ts` (snapshots), `graph.ts` (derived), `region-rollup.ts` (derived region severity rollups), `digest.ts`, `portfolio.ts`, `svg.ts`. Change deliberately; much depends on them.
- `src/main/junto/state/` — the one SQLite engine and composed current schema.
- `src/main/junto/` — document/work/station services, data adapters, and IPC/control boundaries.
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

## Factory physics (architecture north star)

**The canvas is a workspace, not an ACL spreadsheet.** Edges are ocaps
(mint by draw, attenuate via ports, revoke by delete); process-bind wields the
seat. Roles derive from entity kind — never authorial `ether.role`. Capability,
phase, and attention/occupancy are separate planes.

- **The law:** four derived physics roles, and **exactly one actor kind — `agent`**, the
  Junto-spawned template terminal. A raw user-opened terminal is
  `geography/"terminal"`; `worker` is reserved for a future native agent UI and
  must not appear as a kind. Geography holds no seat, no ports, no inbox, and no
  work claim — but it *may* display agent state, because display is not a canvas
  power. Placement (`Cc | Station{hostId}`) is data: it never gates a port.
- **PR test:** no host capability without connected edge + port + process-bind.
- **Full doctrine:** [`docs/architecture-factory-physics.md`](docs/architecture-factory-physics.md).
- **Cement:** [`tests/factory-physics-architecture.test.ts`](tests/factory-physics-architecture.test.ts)
  holds the three invariants no type can hold.

## Discipline

- `~/.junto/state/junto.db` is the only **product** state store. Do not add
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

1. **Schema evolution** — DDL steps in
   `src/main/junto/state/migrations.ts`: versioned (`user_version` N→N+1),
   identity-witnessed, one startup transaction, authorizer-guarded. An
   expand-only step adds tables/columns/triggers and never rewrites rows; a
   consolidate step may also drop exactly the tables it names in
   `removesTables` (1 -> 2 retired the mail delivery ledger this way).
2. **Data backfills** — marker-gated, idempotent walks that run after
   StateEngine is up (e.g. `content/inline-media-migration.ts`). Completeness
   markers live in install-ops (`install-ops.db` / `InstallOpsService`), not
   in product tables. Dev seeds may copy `junto.db` + content files; they
   must never copy install-ops ledgers.

Backfill laws (each one broke, or nearly broke, a real release):

- **Immutable logs are immutable to migrations too.** `work_events`,
  `work_facts`, `work_commands`, and `work_dispositions` are never UPDATEd or
  DELETEd — not even to "modernize" old payloads. History is served as written;
  decode paths admit historical shapes (decode-admits-history). Backfills
  rewrite material projections only.
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
