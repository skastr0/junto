#!/usr/bin/env bash
set -euo pipefail

# The release gate's zoom ladder (e2e/scenarios/gpu-zoom-ladder.spec.ts): every
# raster bucket, in and out, at three places on the factory board, each stop's
# screenshot against a fresh-launch reference, the atlas audit, the texel
# readback and the GPU error count. Run before every release:
#   bun run release:zoom-ladder
# The board is the seeded factory-like board, or a real board's shapes file
# (JUNTO_FACTORY_JSON: made-up ids and names, rects, kinds, region colours and
# wire verbs only). Never a copy of a database. GPU runs go to the Mac mini:
#   scripts/mini.sh run <folder> 'scripts/zoom-ladder-gate.sh'
# Output: JUNTO_ZOOM_LADDER_OUT (default /tmp/junto-zoom-ladder): proof.json,
# every stop, the references, the diffs and index.html (the contact sheet).

out="${JUNTO_ZOOM_LADDER_OUT:-/tmp/junto-zoom-ladder}"

rm -rf "$out"
JUNTO_FEATURE_PROFILE=all-on bun run build:bundles
JUNTO_GPU_PROOF=1 JUNTO_ZOOM_LADDER_OUT="$out" \
  scripts/run-e2e.sh e2e/scenarios/gpu-zoom-ladder.spec.ts "$@"
