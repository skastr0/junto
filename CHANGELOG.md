# Junto changes

## Unreleased

- Read the operator's authored board title on every projection — canvas card,
  node titles, digest, SVG export, and region rollups — instead of a constant
  kind name, while dash-prefixed topic lines still never leak into titles.
- Settle request resolution idempotently: resolving an already-resolved request
  returns the settled state instead of an error banner, and every raising
  actor ref learns the answer, not just one.
- Fix credential-vault retention corrupting the settings row: patching any
  preference while plaintext secrets await vault migration no longer makes the
  next read fail with a corrupt-settings error.
- Give the artifacts glance an honest empty state ("quiet") like the other
  sinks instead of rendering nothing.
- Make the remote deploy's installed-generation check portable to mawk
  (POSIX awk has no regex interval expressions), so Linux observe no longer
  reports every install absent.

- Authenticate Linux desktop first install with an independently obtained
  bootstrap or reviewed source checkout. Do not extract or execute the
  candidate archive's bundled CLI. Incumbent signed updates are unchanged.
- Stop treating pad shape and ink colors as HTML or CSS. Render only
  hex/`none` paint, serialize SVG with escaped attributes, and drop
  `script-src 'unsafe-inline'` from the renderer CSP.
- Store operator provider credentials outside SQLite and omit them from
  newly minted state backups. Historical backups remain immutable.
  Vault unavailability no longer blocks boot or erases leftover secrets.
- Make project-owned source available under Apache-2.0, with source-build
  instructions and third-party notices.
- Remove purchases, activation, and commercial access checks from desktop and
  experimental Remote startup. Existing databases keep their historical schema.
- Remove the copied Canvas UI Fleet presentation and its unused assets.
- Replace generated sound clips with original, reproducible waveform cues.
- Remove private checkout dependencies and use synthetic development fixtures.
- Separate local source packages from official signing and publication.
- Add signed Linux desktop alpha releases, managed rootless installation, and
  automatic update downloads with an explicit restart to install.
- Bound Linux desktop generation retention to the active generation and live
  staged candidate, with post-readiness collection, disk admission, and a
  Doctor storage check.

macOS remains the primary platform. Linux desktop is alpha. Fleet and Remote
remain experimental and disabled in the default build. This entry describes
source changes awaiting release; it does not identify a published installer.
