# Vellum Command changes

## Unreleased

- Authenticate Linux desktop first install with an independently obtained
  bootstrap or reviewed source checkout. Do not extract or execute the
  candidate archive's bundled CLI. Incumbent signed updates are unchanged.
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

macOS remains the primary platform. Linux desktop is alpha. Fleet and Remote
remain experimental and disabled in the default build. This entry describes
source changes awaiting release; it does not identify a published installer.
