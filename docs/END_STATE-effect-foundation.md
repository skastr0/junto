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

## Review slices (validation lane — parallel + deep)

Review tasks **depend on** the implement pack/slice completing (factory `dependsOn`).
Claim-ready only after implement is **completed**. Reviewers are different seats from implementers when possible.

| id | depends on | done when |
|---|---|---|
| **R4-work** | S4-work pack complete | Alignment review of `src/main/vellum/work/**` vs END_STATE §S4; dual-service / dual-path rejected; typecheck green; **≥1 commit** (review note under `docs/effect-foundation/reviews/` or nits fixed in-path). |
| **R4-station** | S4-station | same for station/** |
| **R4-state-content** | S4-state-content | same for state/content/install-ops |
| **R4-hosts-ssh** | S4-hosts-ssh | same for hosts/ssh |
| **R4-browser-term** | S4-browser-term | same for browser/term |
| **R4-rest-main** | S4-rest-main | same for remaining main+cli pack |
| **R5-fork** | S5-fork-main | fork rename prep does not thrash kernel; no dual fork helpers; **≥1 commit** |
| **R7-platform** | S7-platform-imports | import map prep is coherent; package.json peers consistent; **≥1 commit** |
| **R4-integrate** | all R4-* pack reviews **or** all S4 implement packs complete | Cross-pack coherence: no duplicate Tag ids across packs, no half-migrated service shapes, END_STATE §S4 overall; **≥1 commit** |
| **R0–R3** | S0–S3 respectively (deep) | Deep foundation reviews: fitness gate real, runtime boundary real, kernel Context fixed, claim+content test exists and passes; **≥1 commit** each |

### Review checklist (every R*)

1. Load **consolidation-engineering** + **pristine-components** (not V3 effect skill).
2. V4 truth: `/Users/developer/Playground/effect` migration docs.
3. Diff only the pack’s path ownership vs `main` / base.
4. Reject dual paths, compatibility shims, bare `Effect.runPromise` in product paths (unless allowlisted by S0).
5. Confirm finishCriteria of implement pack was commit-based (no artifact theater).
6. Commit review note or in-path nits; complete with git evidence.

**Hard `dependsOn`:** only works once implement proposals are **approved into tasks**. Soft order in briefs is a fallback until then.

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
