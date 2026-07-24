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
