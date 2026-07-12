# chassis

Reusable desktop app chassis for local, open source, AI-first tools that connect rich visual product surfaces to Codex and Prism.

This repo is the baseline architecture for stations such as `observatory` and `almanac`. It is intentionally small, strict, and boring in the places that must stay dependable:

```
Electron main process
  Effect ManagedRuntime
  typed services
  Codex App Server adapter
  Prism compile adapter
  local filesystem/store services

Electron preload
  narrow contextBridge API

Renderer
  Vite + React
  Tailwind
  Motion
  Legend State
```

## Current MVP

The app currently boots as a real Electron desktop app and renders a control surface that verifies the stack:

- Electron main/preload/renderer split
- Effect `ManagedRuntime` created once in the main process
- typed IPC bridge exposed through preload only
- Codex CLI health check
- Codex App Server initialize handshake over JSONL stdio
- Prism codex-cli dry-run compile of the bundled station skill
- local folder reader and JSON store service
- React 19 renderer using Legend State and Motion

## Quick Start

```bash
bun install
bun run dev
bun run verify
```

`bun run dev` launches Electron and serves the renderer at `http://localhost:5173/`.

`bun run verify` runs:

```bash
bun run typecheck
bun run test
electron-vite build
```

## Local Package Dependencies

Until the family packages are published, Chassis imports local packages by absolute file dependency:

```json
{
  "@skastr0/prism": "file:/Users/developer/Projects/prism",
  "@skastr0/groundwork": "file:/Users/developer/Projects/groundwork",
  "@skastr0/pulsar-core": "file:/Users/developer/Projects/pulsar/packages/core",
  "@skastr0/quartz-core": "file:/Users/developer/Projects/quartz/packages/core"
}
```

That is deliberate for now. As these packages harden, the same imports can move to published npm versions without changing station architecture.

## Source Map

| Path | Purpose |
|---|---|
| `src/main/index.ts` | Electron app/window lifecycle |
| `src/main/runtime.ts` | Effect root layer and single `ManagedRuntime` |
| `src/main/ipc.ts` | typed IPC handlers |
| `src/main/services/*` | Store, Folder, Prism, and Codex services |
| `src/preload/index.ts` | secure `contextBridge` API |
| `src/shared/*` | shared schemas and IPC contracts |
| `src/renderer/*` | React UI, Legend State state, Motion surfaces |
| `station/plugin.json` | bundled Prism station pack |
| `station/skills/chassis/SKILL.md` | default Codex skill compiled by Prism |

## Prism Boundary

Chassis treats Prism as both:

- a package dependency for authoring/SDK APIs as Prism exposes them
- a compile tool for station-local skills, tools, agents, and future station packs

The current adapter uses the Prism CLI for dry-run compilation because Prism's published SDK surface is still being shaped. The service boundary is already in place so the implementation can switch to a direct SDK call later without touching renderer code.

## Codex Boundary

Chassis integrates with Codex through the Codex App Server, not by pretending Codex is a single request/response API. The adapter launches `codex app-server`, sends `initialize`, follows with `initialized`, and reads JSONL notifications/responses over stdio.

The MVP only performs the handshake. The next version should keep a long-lived app-server process, model threads/turns/items as Effect streams, and expose approval requests as renderer events.

## Station Derivation

A station should fork or template this repo, then add only its domain layer:

- domain service interfaces and Effect layers
- renderer views
- station Prism pack
- station-specific local folder contracts
- station-specific integrations with local family packages

For example:

- `observatory` adds Pulsar, Quartz, Groundwork, file tree, diff, source reader, and code health visualizations.
- `almanac` adds Atlas, Groundwork, markdown/wiki indexing, compiler/linter/query workflows, and knowledge-base visualizations.

## Status

First functional Chassis slice is implemented and verified. The next slice is to turn this into a templateable station package and then bootstrap `observatory` and `almanac` from it.
