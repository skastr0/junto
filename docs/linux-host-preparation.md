# Linux host preparation

**Status:** normative Linux Station Beta host-boundary contract; the rootless
candidate is in progress and no Linux release is qualified or published

**Audience:** operators, release engineers, support, and qualification
reviewers

Vellum's Linux Station lane is an ordinary-user install and update path. A
supported host does not need a custom image and Vellum does not become a host
administrator. Vellum may inspect the host read-only, explain a missing
capability, and verify the result after the operator changes the host.

The first qualified userland Linux Station ships with the explicit maturity
label **Beta**. Beta admission requires the core userland path to be fully
tested. Optional capabilities may degrade independently; security-sensitive
features remain fail-closed.

The canonical contract is:

- one signed, versioned Vellum payload is installed and activated entirely
  inside the Station user's account;
- first install and later update use the same userland transaction and state
  preflight;
- Vellum never invokes `sudo`, accepts an administrator password, writes
  privilege input, installs a persistent privilege grant, or mutates the
  system package manager;
- host-administrator work is optional, explicit, minimal, and performed
  outside Vellum;
- a missing optional host capability degrades only the affected Vellum
  capability when that is safe;
- a missing security prerequisite fails the affected security boundary
  closed;
- a future Vellum-hosted machine follows the same contract; it merely arrives
  with the optional host preparation already completed.

Current `.deb`, `/opt/Vellum Command`, privileged release-installer,
release-bridge, root journal, and in-app administrator-credential paths are
migration residue. They are not a supported fallback and cannot qualify a Linux
release.

## What does Vellum inspect?

Host preflight and Doctor are read-only. They may observe:

- operating system, distribution, release, architecture, and libc;
- the Station user's identity, home ownership, writable user directories,
  available disk space, and ability to execute from the intended userland
  install location;
- the user service manager and whether the Vellum user service can run for the
  current login;
- whether lingering is enabled, without changing it;
- AppArmor presence, enablement, parser/profile state, and the effective
  process label when evaluating a future browser sidecar;
- the kernel and distribution facts that determine unprivileged user-namespace
  availability for that future sidecar;
- runtime shared libraries and fixed external programs required by a specific
  signed Vellum release;
- terminal, SSH, owner-local socket, and optional future browser-sidecar
  readiness, including display facts when relevant;
- the installed Vellum version, signed payload identity, state-preflight
  result, and Station protocol compatibility.

Preflight must not probe by changing global policy, installing a package,
loading a security profile, enabling lingering, opening a port, or starting a
privileged helper. A check that cannot be made read-only is an operator action,
not preflight.

## How are host findings reported?

Each finding applies to one named capability. One host can therefore be ready
for Station work while browser automation or reboot persistence remains
unavailable.

| Status | Meaning | Product behavior |
|---|---|---|
| `available` | The observed host facts satisfy this capability. | The capability may run, subject to normal Vellum intent and authorization. |
| `degraded` | The capability is optional and unavailable without weakening a security boundary. | Vellum disables or omits only that capability and reports the limit. |
| `requires-admin` | A bounded external administrator action could make the capability available. | Vellum shows the action and consequence but does not execute it or collect its credentials. |
| `unavailable` | A required runtime, security, or integrity gate is unsatisfied. | The affected capability does not start and no insecure fallback is attempted. |
| `unsupported` | The host is outside the qualified release envelope. | Install, update, or the affected capability is refused without mutation. |
| `unknown` | The fact could not be observed reliably. | Vellum does not infer success; the affected gate remains unavailable or blocked according to its safety requirement. |

The overall host summary is derived from the capability findings:

- **ready** — every capability requested for this Station is `available`;
- **ready with limits** — core Station operation is available and at least one
  optional capability is `degraded` or `requires-admin`;
- **not ready** — a required install, update, state, or security gate is
  `unavailable`, `unsupported`, or safety-critical `unknown`, or a core
  capability is `requires-admin`.

The summary never erases the individual findings.

## Troubleshooting flow (required)

Use this order whenever host preflight reports a blocked capability:

1. run host preflight and capture the per-capability status set;
2. open Doctor immediately and map the blocked capability to a documented
   remediation
   action;
3. execute only externally reviewed host actions outside Vellum;
4. rerun preflight, then Doctor, and only proceed if the finding changed as
   expected;
5. if it is still blocked, keep the station in `not ready` and stop.

Do not use SSH success, package-manager exit code, stale receipts, or image
labels as readiness proof. Readiness is per-capability evidence from the
updated preflight + Doctor state.

## What must remediation guidance contain?

Every `requires-admin` finding must name:

1. the observed host fact;
2. the affected Vellum capability;
3. why the action is optional or required for that capability;
4. the smallest exact administrator action for the detected distribution and
   signed release;
5. the files, packages, services, or policy that action changes;
6. whether logout, login, reboot, or service restart is needed;
7. how to verify the result without relying on the action's exit code alone;
8. how to remove or revoke the change;
9. what remains unavailable if the operator declines;
10. the release version or documentation revision that owns the instruction.

Vellum may render a copyable command only when the signed release documentation
defines that exact action. It must not synthesize package names, broaden a
command after failure, open a terminal with the command preauthorized, or
interpret shell exit zero as product readiness.

Support uses the same contract. If no reviewed action exists for the observed
host fact, the status remains `unknown`, `unavailable`, or `unsupported`; support
does not invent an administrative workaround.

## Which host actions are separate?

### Remote display driver: Xvfb, xauth, and mcookie

The core Linux Remote is a packaged Node process. It does not import Electron
or Chromium and does not require `DISPLAY`, Wayland, `Xvfb`, `xauth`, or
`mcookie`. Missing display tooling cannot make core Remote readiness
`requires-admin` or `unavailable`.

Browser automation is intentionally unavailable on Linux Remote for the first
Beta. It is an optional capability and is not part of core health. Current
Doctor may observe display tooling so the operator can understand the host,
but that finding applies only to a future browser sidecar and cannot override
a ready core Node Remote.

Do not install `Xvfb`, `xauth`, or `mcookie` to make the current core Remote
work. If a later release introduces a browser sidecar, that release must
declare and qualify its exact display contract separately. Vellum still must
not install host packages, invoke the package manager, or request
administrator input.

### AppArmor and unprivileged user namespaces

AppArmor and secret-storage preparation are not core Remote prerequisites.
They apply only to a future browser sidecar. If that optional capability is
introduced, Chromium-dependent surfaces require a real sandbox path and
AppArmor profile preparation and user-namespace availability remain separate
host facts:

- when the qualified path uses an AppArmor profile, an administrator may
  install or load only the exact release-reviewed profile outside Vellum;
- when the qualified path uses the distribution's unprivileged user-namespace
  behavior, Vellum verifies that behavior as the Station user;
- a present but broken security path is not silently reclassified as another
  path;
- Vellum never disables AppArmor, changes a host-wide user-namespace sysctl,
  installs a setuid sandbox, or adds `--no-sandbox`.

For the first Beta, Linux Remote browser automation remains `unavailable`
regardless of these host facts. If a future sidecar has no qualified sandbox
or secret-storage path, only that browser capability is `unavailable`; the
core Node Remote continues.

### User lingering

Lingering is optional. It changes whether the user's service manager may
continue without an interactive login; it does not make Vellum more
authorized.

An administrator who wants an unattended Remote to return after reboot may
explicitly run:

```sh
sudo loginctl enable-linger STATION_USER
```

Verify with:

```sh
loginctl show-user STATION_USER --property=Linger
```

To revoke the change, first stop and disable the Vellum user service as the
Station user, confirm no other user service depends on lingering, then run:

```sh
sudo loginctl disable-linger STATION_USER
```

Vellum reports lingering as `available`, `requires-admin`, or
`degraded`; it never enables or disables it.

### Missing operating-system packages

A signed release must declare the exact external runtime packages it needs for
each supported distribution. Missing packages are reported individually as
`requires-admin` when the supported distribution has a reviewed
installation instruction. The operator or host administrator runs the native
package manager outside Vellum.

Vellum does not call `apt`, `apt-get`, `dpkg`, or another system package
manager. It does not request blanket build tools or a convenience package set.
Declining an optional package degrades only its named capability. A missing
library required to execute the signed core payload makes install/update
`not ready` until the host action is completed.

Before removing an administrator-installed package, check whether another
application uses it. After removal, rerun Vellum preflight and Doctor and
expect the corresponding capability to become degraded or blocked.

## How are preparation changes verified and removed?

Administrator command completion is never the final proof. After any host
change:

1. rerun the same read-only preflight;
2. confirm the expected finding changed and unrelated findings did not;
3. start only the affected Vellum capability;
4. run Doctor and capture the observed runtime boundary;
5. record the host action, release, result, and removal instruction in the
   operator's host inventory.

Removal is the inverse administrator action, performed outside Vellum. Vellum
may verify that a profile, package, or lingering setting is gone, but it must
not remove it. Removing optional preparation may intentionally return the host
to **ready with limits**.

## No-go list

The Linux product and its support procedures must not:

- require a custom VM or machine image as the ordinary install prerequisite;
- add Electron, Chromium, `DISPLAY`, Xvfb, xauth, or mcookie as a core Remote
  prerequisite;
- present Linux Remote browser automation as available in the first Beta;
- let display, AppArmor, user-namespace, or secret-storage findings override
  healthy core Node Remote status;
- keep both rootless and privileged product install/update paths;
- run Vellum itself as root;
- invoke `sudo`, `su`, `pkexec`, or a privileged package helper from the app;
- collect, forward, pipe, cache, retry, log, or persist an administrator
  password or privilege input;
- install a `sudoers` rule, setuid helper, file capability, polkit rule,
  privileged daemon, root-owned transaction journal, or ambient package
  mutation bridge for Vellum updates;
- write application releases under `/opt`, `/usr`, `/var/lib`, or another
  system-owned location as part of the canonical lane;
- disable AppArmor, weaken global user-namespace policy, disable Chromium
  sandboxing, or turn a security failure into a warning-only fallback;
- enable lingering or install operating-system packages without a separate,
  explicit host-administrator action;
- treat SSH reachability, package-manager success, a stale receipt, or a
  prepared hosted image as proof that Vellum is ready;
- describe the current privileged `.deb` lane as beta, production, fallback,
  offline, enterprise, or recovery support.

## Reference links

- [Linux operator runbook](linux-operator-runbook.md)
- [Linux production contract](linux-production-contract.md)
- [Linux package qualification](linux-package-qualification.md)

## Related contracts

- [Security doctrine](security-doctrine.md)
- [Linux production contract](linux-production-contract.md)
- [Linux operator runbook](linux-operator-runbook.md)
- [Linux support matrix](linux-v1-support-matrix.md)
- [Linux qualification](linux-package-qualification.md)
