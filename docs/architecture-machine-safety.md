# Architecture north star: machine safety

**Vellum must never threaten the user's machine.**

Not as a guideline. Not as “be careful in tests.” As a physical property of the
architecture: the type system, Effect services, and domain boundaries make
host-destructive operations **unrepresentable** or **unreachable** without a
capability that only Vellum can mint when it owns the resource.

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

- Group pids are captured only by `spawnDetachedProcessGroup` after the child
  actually starts, together with its start epoch and process-group identity.
- Signals that may terminate: `TerminatingSignal` — closed literal set.
- SSH endpoints, remote paths, etc. already follow this pattern (`SshEndpoint`,
  `RemoteCommand`). New host-touching domains copy that pattern.

Invalid values **cannot** enter the authority store. Schema failure is not a
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
- Authority is a private discriminated union. Child authority stores only a
  child handle; group authority additionally stores the verified pid + epoch.

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
| Group epoch/pgid cannot be captured or revalidated | Child-only authority / `child.kill` |
| Unknown / released handle | No OS signal |
| Missing child + no capability | No-op / session marked exited |
| Tests with fake pid=self/1 | Cannot obtain `OwnedProcess`; child.kill only |

### 6. Recoverable by design

Product code must not implement:

- home / disk wipes
- recursive deletes of arbitrary user paths
- git history destruction

Scoped lifecycle deletes (app sockets under `~/.vellum/…`, install staging,
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
         → mint child-only OwnedProcess + WeakMap authority
    → OR spawnDetachedProcessGroup(...)
         → child starts detached; capture start epoch and pgid === pid
         → mint group OwnedProcess only when verification succeeds
    → store OwnedProcess on session / adapter record

kill / quit
    → signalOwned(owned, TerminatingSignal)
         → WeakMap get
         → group: recheck epoch + pgid, then process.kill(-pid) // only here
         → otherwise child.kill

exit
    → releaseOwned(owned)
```

**There is no raw-pid admission API, positive terminating `process.kill(pid)`,
or caller-supplied group-ownership boolean.** This is an application boundary,
not a claim that the operating-system kernel makes all process signaling
impossible: Vellum's own code cannot mint the authority without owning the
spawn path.

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
| Terminal sessions | `src/main/vellum/term/local-host.ts` |
| Adapter CLI children | `src/main/vellum/adapters/exec.ts` |
| SSH child stop | `src/main/vellum/ssh/process-spawner.ts` |
| SSH brand precedent | `src/main/vellum/ssh/domain.ts` |
| Tests | `tests/process-signal.test.ts` |

---

## Product promise

Vellum is a **premium station**. Polished means:

- the user’s machine is treated as sacred
- host power is held behind domain types
- mistakes fail closed without session-wide blast radius
- remote durability and local quit law never justify open kill APIs

When in doubt: **narrow the type until the dangerous call cannot be written.**
