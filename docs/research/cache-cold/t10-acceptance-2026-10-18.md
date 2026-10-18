# T10 acceptance, the cache-cold loop (2026-10-18)

**Verdict: this machine passes items 1 to 8. Item 5 failed on a7d490f53 and passes on 7195b33ee, which holds pty-lead's fix 815dde913. On the mini, the rerun at a10d273b2 (which holds d7806b265 and 696cf5424) passes items 1, 2, 2b, 3, 4, 6 and 8, with 7 measured. Item 5 fails there: the mini core cuts a Blocked seat. The desktop's offboard status for remote seats still reads sessionId null (see Mini rerun). The record checks were dropped after the operator ordered the record reverted.**

## Setup

- A Junto PREVIEW ran beside the live app, as `scripts/preview.sh` sets one up. Its home was `~/.junto-preview-t10`, with Electron data isolated, and it was launched from its build checkout. The live app (pid 6981) and `/Applications` were never touched.
- Builds, both from automation-lead slots, under the app-run lock in my own worktree: `a7d490f53b418a904707089d4c8c29fd3e446c86` for items 1 to 4 and 6 to 8, and `7195b33ee0d170ee32b1663eff89ae47036abfc4` for the item 5 rerun. The preview reports the build hash in its launch line ("Junto PREVIEW: build 7195b33ee0d1... (ship features)").
- Canvas `t10` held 4 real claude seats: `t10-reader`, `t10-blocked`, `t10-commit-a` (repo-a, which has a pre-commit hook refusing staged `BLOCKME`) and `t10-commit-b` (repo-b). The worth guard was unchanged (30 work minutes or about 200k tokens), and no test hooks were added.
- Receipts are in `~/junto-receipts/t10-20261018/`, outside the repo because of size:
  - `shots/` holds the screenshots.
  - `records/` holds the `.ended.json` and `.record.json` files and the reader's fresh transcript.
  - `monitor-run{1,2,3}.jsonl` holds each seat's offboard status, state and launch state every 15 seconds.
  - Also there: `seat_commits.txt`, `seat_sessions.txt` and the item JSON files.

## Per item

| # | Item | Result | Seat (workMinutes, sessionTokens) | Receipt |
|---|---|---|---|---|
| 1 | Window set and read back | PASS here, mini unverified | preview machine | `item1-local-window.json`: before `{60, harness:{}}`, after `{60, harness:{claude:2}}`, kept across an app restart. Restored at 19:31:24, read back `{60, harness:{}}` (`restore-window.json`). |
| 2 | Eager cut at 2 min of idle | PASS | t10-blocked (2, 359,313) | Idle from about 18:43:22, `pastWindow` at 18:45:34, cut at 18:45:55. `8b5b39dc...ended.json` `{"by":"automatic"}`. `record.json` has kind `junto_observation`, ended_by automatic, and transcript_path. The last assistant turn in the old transcript is 18:43:15, with no turn after it. Card "fresh next": `shots/12-blocked-cut-card.png`. |
| 2b | A seat below the guard is left alone | PASS | t10-commit-a (0, 51,689) | At 18:51:05 it was idle 6 min, past its window, worth false, still running, nextTurn fresh false. Cards show no "fresh next": `shots/15-2b-cards.png`. |
| 3 | A repaint does not reset the clock | PASS | t10-commit-b | `item3-before/after.json`: stillSince stayed 18:47:00.374 across a terminal open and resize, while the state's updatedAt moved to 18:47:12.93. |
| 4 | The hold | PASS | t10-blocked, fresh session (3, 369,925) | Idle at 19:04:26. Terminal open from 19:04:41 (`shots/19-hold-open.png`). Past its window from 19:06:36 to 19:08:36 with the same epoch and nextTurn fresh false (`monitor-run2.jsonl`). Closed at 19:08:49, nextTurn fresh at 19:08:51, offboarded at 19:09:06. |
| 5 | A Blocked seat is not cut | FAIL on a7d490f53, PASS on 7195b33ee | t10-reader (10, 339,120), then (6, 223,934) | See below. |
| 6 | Mail to a cut seat starts fresh with the record | PASS | t10-blocked | Fresh session 9eea3bf4: its onboard shows `previous_session_without_notes` (8b5b39dc, ended_by automatic, transcript_path) and `sessions.past[0].record` with mail, signals, tasks and commits. `journal: null`, because the seat wrote none (`item6-onboard-raw.txt`). The first wake was Junto's "Your connections changed" notice from my wire. commit-b's mail followed into the same fresh session. |
| 7 | Cost | Measured | t10-blocked | The fresh session's first call wrote 19,356 cache tokens (read 25,963), and the whole wake turn wrote 24,821. The cut session's last context was 358,961 tokens, so a cold resume would rewrite about 333k (inferred, not run). That agrees with the baseline's worst case of 279,124 written and 24,701 read after 9 h (`baseline-2026-10-18.md`). |
| 8 | Commits are attributed | PASS | t10-commit-a, t10-commit-b | `seat_commits.txt`: repo-a `6ec1017` is commit-a's (session 13a6563c), and repo-b `cb444a1` is commit-b's (session 2fcc9016). No commit is credited to the other seat. The repo-a hook refused the `BLOCKME` commit, and `bad.txt` stayed staged. |

### Item 5 in detail

- **a7d490f53, FAIL.**
  - t10-reader was Blocked from 18:54:52 and was not cut through 18:59:50, 4 min past its window (`shots/17`).
  - Answering the signal at 19:00:29.880 ended session bc10a311 at 19:00:29.885 (`ended.json` by automatic). The answer was then typed into fresh session 6a301a96, which replied "I haven't read any files this session".
  - Cause: the mail-time cut (`cutIfCold` and `coldness` in `operator-offboard.ts`) did not check `waitsOnOperator`.
  - Sent to pty-lead via product-lead, and fixed in 815dde913.
- **7195b33ee, PASS.**
  - t10-reader was Blocked at 19:25:52 and idle from 19:26:01. It was past its window from 19:28:16 through 19:29:46 with the same epoch and nextTurn fresh false throughout. The card shows "blocked" and no "fresh next" (`shots/23`).
  - The answer at 19:30:16 reached session 6a301a96, the session that asked, with no new session row. The seat replied `src/main/junto/git/state-schema.ts`, the last file it read before the question (`records/6a301a96...jsonl`).

## Mini

**Verdict: item 1 passes, and item 2 fails. Items 3 to 8 are blocked behind two product gaps (A and B below). Production on the mini was never touched.**

### Setup

- The test used a parallel install, never the production core. The preview was built from `fd13f0111`, which has pty-lead's fix so that remote terminals reach the machine record's own Junto home.
- `junto machine add` created a record `mini-t10` with juntoHome `/Users/guilhermecastro/.junto-preview-t10` and installRoot `.../.junto-preview-t10/machine`, then `machine send` installed it. The core was build `038866...` under service `dev.junto.machine.28dbe19ac31ac094` (pid 37837).
- Production stayed untouched throughout. Its services `c0f20e6dcbd48300` (pid 7351) and `000515008554c211` (pid 7382) kept their pids, and `~/.junto/machine/current` stayed on `65a4b79e...`.
- Four seats ran on canvas `t10-mini`. All four claude processes were children of pid 37837, which confirms fd13f0111.
- Receipts are in `~/junto-receipts/t10-20261018/mini/`.

### Per item

| # | Result | Receipt |
|---|---|---|
| 1 | PASS | `mini-item1.json`: before `{60, harness:{}}`, after `{60, harness:{claude:2}}`, read back over the link. The mini preview database shows `{"claude":{"cacheWindowMinutes":2}}` at 20:57:14.439Z, and the production database there is unchanged since 2026-10-17. Restored at 21:11:55, read back `{60, harness:{}}`. |
| 2 | FAIL (B) | m10-blocked had a 252,311-token context and was idle from 21:02:43 (`offboard-clock.json` idleSince). At 21:11 it had still not been cut, past its 2 min window. |
| 2b | Not meaningful | Nothing is cut on the mini (B), so a seat being left alone proves nothing. |
| 3 to 7 | Blocked | They need a cut (B), or a seat that can run `junto` (A). |
| 8 | Partial | The repo's own hook still ran: `pre-commit: BLOCKME refused`, and `bad.txt` stayed staged. Attribution fails (A): `seat_commits` is empty after commit `efbab60`. |

### Blockers

- **(A) A windowless core gives its seats no Junto CLI (cli-lead).**
  - Mini seats have no `JUNTO_CLI` and no `junto` on PATH.
  - `juntoCliPathPrefixes` (`src/main/junto/term/templates/seat-env.ts:27-40`) only tries `<resources>/bin` and `<cwd>/dist`. The core runs `bin/node` from launchd, with no resources path and cwd `/`.
  - Receipts: the post-commit hook printed "junto: this commit is not attributed to the seat: the junto CLI was not found", and `junto blocked` gave "zsh: command not found: junto" (`mini/transcripts/`).
- **(B) The core records a different session id than the one it launches (pty-lead).**
  - For m10-blocked, the process is `claude --session-id 19f242d7...`, but `seat_sessions` and `offboard-clock.json` hold `39f08e2b...`. For m10-reader, the process is `d39ffd4a...` and the records hold `a5f90d78...`.
  - No transcript exists under the recorded ids, so the core cannot size the session, worth stays false, and the cut never fires (`mini/seat_sessions.txt`, `mini/offboard-clock.json`).
  - The desktop's status for these seats also reads wrong: idleMinutes 16, sessionId null, nextTurn fresh true (`mini/mini-monitor.jsonl`).

### Teardown

The parallel install was removed with `machine uninstall-local`: its service definition was removed and the service no longer appears in `launchctl list`. `~/.junto-preview-t10` on the mini was deleted, and the production core is still running under its own labels.

## Mini rerun (a10d273b2)

### Setup

- Main `a10d273b2` holds d7806b265 (cli-lead's CLI fix) and 696cf5424 (pty-lead's session-id fix). Payloads and the preview package were built in one lock hold.
- The mini record is `mini-t10b`, with the same juntoHome and installRoot as before. The parallel core was build `87ad1b7d...`, pid 44648, under the same label.
- Production stayed untouched: `c0f20e6dcbd48300` (7351) and `000515008554c211` (7382) kept their pids, and `current` stayed on `65a4b79e...`.
- Canvas `t10-mini2` held seats n-reader, n-blocked, n-commit-a and n-commit-b.
- The record checks are dropped, as the operator ordered the record reverted.
- Receipts are in `~/junto-receipts/t10-20261018/mini2/`.

### Both fixes, confirmed

- Every mini seat has `JUNTO_CLI=<installRoot>/current/bin/junto`.
- `seat_sessions` holds exactly the `--session-id` each claude was launched with, e.g. n10-blocked `81917e01...` (`mini2-check.txt`).

### Per item

| # | Result | Seat (context tokens) | Receipt |
|---|---|---|---|
| 1 | PASS | machine mini-t10b | Before `{60, harness:{}}`, after `{harness:{claude:2}}`, read back over the link. The mini database shows it at 21:27:21.465Z, and production there is unchanged since 2026-10-17. Restored at 21:59:22 and read back `{60, harness:{}}`. |
| 2 | PASS | n-blocked (259,103) | Idle from 21:29:32, cut at 21:31:58: `81917e01...ended.json` `{"by":"automatic"}` on the mini. The old transcript's last assistant turn was 21:29:31, with none after. |
| 2b | PASS | n-commit-a (small, workMs 19,368) | Idle from 21:28:47, never cut through teardown at 21:59. Its card shows "done, not read yet" and nothing about a fresh session (`shots/41-mini2-after-cut.png`). |
| 3 | PASS | n-blocked (250,791) | On the mini clock, idleSince stayed 1792360440926 (21:54:00.9) across a viewport resize repaint at 21:56:38 (`mini2-item4.txt`). |
| 4 | PASS | n-blocked (250,791) | View open from 21:53:14 (`shots/44`, `45`, `47`). Idle 21:54:00, window over 21:56:01, still no cut at 21:58:34. Released at 21:58:47 and cut at 21:58:58 (`3c286eeb...ended.json` by automatic). The open view hides the card, so "the card shows nothing" is not separately shown. |
| 5 | FAIL | n-reader (253,424) | `junto blocked` succeeded (signal `01M58ENT4YJHG07AZV9JG5Q3A9`, open, 21:28:54). The seat went idle at 21:28:58 and was cut automatically at 21:31:58 (`seat_sessions` f4584fbc ended, offboard). The mini core does not see that the seat waits on the operator. The n-reader card still reads "blocked" after the cut (`shots/43`). |
| 6 | PASS | n-blocked | n-commit-b's mail (`01M58EX1WZZCEBQ431RS0D8RTM`) woke fresh session `1bce8be7...` at 21:32:56. It answered there, and the cut session got no turn. |
| 7 | Measured | n-blocked | The fresh session's first call wrote 17,762 cache tokens (read 30,048), and the whole wake turn wrote 26,061. A cold resume would rewrite most of the cut session's last context of 259,103 (inferred). |
| 8 | PASS | n-commit-a, n-commit-b | `seat_commits` on the mini: repo-a `5d2ee59` is n10-commit-a's (session 8c530483), and repo-b `939b62d` is n10-commit-b's (session ffb67ed3). The repo hook refused BLOCKME, and `bad.txt` stayed staged. |

### Still open

- **Item 5 on the mini (pty-lead).** The machine core cuts a Blocked seat. The exemption in `waitsOnOperator` (`operator-offboard.ts:77`) reads the seat's status snapshot, which this core evidently lacks for a seat whose signal lives with the canvas editor. That last point is inference: I did not trace where the core gets it.
- **Desktop status for remote seats (pty-lead, as product-lead asked).** It still reads wrong after 696cf5424: `seatOffboardStatus` gives sessionId null, sessionTokens null, worth false, and idleMinutes counted from seat start (34 at 21:56), while the mini core's own clock is correct (`mini2-monitor.jsonl` against `offboard-clock.json`). So it has a separate cause from 696cf5424.
- **Setup note, not a product gap.** Deleting a parallel install's folder gives it a new installation id. The installer then correctly refuses the old record ("candidate identity changed"), and the peer pin keeps the old name, so a rerun needs a new record name.
- **Tooling (automation-lead's note).** `scripts/preview.sh:82` always packages `refs/heads/main`, so on a busy main a preview cannot be pinned to the commit its payloads came from.

### Teardown

- Window restored and read back.
- `machine uninstall-local`: the service is gone from `launchctl list`, and `~/.junto-preview-t10` on the mini is deleted.
- Production labels and pids are unchanged, with no seat processes left.
- Preview quit, worktree removed, live app (pid 6981) untouched.

## Findings beyond the items

- **Seat CLI path (cli-lead).** A packaged app hands seats `<process cwd>/dist/junto` ahead of its bundled bin (`src/main/junto/term/templates/seat-env.ts:22-35`). Launched from a repo checkout, it gave seats a stale CLI that lacked `commit-observed`, so the first two commits went unattributed. `preview.sh` and the installed app are not affected.
- **Compaction and the worth guard (pty-lead).** For claude, sessionTokens is the latest context size, so an auto-compacted session drops below the guard: t10-reader went from 341,752 to 139,391 tokens. A long session that compacted is never cut by size alone, only by its work minutes.
