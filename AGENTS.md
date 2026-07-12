# AGENTS.md — vellum

vellum is a desktop station (Electron + Effect + React) that renders a **portfolio canvas**: your projects, orbits, plugins, agents, and notes as spatial nodes; dependencies/blockers/relationships as edges; named regions as geography. The canvas is a [JSON Canvas 1.0](https://jsoncanvas.org) document extended with a namespaced `ether` key that binds nodes to live sources (tower, quasar, booth, hermes).

**The document is the product; the app is one projection of it. The file is the agent API.**

## The agent surface (headless — no GUI needed)

Canvases live at `~/.vellum/canvases/*.canvas`. Read or write them directly (the running app file-watches and hot-reloads external edits), or use the CLIs:

| command | what it does |
|---|---|
| `bun run populate [name] [--all]` | merge the live corpus (tower/quasar/hermes) onto a canvas as bound, hydrated nodes. Default = owned/registered projects; `--all` = every indexed repo. Idempotent, preserves existing nodes. |
| `bun run explode <project> [name] [--all-states]` | drill a project into its glyphs — one bound node per glyph, grouped by orbit. Idempotent. |
| `bun run render [name]` | write `<name>.svg` — a deep-field image of the board, for multimodal reading. |
| `bun run digest [name]` | print (and write `<name>.digest.txt`) a deterministic text projection of the board + live source data. |
| `bun run canvas:ls [--json]` | list canvases with node/edge counts. |

To **read the board as an agent**: `bun run digest` (text) or `bun run render` then view the SVG (image).

## The document contract

Standard JSON Canvas 1.0 (`nodes` of type `text`/`file`/`link`/`group`, `edges`) plus an optional `ether` key on nodes and edges:

```jsonc
{ "id": "n1", "type": "text", "x": 0, "y": 0, "width": 220, "height": 84, "text": "prism",
  "ether": {
    "entity": { "kind": "project" },          // open vocab: project|orbit|plugin|agent|station|skill|glyph|...
    "bindings": [                              // pointers into live sources; [] = a free node
      { "source": "tower",  "ref": { "type": "project", "key": "prism" } },
      { "source": "quasar", "ref": { "type": "project", "key": "git:github.com/skastr0/prism" } }
    ],
    "flags": ["blocker"]                       // blocker|parked|attention
  } }
```

Edges: `{ "id", "fromNode", "toNode", "ether": { "kind": "blocks" | "depends" | "relates" } }`.

**Two invariants** (enforced on every app/CLI write):
1. **Graceful degradation** — strip every `ether` key and the file is still valid, readable JSON Canvas 1.0.
2. **Mirror law** — extension semantics mirror into native fields (edge `kind` → `label`, blocker → red `color`).

Derived state (blocked closure, group membership, binding health) is **never stored** — recomputed from the document, so it cannot go incoherent.

## Binding refs and canonical keys

`ref.key` is always the join key against a live `Entity.key`. Granularity by `ref.type`:
- tower: `project` (`key`), `orbit` (`orbit:<project>/<orbit>`), `glyph` (`glyph:<project>/<orbit>/<glyphId>`)
- quasar: `project` (`git:...`), `session` (`session:<sessionId>`)
- booth: `project`
- hermes: `agent` (`<host>:<profile>`)

Never hand-format these strings — use the builders/parsers in `src/shared/refs.ts`.

## Sources (read-only adapters)

`src/main/vellum/adapters/` shell out to the reference CLIs and normalize into snapshot bundles. A down source degrades to a stale badge; it never touches the document. tower/quasar/hermes are live; booth may be down. hermes enumerates profiles on the local machine + remote-a over ssh.

## Structure

- `src/shared/` — **frozen contracts**: `canvas.ts` (document schema), `entities.ts` (snapshots), `graph.ts` (derived), `refs.ts` (keys), `digest.ts`, `portfolio.ts`, `explode.ts`, `svg.ts`. Change deliberately; much depends on them.
- `src/main/vellum/` — document plane (`canvases.ts`), data plane (`snapshots.ts` + `adapters/`), IPC (`ipc.ts`).
- `src/renderer/` — the canvas surface. **A dedicated UI agent owns this directory exclusively; backend sessions do not commit renderer files.**
- `scripts/` — the headless CLIs above.

## Discipline

- Adapters are read-only. The document is the only thing the user (or an agent) mutates.
- Board/source IDs and tokens never leak into committed source.
- `bun run typecheck && bun run test` gate every change.
