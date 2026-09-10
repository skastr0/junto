# OrbStack experimental Linux Station two-station qualification

**Status:** experimental Fleet/Remote lab runner; stock-host qualification
remains required before a release receipt can pass.

OrbStack may host disposable Ubuntu 24.04 x86-64 machines for
two-installation evidence. It is a test-lab convenience, not a product
prerequisite and not a substitute for stock-host qualification.

This runner covers experimental Fleet/Remote, not Linux desktop alpha
qualification. Fleet and Remote remain behind their existing feature flags.
The runner must exercise the fully tested core userland path,
independent optional-capability degradation,
and fail-closed security-sensitive features.

The current runner clones a prepared golden VM and installs a signed rootless
userland archive. It starts Command Center through its normal desktop and
checks Station and Fleet readiness without commercial activation. It may reuse
an explicitly identified, stopped Command Center installation for repeat runs.
A golden-image run may retain bounded Station, Work, PTY, and Chromium
observations, but it must not write a passing Linux release receipt.

## Canonical runner contract

The complete qualification contract requires that the runner:

- creates two disposable stock Ubuntu 24.04 x86-64 installations
  (`orbctl create -a amd64 ubuntu:24.04` when not cloning a pinned golden;
  never repair a failed guest into a stand-in stock host);
- observes distribution and architecture from each guest rather than trusting
  image names;
- invokes the signed payload's read-only host preflight as the intended
  ordinary users;
- starts Remote only through the generation-pinned product unit
  `vellum-command-remote.service` → `~/.vellum-command/runtime/releases/<ver>-<sha>/resources/bin/vellum-command-remote`
  (no Electron, Chromium, renderer, CDP, Xvfb, or display env on Remote);
- proves the packaged Node Remote starts without `DISPLAY`, `Xvfb`, `xauth`,
  or `mcookie`, while browser automation remains `unavailable` independently
  from core health;
- records optional host preparation as a separate external lab action;
- installs and updates Vellum Command through the exact rootless product transaction;
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

User lingering and missing core OS packages remain separate actions. Display,
AppArmor/user-namespace, and secret-storage findings apply only to a future
browser sidecar. The runner must not globally weaken AppArmor or
user-namespace policy, add a sandbox-disabling switch, or hide preparation
inside the golden image.

## Rootless product flow

The fixed product flow exercises:

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

The runner is lab tooling, not an operator installation guide. A successful
golden-image run does not establish the required stock-host proof.

## Runtime observation

Observation on both installations must prove:

- exact signed payload and Station installation identity;
- supervised packaged Node Remote startup with `DISPLAY`, `WAYLAND_DISPLAY`,
  and `XAUTHORITY` absent and no Xvfb, xauth, or mcookie dependency;
- no Electron, Chromium, renderer, or browser-composition dependency in the
  Remote closure;
- ordinary-user ownership of release, service, and runtime material;
- role-correct Station readiness;
- canonical SQLite readiness;
- Linux Remote browser automation reported `unavailable` for the experimental build
  without affecting core health;
- native PTY behavior;
- owner-only control material;
- zero Vellum Command TCP/debug listeners;
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
