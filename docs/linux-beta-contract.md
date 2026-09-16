# Linux beta contract

**Status:** canonical Linux Station Beta contract; no Linux artifact is
currently Beta-qualified

The first Linux beta uses the same rootless/userland installation and update
lane required for production. Beta narrows product capability and evidence
scope; it does not authorize a privileged installer, a custom-image
prerequisite, or a second package path.

The first published maturity label is **Beta**. Admission requires the core
userland path to be fully tested. Optional capabilities may degrade
independently when safe; every security-sensitive feature fails closed.

This contract cannot weaken
[Linux production](linux-production-contract.md),
[Linux host preparation](linux-host-preparation.md), or
[security doctrine](security-doctrine.md).

## Current status

The current `.deb`/`/opt` artifact contract and any remaining privileged
bridge/installer/journal/administrator-credential types, tests, scripts,
receipts, or instructions are migration residue. The rootless payload and
packaged displayless Node Remote have landed as candidate implementation, but
the complete release lane has not passed the required fresh-host,
two-installation, signing, and publication gates. Therefore:

- the current `.deb` is not the Linux beta install path;
- a passing `.deb` build, install, or OrbStack run cannot label a candidate
  beta-ready;
- there is no manual privileged fallback for beta;
- beta qualification can close only after the canonical rootless lane replaces
  every remaining privileged product path and passes the complete gate set.

## Narrow beta surface

| Surface | Beta contract |
|---|---|
| Platform | Ubuntu 24.04 LTS x86_64 |
| Command Center | One Linux desktop installation of the signed userland payload |
| Remote | Packaged Node runtime from the same signed userland payload under the Station user's service manager; no display server, Electron, or Chromium dependency |
| Browser automation | Unavailable on Linux Remote for the first Beta; a future browser sidecar is optional and independent of core health |
| Install/update | One ordinary-user transaction for first install and later update |
| Host preparation | Read-only preflight; optional administrator actions remain outside Junto |
| Connectivity | Operator-enrolled OpenSSH route, Command Center to Remote |
| Durable state | One `~/.vellum-command/state/vellum-command.db` per installation |
| Fleet control | Fixed Station surface; `pair`, `configure`, `project`, `report`, `status` |
| Projection | One complete replace-only Command Center projection |
| Local runtimes | Host-local agents, terminals, watchers, and timers |

Command Center and Remote use the same schema. Role changes row residency and
execution, not storage implementation or installation authority.

## Beta operator sequence

Once the rootless implementation exists, the shortest valid sequence is:

1. Run read-only host preflight as the intended Station user.
2. Review each capability finding and decide whether to perform any optional
   host-administrator action outside Junto.
3. Rerun preflight; accept **ready with limits** only when the missing
   capabilities are optional for the intended workload.
4. Verify and install the exact signed payload as the Station user.
5. Start the desktop Command Center or owner-local Remote user service.
6. Enroll the Remote's ordinary-user SSH endpoint.
7. Configure through `status → pair → configure`.
8. Confirm live identity, state, work-control, simulation, projection, and
   per-capability Doctor status.
9. Exercise update through the same rootless transaction.

These steps describe the beta contract, not a currently available command
surface. Release documentation must replace them with exact, proof-backed
commands before beta qualification.

## Fail-closed boundaries

- Signature, target, ownership, state preflight, or activation ambiguity
  blocks install/update.
- Browser automation is `unavailable` on Linux Remote for the first Beta;
  display, sandbox, and secret-storage findings do not block core Remote
  readiness.
- Declining lingering disables unattended logout/reboot persistence only.
- Missing optional OS packages degrade only their named capabilities.
- A missing core runtime library blocks install/update until the operator
  prepares the host separately.
- Missing `DISPLAY`, `Xvfb`, `xauth`, or `mcookie` does not block the packaged
  Node Remote.
- SSH success alone is neither configuration nor synchronization.
- Unknown or unreachable fleet state remains unknown or stale.

## Disabled and excluded

The beta does not include:

- Command Center transfer;
- Station-to-Station control;
- app-managed administrator passwords or privilege input;
- `sudo`, system package manager, `.deb`, `/opt`, root helper/bridge/journal,
  setuid, file capability, polkit, or privileged daemon product paths;
- custom images as the supported installation route;
- parallel manual/offline and managed install implementations;
- file-store compatibility, direct helper database access, or rollback to a
  retired store.

Air-gapped installation, when later supported, must consume the same signed
userland payload and rootless transaction. It is a transport variation, not a
second installer.

## Beta release gates

Do not label an artifact beta-ready until native Ubuntu evidence proves:

- the complete core userland install, update, state, service, control, and
  Station path is fully tested;
- stock-host read-only preflight and exact per-capability status;
- successful supervised Node Remote startup with `DISPLAY` unset and
  `Xvfb`, `xauth`, and `mcookie` absent;
- Doctor reports core ready independently while Linux Remote browser
  automation remains explicitly `unavailable`;
- rootless fresh install, update, interruption handling, removal, and forward
  repair with no Junto-owned privilege path;
- optional host preparation is separate, explicit, verifiable, and removable;
- declined optional preparation produces the documented graceful degradation;
- desktop Command Center and Remote user service boot the same SQLite schema;
- Station configure/status, projection restart, report retry, and
  Command Center-offline Remote work pass;
- no Electron, Chromium, browser-composition, or renderer dependency enters
  the packaged Remote closure;
- any future browser sidecar remains outside first-Beta admission and must
  qualify its own sandbox and secret-storage boundaries before availability;
- no privileged Linux install/update residue or retired state path remains in
  source or the signed payload;
- the exact source revision and payload digest are bound to the operator
  qualification receipt.

Repository contracts and CI smoke do not prove these gates. Until the rootless
lane and two-installation receipt exist, the candidate is unqualified.
