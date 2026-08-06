# Architecture north star: machine safety

**Vellum Command must never threaten the user's machine.**

> **Governing trust model:** read
> [`security-doctrine.md`](security-doctrine.md) first. This document protects
> against destructive mistakes, malformed input, and confused code. It does not
> define attached agents or arbitrary same-user processes as hostile tenants.
> If a stricter interpretation conflicts with the security doctrine, the
> security doctrine wins.

Not as a guideline. Not as “be careful in tests.” As a physical property of the
architecture: the type system, Effect services, and domain boundaries make
host-destructive operations **unrepresentable** or **unreachable** without a
capability that only Vellum Command can mint when it owns the resource.

This document is the north star for process control, file mutation, and any
future surface that can affect the host OS outside the app sandbox.

---

## Laws

### 1. Capability, not ambient authority

If an operation can harm the host (signal a process, delete a path, bind a
privileged port), the API **must not** accept a bare OS identifier.

| Forbidden | Required |
|-----------|----------|
| `kill(pid: number)` | `signalOwned(process: OwnedProcess)` |
| `rm(path: string)` for user trees | scoped handles / app-owned paths only |
| “trust the caller’s flag” | mint authority only from a constrained spawn path |

### 2. Parse, don’t trust (Effect Schema)

Inputs that touch the OS cross a **Schema** boundary first.

- Numeric child pids are read from the spawned child handle itself and admitted
  only with a coherently captured start epoch. Callers cannot supply a pid.
- Group pids are captured only by `spawnDetachedProcessGroup` after the child
  actually starts, together with that same child epoch and process-group
  identity from one process-table snapshot.
- Signals that may terminate: `TerminatingSignal` — closed literal set.
- SSH endpoints, remote paths, etc. already follow this pattern (`SshEndpoint`,
  `RemoteCommand`). New host-touching domains copy that pattern.

Invalid values **cannot** enter canonical state. Schema failure is not a
soft warning; it is non-admission.

### 3. Brand + private store (unforgeable handles)

Follow the SSH domain pattern (`RemoteCommand` + WeakMap):

```text
unique symbol brand on public interface
        +
WeakMap<BrandedHandle, PrivateAuthority>
        +
only one mint function in the owning module
```

- A plain object is **not assignable** to the branded type (TypeScript).
- A cast impostor still fails WeakMap lookup (runtime).
- Authority is a private discriminated union. A truly pid-less internal wrapper
  stays opaque and handle-scoped. A numeric child stores a verified pid + start
  epoch or an inert refusal; group authority additionally stores the verified
  process-group/session identity.

### 4. Single sealed implementation site

There is **one** module allowed to call `process.kill` with a negative pid
(process-group signal): `src/main/vellum/process-signal.ts`.

Callers hold `OwnedProcess` and use `signalOwned` / `releaseOwned`.
`admitChildProcess({ source, child })` cannot receive a pid. Intentional POSIX
group authority is minted only by `spawnDetachedProcessGroup`, which hardcodes
`detached: true` and verifies `pgid === pid` plus process start identity.

No second “helper” that reopens bare pid kill.

### 5. Fail closed

| Situation | Behavior |
|-----------|----------|
| Numeric child pid is invalid, dangerous, or has no start epoch | Mint inert/refused authority; never call `child.kill` |
| Numeric child pid or start epoch changes before signal | Audit and refuse; retain/report the straggler |
| Group epoch/pgid cannot be captured at spawn | Reuse the verified child epoch for child-only fallback; if no child epoch exists, mint inert authority |
| Admitted group epoch cannot be revalidated at signal time | Refuse the signal; never fall back to `child.kill` |
| Original process-group leader has exited | Refuse group signaling; retain/report any orphan instead of guessing from a recycled PGID |
| Unknown / released handle | No OS signal |
| Missing child + no usable capability | No OS signal; retain/report until exit is observed |
| Tests with fake pid=self/1 | Obtain only inert authority; no child or group signal |
| `child.kill` explicitly returns `false` | Audit `child-signal-refused`; do not report an attempted signal |

### 6. Recoverable by design

Product code must not implement:

- home / disk wipes
- recursive deletes of arbitrary user paths
- git history destruction

Scoped lifecycle deletes (app sockets under `~/.vellum-command/…`, install staging,
tmpdir tests) are allowed when path-bounded.

Process death is recoverable (reopen apps). **Data destruction is not an
acceptable “cleanup” tool.**

### 7. Tests prove the seal; they are not the seal

Tests must show:

- Schema rejects dangerous pids
- Admit refuses them
- Forged handles never call `process.kill`
- Group kill only after central detached spawn and an unchanged epoch + `pgid === pid`

Flaky or missing tests do not reopen the API. The **types and module boundary**
are the seal.

---

## Process-signal surface (canonical)

```text
spawn child
    → admitChildProcess({ source, child })
         → read child.pid internally (the caller cannot pass one)
         → pid absent from the wrapper: mint opaque child-only authority
         → numeric pid: validate + capture exact start epoch
              → verified: mint epoch-bound child-only authority
              → invalid / unavailable: mint inert refusal
    → OR spawnDetachedProcessGroup(...)
         → child starts detached; capture child + optional group identity once
         → mint group OwnedProcess only when verification succeeds
         → otherwise reuse the verified child epoch or remain inert
    → store OwnedProcess on session / adapter record

kill / quit
    → signalOwned(owned, TerminatingSignal)
         → WeakMap get
         → group: read one coherent process-table snapshot
              → same live leader + start epoch + session + pgid
                  → process.kill(-pid) // only here
              → mismatch / leader gone / signal failure
                  → audited refusal; no fallback signal
         → numeric child: same handle pid + fresh matching start epoch
              → child.kill; explicit false is an audited refusal
              → pid/epoch mismatch: audited refusal; no signal
         → opaque pid-less wrapper: child.kill only
    → OR signalOwnedGroupLeader(owned, SIGTERM)
         → verified group authority only
         → revalidate the same live leader + epoch + session + pgid
         → signal the spawn-bound exact child handle, never the whole group
         → retain group authority for bounded SIGKILL escalation

exit
    → releaseOwned(owned)
```

**There is no raw-pid admission API, positive terminating `process.kill(pid)`,
or caller-supplied group-ownership boolean.** This is an application boundary,
not a claim that the operating-system kernel makes all process signaling
impossible: Vellum Command's own code cannot mint the authority without owning the
spawn path.

On macOS, process-table observation and the subsequent child or group signal
are not one atomic kernel operation. Vellum Command therefore requires the original
numeric child (and, for a group, its leader) to remain live with the captured
start epoch and fails closed when it cannot prove that identity. It deliberately
accepts a possible orphan over signaling a numeric pid or leaderless process
group that may have been recycled. The remaining `ps`-to-signal interval is an
operating-system TOCTOU limit; macOS does not offer Vellum Command a pidfd-style atomic
process-group signal primitive.

## Current enforced posture

- `app-process-plane.ts` is the application-wide spawn and lifetime registry.
  App shutdown closes admission first, then performs bounded TERM/KILL phases
  and reports retained stragglers instead of manufacturing a clean result.
- SSH process scopes wait for the child's `close` witness, not merely `exit`.
  Shared SSH commands use `ControlPersist=no`; `-O exit` remains confined to
  the explicit host removal/edit operation and is never a scope finalizer.
- Canvas names share one bounded ASCII contract across settings, node refs,
  projections, and the repository. Full authorial generations commit through
  the one app-owned `StateEngine`; render/export sidecars are outputs rather
  than product durability. Station projection installation is a typed,
  replace-only database operation and has no caller-selected filesystem
  destination.
- The Electron quit transaction synchronously closes authoring and resource
  admission, then awaits the canvas, browser, work-control, terminal, host,
  Hermes/Herdr, launchctl, and central process drains before deciding whether
  shutdown is clean.
- Architecture fitness tests inventory every asynchronous spawn,
  `process.kill`, direct `.kill`, detached group creation, and the SSH process
  implementation boundary.

## Explicit residual limits

These are not represented as solved guarantees:

- POSIX group signaling is still intentional for Vellum Command-created detached
  groups. Identity is revalidated immediately before signaling, but the final
  process-table-observation-to-signal interval is not atomic on macOS.
- SQLite state is protected by owner-only directory/file modes and one
  main-process connection. Vellum Command does not claim containment from arbitrary
  hostile code already running as the same operating-system user.
- Explicit host removal/edit may close a concurrently shared SSH master by
  design. Ordinary operation and app shutdown do not issue `-O exit`.

---

## Where this applies next

Any new code that:

- spawns OS processes
- forwards signals
- deletes files outside a known app root
- installs LaunchAgents / login items
- opens privileged network listeners

…must either reuse this capability pattern or introduce an equally closed
domain (brand + Schema + single mint site) **before** calling the OS.

Code review question for every PR:

> Can a confused agent or a bad test pass a bare pid/path into a host-destructive
> call? If yes, the PR is not done.

---

## Related code

| Area | Module |
|------|--------|
| Process kill seal | `src/main/vellum/process-signal.ts` |
| Central process lifetime | `src/main/vellum/app-process-plane.ts` |
| Terminal sessions | `src/main/vellum/term/local-host.ts` |
| Adapter CLI children | `src/main/vellum/adapters/exec.ts` |
| SSH child stop | `src/main/vellum/ssh/process-spawner.ts` |
| SSH brand precedent | `src/main/vellum/ssh/domain.ts` |
| Canvas repository boundary | `src/main/vellum/canvases.ts` |
| Architecture fitness | `tests/process-safety-architecture.test.ts` |
| Runtime safety tests | `tests/process-signal.test.ts`, `tests/canvas-path-capabilities.test.ts` |

---

## Product promise

Vellum Command is a **premium station**. Polished means:

- the user’s machine is treated as sacred
- host power is held behind domain types
- mistakes fail closed without session-wide blast radius
- remote durability and local quit law never justify open kill APIs

When in doubt: **narrow the type until the dangerous call cannot be written.**
