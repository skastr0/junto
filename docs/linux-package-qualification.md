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

The build worker needs Bun plus Node 22.12.0 or newer; Node is the declared
runtime for `@electron/rebuild` and its node-gyp subprocess. The package lane
uses only locally installed, lockfile-resolved tools. It rebuilds only
`node-pty`, sequentially, for the target Electron ABI and disables
electron-builder's broader native-dependency rebuild pass.

The build emits both artifacts and runs `scripts/audit-linux-package.ts`. That
audit fails closed on the deb identity/dependency inventory, archive ownership
and modes, desktop metadata, AppArmor policy, x86-64 ELF objects, unresolved
Electron or `node-pty` shared libraries, ASAR unpack placement, executable
modes, and the complete Electron fuse wire.

## Headless Remote user service

The deb carries, but does not automatically enable, the versioned
`resources/systemd/vellum-remote-launch-v1` launcher and
`resources/systemd/vellum-remote.service` unit. Activation is an operator or
deployment action for the intended station user; the package never selects a
role, host ID, or user on its own:

```sh
install -D -m 0644 \
  '/opt/Vellum Command/resources/systemd/vellum-remote.service' \
  "$HOME/.config/systemd/user/vellum-remote.service"
systemctl --user daemon-reload
systemctl --user enable --now vellum-remote.service
```

The unit starts one package-owned Xvfb `:89` with an Xauthority file in the
user runtime directory, then starts the fixed headless Electron invocation on
the explicit X11/Ozone path. It removes only a dead, regular `:89` lock and
never unlinks an existing socket or signals an unowned process.

The package does not enable user lingering. If the Remote must survive reboot
without a login, an administrator must explicitly approve and run
`loginctl enable-linger <station-user>`. After that approval, rerun the three
`systemctl --user` commands above; they are idempotent. Without linger, the
unit runs for the user manager's normal login lifetime.

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
8. Qualify the user service under systemd: fresh start, crash restart, deliberate
   stop/disable, duplicate start, stale lock, logout/login, reboot, upgrade, and
   uninstall. Confirm only the unit cgroup's Vellum/Xvfb processes stop; existing
   ACP, Herdr, SSH, and other station processes remain alive.

Do not weaken `kernel.unprivileged_userns_clone`, disable AppArmor, add
`--no-sandbox`, make `chrome-sandbox` setuid, run Vellum itself as root, or use
a real operator home/profile to make this gate pass. A failed or unavailable
host check remains an open release gate.
