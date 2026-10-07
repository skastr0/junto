#!/usr/bin/env bash
# One lock hold: build the verifier lab worktree, launch it isolated, run the
# one-mail measurement REPEATS times on fresh canvases, stop the app.
set -uo pipefail
WT="${HOME}/Projects/junto-verify-lab"
OUT="${1:?out dir}"
REPEATS="${REPEATS:-3}"
export JUNTO_PERF_LAB_HOME="${HOME}/.junto-verify-lab"
export JUNTO_PERF_LAB_RENDERER_PORT=9339
export JUNTO_PERF_LAB_MAIN_PORT=9340
export PATH="${WT}/node_modules/.bin:${PATH}"
mkdir -p "${OUT}"
cd "${WT}"
git rev-parse HEAD >"${OUT}/commit.txt"

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  electron-vite build >"${OUT}/build.log" 2>&1 || { echo "build failed"; tail -20 "${OUT}/build.log"; exit 1; }
fi

scripts/perf-lab.sh launch >"${OUT}/app.log" 2>&1 &
APP=$!
trap 'kill ${APP} 2>/dev/null; sleep 2; pkill -f "junto-verify-lab/node_modules/electron" 2>/dev/null; true' EXIT
for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:${JUNTO_PERF_LAB_RENDERER_PORT}/json/list" 2>/dev/null | grep -q '"title": "Junto' && break
  sleep 1
done
sleep 5

for run in $(seq 1 "${REPEATS}"); do
  name="verify-base-$(date +%H%M%S)"
  echo "== run ${run} canvas ${name} load $(sysctl -n vm.loadavg)"
  bun scripts/verify-lab-canvas.ts --canvas "${name}" --cards 46 || exit 1
  bun scripts/perf-lab-work-changes.ts --changes 10 --grow 250,750,2000 --out "${OUT}/run-${run}" >"${OUT}/run-${run}.ndjson" 2>&1
  echo "exit $? rows $(wc -l <"${OUT}/run-${run}.ndjson")"
  bun scripts/verify-lab-canvas.ts --canvas "${name}" --remove
  sleep 3
done
