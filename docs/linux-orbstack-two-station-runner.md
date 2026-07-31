# OrbStack Linux Station Beta two-station qualification

**Status:** runner migration required; current privileged `.deb` run cannot
qualify Linux

OrbStack may host disposable Ubuntu 24.04 x86-64 machines for
two-installation evidence. It is a test-lab convenience, not a product
prerequisite and not a substitute for stock-host qualification.

The qualifying product is explicitly **Beta**. The runner must exercise the
fully tested core userland path, independent optional-capability degradation,
and fail-closed security-sensitive features.

The current runner assumes a prepared golden VM, installs a `.deb`, and uses
passwordless `sudo` for managed deployment. Those assumptions belong to the
retired privileged lane. A current run may retain bounded Station, Work, PTY,
and Chromium observations, but it must not write a passing Linux release
receipt.

## Canonical runner contract

The replacement runner:

- creates two disposable stock Ubuntu 24.04 x86-64 installations;
- observes distribution and architecture from each guest rather than trusting
  image names;
- invokes the signed payload's read-only host preflight as the intended
  ordinary users;
- proves the Remote is `requires-admin` or `unavailable` without `Xvfb`,
  `xauth`, and `mcookie`, then prepares those core prerequisites externally;
- records optional host preparation as a separate external lab action;
- installs and updates Vellum through the exact rootless product transaction;
- drives only fixed packaged Station and qualification operations;
- never opens SQLite, reproduces Station verbs, accepts an arbitrary guest
  command, or transports an administrator password;
- records bounded observations and performs explicit identity-bound cleanup.

A pre-prepared lab image may be used for speed only in an additional run. It
cannot replace the required stock-host path, and its preparation inventory must
match the same actions a normal operator could review and remove.

## Required preparation evidence

For each guest, retain:

- opaque VM identity and observed platform facts;
- pre-action host-preflight findings;
- each optional lab administrator action, why it was taken, and what it
  changed;
- post-action read-only verification;
- the consequence of declining that action in a separate negative run;
- removal/revocation verification where applicable.

AppArmor/user namespaces, user lingering, and missing OS packages remain
separate actions. The runner must not globally weaken AppArmor or
user-namespace policy, add a sandbox-disabling switch, or hide preparation
inside the golden image.

## Rootless product flow

The future fixed runner exercises:

```text
verify exact signed rootless payload
preflight stock Command Center user
preflight stock Remote user
install Command Center as its ordinary user
install Remote as its ordinary user
configure Command Center
enroll ordinary-user SSH route
status → pair → configure
project → report → status
prepare one claimed cross-home task
stop Command Center
progress already-claimed and Remote-home work
restart Command Center
reconcile projection, dispositions, and cursors
restart Remote
update Remote through the same rootless transaction
observe runtime and security state
```

Exact CLI commands must not be documented until the rootless product surface
exists and has been proved. The current `.deb` runner commands are migration
tools, not operator instructions.

## Runtime observation

Observation on both installations must prove:

- exact signed payload and activation identity;
- host-provided `Xvfb`, `xauth`, and `mcookie` plus the supervised display
  witness; no display-less Remote path;
- ordinary-user ownership of release, service, and runtime material;
- role-correct Station readiness;
- canonical SQLite readiness;
- Chromium sandbox, `NoNewPrivs`, seccomp, and the qualified
  AppArmor/user-namespace path;
- native PTY behavior;
- owner-only control material;
- zero Vellum TCP/debug listeners;
- per-capability Doctor status consistent with host-preflight facts;
- no privileged product process, helper, bridge, journal, password path, or
  system-owned active release.

The evidence directory contains bounded, redacted observations. A passing
receipt is emitted only after every rootless, host-preparation, Station, Work,
runtime, and security phase passes and binds the exact source revision and
payload SHA-256. Partial runs write no receipt.

## Failure semantics

Failures preserve both guests and their exact identities for inspection.
Evidence must not be edited to make a retry pass.

The runner reports:

- missing optional capability as the exact degraded or
  `requires-admin` finding;
- missing security prerequisite as a blocked affected capability;
- unsupported host facts as refusal without mutation;
- any attempt to invoke the privileged `.deb` lane as
  `noncanonical-installer`;
- a custom-image-only success as insufficient qualification.

## Guarded cleanup

Cleanup is explicit and bound to the recorded run and opaque guest identities.
It refuses broad targets and the source image, preserves frozen passing
evidence, and deletes only the exact disposable guests authorized by the
operator.

Optional host preparation is removed by the lab administrator before a guest
is reused outside the run. See
[verification and removal](linux-host-preparation.md#how-are-preparation-changes-verified-and-removed).
