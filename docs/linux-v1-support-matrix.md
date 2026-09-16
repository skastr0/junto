# Linux support matrix

**Status:** desktop alpha is the official Linux release target. Fleet Remote
is experimental, feature-gated and not Beta-qualified. A build or CI pass is
not an assertion that a signed release has passed installed-update checks or
been published.

## Desktop alpha

| Surface | Contract | Qualification boundary |
| --- | --- | --- |
| Distribution / CPU | Ubuntu 24.04 LTS, x86-64 | Official alpha target |
| C library | glibc 2.39 on Ubuntu 24.04 | Other distributions are not implied |
| Package | Rootless `vellum-command-runtime-<version>-linux-x64.tar.gz` | Exact archive must pass audit and signature admission |
| Install layout | `~/.local/opt/vellum-command-alpha/<version>-<archiveSHA256>/` | Immutable owner-local generations |
| Launch | `~/.local/bin/vellum-command-desktop` and user desktop entry | Same ordinary user; no system service |
| Desktop display | X11 or Wayland/XWayland session | Native session evidence is distinct from Xvfb CI smoke |
| Sandbox | Chromium sandbox with reviewed host-specific preparation if needed | No root launch, global policy weakening or sandbox bypass |
| Updates | Signed `/linux/x64/alpha.json`; automatic check/download, explicit Restart | Managed official installations only |
| Source builds / loose archives | Build and launch locally | Do not gain managed update eligibility by extraction |
| Corresponding source | `/linux/x64/sources/<version>/sources.json` | Bound to the exact released archive |
| State | One app-owned `~/.vellum-command/state/vellum-command.db` | Install/update never copies, replaces or separately opens it |
| Maturity | Alpha | Does not imply Fleet Beta or production qualification |

Use the [desktop guide](linux-command-center-alpha.md) and
[bootstrap guide](linux-desktop-bootstrap.md) for independently authenticated
first install, source builds and sandbox preparation, and the
[operator runbook](linux-operator-runbook.md) for updates and recovery.

## Gated Fleet Remote Beta target

| Surface | Target | Current boundary |
| --- | --- | --- |
| Core Remote runtime | Packaged Node, without Electron, Chromium, display server, Xvfb, xauth or mcookie | Candidate implementation; separate native signed qualification required |
| Supervision | Station-user service manager | No root-owned launcher; lifecycle proof required |
| Readiness | Current invocation, owner-local controls and SQLite readiness | Stale receipts or SSH success are insufficient |
| Login persistence | Optional externally configured user lingering | Never enabled by Junto |
| Host preflight | Read-only per-capability findings | Unknown security facts fail closed |
| Host preparation | Optional reviewed actions outside the app | Capability-specific degradation where safe |
| Browser automation | Unavailable in the first Remote Beta | Display/sandbox/secret-storage gaps do not block core Node health |
| Station API | Five bounded verbs over OpenSSH | Real two-installation qualification required |
| Work control | Owner-local Unix socket with process-bound identity | Exact rootless payload proof required |
| Maturity | Unreleased, experimental and feature-gated | Desktop alpha evidence grants no Fleet qualification |

Fleet contracts are in [host preparation](linux-host-preparation.md),
[package qualification](linux-package-qualification.md) and the
[production contract](linux-production-contract.md).

## Outside the qualified envelope

Linux ARM64, musl/Alpine and other distributions are not v1 targets. AppImage,
RPM, Snap, Flatpak and privileged `.deb` installers are not release units.
Container-only results do not establish host-kernel qualification. No `/opt`
installer, administrator-credential flow, privileged bridge, root journal,
setuid helper or package-manager fallback is supported.
