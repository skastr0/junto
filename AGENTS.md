# AGENTS.md — vellum

vellum is a desktop station (Electron + Effect + React) that renders a **portfolio canvas**: agents, work surfaces, notes, and regions as spatial nodes; dependencies/blockers/relationships as edges; named regions as geography. The canvas is a [JSON Canvas 1.0](https://jsoncanvas.org) document extended with a namespaced `ether` key.

**The document is the product; the app is one projection of it. The file is the agent API.**

## The agent surface (headless — no GUI needed)

**Agents never write the canvas.** The canvas is human-authored (Command Center). Agents consume compiled projections and local Vellum tools.

Canvases live at `~/.vellum/canvases/*.canvas`. The running app file-watches external edits. Headless CLIs:

| command | who | what it does |
|---|---|---|
| `bun run digest [name]` | agents + operators | print (and write `<name>.digest.txt`) a deterministic text projection of the board + live hermes snapshot data. |
| `bun run render [name]` | agents + operators | write `<name>.svg` — a deep-field image of the board, for multimodal reading. |
| `bun run canvas:ls [--json]` | agents + operators | list canvases with node/edge counts. |
| `bun run canvas:rm <name>…` | **operator only** | delete canvas document(s). Requires `VELLUM_AUTHORIAL_WRITE=1`. |

To **read the board as an agent**: `bun run digest` (text) or `bun run render` then view the SVG (image). Do not mutate `.canvas` files from agents.

### Station roles

- **Command Center** — user-selected. Human authors the canvas; fleet management via host registry.
- **Remote** — user-selected. Capability host for that machine; pulls canvases; host-scoped execution only.
- Role is never inferred from hardware or open windows.

## The document contract

Standard JSON Canvas 1.0 (`nodes` of type `text`/`file`/`link`/`group`, `edges`) plus an optional `ether` key on nodes and edges:

```jsonc
{ "id": "n1", "type": "text", "x": 0, "y": 0, "width": 220, "height": 84, "text": "prism",
  "ether": {
    "entity": { "kind": "project" },          // open vocab: project|agent|herdr|task|watcher|timer|page|...
    "bindings": [                              // document vocabulary; may name tower/quasar/booth keys
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
- `criteria.mode: "glyphs"` → selected glyph ids must be `done` when glyph data is available (blocks while pending; depends when clear). Unknown/missing glyph data does not invent blocks.
- `criteria.mode: "wip"` → opt-in: any glyph in `committed`|`building`|`reviewing` blocks (never default on projects).
- `criteria.mode: "tasks"` → incomplete checklist items on the source tasks node block. Connecting from a tasks node attaches this automatically.
- Live **phase** (`blocks`|`depends`|`relates`) is derived. Optional `ether.kind` is only a phase mirror for offline JSON Canvas readers — never authorial input.

**Two invariants** (enforced on every app/CLI write):
1. **Graceful degradation** — strip every `ether` key and the file is still valid, readable JSON Canvas 1.0.
2. **Mirror law** — extension semantics mirror into native fields (blocker → red `color`; derived phase may project to edge `label`/`color`).

Derived state (blocked closure, group membership, binding health, live phase) is **recomputed** from the document (+ live sources). Phase may be mirrored onto `ether.kind` for offline readability; it is not the authoring surface.

**Vocabulary vs live plane:** schema string literals (`EntitySource` includes `tower`|`quasar`|`booth`|`hermes`, EtherWatch kinds, edge criteria modes) remain valid so operator canvases keep decoding. The **live** adapter plane is hermes-only. Private-source bindings and project nodes degrade offline (project cards render as plain notes; glyph criteria stay non-generating without glyph data).

## Kernel: watchers, timers, region pulse

Region activation gated by three structures (`src/shared/canvas.ts`):

**EtherWatch** (102–118): `{ kind, project, orbit, glyphIds, state, source, key, stat, op, value, flagOnUnsatisfied }`. Predicate on live data. Kinds: `glyphs_done` | `glyphs_entered_state` | `stat_threshold`. Edge-detection fires when a glyph enters `state` between polls.

**EtherTimer** (123–126): `{ everyMinutes }`. Bare pulse on interval.

**EtherRegion** (88–92): `{ hold, instruction }` on group nodes. `hold: true` = structural container. `instruction` = pulse briefing sent to every agent node inside when a watcher fires, timer ticks, or manual pulse triggers.

**Three laws**: (1) Watcher state is derived, never stored in the document. (2) Edge-detection memory is app-local — restart re-baselines, no latent fire. (3) Arming lives only in the running app: document defines pulses, app flips the switch.

## Binding refs and canonical keys

`ref.key` is always the join key against a live `Entity.key` when a source is live. Granularity by `ref.type`:
- tower / quasar / booth: document vocabulary only (no live fetch)
- hermes: `agent` (`<host>:<profile>`) — live

## Sources (read-only adapters)

`src/main/vellum/adapters/` — live: **hermes** (+ exec helpers). A down hermes degrades to a stale badge; it never touches the document. hermes enumerates profiles on the local machine + remote hosts over ssh.

## In-app planes

**Attached agent chat** — one live ACP session per agent node (`<host>:<profile>`); resumable across app sessions (channels: `chatOpen`, `chatPrompt`, `chatPermission`, `chatSetModel`, `chatClose`). Main process owns the `hermes acp` child; renders in the canvas as inline composition. The file remains the agent API.

**Focus surfaces** — centered, measure-constrained overlays for single-subject work (one agent, one herdr pane, one page). Prefer these over full-bleed or stage-split when the interaction is deep and solitary. Shell: `FocusSurface` (`src/renderer/components/FocusSurface.tsx`); measures + math: `src/renderer/lib/focus-measure.ts`.

| measure | width intent | use |
|---|---|---|
| `prose` | ~65ch reading line | long copy |
| `document` | ~760px, resizable | glyph/session-shaped readers when present |
| `terminal` | ~140 mono cells @ 13px (~1100px) | herdr agent PTY |
| `workspace` | ~1280px immersive | focused browser / multi-pane still framed |
| `form` | ~448px fit | wizards |

Techniques baked in: dim+blur backdrop, titlebar-aware padding, enter animation (respects `prefers-reduced-motion`), portal to `document.body`, layer (`detail` vs `work` z-index). Dock/split remains available for multi-surface work; focus is the default for one subject.

## Structure

- `src/shared/` — **frozen contracts**: `canvas.ts` (document schema), `entities.ts` (snapshots), `graph.ts` (derived), `region-rollup.ts` (derived region severity rollups), `digest.ts`, `portfolio.ts`, `svg.ts`. Change deliberately; much depends on them.
- `src/main/vellum/` — document plane (`canvases.ts`), data plane (`snapshots.ts` + `adapters/`), IPC (`ipc.ts`).
- `src/renderer/` — the canvas surface.
- `scripts/` — the headless CLIs above.

## Discipline

- Adapters are read-only. The document is the only thing the user (or an agent) mutates.
- Board/source IDs and tokens never leak into committed source.
- `bun run typecheck && bun run test` gate every change.

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
