# END_STATE — Effect foundation (Vellum Command main)

**Campaign:** make main process a real Effect program so factory claims and product expansion are not quicksand.

**Not in scope:** renderer React/Legend rewrite; GPU/fan tuning; rare edge cases.

## Canonical end state

```
boot  → ManagedRuntime.make(AppLayer) once
IPC   → runtime.runPromise(handler)   // adapter only
loops → runtime.runFork(kernelCycle)  // same Context
quit  → runtime.dispose()
```

Product interior is pure Effect + Layers/Services. No bare `Effect.runPromise` in product paths (allowlist only for true host/post-dispose adapters).

**Sole product store** remains `vellum.db`. Install-ops / content files stay install-local (see AGENTS.md).

## V4 substrate

| Item | Value |
|---|---|
| Product today | `effect@3.21.x` |
| Target | Effect **V4** (beta OK on branch; pin lockstep `@effect/*`) |
| **Reference codebase (V4 source of truth)** | `/Users/developer/Playground/effect` |
| Migration docs | `Playground/effect/MIGRATION.md`, `Playground/effect/migration/*` |
| Do **not** use | outdated repo/global “effect skill” (V3-oriented) |

Prefer APIs that match V4 end shape: `Context.Service`, `forkChild`/`forkDetach`, `ManagedRuntime` + `runPromise`/`runFork` with warm Context, `Layer` composition once.

## Skills (required on every claim)

Load and apply:

1. **consolidation-engineering** — one canonical end state; kill dual hybrid paths; no “temporary” bare-runPromise left alive.
2. **pristine-components** — pristine Effect/domain cores; messy only at Electron/IPC adapters.

Read V4 patterns from **Playground/effect**, not from V3 skill text.

## Slices (finish criteria reference)

| id | lane | done when |
|---|---|---|
| **S0** | deep | Fitness: CI/rg or architecture test bans bare `Effect.runPromise` under product globs except allowlist file. Document allowlist. **≥1 commit.** |
| **S1** | deep | Single warm ManagedRuntime story documented in code comments at `runtime.ts` / `remote-runtime.ts`; product IPC uses `AppRuntime`/`RemoteRuntime` only for domain Effects. **≥1 commit.** |
| **S2** | deep | Kernel factory cycle (claim/delivery/timer bridges) does not use bare empty-Context `Effect.runPromise` for Work/Content paths; claims see ContentService. **≥1 commit.** |
| **S3** | deep | Regression test: media/ContentRef task claim succeeds when receipts+files present (would catch prior claim-gate bug). **≥1 commit.** |
| **S4** | parallel | `Context.Tag` → V4-ready `Context.Service` (or staged rename map) for **owned path pack only**. **≥1 commit.** |
| **S5** | parallel | `Effect.fork` / `forkDaemon` → `forkChild` / `forkDetach` (V4 names if on V4; else V3-compatible prep + comment) **owned paths only**. **≥1 commit.** |
| **S6** | parallel | Error combinator renames (`catchAll`→`catch` etc.) **owned paths only** when on V4; else no-op commit documenting N/A. **≥1 commit.** |
| **S7** | parallel | Platform import path prep / V4 import map for **owned paths only** (ssh/cli/platform). **≥1 commit.** |
| **S8** | deep | Optional later: Schema V4 — **serial only**, not parallel packs. |

## Parallelization boundaries (hard)

- **Own only the path glob in the task brief.** Do not edit other packs.
- **Commit only your files.** Multi-agent tree: never stash/revert others’ work.
- **No worktrees required** — path isolation is the lock.
- Parallel packs must not touch: `src/main/vellum/kernel/**` except deep lane; `src/shared/**` Schema wire only in S8.
- After each pack: `bun run typecheck` (or package gate) on touched surface; fix only owned paths.

## Completion evidence

- **finishCriteria.git.minCommits ≥ 1** — commits required; **no artifacts**.
- Complete with git commits on `main` (or campaign branch if operator says so).
- Point finish description at slice id + END_STATE path.

## Repo roots

| Root | Role |
|---|---|
| `/Users/developer/Projects/vellum` | Product under change |
| `/Users/developer/Playground/effect` | Effect V4 reference + migration guides |
