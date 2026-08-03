# END_STATE — Effect V4 IRON (no theater)

**Campaign objective (one line):**  
Electron main (and Remote) run as a **V4 Effect program**: `effect@4` lockstep, `Context.Service` only, product domain Effects only through **AppRuntime / RemoteRuntime**, kernel factory loop is an **Effect** (not an async Promise control plane), bare `Effect.runPromise` gone except **permanent** post-dispose host adapters.

**Reference:** `/Users/developer/Playground/effect` (`MIGRATION.md`, `migration/*`).  
**Skills:** consolidation-engineering, pristine-components. **No V3 effect skill.**

---

## Phase status (as of IRON deep close-out)

| slice | status |
|---|---|
| V4-PIN | **DONE** — `effect@4.0.0-beta.102` |
| V4-SERVICE-CORE + main/cli Tag purge | **DONE** — P1 zero under main/cli |
| V4-KERNEL hostRun / no runPromise *in* kernel file | **DONE** — still **async cycle + hostRun** (not full program) |
| V4-VERIFY (probe sheet) | **DONE** at time of review |
| **V4-PROGRAM** | **DONE** — factory cycle/claim/deliver/hydrate are Effect; host `runFork` |
| **V4-DEBT-ZERO** | **DONE** — `debt: []`; only permanent post-dispose `update/ipc.ts` |
| **V4-ENTRY** | **REMAINING** — main/remote/ipc domain entry only via ManagedRuntime |
| **V4-CONSOLIDATE-FINAL** | **REMAINING** — end-to-end proof |

---

## Forbidden (instant FAIL)

- Comment-only / “on V4 pin…” / import-map without live import change  
- `Runtime.runPromise` or bare `Effect.runPromise` **inside** `src/main/vellum/kernel/**`  
- Completing without **pasting full probe stdout** in the **git commit body**  
- Docs-only finish  
- Shrinking scope silently (“mostly pure”)  
- Dual control planes left alive (async cycle **and** Effect program)

---

## Iron probes

```bash
# P0 version
node -p "require('effect/package.json').version"   # /^4\./

# P1 services
rg -n 'Context\.Tag\b|Context\.GenericTag\b|Effect\.Tag\b|Effect\.Service\b' \
  src/main src/cli --glob '*.ts' --glob '*.tsx'   # exit 1 = clean

# P2 forks
rg -n 'Effect\.fork\b|Effect\.forkDaemon\b' src/main src/cli --glob '*.ts'  # exit 1

# P3 kernel — no Promise runners in kernel tree
rg -n 'Effect\.runPromise|Runtime\.runPromise' src/main/vellum/kernel --glob '*.ts'  # exit 1

# P5 program shape — no async factory control plane in kernel
rg -n 'async \(|= async |: Promise<' src/main/vellum/kernel/service.ts
# After V4-PROGRAM: factory control path must not be an async runCycle/runClaimTicks chain.
# Iron definition in V4-PROGRAM task: zero matches for runCycle/runClaimTicks as async functions;
# cycle is Effect.gen (or equivalent) started via AppRuntime.runFork from boot.

# P6 bare product runPromise debt
bun run lint:effect-runpromise
# After V4-DEBT-ZERO: debt array empty or maxCount sum 0; only permanent[] remains

# P4 green
bun run typecheck && bun run lint:effect-runpromise && bun run test
bunx vitest run tests/work-claim-content-ref.test.ts tests/effect-runpromise-boundary.test.ts
```

---

## Remaining Deep sequence (this fill)

| order | id | one-line iron done |
|---|---|---|
| 1 | **V4-PROGRAM** | Kernel factory loop is Effect under `AppRuntime.runFork` (or equivalent single host entry); no async `runCycle`/`runClaimTicks` Promise control plane; P3+P5+claim tests |
| 2 | **V4-DEBT-ZERO** | `scripts/effect-runpromise-allowlist.json` **debt: []** (or all maxCount 0); every former debt site uses AppRuntime/RemoteRuntime or is deleted; permanent only post-dispose; lint green |
| 3 | **V4-ENTRY** | Domain Effects in `src/main/index.ts`, `src/main/ipc.ts`, `src/main/vellum/ipc.ts`, `src/main/vellum-remote.ts` enter only via AppRuntime/RemoteRuntime; no new bare product runPromise |
| 4 | **V4-CONSOLIDATE-FINAL** | P0–P6 + full test suite green; claim+content green; END_STATE one-line objective true |
| * | **R-*** | Review re-runs same probes; PASS only if green |

Parallel track: **ignored** for this endgame.

---

## Review iron

Same probes as implement. **PASS only if probes match.** Theater → **FAIL** + commit documenting FAIL.
