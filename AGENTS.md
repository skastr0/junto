# AGENTS.md — vellum

vellum is a desktop station (Electron + Effect + React) that renders a **portfolio canvas**: your projects, orbits, plugins, agents, and notes as spatial nodes; dependencies/blockers/relationships as edges; named regions as geography. The canvas is a [JSON Canvas 1.0](https://jsoncanvas.org) document extended with a namespaced `ether` key that binds nodes to live sources (tower, quasar, booth, hermes).

**The document is the product; the app is one projection of it. The file is the agent API.**

## The agent surface (headless — no GUI needed)

Canvases live at `~/.vellum/canvases/*.canvas`. Read or write them directly (the running app file-watches and hot-reloads external edits), or use the CLIs:

| command | what it does |
|---|---|
| `bun run populate [name] [--all]` | merge the live corpus (tower/quasar/hermes) onto a canvas as bound, hydrated nodes. Default = owned/registered projects; `--all` = every indexed repo. Idempotent, preserves existing nodes. |
| `bun run render [name]` | write `<name>.svg` — a deep-field image of the board, for multimodal reading. |
| `bun run digest [name]` | print (and write `<name>.digest.txt`) a deterministic text projection of the board + live source data. |
| `bun run canvas:ls [--json]` | list canvases with node/edge counts. |
| `bun run canvas:rm <name> [name...] [--json]` | delete canvas document(s) and known sidecars (digest/svg). |

To **read the board as an agent**: `bun run digest` (text) or `bun run render` then view the SVG (image).

## The document contract

Standard JSON Canvas 1.0 (`nodes` of type `text`/`file`/`link`/`group`, `edges`) plus an optional `ether` key on nodes and edges:

```jsonc
{ "id": "n1", "type": "text", "x": 0, "y": 0, "width": 220, "height": 84, "text": "prism",
  "ether": {
    "entity": { "kind": "project" },          // open vocab: project|orbit|plugin|agent|station|skill|...
    "bindings": [                              // pointers into live sources; [] = a free node
      { "source": "tower",  "ref": { "type": "project", "key": "prism" } },
      { "source": "quasar", "ref": { "type": "project", "key": "git:github.com/skastr0/prism" } }
    ],
    "flags": ["blocker"],                      // blocker|parked|attention
    "view": { "orbit": "forge", "glyphQuery": "refactor", "states": ["reviewing"] }  // presentational filter
  } }
```

Edges: `{ "id", "fromNode", "toNode", "ether": { "criteria"?: EdgeCriteria } }`.

**Edge product (criteria-only):**
- No `criteria` → soft **relates** (never generates or relays blocks).
- `criteria.mode: "glyphs"` → selected glyph ids on a tower project must be `done` (blocks while pending; depends when clear). Unknown/missing tower data does not invent blocks.
- `criteria.mode: "wip"` → opt-in: any glyph in `committed`|`building`|`reviewing` blocks (never default on projects).
- `criteria.mode: "tasks"` → incomplete checklist items on the source tasks node block. Connecting from a tasks node attaches this automatically.
- Live **phase** (`blocks`|`depends`|`relates`) is derived. Optional `ether.kind` is only a phase mirror for offline JSON Canvas readers — never authorial input.

**Two invariants** (enforced on every app/CLI write):
1. **Graceful degradation** — strip every `ether` key and the file is still valid, readable JSON Canvas 1.0.
2. **Mirror law** — extension semantics mirror into native fields (blocker → red `color`; derived phase may project to edge `label`/`color`).

Derived state (blocked closure, group membership, binding health, live phase) is **recomputed** from the document (+ live sources). Phase may be mirrored onto `ether.kind` for offline readability; it is not the authoring surface.

## Kernel: watchers, timers, region pulse

Region activation gated by three structures (`src/shared/canvas.ts`):

**EtherWatch** (102–118): `{ kind, project, orbit, glyphIds, state, source, key, stat, op, value, flagOnUnsatisfied }`. Predicate on live data. Kinds: `glyphs_done` | `glyphs_entered_state` | `stat_threshold`. Edge-detection fires when a glyph enters `state` between polls.

**EtherTimer** (123–126): `{ everyMinutes }`. Bare pulse on interval.

**EtherRegion** (88–92): `{ hold, instruction }` on group nodes. `hold: true` = structural container. `instruction` = pulse briefing sent to every agent node inside when a watcher fires, timer ticks, or manual pulse triggers.

**Three laws**: (1) Watcher state is derived, never stored in the document. (2) Edge-detection memory is app-local — restart re-baselines, no latent fire. (3) Arming lives only in the running app: document defines pulses, app flips the switch.

## Binding refs and canonical keys

`ref.key` is always the join key against a live `Entity.key`. Granularity by `ref.type`:
- tower: `project` (`key`), `orbit` (`orbit:<project>/<orbit>`)
- quasar: `project` (`git:...`)
- booth: `project`
- hermes: `agent` (`<host>:<profile>`)

## Sources (read-only adapters)

`src/main/vellum/adapters/` shell out to the reference CLIs and normalize into snapshot bundles. A down source degrades to a stale badge; it never touches the document. tower/quasar/hermes are live; booth may be down. hermes enumerates profiles on the local machine + remote-a over ssh.

## In-app planes

**Read-only browse** — tower glyphs/signals and quasar sessions, searchable via canvas detail inspectors (ipc.ts channels: `towerBrowse`, `towerSearch`, `towerGlyphRead`, `towerSignalRead`, `quasarSessions`, `quasarSearch`, `quasarSessionDetail`). Never surface as nodes.

**Deliberate writes** — narrow, user-initiated mutations: tower comments on glyphs/signals, tower signal emit, and booth review actions (channels: `towerCommentGlyph`, `towerCommentSignal`, `towerEmitSignal`, `boothDrafts`, `boothReview`). Booth reviews pending server integration.

**Attached agent chat** — one live ACP session per agent node (`<host>:<profile>`); resumable across app sessions (channels: `chatOpen`, `chatPrompt`, `chatPermission`, `chatSetModel`, `chatClose`). Main process owns the `hermes acp` child; renders in the canvas as inline composition. The file remains the agent API.

## Structure

- `src/shared/` — **frozen contracts**: `canvas.ts` (document schema), `entities.ts` (snapshots), `graph.ts` (derived), `digest.ts`, `portfolio.ts`, `svg.ts`. Change deliberately; much depends on them.
- `src/main/vellum/` — document plane (`canvases.ts`), data plane (`snapshots.ts` + `adapters/`), IPC (`ipc.ts`).
- `src/renderer/` — the canvas surface. **A dedicated UI agent owns this directory exclusively; backend sessions do not commit renderer files.**
- `scripts/` — the headless CLIs above.

## Discipline

- Adapters are read-only. The document is the only thing the user (or an agent) mutates.
- Board/source IDs and tokens never leak into committed source.
- `bun run typecheck && bun run test` gate every change.
