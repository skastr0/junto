# Linux Station Beta qualification

**Status:** required evidence contract; no current Linux artifact passes it

Linux v1 qualification applies to one exact signed rootless payload, one source
revision, and one two-installation run. It does not qualify a packaging idea,
an unsigned archive, or a privileged `.deb` lane.

The release maturity label is **Beta**. Qualification must fully test the core
userland path. Optional capabilities may degrade independently when the
retained evidence names the limit; security-sensitive features fail closed.

The governing contracts are
[Linux production](linux-production-contract.md),
[Linux host preparation](linux-host-preparation.md), and
[security doctrine](security-doctrine.md).

## Current evidence boundary

The repository's current Linux build and CI surfaces produce and inspect a
`.deb` installed under `/opt`, together with privileged installer/bridge,
root-journal, and administrator-credential deployment code. That is
noncanonical migration residue.

Existing tests and native runs remain evidence for bounded components such as
x86-64 native modules, PTY behavior, Chromium sandbox observation, Station
protocol, SQLite state preflight, interruption semantics, and two-installation
work convergence. They are not proof of the canonical install/update
transaction. No current `.deb`, CI artifact, OrbStack receipt, or manual run
may be promoted as beta or production qualification.

Qualification resumes only against the rootless replacement. The old lane is
deleted, not retained as a fallback matrix.

## What must the release bind?

The passing evidence set binds:

- full source revision;
- signed release manifest and trusted key identity;
- exact rootless payload filename, size, and SHA-256;
- exact userland installer/updater executable identity;
- supported Ubuntu release, architecture, and libc;
- external runtime dependency declaration;
- Station protocol descriptor;
- Command Center and Remote installation identities;
- host-preflight findings and any separately performed host actions;
- activation and state-preflight receipts;
- two-installation Station and Work witnesses;
- human promotion decision.

A passing receipt for one payload does not qualify a rebuild, another host
contract, or the retired `.deb`.

## Stock-host and host-preparation proof

Start from a stock supported Ubuntu 24.04 x86-64 installation. A custom golden
image may accelerate a test lab, but it is not evidence that ordinary host
preparation works.

Before mutation, run the product's read-only preflight and retain every
per-capability finding. Prove:

- supported platform facts are observed rather than inferred from an image
  name;
- a clean Station user can reach a truthful **ready**, **ready with limits**,
  or **not ready** result;
- every `requires-admin` finding names one reviewed, minimal action,
  consequence, verification, and removal path;
- Vellum does not execute that action or collect administrator input;
- rerunning preflight after a host action observes the expected change;
- declining an optional action degrades only its named capability;
- an absent security prerequisite blocks its affected boundary.

Exercise AppArmor/user namespaces, user lingering, and missing OS packages as
separate findings. At least one run must decline each optional action and prove
the documented limit. At least one run must remove previously applied optional
preparation and prove the host returns to the expected limited state.

Separately remove `Xvfb`, `xauth`, and `mcookie` from a disposable Remote host.
Prove preflight/Doctor reports `requires-admin` or `unavailable`, and that the
core Remote does not start. Restore them through the recorded external host
action and prove the supervised Remote path. Electron 43.2 / Chromium 150 has
no qualified secure display-less fallback.

## Rootless install and update proof

Run as the intended ordinary Station user. Prove:

1. exact signed payload admission;
2. owner-only staging and activation entirely outside system-owned
   application locations;
3. fresh install with no `sudo`, `su`, `pkexec`, system package manager,
   administrator prompt, setuid/file-capability/polkit path, privileged daemon,
   release bridge, or root journal;
4. exact installed version and activation identity;
5. same-version idempotence;
6. update through the same transaction;
7. interrupted staging before activation leaves incumbent bytes and canonical
   state unchanged;
8. sealed candidate state preflight against a disposable clone;
9. one-way activation and forward-only repair after schema or
   candidate-authored state advances;
10. downgrade only as a rejection: no older build may activate;
11. removal of only userland release bytes while preserving app-owned state;
12. no second Linux installer or recovery path in source or payload.

Snapshot the Station user's Vellum state before each release operation.
Package activity must not copy, replace, archive, or synthesize
`vellum.db`, its WAL, or its shared-memory file.

No Vellum process may open a privileged prompt or receive an administrator
credential during the run. Checking that no password was persisted is
insufficient; the input path itself must be absent.

Every core userland branch—success, denied input, interruption, retry,
same-version, update, forward-repair admission, and removal—must be covered by
automated tests and a native packaged run. A partial happy-path proof cannot
admit the Beta.

## Runtime and security proof

For desktop Command Center and Remote user-service paths, prove:

- exact current-generation boot readiness;
- supervised `Xvfb` display creation using host-provided `Xvfb`, `xauth`, and
  `mcookie`, with TCP disabled;
- owner-only work and Station controls;
- SQLite database readiness;
- native PTY behavior and capability-owned shutdown;
- no Vellum TCP or Chrome DevTools listener;
- Chromium renderer `NoNewPrivs`, seccomp, and the qualified
  AppArmor/user-namespace path;
- fail-closed refusal of every sandbox-disabling switch;
- capability-specific Doctor status that matches the retained preflight facts;
- only the affected capability degrades when an optional prerequisite is
  absent.

Boot readiness must not absorb terminal, browser, display, persistence, or
other Doctor observations. A user service may be structurally ready while an
optional capability is degraded. A missing security gate blocks the affected
surface, not the whole host by convenience and not a warning-only fallback.

## User-service lifecycle proof

As the Station user, exercise:

- service definition install/refresh;
- start, restart, duplicate start, stop, disable, and removal;
- crash restart and stale runtime artifact handling;
- logout/login without lingering;
- reboot persistence only after a separately recorded administrator action
  enables lingering;
- revocation of lingering followed by the expected login-lifetime behavior;
- no stop or cleanup action signals an unowned process or unlinks an unowned
  socket.

The service, launcher, release bytes, and runtime receipts remain owner-local.
There is no system service or root-owned lifecycle helper.

## Two-installation Station proof

One passed receipt qualifies:

- one exact Linux Remote with a Linux or supported macOS Command Center;
- five-verb `pair`, `configure`, `project`, `report`, and `status` exchange;
- distinct installation identities and the exact protocol 3 bundle;
- complete replace-only projection and restart persistence;
- bidirectional logical cursor convergence;
- interrupted project/report retry;
- one already-claimed Command Center-home task progressing while Command
  Center is offline;
- Remote-home task/request/artifact work while offline;
- rejection of a new disconnected Command Center-home claim;
- no Remote callback or Remote-to-Remote control route;
- Doctor witnesses for both installations;
- synthetic no-overlap producing `update required`.

The receipt remains bounded, redacted operator evidence. It is not
self-proving automation and it may not be synthesized from single-host smoke.

The structured receipt retains the established
`vellum/station-two-installation-qualification/v1` shape:

- each installation records a closed `nativePlatform`;
- Remote is `linux` / `ubuntu` / `24.04` / `x64`;
- Command Center is either the same Linux target or supported
  `darwin` / `macos`;
- `commandCenterOfflineClaimedTask`, `reportResponseRetry`, and
  `syntheticNoOverlap` name their exact witnessed phases;
- bidirectional cursors retain both `eventHome` and `entityHome`;
- `station-qualification-evidence.txt` contains bounded human/operator
  attestation;
- every witness digest resolves to the exact
  `station-qualification-evidence` entry in the signed release manifest.

Only the Remote platform is bound to the exact Linux rootless payload. Both
installations remain bound to the source revision, protocol, identities, and
their evidence. References to a `deb` in the current schema/tooling are
migration fields that must be replaced before Beta qualification.

## Required negative qualification

Fail the candidate when any run finds:

- app-managed administrator input or privilege;
- a system-owned active release path such as `/opt`, `/usr`, or `/var/lib`;
- `.deb`, `apt`, `dpkg`, privileged helper/bridge/journal, or persistent grant
  on the product install/update path;
- a custom-image-only prerequisite;
- a display-less Remote claim or Remote startup without qualified `Xvfb`,
  `xauth`, and `mcookie`;
- an insecure Chromium fallback;
- global AppArmor or user-namespace weakening;
- lingering or OS-package mutation performed by Vellum;
- capability status collapsed into generic healthy/unhealthy;
- SSH exit zero, stale receipt, or image metadata treated as readiness;
- direct helper/database access, file-store compatibility, or a second
  installer;
- support or recovery instructions that revive the privileged lane.

## CI evidence

The future canonical CI lane must build and smoke the exact rootless payload on
native Ubuntu 24.04 x86-64 and upload:

- source/tool inventory;
- payload and verifier hashes;
- dependency/license inventory and SBOM;
- static ownership, mode, ELF, fuse, and protocol audit;
- clean-user rootless install/update/removal receipts;
- preflight status fixtures and negative security results;
- native PTY and Chromium sandbox receipts;
- explicit `unqualified` metadata until operator two-installation evidence and
  human promotion exist.

The current `.github/workflows/linux-release.yml` is a legacy `.deb` evidence
lane. Its output may be used only for bounded component evidence while
migration proceeds. It is not the authoritative Linux release workflow under
this contract and cannot emit a promotable candidate.

## Human Beta release gate

The named release authority may record GO only after:

1. the canonical rootless lane is implemented;
2. the privileged Linux product lane and its documentation are removed;
3. the exact CI payload and source receipts pass;
4. the stock-host, optional-preparation, runtime, lifecycle, and
   two-installation evidence above pass;
5. an independent reviewer confirms the support matrix matches observed
   limits;
6. the signed final bundle re-verifies without changing payload bytes.

Until then, Linux remains unqualified.
