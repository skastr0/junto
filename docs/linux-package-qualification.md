# Linux package qualification

Vellum Linux v1 supports one release target: Ubuntu 24.04 LTS, glibc, x86-64.
The release unit is a versioned `deb`; the matching `.unpacked` directory is a
diagnostic artifact, not an installer. AppImage, Snap, Flatpak, RPM, musl, and
Linux arm64 are outside this support contract.

## Build and static audit

Run the native build on a clean Ubuntu 24.04 x86-64 worker:

```sh
bun install --frozen-lockfile
bun run app:build:linux -- --verify
```

The build rebuilds `node-pty` for the target Electron ABI, emits both artifacts,
and runs `scripts/audit-linux-package.ts`. That audit fails closed on the deb
identity/dependency inventory, archive ownership and modes, desktop metadata,
AppArmor policy, x86-64 ELF objects, unresolved Electron or `node-pty` shared
libraries, ASAR unpack placement, helper modes, and the complete Electron fuse
wire.

## Disposable-host gate

Static package success is not release proof. Before promotion, use a disposable
Ubuntu 24.04 x86-64 VM (not a cross-build and not a container standing in for
the host kernel) to record all of the following:

1. Install the deb as root, then run Vellum as an ordinary user under the
   packaged Xvfb/display path.
2. Confirm `/etc/apparmor.d/vellum` is loaded and labels the exact executable
   `/opt/Vellum Command/vellum`; the profile grants `userns` only. Confirm
   `chrome-sandbox` is root-owned mode `0755`, not setuid.
3. Confirm a real renderer starts with Chromium sandboxing active. Every
   sandbox-disabling switch must terminate packaged startup before Vellum owns
   a renderer, socket, document, or child process.
4. Run the real packaged PTY gate: interactive echo, UTF-8, resize,
   `TERM`/`COLORTERM`, login-shell behavior, exit status, and bounded shutdown
   through Vellum's sealed process authority. A pipe fallback is a failure.
5. Run the packaged station smoke and record zero TCP/CDP listeners, correct
   control-file modes, successful work/browser doctor calls, and clean
   descendant shutdown.
6. Exercise install, same-version reinstall, upgrade, downgrade, remove, and
   purge. Snapshot the test user's `~/.vellum` tree before each package action
   and prove it is byte-for-byte unchanged afterward.
7. Inspect the installed `/opt/Vellum Command` tree as root: every path remains
   root-owned and no regular file or directory is group/world writable.

Do not weaken `kernel.unprivileged_userns_clone`, disable AppArmor, add
`--no-sandbox`, make `chrome-sandbox` setuid, run Vellum itself as root, or use
a real operator home/profile to make this gate pass. A failed or unavailable
host check remains an open release gate.
