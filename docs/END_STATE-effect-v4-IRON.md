# END_STATE — Effect V4 IRON (no theater)

**Campaign objective (one line):**  
Product dependency **`effect` major version is 4**, all `@effect/*` lockstep 4.x, product builds green, services are `Context.Service`, kernel has **no** bare/`Runtime.runPromise` claim theater.

**Reference:** `/Users/developer/Playground/effect` (V4 beta source + `MIGRATION.md`).  
**Do not use** V3 effect skills.  
**Skills:** consolidation-engineering, pristine-components.

## Forbidden (instant FAIL)

- Comment-only commits (“on V4 pin…”)
- Import-map files that do not change live imports
- “Staged Tag inventory” without removing Tag
- `Runtime.runPromise` as a substitute for fixing Context (counts as **not done**)
- Claiming done without pasting **command output** in the git commit body
- `finishCriteria` satisfied by docs alone

## Iron finish probes (every implement task must run and paste)

```bash
# P0 — version (whole campaign blocked until true)
node -p "require('effect/package.json').version"   # MUST match /^4\./
# every package matching @effect/* in package.json must report same 4.x line

# P1 — product services
rg -n 'Context\.Tag\b|Context\.GenericTag\b|Effect\.Tag\b|Effect\.Service\b' src/main src/cli src/shared --glob '*.ts' --glob '*.tsx'
# MUST exit 1 (no matches) after full cutover; path-pack tasks: zero matches under OWNED globs only

# P2 — forks
rg -n 'Effect\.fork\b|Effect\.forkDaemon\b' src/main src/cli --glob '*.ts'
# MUST exit 1 (no matches); use forkChild/forkDetach per V4

# P3 — kernel theater ban
rg -n 'Effect\.runPromise|Runtime\.runPromise' src/main/vellum/kernel --glob '*.ts'
# MUST exit 1 (no matches). Claims/cycles enter via AppRuntime.runPromise/runFork from main boot only.

# P4 — green product
bun run typecheck
bun run lint:effect-runpromise
bun run test
# all exit 0
```

## Slices

| id | lane | iron done |
|---|---|---|
| **V4-PIN** | deep first | P0 true in lockfile + node_modules; P4 typecheck starts (may be red until later slices — PIN alone requires typecheck **or** documented compile blockers filed as **code** fixes in-flight; **cannot** complete PIN with effect still 3.x) |
| **V4-SERVICE** | deep or parallel packs | P1 zero under owned paths; live `Context.Service` |
| **V4-FORK** | deep/parallel | P2 zero |
| **V4-KERNEL** | deep only | P3 zero; factory claim path works with ContentRef test green |
| **V4-IMPORTS** | parallel | live imports from V4 paths (not comments); P4 |
| **V4-SCHEMA** | deep serial | shared Schema on V4; P4 full |
| **V4-VERIFY** | deep last | all P0–P4 green; claim+content test green |

## Review iron

Reviewer re-runs the **same** probes for the implement slice.  
**PASS only if probes match.**  
If implement left comments / 3.x / Tag remaining → **FAIL**, no niceness.
