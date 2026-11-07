#!/usr/bin/env bash
# One scenario of the performance pass, on the installed app, into one folder:
#   ~/.junto/traces/<run-id>/<scenario>/
#     load.txt        load averages before and after
#     top.txt         per-process CPU, idle wakeups and energy for Junto and WindowServer
#     metrics.jsonl   the app's own [metrics] and [perf] rows from the window
#     trace.json      a 30 s Chromium trace of every process, JS sampling included
#     summary.json    frames, main-thread busy time and input latency from the trace
# Main and core span files (canvas-lead's tracer) land in the same folder.
#
# usage: scripts/perf-pass-scenario.sh <run-id> <scenario> [seconds, default 120]
#   e.g. scripts/perf-pass-scenario.sh pass-0.11.9 s1-idle-front
#
# SAFETY: only builds from 40d4f137f on handle SIGUSR2. On 0.11.8 and older the
# signal's default action QUITS the app, so this script refuses to signal unless
# the running app wrote a [metrics] row in the last three minutes, which only a
# build with the handler does.
set -euo pipefail

RUN="${1:?run id}"
SCENARIO="${2:?scenario name}"
SECONDS_TOTAL="${3:-120}"
TRACE_SECONDS=30
HOME_DIR="${JUNTO_HOME:-$HOME/.junto}"
LOG="$HOME_DIR/logs/app.jsonl"
OUT="$HOME_DIR/traces/$RUN/$SCENARIO"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

[[ "$RUN$SCENARIO" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "run id and scenario: letters, digits, . _ - only" >&2; exit 2; }

PID="$(ps -axo pid=,command= | awk '$2 == "/Applications/Junto.app/Contents/MacOS/Junto" && !found { print $1; found = 1 }')"
[[ -n "$PID" ]] || { echo "Junto is not running from /Applications" >&2; exit 1; }

# The handler check: a [metrics] row in the last 3 minutes.
SINCE="$(date -u -v-3M +%Y-%m-%dT%H:%M:%S)"
LAST_METRICS="$(grep -o '"time":"[^"]*","level":"info"[^}]*"area":"metrics"' "$LOG" 2>/dev/null | tail -1 | sed -E 's/^"time":"([^"]*)".*/\1/' || true)"
if [[ -z "$LAST_METRICS" || "$LAST_METRICS" < "$SINCE" ]]; then
  echo "refusing: no [metrics] row since $SINCE, so this build may not handle SIGUSR2 (it would quit)." >&2
  echo "Install a build from 40d4f137f on, run it for 2 minutes, and retry." >&2
  exit 1
fi

mkdir -p -m 700 "$OUT"
START_ISO="$(date -u +%Y-%m-%dT%H:%M:%S)"
{ echo "before $(sysctl -n vm.loadavg)"; } > "$OUT/load.txt"
echo "scenario $SCENARIO: ${SECONDS_TOTAL}s from $START_ISO, main pid $PID, load $(sysctl -n vm.loadavg)"

# Per-process sampling for the whole window, 5 s apart (the first sample has no deltas).
SAMPLES=$(( SECONDS_TOTAL / 5 + 1 ))
top -l "$SAMPLES" -s 5 -stats pid,command,cpu,idlew,power,mem -o cpu -n 40 2>/dev/null \
  | grep -E '^(PID|[0-9]+ +(Junto|WindowServer))' > "$OUT/top.txt" &
TOP=$!

# The trace starts a third of the way in, so it sits inside the sampled window.
sleep $(( SECONDS_TOTAL / 3 ))
BEFORE_TRACES="$(ls "$HOME_DIR/traces" 2>/dev/null | grep -E '^trace-.*\.json$' || true)"
kill -USR2 "$PID"
TRACE=""
for _ in $(seq 1 $(( TRACE_SECONDS + 60 ))); do
  sleep 1
  NEW="$(comm -13 <(printf '%s\n' "$BEFORE_TRACES" | sort) <(ls "$HOME_DIR/traces" | grep -E '^trace-.*\.json$' | sort) | tail -1 || true)"
  if [[ -n "$NEW" ]]; then TRACE="$HOME_DIR/traces/$NEW"; sleep 2; break; fi
done
wait "$TOP" || true
{ echo "after $(sysctl -n vm.loadavg)"; } >> "$OUT/load.txt"

# Rows start {"time":"<ISO>", so a string compare on the line keeps the window.
grep -E '"area":"(metrics|perf|trace)"' "$LOG" | awk -v since="{\"time\":\"$START_ISO" '$0 >= since' > "$OUT/metrics.jsonl" || true

if [[ -n "$TRACE" ]]; then
  mv "$TRACE" "$OUT/trace.json"
  (cd "$ROOT" && bun scripts/perf-trace-summary.ts "$OUT/trace.json" "$TRACE_SECONDS") > "$OUT/summary.json" || echo "summary failed" >&2
else
  echo "no trace appeared within $(( TRACE_SECONDS + 60 ))s; see [trace] rows in metrics.jsonl" >&2
fi

echo "done: $OUT"
ls -la "$OUT"
