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

Schema + pure frame compiler + Station apply store + Command Center delivery
status lane:

| Item | Status |
|---|---|
| Manifest + frame (`VELLUM-STATION-PROJECTION/1`) | v1 — full-canvas-set scope only |
| Station apply store | generation gate + content-addressed objects under `~/.vellum/projections/station/` |
| CC delivery queue (`projection/delivery.ts`) | compile from live docs · pure status machine · local apply · scheduleHostSync receipts |
| Station status `lastProjection` / `projections` | durable pending → applied \| rejected \| unreachable (Cut 7.1 surface) |
| Doctor metadata | `lastProjectionStatus` / generation / host / detail |
| Named remote recipe `compileProjectionFrameDeliver` | **landed** — stdin atomic write to `~/.vellum/projections/incoming.frame` |
| CC push transport (`createProjectionDeliveryTransport`) | **landed** — SshTransport + named recipe; wired via `pushLiveProjectionToEnrolledRemotes` (post-configure best-effort) |
| Remote apply of `incoming.frame` | **landed** — boot apply + materialize canvases + live authority admit |
| **Live canvas-pull** | **Fallback residual** — Settings labels it fallback; keep for offline/manual recovery |
| Auto-tick push on every CC canvas write | residual |
| Remote interval poll of drop path | residual (boot-only for beta) |
| Packaged `/opt/Vellum Command/resources/bin/vellum-projection-bridge` | residual (drop-file path ships first) |

Preferred fleet path in beta: Command Center stages projection frames over the
enrolled remote recipe; Remote applies on boot. canvas-pull remains available as
operator fallback and is not removed.

## Cut 7.1 residual — Projection reachability truth

| Item | Status |
|---|---|
| `StationProjectionRecord` on `station-status.json` | landed (generation, manifestSha256, status, detail, per-host map) |
| Doctor / Settings detail string | doctor metadata + detail line landed; Settings UI optional polish residual |
| Live Remote observation of remote `lastProjection` over SSH | residual (status file is readable in principle via existing doctor SSH cat of station-status; product-facing fleet matrix polish later) |
