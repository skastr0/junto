# Linux support matrix

**Status:** desktop alpha is the official Linux release target. A build or CI
pass is not an assertion that a signed release has passed installed-update
checks or been published.

## Desktop alpha

| Surface | Contract | Qualification boundary |
| --- | --- | --- |
| Distribution / CPU | Ubuntu 24.04 LTS, x86-64 | Official alpha target |
| C library | glibc 2.39 on Ubuntu 24.04 | Other distributions are not implied |
| Package | Rootless `junto-runtime-<version>-linux-x64.tar.gz` | Exact archive must pass audit and signature admission |
| Install layout | `~/.local/opt/junto-alpha/<version>-<archiveSHA256>/` | Immutable owner-local generations |
| Launch | `~/.local/bin/junto-desktop` and user desktop entry | Same ordinary user; no system service |
| Desktop display | X11 or Wayland/XWayland session | Native session evidence is distinct from Xvfb CI smoke |
| Sandbox | Chromium sandbox with reviewed host-specific preparation if needed | No root launch, global policy weakening or sandbox bypass |
| Updates | Signed `/linux/x64/alpha.json`; automatic check/download, explicit Restart | Managed official installations only |
| Source builds / loose archives | Build and launch locally | Do not gain managed update eligibility by extraction |
| State | One app-owned `~/.junto/state/junto.db` | Install/update never copies, replaces or separately opens it |
| Maturity | Alpha | Does not imply production qualification |

Use the [desktop guide](linux-desktop-alpha.md) and
[bootstrap guide](linux-desktop-bootstrap.md) for independently authenticated
first install, source builds and sandbox preparation, and the
[operator runbook](linux-operator-runbook.md) for updates and recovery.

## Outside the qualified envelope

Linux ARM64, musl/Alpine and other distributions are not v1 targets. AppImage,
RPM, Snap, Flatpak and privileged `.deb` installers are not release units.
Container-only results do not establish host-kernel qualification. No `/opt`
installer, administrator-credential flow, privileged bridge, root journal,
setuid helper or package-manager fallback is supported.
