#!/bin/sh
# Replays the gesture script against each place the canvas can run, under each
# main thread load, and writes one JSON per run.
#   run-matrix.sh <out dir> [extra flags for every run, such as --size=1726x1083]
set -eu
OUT=${1:?out dir}
shift
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
mkdir -p "$OUT"
run() {
  name=$1
  shift
  "$ROOT/node_modules/.bin/electron" "$HERE/main.cjs" --drive=1 --out="$OUT/$name.json" "$@" > "$OUT/$name.log" 2>&1 || echo "$name failed"
  sleep 2
}
# Where the canvas runs, with the page idle and with the page as busy as a fleet makes it.
for load in none fleet storm; do
  run "frame-$load" --mode=frame --load=$load "$@"
  run "worker-$load" --mode=worker --pump=1 --load=$load "$@"
  run "main-$load" --mode=main --load=$load "$@"
done
# What page chrome laid over a separate-process canvas costs.
run frame-overlap-fleet --mode=frame --overlay=1 --load=fleet "$@"
# A worker whose page draws nothing and so starts no main frames.
run worker-nopump-none --mode=worker --load=none "$@"
# Bigger boards and heavier fleets.
run frame-x5 --mode=frame --scale=5 --rate=150 --load=fleet "$@"
run frame-x25 --mode=frame --scale=25 --rate=750 --load=fleet "$@"
run frame-reports-3000 --mode=frame --rate=3000 --load=fleet "$@"
# One run with a Chromium trace, for trace-nav.py.
run frame-fleet-traced --mode=frame --load=fleet --tracefile="$OUT/frame-fleet-trace.json" "$@"
