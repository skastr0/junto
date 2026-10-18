# T10 acceptance, the cache-cold loop (2026-10-18)

**Verdict: this machine passes items 1 to 8. Item 5 failed on a7d490f53 and passes on 7195b33ee, which holds pty-lead's fix 815dde913. The mini was not tested: its update is waiting on the operator (signal 01M584MGHP1TT5KEAEA2C8WSFG, still open), so every mini item is unverified.**

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

The live link to the mini was already down before T10: `~/.junto/logs/app.jsonl` 16:49:33Z LinkBuildMismatch, "Update mac-mini before connecting Junto". Its core is a build of 65a4b79e from Oct 16. The live app has 1 seat there (quasar-lead, no session). Updating the mini's core is the operator's decision, so it waits on signal 01M584MGHP1TT5KEAEA2C8WSFG. Items 1 to 8 on the mini are unverified. The mini was not changed.

## Findings beyond the items

- **Seat CLI path (cli-lead).** A packaged app hands seats `<process cwd>/dist/junto` ahead of its bundled bin (`src/main/junto/term/templates/seat-env.ts:22-35`). Launched from a repo checkout, it gave seats a stale CLI that lacked `commit-observed`, so the first two commits went unattributed. `preview.sh` and the installed app are not affected.
- **Compaction and the worth guard (pty-lead).** For claude, sessionTokens is the latest context size, so an auto-compacted session drops below the guard: t10-reader went from 341,752 to 139,391 tokens. A long session that compacted is never cut by size alone, only by its work minutes.
