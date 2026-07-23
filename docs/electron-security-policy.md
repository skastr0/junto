# Electron release-freshness policy

[`scripts/electron-security-policy.json`](../scripts/electron-security-policy.json) is the canonical, machine-readable offline policy for the Electron runtime. It pins the exact runtime, its audited release, the current supported-major window, source provenance, review dates, and both review SLAs.

Every local verification, native package build, and macOS install checks it offline. The gate requires the package manifest, installed Electron package, and installed Electron runtime to exactly match the audited release. It fails closed when policy review has expired, provenance is incomplete, the pin is outside the supported-major window, or a local artifact is older than the audited release.

Routine review is due within `reviewSla.routineDays`; a security-driven refresh is due within `reviewSla.urgentHours`. Update the policy and its exact Electron dependency only after a human review of the official sources and the corresponding release gates.

To collect current upstream evidence without changing policy, run:

```sh
bun run electron:policy:check
```

This command only fetches the official Electron timeline, release index, and audited-release record, then prints an evidence receipt. It never updates the policy, dependencies, lockfile, or a release artifact. Offline enforcement remains `bun run electron:policy:validate`.

Before shipping a macOS artifact, a signed rebuild/reinstall remains separately required: `bun run app:build:ship`, then `bun run app:install -- --verify`. The freshness policy does not replace code-signing, notarization, or installed-artifact audit evidence.
