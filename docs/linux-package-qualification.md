# Linux package qualification

**Status:** required evidence contract; no two-installation pass is implied by
this document or by CI

Vellum Linux v1 supports one release target: Ubuntu 24.04 LTS, glibc, x86-64.
The release unit is a versioned `deb`; the matching `.unpacked` directory is a
diagnostic artifact, not an installer. AppImage, Snap, Flatpak, RPM, musl, and
Linux arm64 are outside this support contract.

Authoritative boot and vocabulary: [`linux-production-contract.md`](./linux-production-contract.md).
Phase 1 repaired preflight and the privileged installer to the generation
receipt. This document is the Phase 2 qualification surface for package audit
expectations and operator proof on real Ubuntu hardware.

## Boot ready vs Doctor (do not collapse)

| Plane | Gate | Evidence |
|---|---|---|
| **Boot ready** | unit start, managed install/update, deploy preflight `ready=1` | `vellum-remote.service` active; private generation receipt `$XDG_RUNTIME_DIR/vellum-remote/ready-$INVOCATION_ID` with body `${INVOCATION_ID}\n`; fresh `~/.vellum/work/` socket + token; launcher notified systemd (`Type=notify`) |
| **Doctor observation** | release qualification / day-to-day ops | terminal, browser, canvas, display, sandbox, capability probes |

Orphan contracts (must not reappear):

- `/run/user/$UID/vellum/station-ready.json`
- Deep JSON multi-component ready file on the boot path
- `python3` as a boot-path gate (package dependency is for `unix-peer-pid.py` identity only)

Static package audit (`scripts/audit-linux-package.ts`) pins the packaged
launcher and unit to the generation-receipt notify path. It does not invent a
second readiness plane.

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
modes, the complete Electron fuse wire, and the Remote launcher/unit
generation-receipt contract (`Type=notify`, `RuntimeDirectory=vellum-remote`,
plain `ready-$GENERATION` body, work-control socket/token, no
`station-ready.json`).

Portable unit tests for the receipt shape run on any host
(`tests/linux-generation-readiness-contract.test.ts`). Full `deb` install and
GUI smoke require native Linux x64.

## Headless Remote user service

The deb installs the immutable versioned
`resources/systemd/vellum-remote-launch-v1` launcher and registers its
`resources/systemd/vellum-remote.service` unit at
`/usr/lib/systemd/user/vellum-remote.service` as a qualified symlink. It does
not automatically enable the unit. Activation is an operator or deployment
action for the intended station user; the package never selects a role, host
ID, or user on its own:

```sh
systemctl --user daemon-reload
systemctl --user enable --now vellum-remote.service
```

The unit starts one package-owned Xvfb on the first free display in the
qualified range (`:89`–`:96`) with an Xauthority file under the unit
`RuntimeDirectory`, then starts the fixed headless Electron invocation on the
explicit X11/Ozone path. It never unlinks an existing X11 socket or signals an
unowned process.

Boot success is **only** the generation receipt + work control plane above.
Terminal/browser/canvas health never block unit start.

The package does not enable user lingering. If the Remote must survive reboot
without a login, an administrator must explicitly approve and run
`loginctl enable-linger <station-user>`. After that approval, rerun the three
`systemctl --user` commands above; they are idempotent. Without linger, the
unit runs for the user manager's normal login lifetime.

## Phase 2 qualification checklist

Scope: prove one desktop Command Center install and one headless Remote
end-to-end on **native Ubuntu 24.04 x86_64** using the generation-receipt boot
contract. Do not invent new readiness infrastructure.

### What this machine (macOS / non-Ubuntu) can prove

- Source + unit gates that do not require Linux package install
- Generation-receipt contract tests
- Launcher/unit string audits when run as part of the suite
- Documentation and audit expectation alignment

### What requires native Ubuntu x86_64 (operator-run)

Everything below. Cross-build, container-as-host-kernel, and remote SSH-only
smoke without a real install do **not** close Phase 2.

### Required two-installation receipt

The operator-run fleet proof produces exactly
`station-qualification-receipt.json` with schema
`vellum/station-two-installation-qualification/v1`. It binds the proof to one
source commit, the exact `deb` filename and SHA-256, the selected Station
protocol, and the observed Command Center and Remote installation identities
and app versions. The Remote identity also records
`platform: "linux"`, `distribution: "ubuntu"`,
`distributionVersion: "24.04"`, and `architecture: "x64"`.

The receipt's ordered `checks` are:

1. `pair`
2. `configure`
3. `project`
4. `status`
5. `report`
6. `project-response-loss-retry`
7. `remote-offline-work`
8. `report-response-loss-retry`
9. `protocol-no-overlap-rejection`

`ok: true` is valid only when all nine checks pass against those exact
installations and package bytes. CI cannot create this receipt. The final
release promotion gate separately hashes and binds it in
`release-promotion-receipt.json`; neither filename may be synthesized from
package-smoke success.

### A. Native x86_64 Ubuntu Command Center proof

Run as an ordinary desktop user after a root `deb` install (not under the
Remote user unit):

1. Install the exact release `deb` as root; launch Vellum from the desktop
   entry or `/opt/Vellum Command/vellum` under a normal X11 or Wayland/XWayland
   session.
2. Confirm AppArmor labels the exact executable
   `/opt/Vellum Command/vellum` with the packaged userns-only profile;
   `chrome-sandbox` is root-owned mode `0755`, not setuid.
3. Confirm a real renderer starts with Chromium sandboxing active. Every
   sandbox-disabling switch must terminate packaged startup before Vellum owns
   a renderer, socket, document, or child process.
4. Run the packaged native-PTY gate: interactive echo, UTF-8, resize,
   `TERM`/`COLORTERM`, login-shell behavior, exit status, and bounded shutdown
   through sealed process authority. A pipe fallback is a failure.
5. Configure role `command-center`, open a test canvas, attach a local agent,
   and prove work-control CLIs only from a process-bound agent tree.
6. Record Doctor observations (station, work, terminal, browser) for
   qualification. Red Doctor components fail **release qualification**, not
   desktop process start.
7. Desktop sessions must **not** publish
   `$XDG_RUNTIME_DIR/vellum-remote/ready-*` unless this process is the
   systemd-managed Remote generation (ambient `XDG_RUNTIME_DIR` alone is not
   Remote readiness authority).

### B. Headless Remote proof

On a disposable Ubuntu 24.04 x86_64 host (or disposable VM with host kernel):

1. Install the same `deb` as root. Enable the packaged user service for the
   intended station user only:

   ```sh
   systemctl --user daemon-reload
   systemctl --user enable --now vellum-remote.service
   ```

2. Boot gate (must all hold for the current `InvocationID`):

   ```sh
   systemctl --user show vellum-remote.service \
     --property=ActiveState,SubState,MainPID,InvocationID,Result,NRestarts
   # replace $UID / $INVOCATION_ID from show:
   stat -c '%a %F %U' /run/user/$UID/vellum-remote/ready-$INVOCATION_ID
   cat /run/user/$UID/vellum-remote/ready-$INVOCATION_ID
   # expect: mode 600, regular file, body is exactly the 32-hex InvocationID + newline
   ```

3. Confirm fresh owner-only work control under `~/.vellum/work/`
   (`control.sock` + `token`). Unit start must not wait on terminal or browser
   sockets.
4. Confirm no TCP/CDP listeners among Vellum descendants; control files remain
   owner-only.
5. Lifecycle: fresh start, crash restart, stop/disable, duplicate start, stale
   X11 lock in range, logout/login, reboot (with linger only if
   administrator-approved), upgrade, uninstall. Only the unit cgroup's
   Vellum/Xvfb processes stop; existing ACP, Herdr, SSH, and other station
   processes remain alive.
6. Doctor observations (terminal/browser/canvas) for release qualification
   only — never as the systemd ready gate.
7. From a Command Center (macOS or Linux), managed deploy preflight reports
   `ready=1` only when the same generation receipt + work plane hold.

### C. Shared package integrity (both roles)

1. Exercise install, same-version reinstall, upgrade, remove, and purge.
   Exercise a downgrade only as a rejection: no older build may activate.
   Snapshot the test user's `~/.vellum` tree before each package action and
   prove it is byte-for-byte unchanged afterward.
2. Inspect `/opt/Vellum Command` as root: every path remains root-owned; no
   regular file or directory is group/world writable.
3. Confirm the package does not ship sudoers policy or
   `station-ready.json`.

### D. Remains operator-run on real hardware

The following cannot be closed from this macOS development machine or from
CI-only package construction without a disposable Ubuntu desktop/Remote host:

- GUI Command Center install and interactive sandbox/PTY proof
- Unattended Remote under real `systemd --user` + host kernel
- Logout/login, linger, and reboot persistence decisions
- Managed install/update against a live Remote with administrator
  password ceremony
- Cross-host fleet (macOS or Linux Command Center → Linux Remote) with live
  Station API projection/report convergence and edge-routed pulse
- Synchronous CC-home task start on a Remote actor, continued progress with
  Command Center closed, and rejection of any new disconnected CC-home claim
- Remote-home task claim plus permitted request/artifact creation while
  offline, followed by cursor-based reconciliation without overwriting
  Remote-owned state
- Proof that neither Remote callbacks nor Remote-to-Remote control connections
  are required

CI (`.github/workflows/linux-release.yml`) records target-native package,
installed PTY, and installed GUI/sandbox smoke under Xvfb when that workflow
runs. CI evidence is necessary for promotion eligibility; it does not replace
operator Phase 2 recording of Command Center desktop and Remote unit proofs
above, and its output remains explicitly unqualified until the exact
two-installation receipt is supplied.

## Disposable-host discipline

Do not weaken `kernel.unprivileged_userns_clone`, disable AppArmor, add
`--no-sandbox`, make `chrome-sandbox` setuid, run Vellum itself as root, or use
a real operator home/profile to make qualification pass. A failed or
unavailable host check remains an open release gate.
