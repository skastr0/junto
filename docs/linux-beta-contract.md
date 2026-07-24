# Linux beta contract (`0.1.0-beta.1`)

Narrow fleet beta surface. This document does **not** supersede
`docs/linux-production-contract.md` or `docs/security-doctrine.md` — it freezes
what ships in beta and what is explicitly out of scope.

## Supported

| Surface | Contract |
|---|---|
| Platforms | Ubuntu 24.04 x86_64 only |
| Command Center | One Linux desktop install of the same `.deb` |
| Remote | Manual `.deb` install + user systemd unit + Xvfb launcher |
| Connectivity | Operator-owned OpenSSH route CC → Remote (enrolled host registry) |
| Canvas intent | App-owned canonical store (migration from public `~/.vellum/canvases`) |
| Fleet sync | Complete replace-only CC → Station projections |
| Enrollment | **Enroll fresh Remote** only on pristine topology (no overwrite) |
| Local work | Agents, chat, native terminal, browser pages, work control |

## Explicitly disabled in beta

| Capability | `RELEASE_CAPABILITIES` |
|---|---|
| Managed Remote install/update/rollback | `managedRemoteDeploy` / `managedRemoteUpdate` / `managedRemoteRollback` = false |
| Darwin Remote deploy | `darwinRemoteDeploy` = false |
| Command Center transfer | `commandCenterTransfer` = false |
| In-app administrator-password deploy ceremony | no entry point |

Manual `.deb` install is the only package path. TermControl remains observational
for managed paths (already non-gating where those paths still exist as dormant code).

## Operator sequence (Remote)

```text
1. Install the exact signed beta .deb on the target (do not launch yet if enrolling)
2. From Command Center: Enroll fresh Remote over the enrolled SSH route
3. Start/enable vellum-remote.service
4. Wait for topology admission + generation readiness receipt + work plane
```

Staging enrollment is not readiness. SSH exit zero alone is not fleet sync.

## Doctrine alignment

- Trusted single-operator factory (see `docs/security-doctrine.md`).
- No hostile same-UID multi-tenant containment theater.
- Edges + process-bind remain the agent capability plane.
- No cross-machine Vellum secret / projection HMAC in beta — OpenSSH + SHA-256 completeness.

## Not beta-ready claims

Do not label the beta production-ready or fleet-grade until native Ubuntu
acceptance (CC + Remote + projection interruption/reboot scenarios) and the
existing signed release lane promote an exact artifact.

## Cut 3 residual — SSH command construction

Beta seals freeform remote command mint behind named recipes. Residual debt
is intentional and must not grow:

| Item | Status |
|---|---|
| `makeRemoteCommand` | Single WeakMap brand in `ssh/domain.ts`; **not** on `ssh/index.ts`. Mint only from `remote-plan` / `hermes-remote-plan` / `read-commands` (+ kernel tests). Architecture tests ban product imports. |
| Named recipes | Product hosts use read constructors + plan compilers only. |
| Darwin `bash -lc` | `compileDarwinRemoteDeployScript` remains in `remote-plan` for dormant Darwin code/tests; **not** public. Product path refused first via `RELEASE_CAPABILITIES.darwinRemoteDeploy` (loader + provider entry) — no script compile on beta fleet path. |
| Parallel command types | **Do not invent** separate WeakMap brands for sh vs bash vs argv — seal at named-compiler boundary. |

Post-beta: re-enable `darwinRemoteDeploy` only with an explicit product decision; prefer migrating Darwin install ceremony toward typed plans before widening the freeform surface.

## Cut 5 residual — Station projection delivery

Schema + pure frame compiler + Station apply store land first
(`src/shared/station-projection.ts`, `src/main/vellum/projection/`). Complete
generations install under `~/.vellum/projections/station/` with a `current.json`
pointer (refuse lower generation; same gen + frame hash is idempotent).

| Item | Status |
|---|---|
| Manifest + frame (`VELLUM-STATION-PROJECTION/1`) | v1 skeleton — full-canvas-set scope only |
| Station apply store | generation gate + content-addressed objects |
| **Live canvas-pull** | **Still the product path** until the CC→Remote delivery lane lands |
| CC push / Remote frame pull / live admit from projection store | residual — do not remove canvas-pull yet |

Operators continue to use Remote canvas-pull for fleet canvas sync in beta.
Projection install into the Station store is not yet the live authority path.
