# vellum

**The portfolio canvas.** A desktop station where the whole ether is drawn on one spatial surface — projects, orbits, plugins, agents, research pointers, and raw ideas as nodes; dependencies, blockers, and relationships as edges; named regions as geography.

vellum renders JSON Canvas 1.0 documents extended with a namespaced `ether` key that binds nodes to live sources: tower (glyphs, signals), quasar (sessions), booth (assets). The document is the product; the app is one projection of it.

## The document

`~/.vellum/canvases/*.canvas` — [JSON Canvas 1.0](https://jsoncanvas.org) plus the `ether` extension:

- `ether.entity.kind` — open vocabulary (`project`, `orbit`, `plugin`, `agent`, `station`, `skill`, …)
- `ether.bindings[]` — pointers into tower / quasar / booth (project-level refs in the POC)
- `ether.flags[]` — `blocker`, `parked`, `attention`
- edge `ether.criteria` — optional; modes `glyphs` | `wip` | `tasks`. No criteria → soft **relates**. Live phase (`blocks`|`depends`|`relates`) is derived; `ether.kind` is only an optional offline phase mirror, never authorial input.

Two laws hold on every save:

1. **Graceful degradation** — stripped of every `ether` key, the file is valid, readable JSON Canvas 1.0 (Obsidian opens it).
2. **Mirror law** — extension semantics mirror into native fields (blocker → red; derived phase may project to edge label/color) so plain readers see the degraded truth.

Derived state (blocked closure, region membership, binding health, live phase) is never stored — recomputed from the document (+ live sources), so the file cannot go incoherent.

## Agent surface

The file is the API. External agents edit `.canvas` files directly; the app file-watches and hot-reloads. `export digest` compiles the canvas + live snapshots into a deterministic text projection for agent consumption; screenshots are the multimodal secondary.

## Architecture

Built on the [chassis](https://github.com/skastr0/chassis) station recipe: Electron main process owning an Effect `ManagedRuntime` (typed services, typed IPC through a narrow preload bridge) and a Vite + React 19 + Tailwind + Motion + Legend State renderer with `@xyflow/react` for the canvas.

- **Document plane** — `CanvasesService`: load / validate / canonical-serialize / atomic-write / watch.
- **Data plane** — `SnapshotsService`: read-only adapters shelling to the reference CLIs (`tower`, `quasar`, `booth`), normalized into snapshot bundles. Bindings hydrate at render; a down server degrades to a stale badge, never touches the document.
- **Surface** — deep-field rendering: warm near-black ground, wireframe over solid, one hue per thing, quiet motion.

## Quick start

```bash
bun install
bun run dev      # electron + renderer at localhost:5173
bun run verify   # typecheck + tests + vite compile
```

First launch seeds a starter portfolio canvas.

## Package & install (macOS)

```bash
bun run app:build              # typecheck + package → release/mac-arm64/Vellum.app
bun run app:build:fast         # skip typecheck (iterate packaging)
bun run app:build:verify       # typecheck + tests + package

bun run app:install            # build then install → /Applications/Vellum.app
bun run app:install:fast       # fast build + install
bun run app:install:skip-build # install already-built release app
bun run app:install:supervised # install + LaunchAgent (crash-only KeepAlive)
bun run app:open               # open /Applications/Vellum.app
bun run app:uninstall-agent    # remove LaunchAgent; leave the .app
```

Scripts: `scripts/build-app.sh`, `scripts/install-app.sh`, `scripts/install-launchd.sh`.

**Herdr safety:** quitting Vellum (Dock, install reload, launchd unload) **detaches** terminal control streams only. It does **not** kill herdr panes, tabs, or sessions. Rebuilding/reinstalling is a non-event for your agent fleet.

## Status

POC. Canvas + live sources are real; packaging scripts install a local Developer-ID-signed `.app` when codesign is available.
