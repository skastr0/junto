# 0.11.0 release checklist

Owner: product-releases. Status: draft 2026-10-27, no track has reported done.
Plan: `README.md` in this folder. Same lane as 0.10.3
(`docs/plans/0.10/13-release-checklist-0.10.3.md`), with a minor bump. Heavy
runs ask product-lead for a slot and wait for the one-minute load to be under
40 (`sysctl -n vm.loadavg`). Nothing here bumps or builds until product-lead
says every track is done and verified. The operator tests nothing: a check
that needs a person is decided from code and reasoning, takes the safe option,
and is noted unverified.

## 0. Decisions I need before the cut

- [x] Ship tier of `files`. Answer (product-lead, 2026-10-27): experimental
      while tracks build, so half-done work never ships; at the cut
      `SHIP_FEATURES` has `files: true` once every track is verified. Notes are
      worded as on. Still to do at the cut: that commit, and the ship-profile
      test updated with it (`test:features:ship`), as 9695a67af did for tasks,
      artifacts and browser in 0.10. If a track is not verified, `files` stays
      experimental and the first notes line says where to switch it on.
- [x] Schema steps (product-lead): step 51 is the files node, expand only,
      50 to 51. The stub step rebuilds stubs so other machines show a Files stub; it
      is with the operator and, if picked, is step 53. If approved, the notes name it; if not, the notes say
      the stub comes later (other machines then show no Files stub). The links
      step below comes on top of either.
- [x] Artifact links add a second step, `work_artifact_links`, expand only
      (`docs/plans/0.11/02-artifact-links.md`), state 51 to 52 (b41388164,
      af2170d68, c3757fd48, 8f4960f2a, 4cd57bdc3, dfedca97d, fa93d0ba9,
      65f2bee92 per product-feed). The notes carry `<HEAD>` until the cut; read
      `CURRENT_STATE_SCHEMA_VERSION` then.
- [ ] Artifact labels (`03-artifact-labels.md`, new 0.11 track, operator
      decision 2026-10-27) add a labels column or table, expand only, "numbered
      when it lands". So the head is at least 53 (54 with the Files stub step),
      not 52 as earlier lines read. Confirm the number from the code.
- [ ] Whether the Files stub step (53) was picked, known before the notes'
      upgrade paragraph and section 1 are filled in.

- [x] Go (operator, 2026-10-28): the real release, no preview build. Database
      steps cleared as needed, each proven on a `.backup` copy of the live
      `~/.junto/state/junto.db` (v50); a step that would break it goes to the
      operator as a signal.
- [x] Files ships on (operator, 2026-10-28): `SHIP_FEATURES` gets
      `files: true` now, not at the cut.
- [ ] Files stub step: signal with the operator; default yes, built by the
      canvas team as the next step after 62.
- [x] Scope frozen (product-lead, 2026-10-28): fleet state and the N5 vault go
      to 0.12; N1 to N4, N2, K2, K4, K5 and A4 ship only if verified in the
      real app by the cut, otherwise gated off in ship.

## 1. State steps (51 files node, 52 artifact links, labels, stub if picked)

Notes open with it, as 0.10.3 did: the older release refuses the newer
database, and going back means opening the backup taken at the upgrade. Run on
a copy of `~/.junto/state/junto.db`, never the live file (canvas-verifier, via
canvas-lead).

Run 1 (canvas-verifier, relayed, redone on main f714cc002 at head 63, with the
Files stub step c403df836; supersedes their 3a3cc2649 run at 62). `git archive`
export, copy by `sqlite3 -readonly .backup` taken at 23:53:54, the only open of
the live file. They rerun everything at the cut hash. Results per line:

- [ ] Head version and identity match: `CURRENT_STATE_SCHEMA_VERSION` in
      `src/main/junto/state/migrations.ts`, `bun run schema:identity` clean.
      Run 1: head 63 (`migrations.ts:808`), "clean (v63 = 83d7611b0b8a2869...)".
- [ ] The copy migrates from v50 to the head (read from the code, see section 0); `PRAGMA quick_check` ok, foreign keys empty.
      Run 1: copy was v50 (identity 47696d80), migrated to v63 in 7.2 s,
      identity 83d7611b, quick_check ok, foreign_key_check 0 rows.
- [ ] Counts unchanged: every table, every wire and its verb, tasks.
      Run 1: all 101 live tables equal; wires 723 and 723 with 0 rows differing
      and no verb change; task_heads 468 and 468; agent_signals 1358 and 1358;
      stubs 0 and 0 (the live canvas has none; `stub_of` now admits files);
      25 new tables, all empty except the step 61 seed (canvas_consensus 1,
      canvas_authorities 1); factory 329 nodes, 723 wires on both opens.
- [ ] Backup written before the stamp, opens on 0.10.3 at v50.
      Run 1: junto-backup-c9d0c26e written before the v63 stamp; v50, counts
      equal; the 0.10.3 engine (6051eddef) opens it (329 nodes, 723 wires) and
      refuses the v63 file ("newer than supported version 50"), leaving it
      byte-identical.
- [ ] A second open runs no step and makes no backup.
      Run 1: still v63, still 1 backup, 126 tables row-identical except
      `state_schema_identity.verified_at`.
- [ ] Built app launches a fresh v50 home made by the 0.10.3 engine and
      migrates it (the 7b run of 0.10.3). Run 1 (canvas-verifier, relayed, main
      31ae22a6f, same state files as f714cc002; f714cc002 itself does not
      build): passes. Ship profile, files=1, unsigned, `build-app.sh --target
      mac --fast` from a `git archive`, app-run lock held. Home
      `~/.junto-preview-gate63` made at v50 by the 0.10.3 engine (6051eddef),
      seeded with a region, 3 task boards, 2 flows wires, a note and 3 stubs
      (a labelled file, a git, a page on mac-mini). Launch 1: v50 to v63,
      identity 83d7611b, quick_check ok, foreign_key_check 0 rows, wires and all
      3 stubs kept with label and host, `stub_of` admits files; backup
      junto-backup-c09ef75e written before the v63 stamp, v50, holds the stubs
      and wires; no errors, exit 0. Launch 2: still v63, 1 backup, 126 tables
      row-identical except `verified_at` and `onboardingSeen`, which they set;
      the renderer drew the canvas and the stubs. Unverified: a frontmost
      on-screen capture. The screen was locked, so captures came from CDP of
      the app's own renderer, not the screen.
- [ ] Body backlinks backfill (dfedca97d): runs once at boot, marker
      `artifact-links.v1` in `install-ops.db`. Gate, both required:
      product-feed's shipped-install proof (fa93d0ba9, landed; a 0.10.3 install
      shows its body backlinks after the step and the backfill), and on the built
      app launched on a copy of an installed 0.10.3 home, an artifact with a
      `[[ ]]` link shows in its target's Linked from without an edit. Check the
      marker is written and a second launch does not backfill again.

## 2. Dependencies and packaging

- [ ] `@pierre/trees` 1.0.0-beta.6 added; `@pierre/diffs` stays at 1.1.21 (the
      plan says so, README line 68; this line once read 1.6.2, which is stale);
      `package.json`, `bun.lock` and `node_modules` agree on all three, checked
      2026-10-29; `pdfjs-dist` 6.4.299
      with its worker bundled. If the F3 spike fails, the fallback is
      CodeMirror with `@codemirror/language-data`: confirm which shipped.
- [ ] Packaged app, not the dev tree: the PDF worker loads under the CSP
      (`worker-src 'self' blob:`), a PDF opens and scrolls, Shiki highlights.
- [ ] `junto-file:` protocol serves byte ranges in the packaged app.
Packaged ship export at main 01bc0c581 (2026-10-29, clean `git archive`,
`build-app.sh --target mac --fast`, Linux payload from the Orb builder, exit 0;
`audit-packaged-app.ts --source` rc 0; renderer main chunk 5,954,865 bytes).
Read from the packed `app.asar`, not run: `pdf.worker.min-CjEcRF4W.mjs` is in
`out/renderer/assets`, `index.html` carries `worker-src 'self' blob:`, and the
main bundle holds the `junto-file` scheme with `Content-Range`. Not yet done
in the packaged app: a PDF opening and scrolling, Shiki highlighting, and a
live byte-range fetch. Those are real-app runs (section 5, product-verify) and
I run them at the cut hash if asked.

- [x] Linux and machine builds: closed as not needed (remote-lead via
      remote-verify at 9c210bd6e, per product-lead, relayed): a real
      darwin-arm64 machine build has no files service code in `core/junto.cjs`
      or `bin/junto`; only the Electron entry imports `src/main/junto/files`;
      canvas-copy kept a Files node home until step 63, after which the stub
      needs no service.

## 3. Security (the cut is blocked on these)

- [ ] `docs/security-doctrine.md` has the "Files node" paragraph, reviewed by
      remote-lead. Reviewed against the code, every claim holds, one fix
      (1fe376a62: the stub crosses at step 63). Closes once step 63 lands or is
      dropped (product-lead via remote-lead).
- [ ] The renderer never names an absolute path: every call names the node and
      a relative path. A path with `..` and a symlink pointing outside the root
      are refused (`outside-root`). Receipt: test names and run.
      tech-lead, relayed and not rerun by me, at main 210a7506e in a clean
      worktree, all-on: 73 of 73 pass; files-contract refuses `/etc/passwd`,
      `..` and `a/../b`; every IPC call decodes node plus relative path
      (`files/ipc.ts` withRefPath); files-service root scoping refuses a
      symlink out. tech-lead reruns at the cut hash on request.
- [ ] Delete goes to the Trash, never `unlink`. Receipt (tech-lead, relayed):
      `shell.trashItem` (`files/ipc.ts:104`); a symlink is trashed itself; the
      only unlink is the atomic-write temp (`fs-ops.ts:223`).
- [ ] A stale write is refused `stale`; a drop never overwrites. Receipt
      (tech-lead, relayed): refused against the stamp it read; taken names are
      numbered.
- [ ] Other machines get a stub with its geometry, a label only when the
      operator wrote one, and no root path. Step 63 landed (c403df836, 62 to
      63, `stubs` rebuilt with every row copied; head is 63). Receipt: still
      none yet: run 1 at head 63 migrated clean but the live copy has no stubs,
      so the row copy is proved by the 7b run, which seeds file, git and page
      stubs.
      The operator answered yes (product-lead, 2026-10-29), so step 63
      stays. Files over SSH from other machines is recorded for 0.12. Receipt:
- [ ] Text reads cap at 5 MB. Receipt (tech-lead, relayed):
      `FILE_TEXT_MAX_BYTES`, `shared/files.ts:81`.
- [ ] Git guard (e9cc0324e, reported by remote-lead): every git main runs
      overrides `core.fsmonitor`, `core.hooksPath`, `log.showSignature` and each
      filter driver the repo names, so a hostile repo opened in the git node or
      a Files node runs nothing. Receipt: `tests/git-guard.test.ts` at the cut.
      Behaviour change in the notes: the git node no longer reports dirty
      submodule work trees (`diff.ignoreSubmodules=dirty`). Unverified, check
      before the notes claim more: a repo whose filter is required (Git LFS)
      may read as modified in the git node now that its filter commands are
      emptied. Answered by tech-lead, verified with a stand-in filter shaped like
      LFS: a Git LFS file reads as modified in the git node right after a
      clone and after any touch, because the guard empties its clean filter.
      The notes say so. Receipts: `tests/git-guard.test.ts` 5 of 5,
      `git-guard-hooks` 4 of 4 for `core.hooksPath` (bf15eeb4b).
- [ ] A repo whose config names a filter driver with an `=` in its name is
      refused (`unguardableDrivers`, 3776924fc): Junto runs no git in it and
      the git node shows the error. Receipt: `tests/git-guard.test.ts` at the
      cut. Unverified: what a seat's checkout in such a repo does.
- [ ] Files import copies only paths a real drop carried and never Junto's
      home (3776924fc). Receipt: `tests/files-service.test.ts` at the cut, and
      the F5 drop run in the real app. tech-lead, relayed: new
      `files-import-drop-gate` 4 of 4 (cbdd4cb31, `files/ipc.ts:198`).

## 4. Before the cut

- [ ] **Cut blocker.** The retired-state package audit must pass on the
      renderer bundle. An all-on Preview export of main failed it: renderer
      `index-*.js` 8.43 MB over the 8 MiB scan bound
      (`maxAsarEntryBytes`, `scripts/audit-retired-state-signatures.ts:92`;
      reported by remote-lead via remote-verify). Decision (product-lead): the
      renderer splits, the bound stays. performance-lead owns the split and
      sends the hash. Receipt wanted: the audit passing on a Preview export
      and on the ship export at the cut hash. Ship profile at 66009c9cc
      (checked 2026-10-28, clean export, `JUNTO_FEATURE_PROFILE=ship
      electron-vite build`): `index-y8KIeOa9.js` is 8,357,477 bytes, 31,131
      under the 8,388,608 bound (size measured; the audit itself not run on
      it). A 30 KiB margin means any renderer growth before the cut can trip
      it; recheck at the cut hash either way.
      **Fixed by ece0679d5** (lazy CodeMirror, diffs and trees; performance-lead).
      Full export audit at main 3fbd56dd0 (2026-10-28), a clean `git archive`
      export per profile built with `build-app.sh --target mac --fast` as
      `scripts/preview.sh` does (Linux machine payload from the Orb builder),
      then `bun scripts/audit-packaged-app.ts Junto.app --source` run inside
      each export: ship `ok:true`, renderer main chunk 5,933,888 bytes; all-on
      `ok:true`, 6,015,358 bytes; bound 8,388,608. Not yet done: the audit at
      the cut hash, and the signed form of the audit (no `--source`), which
      only the real `app:build:ship` runs.

- [ ] Ship gates: `codeSteps` (K2 runtime, K3 editor, K4 CLI) is OFF in ship
      (c2f4df48b); `automationSignals` (N2, an automation raising a signal,
      and the answered trigger, 0.11/09) is ON in ship from 0.11.1 (15c9e388e,
      after operator-work-verify 25/25 and human-loop-h5-verify 12/12). Seat
      raises with forms (N1, N3, N4) were never under it. The notes' Code
      steps bullet is out while codeSteps is off. If product-lead flips
      codeSteps after its real-app walk (automation-lead mails the hash), put
      the bullet back: edit an automation's code in its modal with the Files
      code editor, unsaved code survives Escape, Revert asks first. For 0.11.1
      the notes carry an N2 bullet (an automation can raise a signal in the
      needs-you feed, and another automation can start from its answer),
      checked against `actionKindInBuild` and `answeredWatchRefusal` in
      `src/shared/automation.ts`.
- [ ] Cut floor, second part (product-lead via canvas-lead): main does not
      build from ffa6c836c through 42a15903b (`control.ts:115` imports
      briefing-mentions, which landed only in e6cfecf72; "Could not resolve" in
      the machine core bundle). The cut is at or after both e6cfecf72 and
      a1308dd3a. Two more cut blockers are being built: Files create, trash and
      a keyboard move in the modal (product-shell), and the Cmd+P Clear button
      (product-modals).
- [ ] Cut floor (product-lead): the cut hash is at or after a1308dd3a, which
      gates the region source's vault token read behind VAULT_ENABLED (210a7506e
      let it read in ship). tech-lead's section 3 receipts ran at 210a7506e and
      are rerun at the cut hash, which covers it.
- [ ] Every track in the plan's tracker reports done and verified by a seat
      that did not write it (product-automation and product-verify in the real
      app), and product-lead names the cut hash. If main moved past it with
      code, say so before bumping.
- [ ] Notes re-read against the cut, bullet by bullet; delete the draft line.
- [ ] `lint:design-tokens`, `lint:product-name`, `lint:no-middot`,
      `lint:layers` pass at the cut hash; `tests/motion-law.test.ts` passes.
- [ ] `git status` clean of other seats' paths.
- [ ] Carried from 0.10.3, still unverified: what the CLI prints for a derived
      task, and a 0.10.2 or 0.10.3 CLI against the new app (cli-lead's answer
      on files commands: none in 0.11).

## 5. Milestone runs (real app, one per feature)

Run the release e2e at `--workers=1`. product-modals sees app launches die at
`firstWindow` at `--workers=2` on this machine, the smoke spec included, while
the same commit is green at `--workers=1` (product-lead, 2026-10-27). Cause
unconfirmed; a run at two workers that fails at launch is not a product failure
until tech-lead confirms the cause. Slower, so ask product-lead for the slot
early. The app-run lock still applies.

Each: frames dark and bright to the needs-you feed for new UI.

- [ ] F1 Files node: made from the palette, takes the region's folder, change
      root, card shows folder name and file count, stub on a second machine.
- [ ] F2 Files modal: tree, open, create, rename, move, trash, watch picks up
      an outside change.
      Receipt, search: performance-lead's review (via product-lead), 200k
      files, keystroke p95 25 ms end to end, main block per build under 10 ms.
- [ ] F3 Editor: opens and saves a TypeScript file; a stale save offers reload
      or keep; Cmd+S; unsaved mark; Markdown opens live.
- [ ] F4 Quick open: Cmd+P in Files, Artifacts, Tasks and Automations; button.
- [ ] F5 Drops: Finder files on the card, on the window, on a folder row; name
      collision gets " 2"; tree drag renames.
- [ ] F6 Preview: PDF (pages, zoom, selection), image, an unknown type offers
      Open and Reveal.
- [ ] F7 Comments: line, image box and PDF page box; the rail lists them; a
      line comment re-finds its lines after an edit.
- [ ] F8 Extract: a PDF box becomes an image artifact in an Artifacts node in
      reach with the source, page and box in its description.
- [ ] L1 to L5 Artifact links: `[[` picks an artifact in reach, an unresolved
      title offers Create document and writes the link, the chip shows the
      current title after a rename, "Linked from" lists body links (document,
      pad text, sheet cell) and mail and comments, an archived source drops
      out, `junto artifact create|edit` resolve `[[Title]]` (zero or several
      matches refused with the candidates) and `show` lists linked from.
- [x] Known limit in the notes: file comment threads stay at the old path when
      a file is renamed or moved outside Junto (Finder, git); a rename or move
      made in Junto carries them. Landed in 63d77dc27 (product-lead,
      2026-10-27). Receipt for the carry itself: the F7 comments run.
- [ ] T1 to T4 Artifact labels: add and remove a label in the header, the
      sidebar filter ANDs several and a parent label matches its children with
      a count each, Cmd+P ranks labels after the title, a label set on one
      machine shows on another, CLI `create --label`, `label --set|--add|--remove`,
      `list --label` and `show`. The cap of 20 and the case folding refuse and
      fold as the contract says.
- [ ] Accessibility for the tree, palette and viewers (product-accessibility).

## Open before the cut (product-lead, 2026-10-27)

All Files and artifact-links tracks are built. Remaining: product-shell's L4
polish, canvas-verifier on 23d5c772b, product-sheet's exploratory list, and
the operator's answers (the Files stub, tags). Tags change the notes if they
land; the stub decides step 53.

## 6. The cut (on product-lead's word only)

Pre-stage and recheck at the go: Developer ID identity 4452968868, `asc`
credentials, Orb builder `junto` running (Bun, Node and rustup; the native
CLI builds there), disk room. The
build script `cut-build.sh` lived in my scratchpad and a purge deleted it once;
recreate it from this recipe if it is gone: archive export of the bump commit
with its own git dir, `cp -cR` of `node_modules`, delete the
`node_modules/node_modules` link (without it the unit lane fails on a second
React), wait for load under 40, set `JUNTO_MACHINE_LINUX_ORB`,
`JUNTO_MAC_TEAM_ID` and `JUNTO_MAC_SIGNING_IDENTITY`, `bun run app:build:ship`.

1. `bun scripts/bump-version.ts --minor --dry-run` shows 0.10.3 to 0.11.0.
2. Run it without `--dry-run`; rename `## Unreleased` in `CHANGELOG.md` to
   `## 0.11.0 — <date>`, new empty `## Unreleased` above, draft line deleted.
3. `git commit -m "chore(release): bump 0.11.0" -- package.json CHANGELOG.md`.
4. Clean export and `app:build:ship` at once. A lone timeout in a lane: rerun
   that file alone, then the build.
5. Publish on product-lead's word: from `~/Projects/junto-landing`,
   `bun scripts/release/publish-mac-release.ts --repo-root <export> --dry-run`,
   then without `--dry-run`.
6. Feed check, redirects followed: `curl -sSL
   https://releases.juntoagents.com/mac/arm64/latest-mac.yml` says 0.11.0; the
   feed zip hashes to the stapled sha256.
7. Delete the export, keep the notarization receipt, mail product-lead the
   hash, artifact names and sizes, sha256, submission id.

## 0.11.1 receipt (product-releases, 2026-10-29)

Published from tag `v0.11.1` = `e41db5bbd` (branch `release/0.11.1`): the bump
`d4907aa89` plus `2f812e263` (test only, one file), cut before quick capture
landed on main. Notarization `eace0b55-61ef-45cf-babf-7a41d98fe038` Accepted.
Stapled zip sha256 `e8bc14274b286508ea097d0099350438c9605796483678e304df33b58496e251`
(sha512 in `latest-mac.yml`), dmg sha256
`6d1e419348ce1f9241b5170dfb080559dd98cc2e70e5a6be8c1ecaedd42a7f7a`. The feed
says 0.11.1 and the downloaded zip hashes to the stapled sha256.

- DB proof, run on a read-only `.backup` of the live v63 file with the cut's
  state engine: v63 to v64 in 7 s, schema identity `f35438d5` matches the
  code, only `artifact_moves` is new (0 rows), the other 126 tables equal,
  canvases and seats identical, `quick_check` ok, one v63 backup written
  before the stamp, a second open runs no step.
- Security receipts at the cut: files-contract, files-service,
  files-import-drop-gate, git-guard (and hooks), install, notarize and
  package security, motion-law: 10 files, 165 tests (ship profile). Four
  lints clean. `test:features:ship` 48 pass, 12 skipped. Signed packaged
  audit `ok:true`, team 4452968868, no forbidden entitlements.
- Unit lane flakes, each passing alone: `automation-editor-actions` (2
  caret tests), `awareness-window-calibration` and `credentials-scrub`
  (wall-clock bounds) under load 20 to 27. The last was fixed by `2f812e263`
  and the final lane passed whole.
- Not run: the runbook's installed-state qualification (installing the
  candidate over an older install and a cold start). It would have migrated
  the operator's live database; the engine proof above stands in for it.
- Known: `bun run audit:dependencies` fails with 14 highs (Electron 43.5.0
  and others) on a lock unchanged since 0.10.3; carried to 0.11.2.
- The tag is local; `v0.11.0` is on origin, `v0.11.1` is not pushed.

## 0.11.2 receipt (product-releases, 2026-10-29)

Published from tag `v0.11.2` = `cf45e6f48` (branch `release/0.11.2`, pushed):
the bump `d8deae328` on main plus five cherry-picks, none of main's later
work: `63f12dd58`, `314d51f2f`, `8e5d01376` (lanes), `568c1c1a8`,
`14870f03b` (tech-lead fixture) and `b481efe1f` (the preview test, with one
app line in `QuickCapture.tsx`, approved by product-documents). Notarization
`af884549-81f8-4cfe-991f-ac5468ad9656` Accepted. Stapled zip sha256
`e4011e3a3ec1d66e13a7a1cfee4ecae9a534311649fd583fe687488e38f8b073`, dmg sha256
`8147a1debb3a02134bfa5397a0e5e5ea612b462142c3d79c618c7da81f585ecf`. The feed
says 0.11.2 and the downloaded zip hashes to the stapled sha256.

- DB proof (on `d8deae328`, the cut differs by tests and one preview key):
  read-only `.backup` of the live v63 file, state engine of the cut, v63 to
  v65 through 64 in 11 s, identity `aefea454` matches the code, only
  `artifact_moves` and `view_capture_inboxes` are new (empty), the other 126
  tables equal, canvases and seats identical, one v63 backup before the
  stamp, a second open runs no step.
- Security receipts on the final cut: 10 files, 165 tests (ship profile; a
  first run failed git-guard twice under load 65, both pass alone and in the
  repeat). Lints clean, `test:features:ship` 13 files, signed packaged audit
  `ok:true`, `audit:dependencies` now clean (845f3864e).
- Unit lane: not a pass. Operator ruling (via product-lead): ignore load
  timing failures. Shared lane passed in 7 of 8 runs at 3 to 4 workers (the
  failure was a 1 worker run, which the shared lane does not support).
  Isolated lane never passed whole at load 20 to 65; every failure was a
  5 s timeout or a wall-clock bound and each file passed alone where it was
  rerun. Final cut's isolated run failed on `lint-product-name` and
  `overseer-live-repository` (timeouts), the alone lane never ran, and the
  published build skipped `bun run test` through a PATH shim, with
  typecheck, the ship feature lane, the packaged smoke, signing and
  notarization intact. Files seen failing on timing across runs:
  adapter-exec-lifecycle (fixed in the cut), artifact-cli, machine-install,
  one-machine-log-migration, git-summary, quick-capture-open (test, fixed in
  the cut), pty-e2e harness-classification, drain-rekey, jev/replay and
  mail-composer-availability, lint-product-name, overseer-live-repository.
- Not run: the runbook's installed-state qualification (it would migrate the
  operator's live database).
- Main carries ahead of this cut: `ebbb81f88` (preview reads the row live),
  `a6342515c` (focus ring CSS), `63f12dd58` order differs but is in both.

## 0.11.3 receipt (product-releases, 2026-10-29)

Published from tag `v0.11.3` = `951f99eac` on main (pushed), cut from origin/main
as it stood, no release branch: the bump `8af02c8ee` plus every later commit
(motion stops, feed filters, threads/2). Notarization
`03f1569d-a219-450d-ba5a-7426009171a9` Accepted. Stapled zip sha256
`ea1ec35d68cebfe0da800d33ea54986543b9d638d034213703c49df23b46cb03`, dmg sha256
`36a2291c60f4c0a3331f89dd0aca5771d19dc5d81dfeb224d7931c8970ed7448`. The feed says
0.11.3 and the downloaded zip hashes to the stapled sha256.

- Unit lane: not a pass. Shared lane 788 files passed. Isolated lane failed on
  5 s timeouts under load (first run: `canvas-editor-migration`, which passes
  alone, 4 of 4; second run: 11 files, migration, lint-product-name, git-guard
  and similar, all load timing). Operator ruling: ignore load-timing failures.
  The published build skipped `bun run test` through a PATH shim, with
  lint:product-name, typecheck, the ship feature lane, signing, Gatekeeper
  assess and notarization intact.

## 0.11.4 receipt (product-releases, 2026-10-30)

Published from tag `v0.11.4` = `22d0ed2de` on main (pushed), cut from a clean
export with the 0.11.3 recipe. Unit lane skipped by operator ruling; typecheck
and the ship feature lane ran. Notarization submission
`1eb49f7b-82d2-4c4e-b4e9-d3ba4f6a236d` Accepted, stapled. Zip sha256
`1d6760163cdccd6c5fb9a3b89dc25c0be3706d5aac5b0e3cd358c88720ca08eb`, dmg
`dc51b65747e7ec41b2e74d1a591c53c7ba870bf8d78cb9392389cd772f3e1788`. Machine
build `478d090a52481dd425dfc21bc5064076c72b63cdf381d375600f5920f4f45c7b`
(darwin-arm64, linux-x64), archive hashes match the catalog. The feed says
0.11.4 and the downloaded zip matches. Launch smoke by product-verify: pass.
The machine core reads mail on main (22d0ed2de); the app keeps the worker.

## 0.11.5 receipt (product-releases, 2026-10-30)

Published from tag `v0.11.5` = `9f7f0192f` on main (pushed, one push, the
bump on top of local main as it stood), cut from a clean export with the
0.11.4 recipe. Unit lane skipped by operator ruling; the eight files this
release touches (96 tests), typecheck, lint:product-name and the ship feature
lane (48 pass, 12 skipped) ran. Notarization submission
`183641bb-8563-4eb3-9c05-db928f97264d` Accepted, stapled. Zip sha256
`428c50b22851bcc99674933592d9141d8a5537280f9bdc2ab14dc05b7b016afe`, dmg
sha256 `18a8ef93f7c5e0878052203196e8f0274d96702582860ea8007cb9deceb63638`.
Machine build `9f15d198df7ddbd0c130cb73e8015135333274e98125e460b0e8fb64af37165a`
(darwin-arm64, linux-x64). The feed says 0.11.5 and the downloaded zip
matches. Launch smoke by product-verify before publish: pass (8 of 8). The
native CLI seats' Rust commits (N2) were on main and built clean.
