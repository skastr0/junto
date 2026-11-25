# The release gate runs the zoom ladder at 1x and 2x

Owner: canvas-automation (wiring). Spec: canvas-verifier
(`e2e/scenarios/gpu-zoom-ladder.spec.ts`, landed at `4fbfdb427`).
Operator row: the GPU canvas plan, item 1. Status: built and wired, 2026-11-25;
the shakedown at `4fbfdb427` is the receipt.

## Where a cut is gated today

A release is cut by hand: `docs/plans/0.11/release-checklist.md` is the runbook,
`scripts/bump-version.ts` is the bump, `bash scripts/build-app.sh --ship` the
build, sign and notarize, and product-releases appends a `## 0.11.N receipt`
section to that same file with the sha256s, the notarization id, the DB proof
and the lanes. There is no release workflow in CI and no cut script; the gate
is the checklist plus the receipt, and a check that is not written into either
is not run. Today no release runs the ladder, so a zoom regression ships unseen.

## The files

| file | runs where | does |
| --- | --- | --- |
| `scripts/release-zoom-ladder.sh` | the cut | drives the mini: `mini.sh at/put/run`, brings the artifacts back, judges |
| `scripts/zoom-ladder-gate.sh` | the Mac mini | both arms under the app-run lock: `mini` at 1x, `mini-2x` at 2x, each in its own dir with its log and status |
| `scripts/release-zoom-ladder.ts` | the cut | the judge: what counts as a pass or a named fault, the receipt and the bullet |
| `tests/release-zoom-ladder.test.ts` | any VM | every fault the judge must refuse, and the one shape it accepts |

`bun run release:zoom-ladder --board <shapes.json>` runs it;
`--record-read <seat>` after a seat has read the sheets; `--check` is the cut's
last gate and fails without a named reader. Artifacts and
`release-zoom-ladder.json` go to `~/junto-receipts/zoom-ladder/<commit>` unless
`--out` names another directory.

## The hook

`bun run release:zoom-ladder`, which the spec's landing pointed at a single-arm
script on the rig, now points at `scripts/release-zoom-ladder.sh`: the cut runs
it at the cut commit and the receipt records what it judged. It is the only release check that needs the Mac mini,
so it owns getting there: `scripts/mini.sh at <seat> <commit>` for a checkout
built there, `scripts/mini.sh put` for the board's shapes file, `scripts/mini.sh
run` for each arm. Locally it refuses rather than pretending: it is not a
command that can pass on the operator's machine.

## Two arms, both required

The mini's screen is 1x and the operator's is 2x, so one arm is not evidence:

| arm | `JUNTO_GPU_PROOF_WINDOW` | window | scale |
| --- | --- | --- | --- |
| 1x | `mini` | 1440x900 | the mini's own 1x |
| 2x | `mini-2x` | 1440x900 | `--force-device-scale-factor=2` |

Each arm runs the spec whole into its own `JUNTO_ZOOM_LADDER_OUT`, and the
wrapper fails on the first of: a non-zero exit from either arm; a `proof.json`
that is missing, truncated, or not readable as a pass; an arm whose logged
`display.devicePixelRatio` is not its own (1 for `mini`, 2 for `mini-2x`); a
run with no evictions (eviction never exercised); or a run whose contact sheet
directory holds no `index.html`.

The devicePixelRatio check is the load-bearing one. `JUNTO_GPU_PROOF_WINDOW`
falls back to the operator display on a value it does not know, so a wrapper
that only passed the variable would report a green 2x arm that never drew at
2x. Reading the scale the run logged, and requiring it, makes the arm real.

## The board

A real board travels as its shapes only: the JSON `JUNTO_FACTORY_JSON` reads
(`{ model, stats }`, made-up ids and names, rects, kinds, region colours and
wire verbs), never a copy of a database, and `scripts/mini.sh put` refuses a
SQLite file body. The wrapper hashes the shapes file (sha256) into the receipt,
so the cut says which board it proved the canvas on. `JUNTO_ZOOM_LADDER_SEED`
stays at the spec's default for the seeded arm of a spec run; the release gate
always names a file.

## The rig

The ladder is a correctness run, not a measurement: it queues on the mini's own
app-run lock through `scripts/run-e2e.sh` and takes no measurement book, but it
holds the rig for about 20 minutes (7 at 1x, 12 at 2x), so the cut books the
rig for 30 and runs nothing else there meanwhile. A failure leaves its
screenshots, references, diffs and `proof.json` under `JUNTO_ZOOM_LADDER_OUT`,
and the wrapper prints those paths, so the red is readable without a rerun.

## The receipt

The wrapper writes `release-zoom-ladder.json` beside the two arms and prints one
bullet for the cut note:

```
- GPU canvas zoom ladder at <commit>: 1x and 2x on board shapes sha256 <sha>
  (mini run <id>). 1x dpr 1 shot 1440x900, 2x dpr 2 shot 2880x1800, every stop
  equal to its fresh-launch reference, audit clean, texels whole, evictions
  <n>. Sheet: <JUNTO_ZOOM_LADDER_OUT>/contact/index.html. Read by <seat>.
```

The checklist line (canvas-verifier's wording, kept) already requires the sheet
to be published and read by a seat; the wrapper's bullet is what the receipt
carries, so the sheet path cannot go missing from a cut.

## What the spec must keep

The wrapper is written against the spec's documented entry, not its internals:
the env it documents, `proof.json`'s single `display` line with
`devicePixelRatio` and the shot size, the `failures` array it writes beside the
proof, the stop lines' `evictions`, and <arm>/index.html`, its screenshots under
`<arm>/contact/`. Those five are the contract; the rest of the proof is
the spec's to change. It still refuses at a commit without the spec, with that
sentence, rather than skipping or passing.
