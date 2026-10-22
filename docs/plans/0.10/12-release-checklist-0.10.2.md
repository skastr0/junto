# 12 Release checklist, 0.10.2

Owner: product-releases. Status: draft 2026-10-21, waiting for product-lead's
go with the cut hash. Same lane as 0.10.1 (`11-release-checklist.md`, section 3
and 5). Heavy runs ask product-lead for a slot and wait for the one-minute
load to be under 40 (`sysctl -n vm.loadavg`). Nothing here bumps or builds
before the go.

## Contents

In: Needs you region chip strip with parent-region rollup (a3b51ada9,
95e057b76, 6d33811fa, 649bc1cb6), free hex contrast clamp (2bdf377b3,
a20bb2345), Ledger kind-seat kit (803a4b1e7, 9f463b13c, 60fd6b687, c4c083bd9)
and its canvas wiring from canvas-window, and a new task-edge style (operator
ask; canvas-edges is trialing previews first). Hashes for the wiring and the
edge style are not yet known.

Out of scope: no state change in the listed commits (`git diff
42d006da3..HEAD -- src/main/junto/state` is empty), so the database stays at
version 49, no backup note and no migration run. Reconfirm at the cut.

## 1. Before the cut

- [x] canvas-window's wiring is on main and cleared by canvas, automation and
      verify (product-lead): 642c999bc, bb021a3eb, e32c25610, 9eb512093,
      c47d976b0, with the kit 803a4b1e7, 9f463b13c, 60fd6b687, c4c083bd9,
      b1c85c01d. Product-lead still names the cut hash.
- [ ] tech-lead's verify is green at the cut hash. Receipt:
- [x] Notes cover the wiring (bullet is in CHANGELOG, worded from
      bb021a3eb and 9eb512093; re-check if the wiring changes).
- [ ] Notes cover the task-edge style. Operator picked B, moving, colour 4
      (ink). Bullet drafted from the picks and canvas-edges' in-progress
      `WireEdge.tsx` comment (verb `flows`, open chevrons, half again a wire's
      weight, opaque at every tier); re-check its words against the committed
      build. Still to confirm: drawing only, no stored setting (else a state
      check).
- [ ] `git status` clean of other seats' staged paths. Today's tree carries
      another seat's `docs/research/tooling/measure-runs.ndjson` and
      `e2e/scenarios/zz-kinds-gallery-check.spec.ts`; neither goes in the cut.
- [ ] `bun run lint:design-tokens`, `lint:product-name`, `lint:no-middot`,
      `lint:layers` pass at the cut hash. 0.10.1 first failed the token lint at
      the build, so run it before the bump.
- [ ] Motion law: `tests/motion-law.test.ts` passes (kind seat bands move on
      transform and opacity only).

Pre-staged 2026-10-21, nothing run: Developer ID identity in the keychain
(4452968868), `asc` notarization credentials present, Orb builder
`vellum-v015-build-clean` running, build script written (same recipe as
0.10.1: archive export, cloned node_modules, wait for load under 40, then
`app:build:ship`). Disk has 34 GiB free at 98% full; the export and build need
room, so the export is deleted after publish. Per product-lead the bump,
export and build start together on the cut hash, in parallel with tech-lead's
verify, and publish waits for verify green.

## 2. The cut (on product-lead's word only)

1. `bun scripts/bump-version.ts --dry-run` shows 0.10.1 to 0.10.2.
2. `bun scripts/bump-version.ts`, then rename `## Unreleased` in `CHANGELOG.md`
   to `## 0.10.2 — <date>`, leaving a new empty `## Unreleased` above it.
3. Commit as `chore(release): bump 0.10.2` with `git commit -- package.json
   CHANGELOG.md`, nothing else.
4. Clean export of that commit, Orb builder as for 0.10.1 (builder name from
   the 0.10.1 receipt, `vellum-v015-build-clean`; confirm it is still up).
   Wait for load under 10.
5. `bun run test` shared, isolated and ship lanes, then
   `bun run app:build:ship` (sign, verify, notarize). Confirm Gatekeeper and
   notarization accepted.
6. `bun run mac:release:publish` (separately authorized by the go).
7. Feed check: `https://releases.juntoagents.com/mac/arm64/latest-mac.yml` says
   0.10.2 with zip and dmg; the zip from the feed hashes to the stapled sha256.
8. Mail product-lead: the commit hash, artifact names and sizes, sha256,
   notarization submission id. Delete the export, keep the receipt.

## 3. After

- [ ] Real-app look at the shipped build (product-verify): Needs you strip with
      a parent and child region, a free hex region in both themes, and the
      kind seats on the canvas. Frames to the needs-you feed.
- [ ] Website download page is not touched by this lane.
