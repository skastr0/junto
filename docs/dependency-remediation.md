# Dependency remediation

Runtime `tar` and updater YAML are pinned. Remaining `bun audit` noise is classified by `scripts/audit-dependencies.ts`, not by scanner row count.

## Policy

- Fail remaining `tar` / `js-yaml` advisories.
- Fail unexcepted high/critical runtime findings.
- Fail unexcepted high/critical packaging findings that apply to enabled targets (`mac` zip/dmg, Linux `dir`). AppImage is outside the v1 envelope.
- Fail unexcepted high/critical development findings.
- Documented exceptions expire. Each records GHSA, versions, lockfile paths, reason, owner, expiry.

## esbuild

Vite 7.3.5 still depends on `esbuild@0.27.7` (`GHSA-g7r4-m6w7-qqqr`, Windows development-server file read). electron-vite keeps `0.25.12`, which is outside that advisory. The Vite copy is excepted until a compatible parent upgrade can take `>=0.28.1`.

## Counts

`bun audit` reports advisory *rows*. Duplicate GHSA IDs across version ranges are not distinct product vulnerabilities.
