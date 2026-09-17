# Seat awareness (Jev) — evaluation harness

Workstream A of the seat-awareness sidecar. New files only, all under
`tests/pty-e2e/jev/`; nothing under `src/` is touched, and the existing
`tests/pty-e2e/runner.ts` is imported read-only and left unchanged.

What this directory is for: turn the committed PTY corpus into a labelled
checkpoint set that a paid Jev run can be scored against, with the labels
derived from the rendered screen alone — never from the seat-state rule engine
and never from a model.

```
tests/pty-e2e/jev/
  types.ts            contract types (no control-path value anywhere)
  chrome.ts           per-harness chrome literals, each with provenance
  evidence.ts         the frozen window: bottom lines, `L000| text`, cap 128
  pack.ts             the frozen question pack, verbatim, + acceptance constants
  labels.ts           screen → label vector (pure)
  replay.ts           trace-complete replay: controlled time, full onEvent log
  checkpoints.ts      the walk + selection + labelling that builds the manifest
  holdout.ts          the held-out split, disjoint from the parent's paid runs
  live-client.ts      dependency-free `POST /v1/systemone` client + acceptance
  report.ts           state derivation, live comparison, markdown report
  manifest-file.ts    reads the committed manifest
  generate.ts         rewrites checkpoints.json
  run-live.ts         the entry point the parent calls with a key
  checkpoints.json    the generated manifest (205 checkpoints, 40 captures)
  *.test.ts           the suites described under "Validation"
  README.md           this file
```

## Reproduce

```bash
bun run typecheck
JUNTO_TEST_FEATURE_PROFILE=all-on bunx vitest run tests/pty-e2e/jev

# regenerate the manifest (about 30s over the whole corpus)
bun tests/pty-e2e/jev/generate.ts
JEV_DRIFT_HARNESSES=claude,grok bun tests/pty-e2e/jev/generate.ts   # scoped, faster

# inspect a split without a key
bun tests/pty-e2e/jev/run-live.ts --split holdout --list
bun tests/pty-e2e/jev/run-live.ts --split holdout --dry-run

# the paid run (the parent holds the key)
TYPESAFE_API_KEY=... bun tests/pty-e2e/jev/run-live.ts --split holdout
```

`--split holdout` is the score that matters; `--split tune` re-scores the
captures the parent already paid on, which is a fit, not a result.

## What each checkpoint proves

A checkpoint is one cut of one capture, selected because the RENDERED screen
carries the harness's own chrome. Selection never consults a rule verdict or a
model. Three classes, all screen-selected:

| class | selected by | what it proves |
| --- | --- | --- |
| `live_turn` | the harness's own mid-turn paint: braille OSC title, elapsed-time line, working footer, spinner status line | `turn_in_progress = yes`; `activity`; the positive side of `highlight_exists` |
| `dialog` | a pending-human frame: permission/trust radio list, login method chooser, credential failure | the four concern Nouls, and `turn_in_progress = no` (the pack's own false criterion names "waiting on a human") |
| `settled_idle` | the harness's own settled-ready chrome, with no live-turn and no dialog match | the NEGATIVE controls: without grounded `no` screens a comparison can only measure false positives |

Per-class counts: `live_turn` 103, `settled_idle` 53, `dialog` 49 (205 total).

The `settled_idle` class is an addition to the brief's "live-turn chrome or
dialog chrome". It exists because a policy that is never shown a `no` screen
cannot be calibrated, and because the concern labels need positive evidence of
absence: they are labelled `no` only when the harness's own settled-ready chrome
is on screen and no concern literal is. It is still a screen-selected class, not
a model- or rule-derived one.

Each checkpoint records: the capture geometry read from that capture's
`manifest.json` (`pty.cols`/`pty.rows`, never a default), the id-tagged window
metadata, every chrome match with its provenance, and a nine-axis label vector
in which every value is either a grounded value or `insufficient_evidence` with
a stated reason.

## Label counts by harness

| harness | checkpoints | classes | turn_in_progress yes/no/abstain | concerns grounded yes |
| --- | --- | --- | --- | --- |
| amp | 17 | live 10, idle 7 | 10 / 7 / 0 | 0 |
| claude | 18 | live 12, dialog 2, idle 4 | 12 / 6 / 0 | 2 (access, answer) |
| codex | 37 | live 31, idle 6 | 31 / 6 / 0 | 0 |
| devin | 20 | live 6, dialog 11, idle 3 | 6 / 14 / 0 | 11 (approval) |
| grok | 24 | live 10, dialog 2, idle 12 | 10 / 14 / 0 | 2 (approval, answer) |
| hermes | 22 | dialog 22 | 0 / 22 / 0 | 22 (access + error) |
| kimi | 8 | dialog 8 | 0 / 8 / 0 | 8 (access + error) |
| muse | 28 | live 20, idle 8 | 20 / 8 / 0 | 0 |
| omp | 25 | live 14, idle 11 | 14 / 11 / 0 | 0 |
| pi | 6 | dialog 4, idle 2 | 0 / 6 / 0 | 4 (access + error) |

Label totals across all 205 checkpoints:

| axis | yes | no | other |
| --- | --- | --- | --- |
| `turn_in_progress` | 103 | 96 | 6 `insufficient_evidence` |
| `activity` | — | — | 199 `indeterminate`, 6 `insufficient_evidence` |
| `approval_requested` | 13 | 53 | 139 `insufficient_evidence` |
| `answer_requested` | 4 | 53 | 148 `insufficient_evidence` |
| `access_problem` | 36 | 53 | 116 `insufficient_evidence` |
| `execution_error` | 30 | 53 | 122 `insufficient_evidence` |
| `repetition` | 14 | 142 | 49 `insufficient_evidence` |
| `highlight_exists` | 152 | 13 | 40 `insufficient_evidence` |
| `highlight_line` | 79 ids, 13 `NONE` | — | 57 `insufficient_evidence` |

## Coverage gaps the corpus does NOT cover

`checkpoints.json` carries them under `coverage.gaps` with the manifest's own
declared reason; the 21 entries include:

- **`claude/permission-returns-idle` — declared skip, "a real permission dialog
  was not observed".** Claude has no permission-return capture at all, so
  `approval_requested` cannot be grounded for the harness whose permission flow
  matters most. Same gap for `codex/permission-returns-idle` ("composer never
  ready"), `devin/…`, `hermes/…`, `kimi/…`, `omp/…`, `pi/…`.
- **`pi/working-turn` and `kimi/working-turn` — declared skip.** Neither
  harness has ANY rendered working chrome in the corpus, so `pi` and `kimi`
  contribute zero `live_turn` checkpoints and `turn_in_progress = yes` is
  ungrounded for both.
- **`hermes/working-turn` — declared skip** ("timebox or composer never
  ready"), and `hermes` never reaches a settled-ready screen: all 22 of its
  checkpoints are `dialog` because the credential failure is always on screen.
- **`*/osc9-empty-composer` — declared skip everywhere.** No capture shows a
  real OSC 9;4;3 with an empty composer.
- **`pi/paste-chip` and `kimi/paste-chip` — declared skip**, so the paste/draft
  boundary is ungrounded for those two.
- **`activity` is ungrounded corpus-wide.** 199 of 205 checkpoints label
  `indeterminate`; no committed capture paints a tool-call or activity-class
  status line. See the finding below.
- Nine declared chrome probes never matched any cut and are listed in
  `coverage.unobservedProbes`: `amp.access_failure`, `amp.approval_wait`,
  `claude.permission_prompt`, `codex.trust_or_approval`, `devin.permission_prompt`,
  `omp.approval_dialog`, `pi.trust_selector`, `pi.turn_footer`, `pi.working_literal`.
  These are rule-pack literals that the committed captures do not paint; they
  are recorded rather than quietly dropped, and `checkpoints.test.ts` fails if a
  probe is neither observed nor listed.

### Corrections to claims I was handed

- The brief says the corpus is "38 captures, 10 harnesses". It is **40
  captures** (10 harnesses) as committed; `checkpoints.json` records the real
  count and `checkpoints.test.ts` asserts it against the files on disk.
- The codex rule pack says the real codex directory-trust modal was "captured
  verbatim (P1 startup-idle fixture)". The committed `codex/startup-idle`
  capture contains the strings `trust`, `Trust` and `hooks` **zero** times; at
  every sampled cut its screen is the settled composer (`› Implement {feature}`,
  `gpt-5.4-mini low · <CWD>`). `codex.trust_or_approval` is therefore recorded
  as unobserved.
- The brief describes the evidence window as "capped at 128 candidate lines".
  Every committed capture renders 32 rows, so the cap never binds: the offered
  window is `L000`…`L031`. The cap is implemented and asserted, but it is not
  exercised by this corpus.

## Measured findings

1. **The 7-way `activity` Choice has no ground truth in this corpus.** 199 of
   205 checkpoints label `indeterminate` from the harness's own live-status
   lines, and only 6 abstain. A full-corpus scan for activity markers
   (`Running`, `Executing`, `Editing`, `Reading`, `Searching`, `tests passed`,
   tool-call syntax) finds none in any rendered live chrome — the single
   `tool` hit in devin is the words "this tool" in a tips box. The parent's
   3/10 agreement on `activity` is therefore not a model failure to explain; the
   question is unanswerable from this evidence, and `indeterminate` is the
   correct answer. Recommendation: drop `activity` from the pack or capture
   evidence that paints tool calls.

2. **The `repetition` question is groundable, and the ground truth is mostly
   `no`.** 142 checkpoints label `no` (the two observations differ after
   stripping volatile chrome), 49 label `insufficient_evidence` (fewer than two
   observations, or identical screens), and 14 label `yes` — all of them on
   hermes/kimi/pi screens where the same credential-failure literal appears in
   both observations. The parent's observed false "repetition yes" on two seats
   is exactly what the pack's own third option covers; a model that answers
   `yes` on a single-observation checkpoint is now falsifiable.

3. **The real grok permission dialog is reachable, and the fine grid is what
   finds it.** `grok/permission-returns-idle` draws its radio dialog for ~0.8%
   of the capture (decoded fractions 0.965 to 0.973). A 20-step grid — the one
   the parent's proof-of-concept used — samples 0.95 and 1.00 and misses it
   entirely. The 400-step fraction grid (plus every PTY write) catches it at
   cuts 99925 and 101479, where the rendered line is
   `┃  1 (●) Yes, and don't ask again for anything (always-approve mode)`.
   Those two checkpoints are the corpus's only `approval_requested = yes` for a
   harness other than devin, and the deterministic trace independently reaches
   `attention / rule:option_dialog_attention` on the same frames — so the label
   and the rule engine agree here, which is the cleanest available calibration
   point for `approval_requested`.

4. **The mid-turn watchdog cannot be exercised by replaying timestamps — for
   two independent reasons.** `replay.ts` enables the watchdog (the runner
   disables it) and drives `now()` from the capture's recorded timestamps, and
   a capture spanning 84s of replayed time with a 5s threshold still publishes
   no `turn-stalled`. Reason one:
   `TurnProgressWatch.arm`/`noteProgress` stamp `lastProgressAt = now()` and
   then compute `remaining = stallMs - (now() - lastProgressAt)`, so `remaining`
   is always exactly `stallMs` and only real elapsed time can fire the timer.
   Reason two: `progressFingerprint` includes the snapshot `seq`, which advances
   on every PTY write, so any output — including a static spinner repaint —
   resets the deadline. Deterministic stall coverage needs a fake-timer harness
   or a clock-injectable deadline; the harness deliberately does not invent one.
   Both reasons are asserted in `replay.test.ts`.

5. **`currentEvents()` is not the event history.** `runner.ts` returns
   `currentEvents()`, one row per live binding. Replaying with a full `onEvent`
   log shows the projection can carry a reason that no published event ever
   carried: `maybePublish` refreshes `slot.reason` without emitting when only
   the reason changed ("Keep reason fresh without event spam"). On
   `claude/working-turn` the projection ends at `rule:empty_prompt_idle` while
   the last published event is `rule:osc_title_idle`. A final-state assertion
   and a trace assertion are therefore not interchangeable.

6. **The deterministic trace is a function of the bytes alone.** Every capture's
   trace digest is recorded before and after a paid run and must be identical;
   `authority.changed` must be empty. With a fake model returning maximal
   confidence on every question, the digests do not move.

## Held-out split

The parent's paid runs are the tune set: `amp/working-turn`,
`claude/working-turn`, `codex/startup-idle`, `codex/working-turn`,
`devin/working-turn`, `grok/working-turn`, `hermes/startup-idle`,
`kimi/startup-idle`, `muse/working-turn`, `omp/working-turn`. Everything else in
the corpus is reserved (`holdout.ts`), and two tiers are named:

- **Tier 1, whole harness `pi`** — the parent's only pi entry
  (`pi/working-turn`) is a declared skip with no bytes, so no real pi capture was
  ever sent. A score on pi is a generalisation score, not a fit.
- **Tier 2, whole captures** — `grok/permission-returns-idle` (the real
  permission dialog), `devin/startup-trust`, `devin/mail-notice`,
  `claude/mail-notice`, `kimi/type-echo`, `hermes/type-echo`,
  `codex/mail-notice`, `muse/startup-idle`. These carry the dialog and
  credential labels the tune set cannot test.

`assertHoldoutDisjoint()` runs in `checkpoints.test.ts`, so a future edit that
adds a holdout capture to the paid list fails red.

## Validation

```bash
bun run typecheck
JUNTO_TEST_FEATURE_PROFILE=all-on bunx vitest run tests/pty-e2e/jev
```

- `checkpoints.test.ts` — manifest structure, screen-only selection, geometry
  from the capture manifest, window shape and cap, cut ordering, label
  well-formedness (every value grounded or an explicit abstention with a
  reason), probe observation bookkeeping, coverage gaps (including claude's
  missing permission return), the held-out split, and a **byte-for-byte
  regeneration** of the committed manifest from the corpus (~30s; scope with
  `JEV_DRIFT_HARNESSES`).
- `replay.test.ts` — controlled time (every `at` is a recorded capture
  timestamp; the clock reaches the capture's elapsed span), the full event
  history vs the projection, the watchdog findings, geometry enforcement,
  grid construction, and determinism across two replays.
- `authority.test.ts` — no awareness file imports the control path; the label
  path cannot reach the runtime module; labels are pure; and a paid run leaves
  every trace digest unchanged.
- `live-client.test.ts` — the frozen pack's shape (nine ids, seven activity
  options, three repetition options, `highlight_line` over the window ids plus
  `NONE`), the HTTP request/response contract, retry on 429/529 and no retry on
  401, and the acceptance policy including the argument that a named choice
  disagreeing with its own distribution is not an answer.

## Next experiment

Widen the activity evidence and re-measure the Choice. Add a capture whose
harness paints tool calls as live status lines (codex's `• Working (… esc to
interrupt)` line and omp's `󱊷 Working…` line are the closest existing
candidates), then re-run `run-live.ts --split holdout-tier2 --class live_turn`
and read the `activity` row of the agreement table. Prediction, from finding 1:
`activity` stays at or below chance on this corpus no matter what the
confidence threshold is, so the Choice should be replaced by a narrower
`is_tool_running` Noul until a capture paints distinguishable activities.
