# Vellum Linux v1 operator runbook

This runbook is the operations surface shipped inside every signed Linux
release bundle as `OPERATIONS.md`. A supported operator needs the bundle, an
independently authenticated Vellum release-key fingerprint, and an Ubuntu
administrator credential. A repository checkout and sibling packages are not
part of the install path.

The release signature is necessary but does not grant release authority. A
bundle is public only after the named human release authority records a GO
decision for its exact manifest digest.

The exact signed metadata files are `release-manifest.json`,
`release-manifest.sig`, and `SHA256SUMS`.

## Support envelope

Linux v1 supports Ubuntu 24.04 LTS on x86-64 with glibc 2.39 or newer. The
installer is the signed `deb`. A Remote station runs on the packaged X11/Xvfb
path. A Command Center runs in a normal X11 session or through the desktop's
native Wayland/XWayland path.

Read the exact matrix shipped beside this runbook as `SUPPORT.md`. Linux
arm64, musl/Alpine, AppImage, RPM, Snap, Flatpak, and container-only hosts are
not qualified in v1.

## Before any package mutation

1. Obtain the release archive from the HTTPS locator announced by the release
   authority. The archive name is
   `vellum-X.Y.Z-ubuntu-24.04-x64-release.tar.gz`.
2. Through a second authenticated channel, obtain the current keyring, key ID,
   release-key fingerprint, and SHA-256 of the offline verifier. A keyring or
   verifier carried only by the same untrusted download is not an independent
   trust anchor.
3. Extract the archive into a new owner-only download directory. Do not merge
   releases. Before executing or installing anything from it, copy the complete
   bundle into a fresh root-owned staging directory without preserving source
   ownership or mode. The version directory must not already exist:

   ```sh
   set -eu
   sudo install -d -o root -g root -m 0755 \
     /var/lib/vellum-release-stage
   sudo mkdir -m 0755 -- \
     /var/lib/vellum-release-stage/X.Y.Z
   sudo cp -R --no-preserve=ownership,mode,timestamps -- \
     ./. /var/lib/vellum-release-stage/X.Y.Z/
   sudo find /var/lib/vellum-release-stage/X.Y.Z \
     -type d -exec chmod 0755 {} +
   sudo find /var/lib/vellum-release-stage/X.Y.Z \
     -type f -exec chmod 0644 {} +
   sudo test ! -L \
     /var/lib/vellum-release-stage/X.Y.Z/vellum-linux-verify-x64
   sudo test -f \
     /var/lib/vellum-release-stage/X.Y.Z/vellum-linux-verify-x64
   sudo chmod 0755 \
     /var/lib/vellum-release-stage/X.Y.Z/vellum-linux-verify-x64
   ```

   Stop if the copy changes during staging, if any path is a symlink, or if
   the staged directory is not entirely root-owned and non-writable by the
   station user. The verifier's exact-inventory check rejects symlinks,
   undeclared files, missing files, and changed bytes in this protected copy.
4. From the Command Center, record the peer product version, station-browser
   protocol, and work-control protocol. Linux v1 expects station-browser `1`
   and work-control `vellum-work/v1`.
5. Check the verifier against the independently authenticated hash, then run
   it as the ordinary station user with the independently authenticated trust
   values:

   ```sh
   printf '%s  %s\n' AUTHENTICATED_VERIFIER_SHA256 \
     /var/lib/vellum-release-stage/X.Y.Z/vellum-linux-verify-x64 \
     | sha256sum --check --strict -
   /var/lib/vellum-release-stage/X.Y.Z/vellum-linux-verify-x64 \
     --bundle /var/lib/vellum-release-stage/X.Y.Z \
     --keyring /path/to/authenticated/release-keyring.json \
     --trusted-keyring-revision AUTHENTICATED_KEYRING_REVISION \
     --trusted-keyring-sha256 AUTHENTICATED_KEYRING_SHA256 \
     --trusted-key-id AUTHENTICATED_KEY_ID \
     --trusted-key-fingerprint-sha256 AUTHENTICATED_KEY_FINGERPRINT \
     --peer-version X.Y.Z \
     --peer-station-browser-protocol 1 \
     --peer-work-control-protocol vellum-work/v1
   ```

Run the staged verifier as the ordinary station user, never with `sudo`. It
checks the pinned key ID and keyring revision, revocation state, both detached
Ed25519 signatures, manifest expiry, target OS/architecture/libc, download
locator, peer compatibility, `deb` metadata, and every file hash. It also
rejects undeclared files. Continue only after it prints one JSON receipt with
`"ok":true`. Record the receipt's exact `packageBytes` and `packageSha256`,
then recheck both against the root-owned staged package immediately before
package mutation:

```sh
sudo test "$(sudo stat --format=%s -- \
  '/var/lib/vellum-release-stage/X.Y.Z/Vellum Command-X.Y.Z-x64-linux.deb')" \
  -eq VERIFIED_PACKAGE_BYTES
printf '%s  %s\n' VERIFIED_PACKAGE_SHA256 \
  '/var/lib/vellum-release-stage/X.Y.Z/Vellum Command-X.Y.Z-x64-linux.deb' \
  | sudo sha256sum --check --strict -
```

Signature, checksum, target, expiry, downgrade, or protocol failure is a stop
condition. Do not stop a running service, invoke `apt`, or replace a package
while verification is red.

## Preserve station state

Vellum's user-authored documents, settings, work state, and browser profiles
live under `~/.vellum`. Package operations never own that directory. Before an
install, upgrade, rollback, profile operation, or recovery drill, create an
owner-only backup:

```sh
install -d -m 0700 "$HOME/vellum-backups"
tar --acls --xattrs -C "$HOME" -czf \
  "$HOME/vellum-backups/vellum-state-$(date -u +%Y%m%dT%H%M%SZ).tar.gz" \
  .vellum
chmod 0600 "$HOME"/vellum-backups/vellum-state-*.tar.gz
```

The archive can contain control tokens and authenticated browser state. Store
it as a secret, encrypt it before moving it off-host, and never attach it to a
support ticket.

## Fresh install

Run package mutation with administrator authority, but run Vellum itself only
as the intended ordinary station user:

```sh
sudo apt-get install \
  '/var/lib/vellum-release-stage/X.Y.Z/Vellum Command-X.Y.Z-x64-linux.deb'
dpkg-query -W -f='${Package} ${Version} ${Architecture}\n' vellum
aa-status
```

The package installs `/opt/Vellum Command`, the `vellum` work CLI, its desktop
entry, the narrow AppArmor profile, and a systemd user-unit definition. It also
bootstraps the fixed root-owned release installer and the fixed root-owned
unprivileged release bridge. It installs no `sudoers` policy, setuid binary, or
file capability. Every managed attempt requires the administrator to enter a
fresh password into Command Center for that exact host and signed release.
The package does not select a station role, enable the user unit, or enable
lingering.

Open Vellum as the ordinary user. In Command Center, choose the station role
explicitly. For a Remote, configure the exact stable host ID and Command
Center reference through the registered-host configuration surface. Role and
host identity are user decisions; never infer them from the machine or an open
window.

## Remote station and Xvfb

After the Remote role and host ID are configured, enable the packaged user
service as that same station user:

```sh
systemctl --user daemon-reload
systemctl --user enable --now vellum-remote.service
systemctl --user status vellum-remote.service --no-pager
```

The service owns one bounded Xvfb display selected from its package-defined
range, with TCP listening disabled and an owner-only Xauthority file. It then
starts the packaged headless Electron station. A successful `active (running)`
state is process evidence, not the complete product proof; complete the Doctor
checks below.

If the Remote should stop when the user logs out, leave lingering disabled. If
it must come back after reboot without an interactive login, the administrator
may explicitly authorize that behavior:

```sh
sudo loginctl enable-linger STATION_USER
systemctl --user daemon-reload
systemctl --user enable --now vellum-remote.service
```

Record that authorization in the host inventory. To revoke it, first disable
the Vellum user service, then run `sudo loginctl disable-linger STATION_USER`.

## Readiness and Doctor

For a Remote, require all of these observations:

- `systemctl --user is-active vellum-remote.service` prints `active`;
- the service's `MainPID` and cgroup belong to the ordinary station user;
- `/etc/apparmor.d/vellum` is loaded for the exact packaged executable;
- no Vellum TCP or Chrome DevTools listener exists;
- the local work and browser control surfaces are owner-only Unix sockets;
- Vellum Doctor reports the selected role, exact host ID, supervised alignment,
  current canvas-pull evidence, work readiness, native terminal readiness, and
  browser product-path readiness.

Use the in-app Doctor surface. The `vellum doctor` CLI is also valid when
launched from an attached Vellum agent or Herdr process, because process-bind
identity is part of the proof:

```sh
vellum doctor
systemctl --user show vellum-remote.service \
  --property=ActiveState,SubState,MainPID,Result,NRestarts
ss -lntp
```

An old deployment receipt, stale socket inode, or reachable SSH endpoint is
not readiness. A red or unknown Doctor component remains a failed release
gate.

## Managed deployment from Command Center

Linux deployment has two explicit phases:

1. An administrator performs the fresh signed-package install above. This
   bootstraps the package-owned privileged installer; Command Center never
   uploads or substitutes a privileged executable.
2. Subsequent install/update attempts originate in Command Center through
   **Settings → Hosts → Deploy Remote**.

Before phase 2, install the complete promoted release bundle—not only its
`deb`—at this fixed owner-controlled location on Command Center:

```text
~/.vellum/releases/linux-x64-glibc/current
```

`current` must be a real directory owned by the Command Center user and not
writable by group or others. It contains exactly one signed release inventory;
do not merge two versions, use a symlink, or put a private signing key there.
The production application supplies the trusted keyring and pins. The mutable
bundle cannot supply its own trust.

In Settings, add the SSH host, choose its capabilities, run **Configure as
Remote**, then run **Deploy Remote**. Command Center first admits the complete
release and shows the exact host, version, manifest SHA-256, package SHA-256,
and inventory SHA-256 in an administrator-authorization dialog. Verify those
facts, enter the Remote station user's administrator password, and authorize
only that attempt. The password is held transiently in memory, is not written
to the canvas, settings, logs, bundle, or Remote stage, and is destroyed after
the one attempt. Vellum does not retry it or cache sudo authority.

A Linux attempt:

- verifies the complete signed bundle locally before transfer;
- admits only Ubuntu 24.04, x86-64, and the fixed package/helper boundary;
- refuses to cut over while live Vellum terminal work is present;
- stages the exact admitted inventory through
  `/usr/libexec/vellum-release-bridge`, then sends only the password line after
  the bridge binds the staged target, candidate, and both provider/bridge
  nonces;
- accepts privileged work only after the fixed
  `/usr/libexec/vellum-release-installer` proves the sudo-derived user, group,
  host, machine, boot, and a fresh helper challenge over that same finite SSH
  child;
- sends `PREPARE` only after that root proof, and sends `COMMIT` only after the
  root helper returns the exact candidate, maintenance cut, rollback fence,
  and pre-mutation receipt;
- re-verifies from root-protected descriptors, caches the rollback artifact,
  journals every package/activation phase, and serializes package mutation;
- reaps the fixed sudo child, removes the exact descriptor-held staging
  directory, and emits a fully bound `STAGE_CLEARED` receipt only after that
  directory inode is proven unlinked;
- reports ready only after the exact installed generation passes station
  readiness; and
- restores the prior cached package, service state, and lingering state when a
  post-mutation check fails.

The first managed attempt after a manual package bootstrap adopts the exact
same signed installed release into the protected rollback cache before a later
upgrade is permitted. A different-version upgrade never proceeds without that
baseline.

Persistent `NOPASSWD` grants are not part of the product contract. Do not add a
Vellum sudoers rule, run the helper directly, pipe a password through a shell,
or pre-authorize package-manager commands. Vellum never retries an
administrator credential or a failed transaction automatically.

A wrong password is reported as `auth-required`, and a pre-`COMMIT` installer
refusal as `not-started`, only when the bridge exits successfully after
returning the exact bound `STAGE_CLEARED` receipt. A disconnect, partial stage,
malformed or mismatched receipt, changed digest or target, missing cleanup
proof, or nonzero bridge exit is conservatively `indeterminate`, even if it
happens before `COMMIT`. Any unexplained outcome after `COMMIT` is likewise
indeterminate until the root journal and release fence are reconciled by the
bounded repair path.

Deployment failures expose one bounded recovery action in Settings:

| recovery | operator action |
|---|---|
| bootstrap Linux release installer | install the current signed package with the fresh-install procedure, then retry |
| active Vellum terminals | close the counted sessions, confirm their work is preserved, then retry |
| restore live-work observation | restore the product observation path through this runbook or support; do not bypass the route cut |
| provision station browser trust | provision trust from Command Center, then retry |
| retry Linux release install | let the current serialized attempt finish, then retry |
| repair Linux release transaction | stop and preserve the root journal/cache; use the bounded recovery procedure or support |

Never turn a recovery action into an ad hoc `sudo dpkg`, helper replacement,
cache deletion, journal deletion, or service-state guess. If Settings reports
an indeterminate transaction, preserve the host and evidence until repair is
explicitly authorized.

## Logs and bounded diagnostics

The headless unit deliberately does not stream application output into the
system journal. Use systemd metadata for lifecycle diagnosis and Vellum Doctor
for product diagnosis:

```sh
systemctl --user status vellum-remote.service --no-pager
journalctl --user-unit vellum-remote.service --since today --no-pager
systemctl --user show vellum-remote.service \
  --property=ExecMainCode,ExecMainStatus,Result,NRestarts
```

Before sharing diagnostics, remove user names, host addresses, canvas content,
tokens, browser data, private keys, and local paths. A support bundle must
contain receipts and bounded status, never `~/.vellum` itself.

## Upgrade

1. Keep the current signed bundle and state backup until the new version has
   passed its burn-in period.
2. For a managed Remote, promote the new complete bundle into Command Center's
   fixed `current` directory, run **Deploy Remote**, and repeat the readiness
   and Doctor checks. This is the normal upgrade path.
3. For a manual recovery upgrade, repeat the protected staging procedure above
   into a fresh version directory, then verify the new bundle before stopping
   anything. Add the installed version:

   ```sh
    /var/lib/vellum-release-stage/X.Y.Z/vellum-linux-verify-x64 \
      --bundle /var/lib/vellum-release-stage/X.Y.Z \
      --keyring /path/to/authenticated/release-keyring.json \
      --trusted-keyring-revision AUTHENTICATED_KEYRING_REVISION \
      --trusted-keyring-sha256 AUTHENTICATED_KEYRING_SHA256 \
      --trusted-key-id AUTHENTICATED_KEY_ID \
      --trusted-key-fingerprint-sha256 AUTHENTICATED_KEY_FINGERPRINT \
      --peer-version X.Y.Z \
     --peer-station-browser-protocol 1 \
     --peer-work-control-protocol vellum-work/v1 \
     --installed-version CURRENT_VERSION
   ```

4. After a green receipt, repeat the staged `packageBytes` and `packageSha256`
   checks shown above. Only then stop the Vellum user service, install the exact
   admitted root-owned `deb`, reload the unit, and start it:

   ```sh
   systemctl --user stop vellum-remote.service
   sudo apt-get install \
     '/var/lib/vellum-release-stage/X.Y.Z/Vellum Command-X.Y.Z-x64-linux.deb'
   systemctl --user daemon-reload
   systemctl --user start vellum-remote.service
   ```

5. Repeat every readiness and Doctor check. Do not discard the prior signed
   bundle or backup yet.

## Rollback

Rollback is a release operation, not a package-manager shortcut. The older
bundle must still have valid metadata signed by a non-revoked key, and its
manifest must explicitly permit rollback down to that version.
Repeat the protected staging procedure into a fresh root-owned rollback
directory. After the green rollback receipt, repeat the staged package size
and SHA-256 checks immediately before `apt-get`.

```sh
/var/lib/vellum-release-stage/ROLLBACK_VERSION/vellum-linux-verify-x64 \
  --bundle /var/lib/vellum-release-stage/ROLLBACK_VERSION \
  --keyring /path/to/authenticated/release-keyring.json \
  --trusted-keyring-revision AUTHENTICATED_KEYRING_REVISION \
  --trusted-keyring-sha256 AUTHENTICATED_KEYRING_SHA256 \
  --trusted-key-id AUTHENTICATED_KEY_ID \
  --trusted-key-fingerprint-sha256 AUTHENTICATED_KEY_FINGERPRINT \
  --peer-version X.Y.Z \
  --peer-station-browser-protocol 1 \
  --peer-work-control-protocol vellum-work/v1 \
  --installed-version CURRENT_VERSION \
  --allow-explicit-rollback
systemctl --user stop vellum-remote.service
sudo apt-get install --allow-downgrades \
  '/var/lib/vellum-release-stage/ROLLBACK_VERSION/Vellum Command-ROLLBACK_VERSION-x64-linux.deb'
systemctl --user daemon-reload
systemctl --user start vellum-remote.service
```

If signed policy forbids the downgrade, stop and obtain a separately
authorized rollback release. Never modify the manifest, keyring, or package
version locally to force it.

## Browser profile lifecycle

Persistent browser profiles live under Vellum's owner-only profile registry.
Closing or stopping a browser session does not erase its profile. Back up
station state before lifecycle work, then use Vellum's in-app profile wipe
action; it owns the two-phase close/delete/restart recovery contract.

Never remove a profile directory by hand. If a wipe remains pending, keep the
station stopped only as directed by Doctor, preserve the backup and pending
receipt, and use the product recovery action or support escalation.

## Uninstall while preserving data

Disable the user service as the station user, then remove the package:

```sh
systemctl --user disable --now vellum-remote.service
sudo apt-get remove vellum
```

The package removes only package-owned files and registrations. It preserves
`~/.vellum` and the backup directory. Verify that preservation before removing
the backup. If lingering was authorized solely for Vellum, an administrator
may revoke it after confirming the user has no other lingering services.

## Disaster recovery

1. Keep the affected host and its state offline. Record the package version,
   signed manifest digest, key ID, Doctor status, and service metadata.
2. Provision a fresh supported Ubuntu 24.04 x86-64 host.
3. Verify and install the same signed release using this runbook.
4. With the Vellum user service stopped, restore the encrypted backup into the
   same ordinary user's home. Preserve ownership, ACLs, and xattrs.
5. Start Vellum, run Doctor, and reconnect the Remote from Command Center.
6. If the restored state is rejected, stop and retain both the backup and the
   rejected copy for diagnosis. Do not turn data deletion into a recovery
   step.

Canvases remain Command Center-authored. A recovered Remote may pull current
canvases, but an agent does not repair or rewrite `.canvas` files.

## Prohibited recovery shortcuts

Vellum does not support disabling Chromium's sandbox, disabling AppArmor,
changing the host's global user-namespace policy, running the application as
root, exposing control over TCP, forwarding raw control sockets, or routinely
erasing `~/.vellum`. Any procedure that asks for one of those shortcuts is
outside the Linux v1 support contract.
