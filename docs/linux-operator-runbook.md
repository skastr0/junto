# Vellum Command Linux operator runbook

**Status:** target Linux Station Beta operator contract; implementation and
qualification are in progress, with no supported Linux install/update release
today

This runbook defines the operator flow the canonical Linux release must make
real. It does not claim the current repository's privileged `.deb` path is
supported.

Vellum Command's Linux Station install and update lane runs entirely as the intended
ordinary user. Vellum Command performs read-only host preflight, installs one exact
signed payload in owner-local storage, runs sealed state preflight, and
activates the candidate. Any host-administrator preparation is a separate
operator decision performed outside Vellum Command.

The canonical userland Linux Station is labeled **Beta**. The Beta release
must fully test this core userland path. Doctor may report independent limits
for optional capabilities, while security-sensitive features fail closed.

The `.deb` and `/opt/Vellum Command` artifact contract, plus any remaining
privileged release-installer/bridge/journal/administrator-credential types,
tests, scripts, or instructions, are noncanonical migration residue. The
active privileged executables and password UI have been removed, but the
migration is not qualified complete. Do not revive that lane as manual,
offline, fallback, beta, or recovery support.

## Support envelope

The target v1 envelope is Ubuntu 24.04 LTS on x86-64 with glibc 2.39 or newer.
Linux arm64, musl/Alpine, AppImage, RPM, Snap, Flatpak, and container-only
hosts are not qualified.

Read:

- [Linux support matrix](linux-v1-support-matrix.md) for current maturity;
- [Linux host preparation](linux-host-preparation.md) for status,
  remediation, verification, and removal;
- [Linux production contract](linux-production-contract.md) for release
  invariants;
- [Linux qualification](linux-package-qualification.md) for required proof.

No custom image is required by the product contract. A hosted Vellum Command machine
may arrive with optional preparation complete, but it uses the same payload,
preflight, state, user service, and update transaction as any supported host.

## Before install or update

The final release must provide one exact, copyable entry point for these steps:

1. Obtain the signed release bundle from the locator announced by the human
   release authority.
2. Authenticate the release key and verifier through the independent channel
   named by the release policy.
3. Place the bundle in a new owner-only directory. Do not merge releases or
   run any downloaded program before verification.
4. Run the release verifier as the intended Station user.
5. Run read-only host preflight for the capabilities this Station is expected
   to provide.
6. Review every `degraded`, `requires-admin`, `unavailable`, `unsupported`,
   or `unknown` finding.
7. If desired, have the host administrator perform only a reviewed optional
   action outside Vellum Command; then rerun preflight.
8. Continue only when the host is **ready** or **ready with limits** that match
   the intended workload.

Signature, target, ownership, state, or security failure is a stop condition.
Vellum Command does not offer a privileged bypass.

The eventual signed release must supply exact rootless verifier and installer
commands. Those commands run as the Station user and do not collect
administrator credentials. No current command is documented here as
release-supported.

## Capability decisions

Handle host findings independently:

| Finding | Operator decision | Consequence if declined |
|---|---|---|
| Missing `DISPLAY`, `Xvfb`, `xauth`, or `mcookie` | No action is required for the packaged Node Remote. | Core Remote remains available; Linux Remote browser automation remains unavailable for the first Beta. |
| AppArmor, user-namespace, or secret-storage preparation | No action is required for the first-Beta core Remote. Apply only a future browser-sidecar release's exact reviewed instruction. | Core Remote remains available; a future browser capability stays blocked without its qualified security boundary. |
| User lingering | Optionally enable outside Vellum Command when a Remote must return without login. | Remote service follows the normal user-manager login lifetime. |
| Missing optional OS package | Optionally install the exact reviewed package outside Vellum Command. | Only the named capability remains degraded. |
| Missing core runtime library | Prepare the host outside Vellum Command and rerun preflight. | Install/update remains not ready. |
| Unsupported platform or architecture | Use a supported host. | Install/update is refused without mutation. |
| Unknown security fact | Diagnose until it is observed. | The affected security boundary remains blocked. |

Vellum Command must not open a privileged prompt, accept a password, pipe input to a
shell, call the package manager, or remember authorization for the next
attempt.

## State custody boundary

The sole durable store remains `~/.vellum/state/vellum.db`. Install, update,
removal, host preparation, and support do not copy, archive, synchronize, or
replace it, its WAL, or its shared-memory file.

Settings → Advanced lists verified retained backups and can export one to an
explicit new destination. There is no restore, import, replacement, or
downgrade surface. Never restore, downgrade, or replace product state as part
of repair.

## Fresh install and role selection

The canonical first install:

1. admits the exact signed payload;
2. stages it inside an owner-only Station-user directory;
3. proves the canonical database path and current schema facts;
4. activates the candidate through one bounded userland transaction;
5. starts no privileged service and creates no system-owned application state;
6. reports its exact installed version and activation identity.

Open Vellum Command as the same ordinary user and choose Command Center or Remote
explicitly. Role and host identity are operator intent; they are never inferred
from hardware, an open window, or whether the user service exists.

The implementation must publish its exact userland layout, filesystem modes,
activation mechanism, and uninstall command before this section becomes an
actionable runbook.

## Remote station and user service

A Remote uses the Station user's service manager and a release-owned,
owner-local service definition. It must not need a system service or root-owned
launcher.

The core Remote executable is a packaged Node process. It does not load
Electron, Chromium, a renderer, or browser composition, and it does not require
`DISPLAY`, Wayland, X authority, `Xvfb`, `xauth`, or `mcookie`. Do not install a
display stack to make the core Remote start.

Browser automation is intentionally unavailable on Linux Remote for the first
Beta. Doctor reports it separately as an optional capability, so its display,
sandbox, AppArmor, user-namespace, and secret-storage findings do not turn a
ready core Remote into an unhealthy Station.

The release must provide exact ordinary-user commands to:

- install or refresh the user service definition;
- start and enable the Remote;
- show its invocation, main process, and restart status;
- stop and disable it;
- remove only Vellum Command-owned userland release files.

Without lingering, the service follows the user's normal login lifetime. If
the operator wants logout/reboot persistence, follow the separate
[user lingering](linux-host-preparation.md#user-lingering) host action. Vellum Command
does not change lingering itself.

## Readiness and Doctor

Boot readiness and capability health are different.

Boot readiness proves only the current Station generation:

- the owner-local Vellum Command service or desktop process is the intended signed
  release;
- the exact current invocation owns the supervised main process;
- the canonical SQLite connection is ready;
- fresh owner-only work and Station control sockets are listening;
- the exact invocation-bound readiness receipt is present.

Doctor then reports terminal, browser, display, sandbox, secret storage,
projection, simulation, SSH, persistence, and other capability observations.
Browser remains `unavailable` on Linux Remote for the first Beta, while core
readiness is independent from browser-side display and security findings. A
missing optional capability may leave the Station **ready with limits**.
Unknown is never converted to success from a stale receipt or SSH
reachability.

Use the in-app Doctor surface. A future packaged `vellum doctor` command is
valid only through its documented owner-local/process-bound path.

## Troubleshooting flow (required)

When an install, configure, or update step fails:

1. rerun host preflight and capture each capability status;
2. run Doctor and map every `requires-admin`, `unavailable`, or `unknown`
   finding to its remediation entry in
   [linux-host-preparation](linux-host-preparation.md);
3. execute optional host preparation outside Vellum Command as a separate admin/host
   action;
4. rerun preflight and Doctor and verify the exact affected capability status
   changed;
5. only then continue with the original operation.

Do not use success from SSH reachability, package-manager output, stale
receipts, or image metadata as proof of capability repair.

## Configure a Remote

After rootless installation and Remote role selection:

1. enroll the ordinary-user SSH endpoint in Command Center;
2. run read-only host preflight and review capability findings;
3. configure the installation through the fixed Station operations;
4. confirm the observed installation identity, role, host ID, database/work
   readiness, projection, and logical cursors;
5. confirm the intended capability limits in Doctor.

OpenSSH authenticates the host and Station user. It does not grant root and
Vellum Command does not add a second administrator credential.

## Upgrade

First install and update are one lane:

1. admit the new signed payload;
2. rerun read-only host and compatibility preflight;
3. quiesce the incumbent and prove SQLite release;
4. run the exact candidate's sealed state preflight against a disposable
   clone;
5. activate only after the receipt passes;
6. start the new generation and repeat readiness and Doctor checks.

Command Center may initiate this same ordinary-user transaction on an enrolled
Remote. A new version must not fall back to `.deb`, `apt`, `dpkg`, `/opt`, a
release bridge, a root journal, or administrator input.

A failure before activation leaves the incumbent and canonical state
unchanged. After schema or candidate-authored state advances, repair is
forward-only with a newer signed payload. An older binary is never activated
against advanced state.

## Logs and bounded diagnostics

Collect only bounded facts:

- signed release and activation identity;
- preflight and Doctor findings;
- user-service lifecycle metadata;
- Station identity, projection, and logical cursors;
- redacted readiness and update receipts.

Remove user names, host addresses, canvas content, tokens, browser data,
private keys, and unnecessary local paths. Never attach `~/.vellum`, the live
database, browser profiles, SSH keys, administrator input, or host-wide
diagnostic dumps.

Support follows the reviewed finding contract in
[Linux host preparation](linux-host-preparation.md#what-must-remediation-guidance-contain).
It does not improvise privileged commands or revive the retired `.deb` lane.

## Removal

The canonical removal flow must run as the Station user:

1. stop and disable the owner-local Vellum Command user service;
2. remove only the selected Vellum Command userland release and its activation
   metadata;
3. preserve `~/.vellum/state/vellum.db` and browser profiles unless an explicit
   app-owned data-removal workflow separately says otherwise;
4. rerun Doctor or inventory to confirm no Vellum Command process or control socket
   remains.

Optional host preparation is removed separately by the administrator who
owns it. Follow [verification and removal](linux-host-preparation.md#how-are-preparation-changes-verified-and-removed).

## Browser profile lifecycle

Linux Remote browser profiles are not part of the first Beta because browser
automation is unavailable. If a future qualified browser sidecar introduces
profiles, they remain host-local runtime data and never travel on the Station
API. Its release documentation must define the supported profile-wipe action;
do not copy, archive, restore, or remove profile directories by hand.

## Disaster recovery

Linux v1 has no operator state-restore or downgrade surface. Do not copy,
replace, reconstruct, or delete `vellum.db`, its WAL, or its shared-memory file
as install, update, or repair.

If the database remains intact, use a newer signed release that supports its
schema and repair forward through the canonical rootless lane. If the host or
database is lost, provision a supported host, install as a new Station user,
and reconnect a fresh Remote so it receives Command Center's latest complete
projection. Escalate an intact database rejected by current code; do not
invent a filesystem restore.

## Prohibited shortcuts

Do not:

- run Vellum Command as root;
- use the current privileged `.deb` deployment as a supported operation;
- add a `sudoers` rule, setuid helper, file capability, polkit rule,
  privileged daemon, root transaction journal, or package bridge;
- disable AppArmor, weaken global user-namespace policy, add
  `--no-sandbox`, or treat a broken security path as graceful degradation;
- enable lingering or install OS packages from inside Vellum Command;
- expose owner-local control over TCP or forward raw control sockets;
- erase `~/.vellum` to make installation, update, or Doctor pass;
- require a custom image where a stock supported host plus explicit optional
  preparation should work.
