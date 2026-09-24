# Junto changes

## Unreleased

- Drop the support email. The startup data-store failure dialog, SECURITY.md,
  and the issue templates send every report to GitHub issues.
- Name the real reason a seat could not start ("Codex could not start: the
  folder ~/x does not exist") instead of a bare "failed to start".
- Strip Electron's template camera, Bluetooth, and audio-capture purpose
  strings from the macOS Info.plist, so the app declares only the microphone
  string it documents. The packaged-app audit refuses a bundle that still
  declares one.
- Hold the canvas viewport busy gate across bursty pan input, so wheel and
  trackpad pans no longer flicker the chrome and regions.
- Unregister the release build output from LaunchServices after install, so
  `junto://` links and `open -a Junto` resolve to `/Applications`.

## 0.3.3 — 2026-09-18

Built and signed, not published to the update feed. The next published
release carries these changes.

- Stop running the operator's login shell at startup to discover `PATH`.
  Harness lookup reads version-manager install directories instead, so shell
  startup files no longer run under Junto's macOS privacy identity.
- Refuse a managed agent seat whose working directory is missing, and say
  which problem it is.
- Prefer version-manager alias directories and bound repeated shim probes
  when resolving a harness binary.
- Pin the browser's session download path under app state so it never
  resolves `~/Downloads`.
- Resolve the Cursor seat by `cursor-agent`, not the `agent` alias.
- Stop offering the review verdict port when the tasks surface is off in the
  build.
- Add seat awareness behind one build gate, off in official builds.
- Rewrite the README around seats, mail, and drawn structure.

## 0.3.2 — 2026-09-16

First release under the Junto name, published to the macOS update feed. It
also carries the source changes earlier entries listed as unreleased.

- Rename the product to Junto: the app, the `junto` CLI, `~/.junto/`,
  `junto.db`, environment keys (`JUNTO_*`), and the `junto://` scheme.
- Collapse the schema and Station protocols to the Junto version-1 baseline,
  and admit unversioned databases witness-first again.
- Point security contacts and download links at juntoagents.com.
- Prove managed seats from the caller node's terminal binding.
- Add the Hermes terminal seat behind its own harness gate.
- Keep the Electron-only filesystem out of the standalone CLI bundle.
- Stop publishing Linux bootstrap relink source materials.
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
remain experimental and disabled in the default build.
