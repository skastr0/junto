# Linux desktop first-install bootstrap

**Status:** this is the independently hosted first-install approval record.
Until a bootstrap tag is published and a fresh-host qualification receipt
exists, do not treat any GitHub Release as an official first-install verifier.

Official Linux desktop first install is authenticated outside the candidate
archive. The website may host the archive, signed `release.json`, and
`sources.json`. It is not the authority for which verifier to run, which
release-trust pins to use, or how to bypass verification.

The packaged application CLI does not install Linux desktop. The incumbent
updater continues to admit signed updates from an already trusted install.

## Current approval

No bootstrap tag is currently approved. Replace these placeholders only from
this document after a qualified publication:

```text
BOOTSTRAP_TAG=REPLACE_WITH_APPROVED_BOOTSTRAP_TAG
BOOTSTRAP_COMMIT=REPLACE_WITH_APPROVED_40_HEX_COMMIT
ALPHA_VERSION=REPLACE_WITH_QUALIFIED_APP_VERSION
```

The bootstrap embeds release-keyring revision 1, key id `vellum-linux-2026a`,
and the public trust pin in `build/linux/release-trust-policy.json`. Changing
those pins requires a newly approved bootstrap, not a website-supplied key.

## Default path

Prerequisites: independently trusted `curl` and GitHub CLI `gh` 2.68.0 or
newer. Do not obtain `gh` from the candidate archive or
https://vellumcommand.com/download.

Download the three payload files into a new private directory. From that
directory:

```sh
(
  set -eu
  umask 077

  BOOTSTRAP_TAG="REPLACE_WITH_APPROVED_BOOTSTRAP_TAG"
  BOOTSTRAP_COMMIT="REPLACE_WITH_APPROVED_40_HEX_COMMIT"
  ALPHA_VERSION="REPLACE_WITH_QUALIFIED_APP_VERSION"

  BOOTSTRAP="vellum-command-desktop-bootstrap-linux-x64"
  BASE="https://github.com/skastr0/vellum-command/releases/download/$BOOTSTRAP_TAG"
  ALPHA_ARCHIVE="vellum-command-runtime-$ALPHA_VERSION-linux-x64.tar.gz"

  gh --version

  curl --fail --location --proto '=https' --proto-redir '=https' \
    --output "$BOOTSTRAP" "$BASE/$BOOTSTRAP"
  curl --fail --location --proto '=https' --proto-redir '=https' \
    --output "$BOOTSTRAP.attestation.jsonl" \
    "$BASE/$BOOTSTRAP.attestation.jsonl"

  gh attestation verify "$BOOTSTRAP" \
    --hostname github.com \
    --bundle "$BOOTSTRAP.attestation.jsonl" \
    --repo skastr0/vellum-command \
    --cert-identity "https://github.com/skastr0/vellum-command/.github/workflows/linux-desktop-bootstrap.yml@refs/tags/$BOOTSTRAP_TAG" \
    --cert-oidc-issuer https://token.actions.githubusercontent.com \
    --source-ref "refs/tags/$BOOTSTRAP_TAG" \
    --source-digest "$BOOTSTRAP_COMMIT" \
    --signer-digest "$BOOTSTRAP_COMMIT" \
    --deny-self-hosted-runners \
    --predicate-type https://slsa.dev/provenance/v1 \
    --digest-alg sha256

  chmod 0700 "$BOOTSTRAP"
  "./$BOOTSTRAP" \
    --release "$PWD/release.json" \
    --archive "$PWD/$ALPHA_ARCHIVE" \
    --sources "$PWD/sources.json"
)
```

There is no archive extraction command and no candidate execution. Launch is a
later, deliberate step after any separately reviewed sandbox preparation:

```sh
"$HOME/.local/bin/vellum-command-desktop"
```

An attestation, identity, commit, or provenance mismatch is a stop condition.
Do not weaken `gh attestation verify` flags. A website checksum cannot override
a failed signature, size, or hash check.

## Source fallback

Use this only when independently installed `gh` or Sigstore verification is
unavailable and a current reviewed checkout plus trusted Bun 1.3.13 are
available. An invalid signature is not a reason to fall back. Compromise of
the GitHub repository or its release authority stops both paths.

```sh
(
  set -eu
  INPUTS="$PWD"
  BOOTSTRAP_COMMIT="REPLACE_WITH_APPROVED_40_HEX_COMMIT"
  ALPHA_VERSION="REPLACE_WITH_QUALIFIED_APP_VERSION"

  git clone --no-checkout \
    https://github.com/skastr0/vellum-command.git \
    vellum-command-bootstrap-source
  git -C vellum-command-bootstrap-source checkout --detach "$BOOTSTRAP_COMMIT"
  test "$(git -C vellum-command-bootstrap-source rev-parse HEAD)" = "$BOOTSTRAP_COMMIT"

  cd vellum-command-bootstrap-source
  test "$(bun --version)" = "1.3.13"
  bun install --frozen-lockfile
  bun scripts/install-linux-desktop.ts \
    --release "$INPUTS/release.json" \
    --archive "$INPUTS/vellum-command-runtime-$ALPHA_VERSION-linux-x64.tar.gz" \
    --sources "$INPUTS/sources.json"
)
```

Review the lockfile and dependency lifecycle scripts. Run from the trusted
checkout, not the downloads directory.

## What this bootstrap does not do

- It does not update an existing managed installation.
- It does not launch the app or open product state.
- It does not accept downloaded keyrings, trust overrides, custom origins, or
  force flags.
- It does not install through apt, `.deb`, `/opt`, or any privileged helper.
- GitHub Releases for the bootstrap are not the application update feed.

Existing alpha installations are not retroactively authenticated by publishing
a bootstrap. Trusted incumbents keep using the in-app updater.

## Historical website checksum path

The former official procedure verified a download-page SHA-256, extracted the
archive, and ran its bundled `desktop-install` CLI. That CLI and its embedded
trust policy arrived inside the same unauthenticated package, so a compromised
download page could publish a matching checksum and skip signature checks.
That procedure is withdrawn. It is not a fallback.
