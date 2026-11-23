#!/usr/bin/env bash
set -euo pipefail

# The release gate's zoom ladder (e2e/scenarios/gpu-zoom-ladder.spec.ts): every
# raster bucket, in and out, at three places on the factory board, each stop's
# screenshot against a fresh-launch reference, the atlas audit, the texel
# readback and the GPU error count. Run before every release:
#   bun run release:zoom-ladder
# The board is a read-only backup of this machine's own junto.db (the live
# database is refused by the fixture loader), or JUNTO_FACTORY_DB if set.
# Output: JUNTO_ZOOM_LADDER_OUT (default /tmp/junto-zoom-ladder): proof.json,
# every stop, the references, the diffs and index.html (the contact sheet).

out="${JUNTO_ZOOM_LADDER_OUT:-/tmp/junto-zoom-ladder}"
db="${JUNTO_FACTORY_DB:-}"
if [[ -z "$db" ]]; then
  db="$(mktemp -u "${TMPDIR:-/tmp}/junto-zoom-ladder-board.XXXXXX").db"
  trap 'rm -f "$db" "$db-shm" "$db-wal"' EXIT
  sqlite3 "file:$HOME/.junto/state/junto.db?mode=ro" ".backup '$db'"
fi

rm -rf "$out"
JUNTO_FEATURE_PROFILE=all-on bun run build:bundles
JUNTO_GPU_PROOF=1 JUNTO_FACTORY_DB="$db" JUNTO_ZOOM_LADDER_OUT="$out" \
  scripts/run-e2e.sh e2e/scenarios/gpu-zoom-ladder.spec.ts "$@"
