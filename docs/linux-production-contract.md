# Linux production contract

**Status:** ratified Phase 0 baseline against `docs/security-doctrine.md`

**Scope:** Ubuntu 24.04 LTS x86_64 only. ARM64 and other distros are out of
v1.

This document freezes the production meaning of “ready,” “secure,” and
“protected” for the Linux path. It is derived from the security doctrine and
from the repository state at HEAD after commits `3345afd`, `b3732b0`,
`049886a`, and `e974aca` (Phase 1 receipt unification).

## Ratified baseline commits

| Commit | Decision | Reason |
|---|---|---|
| `3345afd` fix(readiness): keep deep health observational | **keep** | Boot is generation + work control; Doctor owns terminal/browser/canvas |
| `b3732b0` fix(linux): distinguish desktop and systemd runtime | **keep** | Ambient `XDG_RUNTIME_DIR` must not put desktop sessions into Remote readiness publication |
| `049886a` test(notarize): isolate release path fixtures | **keep** | Test-only isolation; no product surface change |
| `e974aca` fix(linux): unify boot readiness on generation receipt | **keep** | Phase 1: preflight + installer + work-control agree on plain generation body |

## Production scope (v1)

One `.deb` supports:

- Linux Command Center with full desktop parity.
- Linux Remote running unattended under user systemd + Xvfb.

Cross-platform fleet:

- macOS Command Center → Linux Remote
- Linux Command Center → Linux Remote

Explicit exclusions for this release:

- Amp Orbs, Vouch, and other harness-managed compute
- Station-to-Station control plane
- Multi-tenant or multi-operator RBAC
- SSH keys, Tailscale, provider, and harness credentials absorbed into Vellum
- ARM64 and non-Ubuntu distributions

## Vocabulary

### Boot ready (structural)

True only when all of the following hold for the current unit generation:

1. `vellum-remote.service` is active/running with a 32-hex `InvocationID`.
2. Work control has published
   `$XDG_RUNTIME_DIR/vellum-remote/ready-$INVOCATION_ID` as a private
   regular file whose body is `${INVOCATION_ID}\n`.
3. Fresh private work control socket and token exist under `~/.vellum/work/`.
4. The packaged launcher owns the MainPID and has notified systemd
   (`Type=notify`) after observing that receipt.

Boot ready is the sole gate for:

- systemd unit start success
- managed install / update / rollback activation success
- deploy preflight `ready=1`

### Doctor observation (non-blocking)

Terminal control, browser transport/composition, canvas freshness, display,
sandbox, and capability probes are Doctor observations. They:

- may warn or fail release qualification
- must never block Station boot
- must never be written as a filesystem boot receipt

### Protected intent (migration in progress)

Landed first cuts:

- **Canvas live plane:** external raw file edits under `~/.vellum/canvases/`
  no longer rehydrate the running document. App-owned
  write/create/remove/mutate only.
- **Station topology:** `station.*` is seal-gated (`topology.key` +
  `topology.seal` HMAC). Generic `settingsPatch` cannot mint role; dedicated
  `settingsSetStationTopology` reseals. Tampered topology fails closed to
  role unset (StationRoleGate). See
  [`protected-topology-migration.md`](./protected-topology-migration.md).
- **Hosts enrollment:** `hosts.json` is seal-gated (`hosts.key` +
  `hosts.seal` HMAC). App registry writes reseal; offline membership mint
  fails closed to local-only. Same residual as station: same-UID wipe of
  both key and seal re-bootstraps.

Remaining debt (not production-complete protection):

- Canvas bytes still at `~/.vellum/canvases/*.canvas` (not app-private store;
  no import/export ceremony)
- Same-user delete of **both** topology/hosts key and seal re-enables
  bootstrap mint (same-UID non-claim)
- Recovery codes / CC transfer ceremony not implemented

“Protected” in a full production claim still requires the private canvas
store and recovery ceremony.

### Secure (doctrine-bound)

A boundary Vellum advertises is a boundary Vellum enforces. Credentials remain
operator/OS-owned. Edges + ports + process-bind are the agent capability plane.
No ambient host-destructive APIs.

## Single readiness receipt contract

```
path   := $XDG_RUNTIME_DIR/vellum-remote/ready-$INVOCATION_ID
body   := <32 hex INVOCATION_ID> + "\n"
mode   := 0600 regular file, owner-only, no symlink
writer := work-control after token rotation + listener bind
delete := RuntimeDirectory teardown on unit stop
```

Readers that must agree:

| Reader | Action |
|---|---|
| Launcher | wait, then `systemd-notify --ready` |
| Deploy preflight | `ready=1` only if private receipt + work plane |
| Privileged installer | activation success only if same receipt + generation |

Orphan contracts (must not exist):

- `/run/user/$UID/vellum/station-ready.json`
- Deep JSON multi-component ready file on the boot path

## Critical path after this contract

1. Repair preflight + installer to this receipt (Phase 1) — landed (`e974aca`).
2. Prove one desktop install and one headless Remote end-to-end on native
   Ubuntu x86_64 (Phase 2) — checklist in
   [`linux-package-qualification.md`](./linux-package-qualification.md);
   hardware proof remains operator-run.
3. Protect canvas and topology as app-owned operator intent (Phase 3) —
   canvas rehydrate cut + topology seal landed; private store + recovery
   remaining.
4. Explicit fleet topology, capability/revocation matrix, lifecycle
   qualification, release (Phases 4–8).

## Exit gates (summary)

Linux is production-ready only when:

- Desktop Command Center works on Ubuntu 24.04 x86_64
- Same artifact runs unattended as Remote under systemd/Xvfb
- Managed install, update, and rollback complete without receipt timeout
- Canvas and topology are protected operator intent
- Stations apply complete Command Center intent without negotiation
- Agents exercise only currently connected capabilities; revocation is next-action
- Credentials remain outside Vellum
- UI truthfully reports reachability, health, and residual risk
