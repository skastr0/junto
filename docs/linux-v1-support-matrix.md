# Linux v1 support matrix

**Status:** target Linux Station Beta support envelope; Linux is not yet
Beta-qualified

“Target” names the contract the implementation and evidence must satisfy. It
does not mean the current privileged `.deb` artifact is supported. The
canonical rootless install/update lane is not yet shipped, so every Linux v1
support claim remains unqualified.

The release label is **Beta**. Beta admission requires a fully tested core
userland path; optional capabilities may degrade independently, while
security-sensitive features fail closed.

| Surface | V1 target | Current status |
|---|---|---|
| Distribution | Ubuntu 24.04 LTS | Target; rootless lane unimplemented |
| CPU / Debian architecture name | x86-64 / `amd64` only | Target; release payload unqualified |
| C library | glibc 2.39 or newer on Ubuntu 24.04 | Target |
| Install/update | One exact signed owner-local payload; same ordinary-user transaction for first install and update | Not implemented |
| Custom image | Not required; stock supported host plus explicit optional preparation | Not yet qualified |
| Host preflight | Read-only, per-capability, no mutation or privilege input | Contract defined; implementation not yet qualified |
| Host preparation | Optional, explicit administrator action outside Vellum | Contract defined |
| Remote display | X11/Xvfb with host-provided `Xvfb`, `xauth`, and `mcookie`; TCP disabled | Core prerequisite; missing means `requires-admin` or `unavailable`, never display-less fallback |
| Command Center display | X11 or Wayland/XWayland desktop session | Target |
| Remote supervision | Station-user service manager; no root-owned launcher | Target; rootless service layout unimplemented |
| Remote boot readiness | Current invocation + owner-local control + SQLite readiness | Target; exact rootless receipt pending |
| Login persistence | Optional administrator-approved user lingering | Target; never app-managed |
| AppArmor/user namespaces | Separate host facts; Chromium capability requires one qualified sandbox path | Target; fail closed |
| Missing OS packages | Exact release-declared optional host actions | Target; never installed by Vellum |
| Station API | five verbs only; OpenSSH transport | Implemented surfaces require rootless end-to-end requalification |
| Browser automation | Host-local; actor and page on the same installation | Capability blocked when sandbox gate fails |
| Work control | `vellum-work/v1`, owner-local Unix socket with process-bind | Implemented surfaces require exact rootless payload proof |
| Linux arm64 / aarch64 | Outside v1 | Unsupported |
| musl / Alpine | Outside v1 | Unsupported |
| AppImage, RPM, Snap, Flatpak | Not v1 release units | Unsupported |
| Container-only host | Does not substitute for host-kernel qualification | Unsupported as production proof |
| Privileged `.deb`, `/opt`, release bridge/installer, root journal, administrator credential flow | Noncanonical migration residue | Must be removed; never fallback support |

Per-capability statuses and consequences are defined in
[Linux host preparation](linux-host-preparation.md#how-are-host-findings-reported).
Qualification is governed by
[Linux package qualification](linux-package-qualification.md).
