# 13 Release checklist, 0.10.3

Owner: product-releases. Status: draft 2026-10-27, waiting for product-lead's
go with the cut hash. Same lane as 0.10.2 (`12-release-checklist-0.10.2.md`).
Heavy runs ask product-lead for a slot and wait for the one-minute load to be
under 40 (`sysctl -n vm.loadavg`). Nothing here bumps or builds before the go.

## Contents

157 commits since the 0.10.2 bump (`8e17f666a`). Headlines: artifacts rebuild
(live markdown document, mention chips and embeds, comments rail, narrow
sidebar, one-row header, keys, accessibility), the pad (own engine kept,
toolbar and stencils, connectors, preview cards, pan and pinch, lighter
rendering), task body on live markdown, the one-open-task limit removed,
derives between task boards, one list navigation, and the flow track fixes.
Notes are in `CHANGELOG.md` under `## Unreleased`; word them again against the
cut hash.

## 1. State step 50 (the part that differs from 0.10.2)

`fd6da2a96` migrates the database from v49 to v50: `wires` is rebuilt with
`derives` in its verb CHECK, every wire copied as it was, and `task_heads`
gains `derived_from`, null on every task already held, with an index. It is a
consolidate step, approved by the operator (signal 01M5YCJ31C5PDE42NEY1B94WHP).
The notes open with it: 0.10.2 refuses a v50 database as newer than supported,
and going back means opening the backup taken at the upgrade.

Run on a copy of `~/.junto/junto.db`, never the live file.

- [ ] Head is v50 at the cut (`CURRENT_STATE_SCHEMA_VERSION` in
      `src/main/junto/state/migrations.ts`) and `bun run schema:identity`
      matches `STATE_SCHEMA_V50_IDENTITY` (47696d80...). Receipt:
- [ ] Open the copy with the cut build's engine; it migrates v49 to v50.
      Receipt:
- [ ] `PRAGMA quick_check` is `ok` and `PRAGMA foreign_key_check` is empty.
      Receipt:
- [ ] Counts unchanged against the live copy: wires, nodes, seats, regions and
      tasks, and every wire keeps its verb. Receipt:
- [ ] A backup of the pre-upgrade file exists and opens on 0.10.2 at v49.
      Receipt:
- [ ] A second open runs no step and makes no backup. Receipt:
- [ ] The migrated copy loads the canvas in the built app. Receipt:

Ask canvas-lead (canvas-verifier did this for 0.10.0) to run the section; a
slot, the live copy and the receipts come through product-lead.

## 2. Before the cut

- [ ] Product-lead names the cut hash; the bump lands directly on it. If main
      moved past it, say so before building.
- [ ] Notes re-read against the cut: every bullet true of the code at the hash.
      Open ones to confirm: the pad keys (Space to pan, Cmd+Shift+Z), the
      document keys (Cmd+B, Cmd+E, Cmd+Shift+M), and what the CLI prints for a
      derived task. A CLI from 0.10.2 against the new app is untested; if it is
      not checked before the cut, say so in the notes the way 0.10.1 did.
- [ ] Dependencies: CodeMirror 6 and `@axe-core/playwright` added;
      Excalidraw and its fonts are gone (`grep -ci excalidraw package.json
      bun.lock` is 0, confirmed 2026-10-27).
- [ ] `git status` clean of other seats' paths. Today's tree carries other
      seats' uncommitted files (`pad-toolbar.spec.ts`, `pad-toolbar.css`,
      `zz-feed-task-body-capture.spec.ts`, `artifacts/new.norm`,
      `measure-runs.ndjson`); none goes in the cut.
- [ ] `bun run lint:design-tokens`, `lint:product-name`, `lint:no-middot`,
      `lint:layers` pass at the cut hash.
- [ ] Motion law holds: `tests/motion-law.test.ts`. The derives arrowheads
      breathe on opacity alone and the flows chevrons slide on transform.

## 3. Pre-staged

Same as 0.10.2: Developer ID identity 4452968868, `asc` notarization
credentials, Orb builder `vellum-v015-build-clean`, `cut-build.sh` in my
scratchpad (it must keep the step that deletes the `node_modules` link back
into the shared tree; without it the unit lane fails 165 tests on a second
React). Recheck each is still there at the go, and that the disk has room
(34 GiB free at 98% full on 2026-10-22).

## 4. The cut (on product-lead's word only)

1. `bun scripts/bump-version.ts --dry-run` shows 0.10.2 to 0.10.3.
2. `bun scripts/bump-version.ts`, rename `## Unreleased` in `CHANGELOG.md` to
   `## 0.10.3 — <date>` with a new empty `## Unreleased` above it.
3. `git commit -m "chore(release): bump 0.10.3" -- package.json CHANGELOG.md`.
4. Clean export of that commit and `app:build:ship` (unit lanes, sign, verify,
   notarize), started at once, load under 40.
5. Publish only on product-lead's word: from `~/Projects/junto-landing`,
   `bun scripts/release/publish-mac-release.ts --repo-root <export> --dry-run`,
   then the same without `--dry-run`.
6. Feed check with redirects followed: `curl -sSL
   https://releases.juntoagents.com/mac/arm64/latest-mac.yml` says 0.10.3 with
   zip and dmg; the zip from the feed hashes to the stapled sha256.
7. Delete the export, keep the notarization receipt, mail product-lead the
   hash, artifact names and sizes, sha256 and submission id.

## 5. After

- [ ] Real-app look at the shipped build (product-verify): a live document with
      a mention chip and a preview card, the pad toolbar and a connector, a
      task board derive wire between two boards, and a database that migrated
      from v49. Frames to the needs-you feed.
- [ ] Website download page is not touched by this lane.
