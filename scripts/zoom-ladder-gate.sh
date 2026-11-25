#!/usr/bin/env bash
set -euo pipefail

# The rig side of the release zoom ladder: both arms, on the Mac mini, from this
# checkout. The cut runs it through scripts/release-zoom-ladder.sh, which is the
# half that drives the mini and judges the artifacts; this half only runs and
# records, so the decision lives in one tested place
# (scripts/release-zoom-ladder.ts).
#
#   scripts/zoom-ladder-gate.sh <board-shapes.json> <out-dir>
#
# 1x is JUNTO_GPU_PROOF_WINDOW=mini, the mini's own 1x screen; 2x is mini-2x, the
# same 1440x900 window with --force-device-scale-factor=2, the operator's scale.
# Each arm runs the whole spec into <out-dir>/<arm> and keeps its console log,
# the proof, and the contact sheet. <out-dir>/summary.json says what each arm
# did; the exit is non-zero when an arm failed, and the judge reads both arms
# either way, because a red arm is worth more with the other arm beside it.
#
# The board is a real board's shapes only (JUNTO_FACTORY_JSON): made-up ids and
# names, rects, kinds, region colours and wire verbs. Never a database.

board=${1:?board shapes file}
out=${2:?out dir}
spec=e2e/scenarios/gpu-zoom-ladder.spec.ts

[ -f "$spec" ] || {
  echo "zoom-ladder-gate: $spec is not in this commit, so the release gate refuses to run rather than pass without a sheet" >&2
  exit 3
}
[ -f "$board" ] || {
  echo "zoom-ladder-gate: no board shapes file at $board" >&2
  exit 3
}

mkdir -p "$out"
commit=$(git rev-parse HEAD)
board_sha=$(sha256sum "$board" | cut -d' ' -f1)
# Written up front so a run that dies mid-arm still says which commit and board it was on.
printf '{\n  "commit": "%s",\n  "boardSha256": "%s",\n  "arms": [\n' "$commit" "$board_sha" >"$out/summary.json"

first=1
for arm in mini mini-2x; do
  arm_out="$out/$arm"
  rm -rf "$arm_out"
  mkdir -p "$arm_out"
  set +e
  JUNTO_FEATURE_PROFILE=all-on JUNTO_GPU_PROOF=1 JUNTO_GPU_PROOF_WINDOW="$arm" \
    JUNTO_FACTORY_JSON="$board" JUNTO_ZOOM_LADDER_OUT="$arm_out" \
    scripts/run-e2e.sh "$spec" 2>&1 | tee "$arm_out/run.log"
  status=${PIPESTATUS[0]}
  set -e
  printf '%s' "$status" >"$arm_out/status"
  [ "$first" = 1 ] || printf ',\n' >>"$out/summary.json"
  first=0
  printf '    { "name": "%s", "window": "%s", "status": %s }' "$arm" "$arm" "$status" >>"$out/summary.json"
  if [ "$status" -ne 0 ]; then
    echo "zoom-ladder-gate: the $arm arm failed ($status); its screenshots, references, diffs, proof.json and run.log are in $arm_out" >&2
  fi
done
printf '\n  ]\n}\n' >>"$out/summary.json"

echo "zoom-ladder-gate: artifacts in $out (summary.json, mini/, mini-2x/)"
