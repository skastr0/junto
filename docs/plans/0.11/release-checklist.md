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
      50 to 51. Step 52 rebuilds stubs so other machines show a Files stub; it
      is with the operator. If approved, the notes name it; if not, the notes say
      the stub comes later (other machines then show no Files stub). The links
      step below comes on top of either.
- [x] Artifact links add a third step, `work_artifact_links`, expand only
      (`docs/plans/0.11/02-artifact-links.md`; product-feed lands it, canvas
      coordinates its number with step 52). So the head is 52 or 53 if the
      stub step is approved, 51 or 52 if not. The notes carry `<HEAD>` until
      the cut; read `CURRENT_STATE_SCHEMA_VERSION` then.
- [ ] Which steps landed, known before the notes' upgrade paragraph and
      section 1 are filled in.

## 1. State steps (51, links, and the stub step if approved)

Notes open with it, as 0.10.3 did: the older release refuses the newer
database, and going back means opening the backup taken at the upgrade. Run on
a copy of `~/.junto/state/junto.db`, never the live file (canvas-verifier, via
canvas-lead).

- [ ] Head version and identity match: `CURRENT_STATE_SCHEMA_VERSION` in
      `src/main/junto/state/migrations.ts`, `bun run schema:identity` clean.
- [ ] The copy migrates from v50 to the head (51 to 53, see section 0); `PRAGMA quick_check` ok, foreign keys empty.
- [ ] Counts unchanged: every table, every wire and its verb, tasks.
- [ ] Backup written before the stamp, opens on 0.10.3 at v50.
- [ ] A second open runs no step and makes no backup.
- [ ] Built app launches a fresh v50 home made by the 0.10.3 engine and
      migrates it (the 7b run of 0.10.3).
- [ ] Diff the step's files between the receipts' commit and the cut.

## 2. Dependencies and packaging

- [ ] `@pierre/trees` 1.0.0-beta.6 added; `@pierre/diffs` 1.1.21 to 1.6.2
      (`CodeView.tsx` and the git review still work); `pdfjs-dist` 6.4.299
      with its worker bundled. If the F3 spike fails, the fallback is
      CodeMirror with `@codemirror/language-data`: confirm which shipped.
- [ ] Packaged app, not the dev tree: the PDF worker loads under the CSP
      (`worker-src 'self' blob:`), a PDF opens and scrolls, Shiki highlights.
- [ ] `junto-file:` protocol serves byte ranges in the packaged app.
- [ ] Linux and machine builds: a Files node on a machine host works, or the
      machine bundle is confirmed not to need the service (remote-lead).

## 3. Security (the cut is blocked on these)

- [ ] `docs/security-doctrine.md` has the "Files node" paragraph, reviewed by
      remote-lead.
- [ ] The renderer never names an absolute path: every call names the node and
      a relative path. A path with `..` and a symlink pointing outside the root
      are refused (`outside-root`). Receipt: test names and run.
- [ ] Delete goes to the Trash, never `unlink`. Receipt:
- [ ] A stale write is refused `stale`; a drop never overwrites. Receipt:
- [ ] Other machines get a stub with the label and no root path. Receipt:
- [ ] Text reads cap at 5 MB.
- [ ] Git guard (e9cc0324e, reported by remote-lead): every git main runs
      overrides `core.fsmonitor`, `core.hooksPath`, `log.showSignature` and each
      filter driver the repo names, so a hostile repo opened in the git node or
      a Files node runs nothing. Receipt: `tests/git-guard.test.ts` at the cut.
      Behaviour change in the notes: the git node no longer reports dirty
      submodule work trees (`diff.ignoreSubmodules=dirty`). Unverified, check
      before the notes claim more: a repo whose filter is required (Git LFS)
      may read as modified in the git node now that its filter commands are
      emptied. Ask remote-lead or the git node's owner.
- [ ] A repo whose config names a filter driver with an `=` in its name is
      refused (`unguardableDrivers`, 3776924fc): Junto runs no git in it and
      the git node shows the error. Receipt: `tests/git-guard.test.ts` at the
      cut. Unverified: what a seat's checkout in such a repo does.
- [ ] Files import copies only paths a real drop carried and never Junto's
      home (3776924fc). Receipt: `tests/files-service.test.ts` at the cut, and
      the F5 drop run in the real app.

## 4. Before the cut

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
- [ ] Known limit in the notes: file comment threads stay at the old path when
      a file is renamed or moved outside Junto; a rename in Junto carries them
      (lands after L1). Confirm it landed before the notes claim it.
- [ ] Accessibility for the tree, palette and viewers (product-accessibility).

## 6. The cut (on product-lead's word only)

Pre-stage and recheck at the go: Developer ID identity 4452968868, `asc`
credentials, Orb builder `vellum-v015-build-clean` running, disk room. The
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
