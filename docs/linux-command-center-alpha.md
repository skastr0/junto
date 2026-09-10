# Linux desktop alpha: install, build and sandbox preparation

**Status:** Linux desktop alpha targets Ubuntu 24.04 LTS x86-64 with glibc 2.39.
Official releases use the existing rootless archive and signed update feed.
Publication requires exact candidate qualification; this guide does not assert
that a qualified build is already serving. Fleet management and its headless
Remote package remain experimental, unreleased and feature-gated. Desktop
qualification does not promote Fleet to Beta or either surface to production.

## Install an official desktop alpha

Use the [official download page](https://vellumcommand.com/download) to obtain
one release's archive, signed `release.json`, corresponding-source
`sources.json`, and the independently published archive SHA-256. If the page
says the installer is being prepared, use the source-build instructions below;
do not substitute an old or unsigned package.

Download the three files into a new private directory. Close any previously
extracted Vellum Command desktop before installing or launching the managed
copy. Verify the archive against the download page **before extracting it or
executing its bundled CLI**. In that download directory, replace both values:

```sh
set -eu
ALPHA_VERSION="REPLACE_WITH_PUBLISHED_VERSION"
ALPHA_ARCHIVE_SHA256="REPLACE_WITH_PUBLISHED_ARCHIVE_SHA256"
ALPHA_ARCHIVE="vellum-runtime-$ALPHA_VERSION-linux-x64.tar.gz"

printf '%s  %s\n' "$ALPHA_ARCHIVE_SHA256" "$ALPHA_ARCHIVE" | sha256sum --check -
tar -xzf "$ALPHA_ARCHIVE"
"./vellum-runtime-$ALPHA_VERSION-linux-x64/resources/bin/vellum-command" desktop-install \
  --release "$PWD/release.json" \
  --archive "$PWD/$ALPHA_ARCHIVE" \
  --sources "$PWD/sources.json"
```

Stop on a checksum mismatch. The first-install command then verifies the
signed descriptor and exact archive/source inputs, stages an immutable
owner-local generation and creates the stable launcher and user desktop entry.
It refuses an existing managed installation. It does not launch the app, open
product state, update a running release or acquire administrator authority.
There is no downloaded shell pipeline or separate bootstrap executable. From
a reviewed source checkout, `bun scripts/install-linux-desktop.ts` accepts the
same three flags and invokes the same first-install API.

The managed generation is:

```text
~/.local/opt/vellum-command-alpha/<version>-<archiveSHA256>/vellum-command
```

After any required external sandbox preparation below, launch as the same
ordinary user:

```sh
"$HOME/.local/bin/vellum-command-desktop"
```

Official managed installations check for and download signed alpha updates
automatically. Choose **Restart** to activate a ready update; the app flushes
and stops its current runtime before activation. First-install commands are
not an update mechanism. Loose extracted copies and source builds do not gain
managed-update eligibility merely by being on disk. Desktop release descriptors
have no expiry; current key trust still applies. A stale feed can withhold newer
versions, but the updater admits only a strictly newer version with its exact
signed bytes.

Alpha installations retain old and staged managed generations. Disk usage can
grow across releases; automatic generation pruning is not implemented.

The signed descriptor lives at `/linux/x64/<version>/release.json`; the feed is
`/linux/x64/alpha.json`, and the matching source index is
`/linux/x64/sources/<version>/sources.json` under the existing release Worker.
See the [operator runbook](linux-operator-runbook.md) for refusal and recovery
behavior.

## Build from source

Build on Linux x86-64 with the exact Bun version in `packageManager` (currently
1.3.13), Node 24.10 or newer, and normal native build
tools (Python 3, a C/C++ toolchain, make, and the platform Electron libraries):

```sh
bun install --frozen-lockfile
bun run app:build:linux --fast
```

The build emits a relocatable desktop directory and `.tar.gz` archive under
`release/`. It includes the standalone CLI, project license, and required
third-party notices. It needs no billing or release credentials and uploads
nothing. A local archive is not an official signed release. Official desktop
publication uses the signed descriptor and source binding in
[the release key policy](linux-release-key-policy.md). Fleet manifest/checksum
verification is a separate gated release contract.

Launch the extracted `vellum-command` executable in your desktop session.
Source builds remain unmanaged and do not consume the official updater.
A restrictive Ubuntu sandbox policy can refuse an executable outside its
reviewed attachment path. The exact AppArmor profile below applies to the
managed alpha generation layout; it does not authorize arbitrary source-build
paths. Do not weaken the host or add sandbox bypass flags to make a local
build launch. External development-host preparation must be reviewed for the
actual executable path.

**Audience:** Alpha operators, host administrators, and qualification
reviewers

## Boundary

The Alpha executable remains an ordinary-user, rootless installation at:

```text
~/.local/opt/vellum-command-alpha/<version>-<archiveSHA256>/vellum-command
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

Run from a terminal inside the native Xorg session. Replace `ALPHA_GENERATION`
with the exact installed version-and-archive-digest directory. Keeping
`WAYLAND_DISPLAY` out of this launch and selecting X11 makes the exercised
display path explicit.

```sh
ALPHA_GENERATION="REPLACE_WITH_VERSION-ARCHIVE_SHA256"
ALPHA_EXECUTABLE="$HOME/.local/opt/vellum-command-alpha/$ALPHA_GENERATION/vellum-command"

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
ALPHA_GENERATION="REPLACE_WITH_VERSION-ARCHIVE_SHA256"
ALPHA_EXECUTABLE="$HOME/.local/opt/vellum-command-alpha/$ALPHA_GENERATION/vellum-command"

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
