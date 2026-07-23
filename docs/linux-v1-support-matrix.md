# Linux v1 support matrix

The matrix is exact. “Unsupported” means unqualified for Linux v1, not
necessarily impossible in a future release.

| Surface | Linux v1 status | Contract |
|---|---|---|
| Distribution | Supported | Ubuntu 24.04 LTS |
| CPU / Debian architecture | Supported | x86-64 / `amd64` only |
| C library | Supported | glibc 2.39 or newer on Ubuntu 24.04 |
| Install artifact | Supported | exact signed `deb` from the release bundle |
| Remote display | Supported | package-owned X11/Xvfb, TCP disabled |
| Command Center display | Supported | normal X11 or Wayland/XWayland desktop session |
| Remote supervision | Supported | packaged systemd user service |
| Login persistence | Optional | explicit administrator-approved user lingering |
| Station-browser protocol | Supported | version `1` |
| Work-control protocol | Supported | `vellum-work/v1`, owner-local Unix socket |
| Linux arm64 / aarch64 | Unsupported | no v1 artifact or qualification |
| musl / Alpine | Unsupported | glibc is required |
| AppImage | Unsupported | not a v1 release unit |
| RPM | Unsupported | not a v1 release unit |
| Snap | Unsupported | not a v1 release unit |
| Flatpak | Unsupported | not a v1 release unit |
| Container-only host | Unsupported | does not substitute for the host-kernel qualification |

The support claim applies only to the exact package hash, source revision,
manifest, key ID, and evidence inventory admitted by the shipped verifier. A
locally rebuilt package or expired/revoked manifest is not the same release.
