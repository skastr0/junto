# OrbStack Linux two-station qualification

This runner takes one exact Linux package through the product's real
two-installation path on native Ubuntu 24.04 x86-64 OrbStack VMs:

- one licensed, packaged Command Center;
- one pristine Remote installed by Command Center's managed-deploy surface.

It is a thin host driver. It owns exact VM and artifact custody, invokes only
fixed packaged CLI operations, records bounded observations, and performs
explicit cleanup. It does not open SQLite, reproduce Station verbs, expose an
arbitrary guest-command hook, or accept secrets.

## Prerequisites

The host needs OrbStack and one stopped `ubuntu:noble` / `amd64` golden VM.
Pin its opaque ID instead of trusting its mutable name:

```sh
orbctl info vellum-ubuntu-x64-golden --format json
```

The golden must not contain Vellum. The runner rechecks its name, ID, image,
architecture, and stopped state before cloning, then proves the guests are
Ubuntu 24.04 / `x86_64`.

Qualification also needs the exact signed, non-publishable candidate bundle.
The runner cryptographically verifies the bundle before mutating OrbStack and
requires its source revision, version, package filename, byte count, SHA-256,
and Station protocol to agree with the supplied `deb`.

Use a private absolute evidence directory outside the repository:

```sh
export VELLUM_QUAL_EVIDENCE="$PWD/../vellum-qualification/release-015"
```

## First run and license checkpoint

Prepare a fresh Command Center and Remote:

```sh
bun run linux:qualify:orbstack -- prepare \
  --run-id release-015 \
  --evidence-dir "$VELLUM_QUAL_EVIDENCE" \
  --golden-vm vellum-ubuntu-x64-golden \
  --golden-id 01EXACTORBSTACKMACHINEID \
  --kind qualification-candidate \
  --deb "/absolute/path/Vellum Command-0.1.5-x64-linux.deb" \
  --bundle /absolute/path/to/signed-qualification-candidate \
  --source-commit 0123456789abcdef0123456789abcdef01234567
```

`prepare` verifies the candidate and golden, creates exact
`vellum-q-<run-id>-cc` and `vellum-q-<run-id>-remote` clones, proves the Remote
package-clean, installs the package only on Command Center, and opens the
normal packaged renderer with owner-local operator control enabled.

Activate that Command Center in its renderer. Do not pass a license through
arguments, environment variables, files, evidence, or logs. Leave the
renderer running and continue with the same VMs:

```sh
bun run linux:qualify:orbstack -- run \
  --run-id release-015 \
  --evidence-dir "$VELLUM_QUAL_EVIDENCE"
```

If activation is incomplete, `run` fails at its first licensed fleet read and
preserves both machines. Activate and rerun; do not prepare replacements.

## What the managed run proves

The fixed packaged CLI path performs:

```text
vellum station configure-command-center
vellum station status
vellum fleet list
vellum fleet add …
vellum fleet enable-managed-installs
vellum fleet qualify <remote>
vellum fleet test <remote>
vellum fleet sync --id <remote>
vellum fleet status --id <remote>
vellum qualification work prepare --run-id <run> --host-id <remote>
[stop Command Center]
vellum qualification work progress-offline --run-id <run>
[restart Command Center]
vellum qualification work verify --run-id <run> --host-id <remote>
[restart Remote and sync]
[redeploy the same candidate and sync]
```

This proves the Remote was installed through Vellum's managed candidate lane,
the two installations synchronized, real Work survived Command Center
offline, the Remote retained identity across restart, and redeploying the
exact artifact was idempotent. Work qualification is a closed product
operation backed by the normal Work and Station services; the runner never
opens product state directly.

The candidate is seated only at
`~/.vellum/releases/linux-x64-glibc/qualification/current`. It cannot fall
back to the production cache. The runner accepts no administrator password;
the disposable OrbStack lane requires passwordless sudo and records
`authorization-required` as failure.

## Runtime observation and receipt

After `run` succeeds:

```sh
bun run linux:qualify:orbstack -- observe \
  --run-id release-015 \
  --evidence-dir "$VELLUM_QUAL_EVIDENCE"
```

Observation proves on both installations:

- exact `dpkg-query` version and architecture;
- live packaged systemd service and generation;
- role-correct Station readiness through the fixed `vellum-station` protocol;
- Chromium sandbox, `NoNewPrivs`, seccomp, and user-namespace isolation;
- owner-only control material;
- zero Vellum TCP listeners and no debug authority.

The directory contains a bounded, redacted
`station-qualification-observations.jsonl`. A signed-candidate run writes
`station-qualification-receipt.json` only after every required phase and
runtime/security assertion passes. The strict receipt binds the exact source,
signed manifest, package bytes and hash, distinct installation IDs, evidence
hash, and completion time. Partial runs write no receipt.

A `final-release` run is only a post-signing smoke and never creates a second
qualification receipt.

## Reuse the licensed Command Center

License activation belongs to one retained Command Center. Cleanup stops and
preserves it while deleting the disposable Remote. For a later run, pin that
stopped Command Center explicitly and clone only a new Remote:

```sh
bun run linux:qualify:orbstack -- prepare \
  --run-id release-015-final \
  --evidence-dir "$PWD/../vellum-qualification/release-015-final" \
  --golden-vm vellum-ubuntu-x64-golden \
  --golden-id 01EXACTORBSTACKMACHINEID \
  --command-center-vm vellum-q-release-015-cc \
  --command-center-id 01EXACTRETAINEDCOMMANDCENTERID \
  --kind final-release \
  --deb "/absolute/path/Vellum Command-0.1.5-x64-linux.deb" \
  --bundle /absolute/path/to/final-signed-v6 \
  --source-commit 0123456789abcdef0123456789abcdef01234567
```

The retained Command Center must already contain the exact package version.
When the version changes, update that installation through the product update
lane before reuse. The final smoke uses
`vellum fleet deploy <remote> --source cached`.

## Guarded cleanup

Cleanup is never automatic:

```sh
bun run linux:qualify:orbstack -- cleanup \
  --evidence-dir "$VELLUM_QUAL_EVIDENCE" \
  --confirm-run-id release-015
```

Cleanup rereads the evidence and fresh OrbStack records, requires the exact
run confirmation plus matching names and opaque IDs, refuses the golden and
broad targets, stops the licensed Command Center, and deletes only the exact
disposable Remote. Passing candidate evidence is frozen after its receipt is
hashed; cleanup never changes that evidence.

Failures preserve both machines and their exact identities for inspection.
Never edit the evidence to make qualification or cleanup pass.
