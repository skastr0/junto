# vellum architecture

vellum is built on the chassis station recipe as-built (Electron shell). STATION-ARCHITECTURE prefers Tauri by default; this station inherits Electron deliberately — the chassis Electron implementation is the working, verified template today, and the POC optimizes for a playable station over shell migration. Revisit at production hardening.

The inherited chassis architecture follows. vellum-specific planes: `src/shared/canvas.ts` (JSON Canvas + ether document), `src/main/vellum/` (document + snapshot services and IPC), `src/renderer/` (the canvas surface).

Chassis is the canonical local desktop app architecture for AI-first stations. The baseline stack is Electron, Effect, Codex App Server, Prism, Vite, React, Tailwind, Motion, and Legend State.

## 1. Process Model

```
Electron app
  main process
    Effect ManagedRuntime
    StoreService
    FolderService
    PrismService
    CodexService
    station domain services

  preload
    contextBridge exposes a small typed API

  renderer
    Vite + React
    Legend State observables
    Tailwind + Motion UI
```

The main process owns all privileged capabilities: filesystem, child processes, Codex App Server, Prism compilation, and eventually local package SDK calls. The renderer never imports Node or Electron APIs. It talks through the preload bridge.

This is the core security and maintainability rule: the renderer is a product surface, not a backend.

## 2. Effect Runtime

The root runtime is created once:

```ts
export const RootLayer = Layer.mergeAll(StoreLive, FolderLive, PrismLive, CodexLive)
export const AppRuntime = ManagedRuntime.make(RootLayer)
```

IPC handlers run programs through `AppRuntime.runPromise`. This keeps service instances coherent across the whole desktop app and avoids fragmented state.

The current base services are:

| Service | Responsibility |
|---|---|
| `StoreService` | local JSON store under Electron `userData` |
| `FolderService` | local folder reads for renderer probes and future station folders |
| `PrismService` | station pack discovery and codex-cli dry-run compilation |
| `CodexService` | Codex CLI health and App Server handshake |

The store is JSON for the first slice. Stations that need transactions can replace this service with SQLite later without changing the IPC or renderer contracts.

## 3. Preload Bridge

`src/preload/index.ts` exposes:

```ts
interface ChassisApi {
  doctor(): Promise<DoctorReport>
  selectFolder(): Promise<FolderSnapshot | null>
  readDirectory(path: string): Promise<ReadonlyArray<DirectoryEntry>>
  probeCodex(): Promise<ServiceCheck>
  prismDryRun(): Promise<ServiceCheck>
}
```

Each method maps to one explicit IPC channel. The preload does not expose raw `ipcRenderer`, generic send/invoke helpers, or filesystem APIs.

## 4. Shared Contracts

`src/shared/contracts.ts` defines Effect Schema-backed data envelopes for service health, doctor reports, and folder entries.

The immediate goal is runtime validation at boundaries where data crosses process or tool edges. The longer-term goal is to generate JSON Schemas for headless surfaces and station plugin contracts from the same source.

## 5. Codex App Server

The Codex service treats the App Server as a bidirectional JSONL-over-stdio protocol:

1. spawn `codex app-server`
2. send `initialize`
3. send `initialized`
4. read JSONL responses/notifications

The current implementation proves the initialize handshake and then terminates the child process. The production implementation should own a long-lived process and expose:

- thread lifecycle
- turn lifecycle
- item lifecycle
- approval requests
- streaming assistant/tool/diff events

Those should be modeled as Effect streams, then bridged into renderer state.

## 6. Prism Integration

Chassis ships a bundled station Prism pack at `station/`:

```
station/
  plugin.json
  skills/chassis/SKILL.md
```

`PrismService` currently shells out to the local Prism CLI:

```bash
bun src/cli.ts install station --harness codex-cli --scope project --project <userData>/compiled --dry-run
```

That is a temporary compatibility layer. Prism should expose a direct SDK entrypoint for app usage, likely something shaped like:

```ts
compilePluginForHarness({
  pluginPath,
  harness: "codex-cli",
  scope: "project",
  projectPath,
})
```

The Chassis service boundary already isolates that future change.

## 7. Renderer State

The renderer uses Legend State for app state:

```ts
export const appState$ = observable({
  doctor: null,
  folderRoot: "",
  folderEntries: [],
  codexProbe: null,
  prismDryRun: null,
  busy: false,
  error: "",
})
```

React components consume observable slices with `use$`. This keeps the renderer ready for high-frequency station surfaces such as file heatmaps, timelines, live Codex event streams, and folder watchers.

Motion is used for UI movement; Tailwind owns the styling system.

## 8. Station Shape

A Chassis-derived station adds:

- `src/main/services/<station>.ts`
- station domain contracts in `src/shared`
- station views in `src/renderer`
- station Prism pack in `station/`
- station folder contract and headless commands

The shared base stays small. Domain services compose local packages:

- Observatory: `@skastr0/pulsar-core`, `@skastr0/quartz-core`, `@skastr0/groundwork`, `@pierre/trees`, `@pierre/diffs`
- Almanac: `atlas`, `@skastr0/groundwork`, `@skastr0/prism`

## 9. Verification

Current verified checks:

- `bun run typecheck`
- `bun run test`
- `electron-vite build`
- live Electron render through Computer Use
- Codex App Server initialize handshake
- Prism codex-cli dry-run compilation

## 10. Next Architecture Work

1. Promote Prism CLI compile behavior into a real SDK entrypoint.
2. Add a persistent Codex App Server process manager and Effect stream API.
3. Add a station template/rename script.
4. Bootstrap Observatory from Chassis.
5. Bootstrap Almanac from Chassis, deciding whether Atlas becomes an FFI library, a CLI adapter, or a TypeScript port of core indexing ideas.
