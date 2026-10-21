# 11 Release checklist

Owner: product-releases. Status: draft 2026-10-21, scope frozen. Heavy runs
(full test, verify, vitest over 3 files, whole-tree typecheck, e2e, builds)
each ask product-lead for a slot and wait for the one-minute load to be under
40 (`sysctl -n vm.loadavg`). Nothing here bumps the version before
product-lead says so.

## 1. Before the cut

- [ ] Main green: tech-lead's hourly full verify on a clean archive passes,
      all lanes, at the commit to be cut. Name the commit.
- [ ] Open release blockers closed: browser hand-back 403, node card redesign
      picked and built, seat portraits on mentions.
- [ ] Operator has answered the ship switches for `tasks`, `artifacts` and
      `browser` (`SHIP_FEATURES` in `src/shared/feature-catalog.ts`). Those
      three flags stay until then (operator decision 6).
- [ ] `bun run lint:product-name`, `lint:no-middot` and `lint:layers` pass
      (all three also run inside `bun run verify`).
- [ ] `git status` clean of other seats' staged paths; commit only through a
      private index.

## 2. Migrations chain on a live copy

Run on a copy of `~/.junto/junto.db`, never the live file.

- [ ] Open the copy with the cut build's engine and let it migrate to the head
      (`CURRENT_STATE_SCHEMA_VERSION` in `src/main/junto/state/migrations.ts`;
      step 47 on 2026-10-21, confirm at the cut).
- [ ] `PRAGMA integrity_check` is `ok` and `PRAGMA foreign_key_check` is empty.
- [ ] Counts unchanged: wires, seats and regions match the live canvas (444,
      127 and 80 at v40). Tasks kept (358 at v40), open tasks on deleted
      boards canceled and readable (13 at v32).
- [ ] No node of a removed kind remains: requests, board, pad, sheet, cron,
      relay, watcher, timer.
- [ ] `bun run schema:identity` matches the head identity.
- [ ] The oldest openable database is v13 (`from-legacy-row` is gone): a
      database below it is refused with a plain message, not a crash.
- [ ] A backup of the pre-upgrade file exists (`state/backup.ts`) and opens
      on the previous release.
- [ ] Relaunch on the migrated copy: no second migration, canvas loads.

## 3. Builds

- [ ] Unit lanes: `bun run test:features:ship` and `bun run test` (all-on).
- [ ] `bun run verify` on the cut commit.
- [ ] All-on build for e2e: `JUNTO_FEATURE_PROFILE=all-on`; e2e batches below
      run on it, with the app-run lock.
- [ ] Ship build after the bump: `bun run app:build:ship` (sign, verify,
      notarize). Confirm the packaged runtime receipt and that the ship
      profile carries no flag of a deleted feature.
- [ ] Linux and machine builds: `bun run app:build:linux` and the machine
      bundle build, with no browser CLI in the machine bundle.

## 4. Milestone runs, one per feature (real app, batched)

Each run: screenshots to the needs-you feed for new or changed UI only;
deletions report the commit only.

- [ ] Tasks: backlog, assign, start, finish, reviewers and stamps, operator
      stamp, dependencies block finish, send-on keeps handoff note, comments.
- [ ] Artifacts: create document, sheet and pad, edit, history, comments with
      mentions, stale edit refused.
- [ ] Automations: create, edit, stale, toggle, run, history, archive; only
      operator and overseers write.
- [ ] Mentions: `@` and `#` in thread and review composers, chips open, seat
      portrait on a seat mention, long mail over 64 KiB attaches a file.
- [ ] Browser (only if the ship switch is on): tabs, takeover and release
      without 403, box comments.
- [ ] Reach and queued writes, two machines: a seat on another machine queues
      commands, a stale write names the winner, one notice each.
- [ ] Deleted features really gone in the packaged app: no pin control, no
      Requests node, no bulletin board, no chat button, no Providers card,
      Hermes still opens as a terminal seat.
- [ ] Add item and CLI refuse an agent seat in the home folder.
- [ ] `junto onboard` lists what changed since the last session.
- [ ] CLI acceptance net: `scripts/work-cli-acceptance.ts` all pass.
- [ ] Node cards and canvas smoothness at many seats (motion law holds,
      `tests/motion-law.test.ts`).

## 5. The cut (on product-lead's word only)

1. `bun scripts/bump-version.ts --minor --dry-run` shows 0.9.2 to 0.10.0, or
   the current version at the cut.
2. `bun scripts/bump-version.ts --minor`, then rename `## Unreleased` in
   `CHANGELOG.md` to `## 0.10.0 — <date>` and delete its draft line, leaving a
   new empty `## Unreleased` above it.
3. Commit as `chore(release): bump 0.10.0` through a private index, paths
   `package.json` and `CHANGELOG.md` only.
4. `bun run app:build:ship`, then `bun run mac:release:publish` (private
   distribution repository). Publishing is separately authorized.
5. Mail product-lead the commit hash and the artifact names.
