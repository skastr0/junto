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
  rescore.ts          zero-cost re-scoring of a stored paid report
  generate.ts         rewrites checkpoints.json
  run-live.ts         the entry point the parent calls with a key
  checkpoints.json    the generated manifest (205 checkpoints, 40 captures)
  holdout-rescore.md  the held-out re-score, from the stored answers, no new calls
  holdout-rescore.json  the same, as data
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

# re-score a stored paid report at zero cost, with the bar sweep and the
# control-plane cross-check (needs no key and makes no calls)
bun tests/pty-e2e/jev/rescore.ts \
  --report .amp/in/artifacts/jev-pty-poc/compare-holdout-<stamp>.json \
  --sweep --cross-check --out tests/pty-e2e/jev/holdout-rescore.json
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
| devin | 20 | live 6, dialog 11, idle 3 | 6 / 12 / 2 | 11 (approval) |
| grok | 24 | live 10, dialog 2, idle 12 | 10 / 14 / 0 | 2 (approval, answer) |
| hermes | 22 | dialog 22 | 0 / 18 / 4 | 22 (access + error) |
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
| `highlight_line` | 98 concrete ids, 13 `NONE` | — | 94 `insufficient_evidence` |

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
   `tool` hit in devin is the words "this tool" in a tips box. The held-out
   re-score makes the consequence exact: on 42 rows the model published
   `activity` 37 times, of which **34 are `indeterminate` and only 3 are
   anything else**. The 34 agreements are agreement on having nothing to say,
   so they are counted as `vacuous`, never as correct; the 3 non-`indeterminate`
   answers are ungrounded, because no rendered chrome supports any other
   option. The earlier 3/10 figure is therefore NOT reported here as a model
   failure: the question is unanswerable from this evidence, and the pack should
   drop it or the corpus should capture chrome that paints tool calls.

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
   resets the deadline. Both reasons are asserted in `replay.test.ts`.
   **Recorded as a requirement, so this is not rediscovered:
   deterministic stall coverage needs a clock-injectable deadline** — either the
   watchdog's `remaining` computed against an injected clock plus a fake-timer
   drain, or `TurnProgressWatch` taking a deadline source instead of
   `setTimeout`. The harness deliberately does not invent a stall the product
   would not produce, so `stalls` is empty on every replay and a `turn-stalled`
   attention event is currently unreachable in this harness.

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

7. **A derived negative bar silently narrows the publish band.** The two-sided
   Noul contract publishes `no` at `<= 0.1`, and `1 - 0.9` is
   `0.09999999999999998` in IEEE-754. With the bar derived that way, a Noul of
   exactly `0.1` abstains. The held-out run contains two such answers
   (`grok/permission-returns-idle#4400` and `kimi/type-echo#3417`), both correct
   negatives that would have been dropped: `turn_in_progress` would have
   published 8 instead of 10, and 7 correct negatives instead of 9, cutting its
   coverage from 23.8% to 19.0%. `NOUL_REJECT_MAX` is now a literal `0.1`, and
   `rescore.test.ts` asserts the edge.

8. **A re-score must join the stored answers to the CURRENT manifest.** The paid
   report freezes the labels as they were when it ran, so scoring against them
   means a label correction can never take effect and the report keeps comparing
   against ground truth that has moved. `rescore.ts` prefers the manifest and
   falls back to the frozen label only for checkpoints the manifest no longer
   lists, reporting how many fell back (2 of 42 in this run).

9. **Three chrome literals were too strict for a mid-paint frame.** A rendered
   line is caught mid-write at some cuts, so a literal that includes the end of
   the line misses. `kimi.llm_not_set` required the trailing `to login`, so at
   cut 6775 the screen showed `Error: LLM not set, send "/login"` and the probe
   missed it; the model answered `L017` (that line) while the label claimed
   `L008` was the only signal line, and five "model errors" on `highlight_line`
   were really one label defect. The literal now stops at the stable prefix, as
   do `devin.workspace_trust` and `devin.trust_folder`, which dropped a trailing
   `?` that a partial paint can omit. After the fix those rows reclassify from
   `wrong` to `unfalsifiable` and `highlight_line` accuracy goes from 72.2% to
   100% on 11 falsifiable answers.

10. **`highlight_line` can only be grounded when the screen facts single out one
   line.** The answer space is the window's own ids plus `NONE`, so when two
   distinct lines carry current signal the "most informative line" is a
   judgement. `labels.ts` now abstains in that case instead of nominating the
   first match. That is what moved 94 of the 205 `highlight_line` labels to
   `insufficient_evidence` and removed the last spurious `highlight_line`
   errors.

## Held-out re-score (zero cost, from the stored answers)

The parent's paid holdout run (42 calls, 0 errors, 158,545 input and 23,964
output tokens, $0.006659, p50 136ms, service model `jev-1.13.0`) is stored as
`.amp/in/artifacts/jev-pty-poc/compare-holdout-2026-09-17T06-29-03-623Z.json`
(sha256 `b35d4b9532a212b121e8a4d6926328eef855829329ac5e1634082ad55f20d726`, untracked).
`holdout-rescore.md` is the re-score of those answers under the two-sided
policy; every number below costs nothing to re-derive. Coverage is
published / 42 rows.

| question | published | coverage | correct | wrong | accuracy | unfalsifiable | vacuous |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `turn_in_progress` | 10 | 23.8% | 9 | 0 | 100% | 1 | 0 |
| `approval_requested` | 33 | 78.6% | 14 | 0 | 100% | 19 | 0 |
| `answer_requested` | 22 | 52.4% | 7 | 0 | 100% | 15 | 0 |
| `access_problem` | 35 | 83.3% | 21 | 0 | 100% | 14 | 0 |
| `execution_error` | 30 | 71.4% | 17 | 0 | 100% | 13 | 0 |
| `highlight_exists` | 15 | 35.7% | 15 | 0 | 100% | 0 | 0 |
| `repetition` | 13 | 31.0% | 8 | 1 | 88.9% | 4 | 0 |
| `highlight_line` | 16 | 38.1% | 11 | 0 | 100% | 5 | 0 |
| `activity` | 37 | 88.1% | 0 | 3 | 0% | 0 | 34 |

Read it as: on the five Nouls that matter (`turn_in_progress` and the four
concerns) the pack publishes on 10 to 35 rows and is wrong on none of the
falsifiable ones. The falsifiable evidence is smaller than the raw agreement
counts suggest — 19 of `approval_requested`'s 33 published answers land on
checkpoints the corpus cannot ground, so they are `unfalsifiable`, not correct.
`activity`'s 34 "agreements" are `vacuous` (see finding 1). The only falsifiable
errors in the whole run are 1 `repetition` and 3 `activity`.

**Bar sweep, same data, zero calls.** Widening the negative bar buys coverage
with no errors: `turn_in_progress` publishes 10 rows at 0.1, 29 at 0.2, 32 at
0.3 and 34 at 0.5, with 0 wrong at every point. That is the measurement behind
the two-sided decision, and it also shows 0.1 is conservative rather than
calibrated.

**`turn_in_progress` against the control plane.** The contract makes a published
negative a cross-check rather than a displayed state, so the re-score compares
it with the seat state the real `SeatStateRuntime` held at the same cut: 10
published, **9 agreed, 1 disagreed**. The disagreement is
`devin/mail-notice#4594`, where the model published `yes` (noul 0.90) and the
control plane was `idle` with `default_known_agent_idle_fallback` — a screen the
rules never understood, which is precisely the class of seat where an advisory
cross-check is worth having. The 9 agreements include the whole
`attention` family (hermes credential failures, kimi's model-not-configured
panel, devin's trust prompt), so the advisory and the deterministic engine
agree on every not-working screen except one.



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

## Known limitations

Recorded so they are not rediscovered:

- **Deterministic stall coverage needs a clock-injectable deadline.** The
  harness enables the mid-turn watchdog and replays real capture timestamps, and
  still cannot produce a `turn-stalled` attention event, for the two reasons in
  finding 4. Closing this needs `TurnProgressWatch` to take a deadline source
  instead of `setTimeout`, or a fake-timer drain around each `observe`. Until
  then `stalls` is empty on every replay and a stall is unreachable in this
  harness.
- **The 128-line evidence cap never binds.** Every committed capture renders 32
  rows, so the offered window is `L000`…`L031` and the cap is implemented and
  asserted but untested against a taller grid.
- **The re-score depends on an untracked artifact.** The raw answers live in
  `.amp/in/artifacts/jev-pty-poc/` (gitignored). `holdout-rescore.md` and
  `holdout-rescore.json` record the source path and its sha256, so the numbers
  are reviewable, but regenerating them needs that file.
- **`repetition`'s `no` is a proxy.** "The two observations differ after
  stripping digits" is not the same claim as "the attempts differ". One
  falsifiable disagreement (`hermes/type-echo#9729`) is a screen going from a
  startup notice to the credential error, which the model called a repetition
  and the label called `no`. Treat it as a candidate label improvement, not a
  confirmed model error.
- **`activity` has no evidence surface.** Findings 1 and the re-score both say
  the same thing: until a capture paints tool calls as live status lines, the
  Choice cannot be measured.

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
- `rescore.test.ts` — the two-sided boundary including the `1 - 0.9` edge, the
  coverage/error buckets partitioning every published answer, the label join
  preferring the current manifest over the frozen report, the window bound on
  `highlight_line`, the bar sweep, and the control-plane cross-check for
  `turn_in_progress` against the real runtime.

## Next experiment (approved)

Widen the activity evidence and re-measure the Choice, on the held-out split.
Capture a harness that paints distinguishable activity as live status lines
(codex's `• Working (… esc to interrupt)` line and omp's `󱊷 Working…` line are
the closest existing candidates), add the new capture to the corpus, then:

```bash
bun tests/pty-e2e/jev/generate.ts
TYPESAFE_API_KEY=... bun tests/pty-e2e/jev/run-live.ts --split holdout-tier2 --class live_turn
```

and read the `activity` row of the agreement table, this time ignoring `vacuous`
and watching `correct` / `wrong` / `unfalsifiable`. Prediction, from finding 1:
on today's corpus `activity` stays at 0 correct and at or below chance no matter
what the confidence threshold is, so the Choice should be replaced by a narrower
`is_tool_running` Noul until a capture paints distinguishable activities. The
experiment is whether a capture that DOES paint them moves the falsifiable
column; if it does not, the question is beyond the model, not the corpus.
