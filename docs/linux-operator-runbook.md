# Junto Linux operator runbook

**Status:** Ubuntu 24.04 x64 desktop alpha. Fleet Remote is unreleased,
experimental and feature-gated, with separate Beta qualification.

An official desktop alpha uses a signed rootless archive and managed
owner-local installation. A source build can run as an unmanaged desktop;
that does not establish official release or automatic-update eligibility.
This runbook describes the qualified release contract, not evidence that a
particular candidate is already published.

## Before first install

Follow the exact commands in the
[desktop install guide](linux-command-center-alpha.md#install-an-official-desktop-alpha)
and the current [Linux desktop bootstrap guide](linux-desktop-bootstrap.md).
Obtain the archive, signed descriptor and source index through the official
download page. Authenticate first install with an independently obtained
bootstrap or a reviewed source checkout before any candidate-archive code runs.
Do not extract the archive or execute its bundled CLI. The bootstrap
`--release ... --archive ... --sources ...` admits the signed inputs with
embedded release trust and installs a fresh managed generation. It refuses
an existing managed launcher and never launches the app or opens its database.

The generation lives at
`~/.local/opt/vellum-command-alpha/<version>-<archiveSHA256>/`.
`~/.local/bin/vellum-command-desktop` launches the selected immutable
generation, with an ordinary-user desktop entry. Close any existing loose
extracted app before launching the managed installation.

Run everything as the intended ordinary user. Missing host libraries or a
blocked Chromium sandbox require separately reviewed host preparation. The
app never invokes a package manager, loads AppArmor policy, enables lingering,
collects administrator credentials or retries through a privileged fallback.
See the [desktop sandbox guide](linux-command-center-alpha.md#boundary).

## Automatic desktop updates

Managed official installations automatically check and download the signed
alpha feed at `/linux/x64/alpha.json`. The descriptor binds its archive and
corresponding-source index. Signature, authorized signing time, current key
trust/revocation, target, version, ownership and digest checks must pass before
a candidate can be staged. Desktop descriptors do not expire. A stale feed
can withhold newer versions; it cannot substitute bytes or roll the installed
version back, and managed updates require a strictly newer version.

A downloaded candidate is not yet active. Choose **Restart** in the app:

1. the existing app flushes pending product work and shuts down its owned
   runtime and database connection;
2. the updater activates only the admitted owner-local generation;
3. the app relaunches that exact executable;
4. schema migration runs during normal app startup through its sole
   `StateEngine` connection.

There is no sealed clone preflight or second database opener in this flow.
Install/update never copies, replaces, archives or redirects the product
database, WAL or shared-memory file. Staging and failed admission leave the
active release and live state intact. Once state advances, repair uses a newer
signed release; there is no downgrade or filesystem rollback.

Unmanaged source builds and loose extracted copies do not update themselves
through the managed release lane. Do not rerun the first-install command to
replace an active installation or switch the launcher to an older generation.
Existing managed installations are not retroactively authenticated by a later
bootstrap release. Installations whose original provenance the operator trusts
continue using the incumbent updater. Uncertain or suspected-compromised
installations need independent incident assessment; comparing current bytes
does not prove that malicious code never ran.

The managed layout keeps the launcher-selected generation and one live staged
candidate. After the newly selected generation starts and reaches readiness,
admitted inactive generations are retired through an owner-local quarantine.
Activation itself still does not retire generations or roll back. Crash-left
`.stage-*` directories with durable installer provenance are collected
independently; unproven leftover directories are reported in Doctor and are
not deleted automatically. Staging refuses when free space is below the next
expansion plus a 1 GiB reserve. There is no operator cleanup path or
filesystem rollback. State repair remains forward-only.

## State custody

The sole product database is
`~/.junto/state/junto.db`, owned by the normal app runtime.
Renderers, CLIs, installers, updaters and SSH callers do not open it directly.

Settings → Advanced can list verified retained backups and export one to an
explicit new destination. Backups are portability/forensic evidence; there is
no restore, import, database replacement or downgrade surface. Do not erase
`~/.junto` to make an install, update or Doctor check pass.

## Troubleshooting

Use the in-app Doctor surface and preserve its exact findings. A failed
signature, unsupported target, ownership check or unknown security fact is a
stop condition. A missing optional capability can degrade independently when
safe; it does not justify bypassing a security check.

For a host-preparation issue:

1. capture the read-only preflight/Doctor finding;
2. review the matching desktop or
   [host-preparation](linux-host-preparation.md) instruction;
3. have the host administrator perform only the optional external action they
   choose;
4. rerun the relevant observation and continue only when its result is proven.

Do not treat SSH reachability, stale readiness files, package-manager output
or a custom image label as evidence of runtime health. Never add
`--no-sandbox`, disable AppArmor, weaken global user namespaces, run the app as
root or install a setuid helper to keep a test green.

Report bounded facts: app version, release/descriptor identity, target,
redacted Doctor findings and the failed stage. Remove usernames, host
addresses, private paths, canvas contents and tokens. Never attach the live
database, whole app home, browser profiles, SSH keys, signing keys or host-wide
diagnostic dumps.

## Removal and repair

Quit Junto normally before removing an installation. Removal may
retire only the selected owner-local application generations, launcher and
desktop entry; it must preserve product state and profiles. This release guide
does not provide a broad recursive-delete or data-reset command.

External host preparation is removed separately by the administrator who owns
it, using the exact reviewed instructions. If an intact database is rejected,
retain the error and repair forward with a newer signed release that supports
its schema. Do not reconstruct, replace or delete state files.

## Separate Fleet Remote contract

Desktop alpha does not enable or qualify Fleet Remote. When that gated surface
is qualified, the operator explicitly selects the role; role is never inferred
from hardware, a window or a service. Remote runs the packaged Node runtime
under the Station user's service manager, with no Electron, Chromium, display
server, Xvfb, xauth or mcookie prerequisite. Browser automation remains
unavailable in the first Remote Beta.

Remote install/update must retain the same ordinary-user authority and
single-store rules. Its user-service lifecycle, boot readiness, fixed OpenSSH
Station operations and two-installation Work convergence require their own
[qualification](linux-package-qualification.md). Desktop launch and update
receipts do not substitute for those proofs.

Optional lingering controls only the user manager's login lifetime. Core Node
health is independent of a future browser sidecar's display, sandbox and
secret-storage requirements. No Remote request can grant administrator
authority, supply a shell body or forward arbitrary control sockets.

See the [support matrix](linux-v1-support-matrix.md) and
[production contract](linux-production-contract.md) for the full boundary.
