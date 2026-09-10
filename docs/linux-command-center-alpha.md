# Linux Command Center Alpha sandbox preparation

**Status:** Linux desktop is alpha and builds as an Electron application.
Fleet management and the headless Remote package nested under Fleet remain
experimental and feature-gated. Desktop build success does not qualify Remote
or promote either surface to beta or production.

## Build from source

Build on Linux x86-64 with Bun, Node 24.10 or newer, and normal native build
tools (Python 3, a C/C++ toolchain, make, and the platform Electron libraries):

```sh
bun install --frozen-lockfile
bun run app:build:linux --fast
```

The build emits a relocatable desktop directory and `.tar.gz` archive under
`release/`. It includes the standalone CLI, project license, and required
third-party notices. It needs no billing or release credentials and uploads
nothing. A local archive is not an official signed release. Official Linux
publication retains the detached manifest/checksum verification described in
[the release key policy](linux-release-key-policy.md).

Launch the extracted `vellum-command` executable in your desktop session. The
Ubuntu 24.04 AppArmor preparation below applies when that host restricts
unprivileged user namespaces. This reviewed policy is external host preparation,
not a packaged payload; desktop alpha does not bypass Chromium's sandbox.

**Audience:** Alpha operators, host administrators, and qualification
reviewers

## Boundary

The Alpha executable remains an ordinary-user, rootless installation at:

```text
~/.local/opt/vellum-command-alpha/ALPHA_VERSION/vellum-command
```

Ubuntu 24.04 restricts unprivileged user namespaces through AppArmor. The
reviewed source file [`scripts/linux-command-center.apparmor`](../scripts/linux-command-center.apparmor)
grants only `userns,` to the exact versioned Alpha executable attachment. It
uses AppArmor ABI 4.0, imports `tunables/global`, names the profile
`vellum-command`, and uses `flags=(unconfined)`. There is no local include and
no second rule in the profile body.

This file is external host preparation only. It is intentionally excluded from
the Vellum Command package, signed rootless payload, installer, updater, and
runtime resources. Vellum Command never invokes `sudo`, loads or installs this
profile, asks for administrator credentials, or edits host policy. An operator
or host administrator separately reviews and installs the exact checked-in
file. Installing the policy does not move the executable or any Vellum Command
state into a root-owned location; the application package remains rootless.

## Review and load the exact policy

Run these commands from the reviewed source checkout. The administrator action
copies the file byte-for-byte and loads that copy. Do not hand-edit the source,
the installed copy, or add a local policy fragment.

```sh
PROFILE_SOURCE="$PWD/scripts/linux-command-center.apparmor"
PROFILE_DESTINATION="/etc/apparmor.d/vellum-command"

test -f "$PROFILE_SOURCE"
sudo install -o root -g root -m 0644 "$PROFILE_SOURCE" "$PROFILE_DESTINATION"
cmp "$PROFILE_SOURCE" "$PROFILE_DESTINATION"
sudo apparmor_parser -r "$PROFILE_DESTINATION"
sudo aa-status | grep -F "vellum-command"
```

`cmp` must succeed before launch. If review or comparison fails, stop; do not
synthesize a broader profile. The expected loaded profile is
`vellum-command`. The runtime label observed through `/proc` is expected to be
`vellum-command (unconfined)`.

## Xorg launch and test

Run from a terminal inside the native Xorg session. Replace `ALPHA_VERSION`
with the installed version directory. Keeping `WAYLAND_DISPLAY` out of this
launch and selecting X11 makes the exercised display path explicit.

```sh
ALPHA_VERSION="REPLACE_WITH_REVIEWED_VERSION"
ALPHA_EXECUTABLE="$HOME/.local/opt/vellum-command-alpha/$ALPHA_VERSION/vellum-command"

test "${XDG_SESSION_TYPE:-}" = "x11"
test -n "${DISPLAY:-}"
test -x "$ALPHA_EXECUTABLE"
env -u WAYLAND_DISPLAY "$ALPHA_EXECUTABLE" --ozone-platform=x11 &
ALPHA_PID=$!
sleep 2
cat "/proc/$ALPHA_PID/attr/current"
wait "$ALPHA_PID"
```

Confirm that the window opens natively and that the label is
`vellum-command (unconfined)`. Close Vellum Command normally so `wait` returns.
A missing profile, a different label, or a Chromium namespace failure is a
failed Alpha test, not permission to weaken the host.

## Native Wayland launch and test

Run from a terminal inside the native Wayland session. Selecting Wayland is
required for this test; an XWayland launch is not native Wayland evidence.

```sh
ALPHA_VERSION="REPLACE_WITH_REVIEWED_VERSION"
ALPHA_EXECUTABLE="$HOME/.local/opt/vellum-command-alpha/$ALPHA_VERSION/vellum-command"

test "${XDG_SESSION_TYPE:-}" = "wayland"
test -n "${WAYLAND_DISPLAY:-}"
test -x "$ALPHA_EXECUTABLE"
"$ALPHA_EXECUTABLE" --ozone-platform=wayland &
ALPHA_PID=$!
sleep 2
cat "/proc/$ALPHA_PID/attr/current"
wait "$ALPHA_PID"
```

Confirm that the window opens through native Wayland and that the label is
`vellum-command (unconfined)`. Close Vellum Command normally so `wait` returns.
Record the Ubuntu version, display session, installed Alpha version, policy
file digest, label, and result as qualification evidence.

## No weakening or fallback

Never add `--no-sandbox` or `--disable-setuid-sandbox`, change a global
user-namespace sysctl, install or alter a setuid Chromium sandbox, disable
AppArmor, run the Vellum Command executable as root, or broaden the profile.
The exact `userns,` grant is the Alpha sandbox boundary. If it does not work on
the stock Ubuntu 24.04 host, stop qualification and retain the failure.

## Remove the external preparation

After closing every Alpha process, the administrator can unload and remove the
external policy:

```sh
PROFILE_DESTINATION="/etc/apparmor.d/vellum-command"
sudo apparmor_parser -R "$PROFILE_DESTINATION"
sudo rm -- "$PROFILE_DESTINATION"
```

Removal does not uninstall or mutate the rootless Vellum Command Alpha bytes.
A later Alpha test must reinstall the exact reviewed policy before launch.
