# Linux production contract

**Status:** normative Beta-to-production graduation contract; Linux is not yet
qualified under this contract

**Scope:** Ubuntu 24.04 LTS x86_64 only. ARM64 and other distributions are out
of v1.

Vellum Command Linux production means one signed rootless Station payload, installed
and updated by the Station user, with optional host-administrator preparation
kept outside the product transaction.

Host preparation and remediation are optional, external, and documented.

The canonical userland Linux Station first ships as **Beta**. Its core userland
path must be fully tested before Beta admission. Optional capabilities degrade
independently when safe; security-sensitive features fail closed. Production
requires the same lane plus every graduation gate in this document, never a
second installer.

This contract derives from
[security-doctrine.md](security-doctrine.md),
[linux-host-preparation.md](linux-host-preparation.md),
[state-architecture.md](state-architecture.md), and
[fleet-station-architecture.md](fleet-station-architecture.md).

## Current implementation status

The canonical rootless install/update lane is in progress and is the only
permitted target path. Signed artifact, user-service, displayless Node Remote,
deployment, and removal pieces have landed as candidate implementation, and
active privileged executables/password UI have been removed. The `.deb`/`/opt`
contract and any remaining privileged types, tests, scripts, receipts, or
instructions are migration residue. No current Linux artifact is supported,
qualified, signed for publication, or publishable.

There is no supported privileged fallback. Consolidation is complete only when
the rootless lane owns first install, update, forward repair, and removal and
the privileged product lane is deleted.

## Production scope

One signed Linux release payload supports:

- Linux Command Center with desktop parity;
- Linux Remote running as the packaged Node runtime under the Station user's
  service manager, with no Electron, Chromium, or display-server dependency;
- macOS Command Center to Linux Remote;
- Linux Command Center to Linux Remote;
- first install and later update through the same ordinary-user transaction.

Linux Remote browser automation is unavailable for the first Beta. A future
browser sidecar is optional and cannot become a core Remote health
prerequisite.

Explicit exclusions:

- ARM64 and non-Ubuntu distributions;
- custom images as an ordinary install prerequisite;
- Station-to-Station control;
- multi-tenant or multi-operator RBAC;
- SSH, Tailscale, provider, host-administrator, or harness credentials absorbed
  into Vellum Command;
- app-managed `sudo`, administrator-password, system-package-manager, setuid,
  file-capability, polkit, privileged-daemon, or root-journal paths.

## Rootless release transaction

The canonical transaction runs entirely as the intended Station user:

1. Read-only preflight records the host, runtime dependencies, security
   facilities, user service manager, installed Vellum Command payload, state schema,
   and requested capability status.
2. The exact signed candidate is staged in an owner-only user directory and
   admitted against independently trusted release metadata.
3. The incumbent is quiesced and proved to have released the canonical
   database.
4. Install cutover stages then activates the candidate; schema migration runs on normal app open (no sealed preflight). Historical path opened the
   fixed canonical database read-only only long enough to mint a verified
   retained backup, migrates and decodes a disposable clone, starts no runtime
   plane, and accepts no database redirect.
5. A passing receipt permits one-way activation of the owner-local candidate.
6. The candidate starts through the user service or desktop path and publishes
   current-generation readiness.
7. Failure before activation leaves installed bytes and live state unchanged.
   After schema or candidate-authored durable state advances, repair is
   forward-only with a newer signed release.

Command Center may initiate the same transaction on an enrolled Remote through
the ordinary Station user's OpenSSH route. It transfers only the admitted
payload and fixed userland protocol. Vellum Command never asks SSH, the app, or a helper
to obtain administrator authority.

The release must define its exact owner-local installation layout, activation
record, mutation bounds, and cleanup behavior before qualification. The release
artifact becomes the authoritative implementation reference for those details.

## Host preparation and graceful degradation

Preflight and Doctor are read-only. Their exact status and remediation contract
is [Linux host preparation](linux-host-preparation.md).

User lingering and missing core operating-system packages are separate facts
and separate optional host actions. AppArmor, user namespaces, display
tooling, and secret storage are relevant only to a future browser sidecar.
Vellum Command may show reviewed commands but never executes them or collects their
credentials.

Troubleshooting sequence for host-boundary failures is always:

1. read-only preflight;
2. Doctor verification;
3. external preparation;
4. rerun preflight + Doctor and verify capability convergence.

One missing optional facility degrades only its named capability when safe.
For example, declining lingering limits unattended persistence; it does not
invalidate owner-local Station state. A missing library required by the core
Node payload blocks install/update until the operator prepares the host.

The packaged Node Remote ignores `DISPLAY`, Wayland, and X authority. It starts
without `Xvfb`, `xauth`, or `mcookie`, and Doctor summarizes core readiness
without display, sandbox, or secret-storage findings. Linux Remote browser
automation remains `unavailable` in the first Beta. Any future sidecar must
fail closed on its own Chromium sandbox and secret-storage gates rather than
adding `--no-sandbox` or weakening core health.

## Durable state

Every installation uses `~/.vellum-command/state/vellum-command.db`, mode `0600`, inside an
owner-only state directory. The normal product main process—Electron on
Command Center, packaged Node on Remote—owns the one Effect `StateEngine`
connection. All services share that connection; renderers, CLIs, helpers, and
SSH callers reach main through typed control surfaces.

The same schema boots for Command Center and Remote. Command Center persists
authorial canvas generations, fleet enrollment, and Command Center-homed work.
A Remote persists its configuration, complete active projection, local work,
events, receipts, and cursors. Each mutable work row and event has one
authoritative installation home.

Release blockers include:

- JSON or content-addressed directories used as live product state;
- settings, hosts, status, frame, ACK, pointer, or seal files used for
  coordination;
- install/update scripts copying, replacing, or archiving `vellum-command.db`, its WAL,
  or its shared-memory file;
- more than one normal product process opening the database;
- dual read/write, legacy import, restore, or rollback to a retired store.

Verified `VACUUM INTO` backups remain portability and forensic evidence.
Linux v1 has no operator restore or downgrade path.

## Boot readiness and Doctor

Boot readiness is structural and belongs to one current user-service
generation:

1. the Vellum Command user service is active for its current invocation;
2. the fixed userland launcher is the supervised main process;
3. fresh owner-only work and Station control sockets are listening;
4. the app reports SQLite readiness;
5. one private, invocation-bound runtime receipt proves that exact generation.

The final rootless implementation must bind launcher, updater, and deploy
preflight to one exact receipt contract. A stale file, SSH exit zero, package
manager result, desktop process, or custom-image label is never readiness.

Terminal, projection, persistence, and capability probes are Doctor
observations. Browser, display, sandbox, and secret-storage observations are
optional and cannot block core Node Remote readiness. Linux Remote browser
remains explicitly `unavailable` for the first Beta. Unknown remains unknown.

## Fleet contract

OpenSSH is the authenticated Command Center-to-Remote transport. Command Center
invokes only fixed Vellum Command Station operations and exchanges the five bounded
verbs: `pair`, `configure`, `project`, `report`, and `status`.

No fleet request accepts a remote path, shell body, administrator credential,
or privilege instruction. A Remote never opens a callback route to Command
Center or another Remote. Tailscale may provide reachability; it grants no
Vellum Command authority. Browser and actor control remain host-local.

Installed version skew uses the one Station protocol descriptor. Remote
Stations are unreleased, so current policy remains protocol 1 with `1/1/1`.
No overlap means `update required`; it does not authorize a privileged fallback
or partial down-conversion.

## Production exit gates

Linux Station Beta is eligible to graduate to production only when one exact
signed payload and source
revision prove:

- first install, same-version adoption, update, interrupted update, and
  forward repair through the ordinary-user lane;
- no Vellum Command process invokes or retains host-administrator authority;
- a stock supported Ubuntu host can reach a truthful preflight result without
  a custom image;
- the packaged Node Remote starts with `DISPLAY` unset and no `Xvfb`, `xauth`,
  `mcookie`, Electron, Chromium, renderer, or browser-composition dependency;
- Doctor keeps core Remote readiness independent from browser, display,
  sandbox, and secret-storage findings, while the first-Beta browser
  capability remains `unavailable`;
- every optional host action is separate, minimal, documented, verifiable, and
  removable;
- declined optional actions produce capability-specific limits, while every
  security gate fails closed;
- the same payload runs as desktop Command Center and unattended Remote;
- fresh install creates only the canonical SQLite state architecture;
- pair/configure/project/report/status pass over the fixed Station route;
- interruption, retry, Remote restart, and Command Center-offline work
  converge through the single-home protocol;
- no retired state, privileged `.deb` installer, release bridge, root journal,
  administrator-credential flow, or alternate Linux product lane exists in
  source or the signed artifact;
- UI, preflight, Doctor, support guidance, and qualification receipts report
  host limits and implementation maturity truthfully.

CI construction and single-installation smoke are necessary evidence, not
production proof. A real two-installation qualification receipt must bind the
exact source revision and signed rootless payload. Until the canonical lane is
implemented and that receipt exists, Linux remains unqualified.
