# Dependency remediation

`bun run audit:dependencies` runs `bun audit --audit-level=high`: it checks
the locked dependency versions against published advisories and fails on any
high or critical finding. Lower-severity advisories still print under a plain
`bun audit` but do not fail the gate.

CI runs the audit once per workflow in the dedicated `dependency-audit` job
(`.github/workflows/verify.yml`). Routine `bun run verify` and the unit suite
do not run it; the check needs the advisory feed, so it stays out of offline
lanes.

## Remediating a failure

Upgrade the flagged package to a fixed version, or pin a patched release
through `package.json` `overrides` when the vulnerable copy is transitive.
Runtime pins (`tar`, `js-yaml`) already follow that path.

## Known advisories

`esbuild` `GHSA-g7r4-m6w7-qqqr` (low, Windows development-server file read)
remains in the tree through `vite`, `electron-vite`, and `react-scan` until a
compatible parent upgrade can take `>=0.28.1`. It is below the gate threshold;
shipped targets are macOS and Linux.
