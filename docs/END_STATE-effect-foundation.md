# END_STATE — Effect foundation (Vellum Command main)

**Goal:** make the main process a real Effect program so factory claims and product expansion are not quicksand.

**Not in scope:** renderer React/Legend rewrite; GPU/fan tuning; rare edge cases.

## Canonical end state

```
boot  → ManagedRuntime.make(AppLayer) once
IPC   → runtime.runPromise(handler)   // adapter only
loops → runtime.runFork(kernelCycle)  // same Context
quit  → runtime.dispose()
```

Product interior is pure Effect + Layers/Services. No bare `Effect.runPromise` in product paths (allowlist only for true host/post-dispose adapters).

**Sole product store** remains `vellum-command.db`. Install-ops / content files stay install-local (see AGENTS.md).

## V4 substrate

| Item | Value |
|---|---|
| Product today | `effect@3.21.x` |
| Target | Effect **V4** (beta OK on branch; pin lockstep `@effect/*`) |
| Reference (V4 source of truth) | the Effect repository's V4 `MIGRATION.md` and `migration/*` guides |
| Do **not** use | outdated repo/global “effect skill” (V3-oriented) |

Prefer APIs that match V4 end shape: `Context.Service`, `forkChild`/`forkDetach`, `ManagedRuntime` + `runPromise`/`runFork` with warm Context, `Layer` composition once.

## Skills (required on every claim)

Load and apply:

1. **consolidation-engineering** — one canonical end state; kill dual hybrid paths; no “temporary” bare-runPromise left alive.
2. **pristine-components** — pristine Effect/domain cores; messy only at Electron/IPC adapters.

Read V4 patterns from the Effect repository's migration guides, not from V3 skill text.

## Slices (finish criteria reference)

| id | lane | done when |
|---|---|---|
| **S0** | deep | Fitness: CI/rg or architecture test bans bare `Effect.runPromise` under product globs except allowlist file. Document allowlist. **≥1 commit.** |
| **S1** | deep | Single warm ManagedRuntime story documented in code comments at `runtime.ts` / `remote-runtime.ts`; product IPC uses `AppRuntime`/`RemoteRuntime` only for domain Effects. **≥1 commit.** |
| **S2** | deep | ✅ Kernel factory cycle (claim/delivery/timer bridges) does not use bare empty-Context `Effect.runPromise` for Work/Content paths; claims see ContentService. **≥1 commit.** |
| **S3** | deep | ✅ Regression test: media/ContentRef task claim succeeds when receipts+files present (would catch prior claim-gate bug). **≥1 commit.** - `tests/work-claim-content-ref.test.ts` |
| **S4** | parallel | `Context.Tag` → V4-ready `Context.Service` (or staged rename map) for **owned path pack only**. **≥1 commit.** |
| **S5** | parallel | `Effect.fork` / `forkDaemon` → `forkChild` / `forkDetach` (V4 names if on V4; else V3-compatible prep + comment) **owned paths only**. **≥1 commit.** |
| **S6** | parallel | Error combinator renames (`catchAll`→`catch` etc.) **owned paths only** when on V4; else no-op commit documenting N/A. **≥1 commit.** |
| **S7** | parallel | Platform import path prep / V4 import map for **owned paths only** (ssh/cli/platform). **≥1 commit.** |
| **S8** | deep | Optional later: Schema V4 — **serial only**, not parallel packs. |

### S0 allowlist (fitness gate)

| Surface | Path |
|---|---|
| Scanner | `scripts/lint-effect-runpromise.ts` (`bun run lint:effect-runpromise`) |
| Allowlist | `scripts/effect-runpromise-allowlist.json` |
| Architecture test | `tests/effect-runpromise-boundary.test.ts` (also in `bun run test` / `verify`) |
| Product globs | `src/main/**/*.{ts,tsx}` (tests excluded) |

**Rules**

- **permanent** — true host / post-dispose adapters only (today: `update/ipc.ts` finalize after `AppRuntime.dispose`). Each entry needs a reason naming dispose/host.
- **debt** — known product bare-`runPromise` sites. Counts are a **ratchet** (may only shrink). S2 clears kernel debt; other packs clear their own.
- **Never permanent:** `src/main/vellum-command/kernel/**`, `src/main/vellum-command/work/**` (claim/ContentService empty-Context class of bug).
- New bare `Effect.runPromise` under product globs → lint exit 1 unless allowlist/debt is deliberately updated in review.

Preferred product path remains `AppRuntime.runPromise` / `RemoteRuntime.runPromise` with warm Context (see § Canonical end state).

### S1 ManagedRuntime / IPC boundary

| Surface | Path |
|---|---|
| Command Center runtime | `src/main/runtime.ts` — `AppRuntime = ManagedRuntime.make(RootLayer)` once |
| Remote runtime | `src/main/remote-runtime.ts` — `RemoteRuntime` once (Node-only) |
| CC boot / dispose | `src/main/index.ts` — bind `AppRuntime.runPromise`; quit → `AppRuntime.dispose()` |
| Product IPC | `src/main/ipc.ts`, `src/main/vellum-command/ipc.ts` — domain Effects via `AppRuntime.runPromise` only |
| Remote boot | `src/main/vellum-remote.ts` — `RemoteRuntime.runPromise` / `dispose` (audit only in S1) |

**Laws (cemented in code comments on the runtime modules):**

- One warm ManagedRuntime per process role; never rebuild per IPC call.
- Domain Effects enter via `AppRuntime` / `RemoteRuntime` — not bare `Effect.runPromise`.
- Sole product store composition: memoized `StateEngine` + co-owned `InstallOps` at `StateRepositoriesLive` (install-ops is not product truth).
- Dispose once on quit; post-dispose host edges stay on S0 permanent allowlist only.

**S2 done (kernel warm Runtime):**

| Surface | Law |
|---|---|
| `src/main/vellum-command/kernel/service.ts` | `KernelLive` captures full ambient `Effect.runtime()`; all Promise bridges use `Runtime.runPromise` — zero bare `Effect.runPromise` |
| `src/main/vellum-command/work/service.ts` | Hard `yield* ContentService` at WorkLive build (no `serviceOption` soft-miss; missing content fails layer, not claim) |
| S0 debt | `kernel/service.ts` removed from allowlist (count 0) |

**Remaining product bare `Effect.runPromise` (not S2):**

| Path | Debt role |
|---|---|
| browser/*, content/inline-media-migration, usage, canvases, settings/ipc, hosts/registry, station/remote-report-pump, term/router, update/service | product/adapter debt — shrink via S0 ratchet when migrated |
| `src/main/vellum-command/update/ipc.ts` | permanent: post-`AppRuntime.dispose` finalize only |
