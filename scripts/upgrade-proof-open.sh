#!/usr/bin/env bash
# Open one throwaway home with the packaged Linux app under Xvfb, wait for the
# database to be open at the expected schema version, then quit with SIGTERM
# (the packaged smoke's own clean-shutdown path) and wait for exit.
#   upgrade-proof-open.sh <home-root> <package-dir> <expected-user-version> <label>
# <home-root> holds home/ (HOME) and user-data/ (--user-data-dir).
#
# The home must already carry populated sqlite_stat1, as an installed one does
# (`node scripts/upgrade-proof-analyze.ts prepare <junto.db>`, app closed). The
# open is refused otherwise: 0.12.0 passed a proof on stat-less homes and
# shipped a SQLITE_AUTH crash on every real one.
set -u
HERE=$(cd "$(dirname "$0")" && pwd -P)
ROOT=$(cd "$1" && pwd -P); PKG=$(cd "$2" && pwd -P); WANT=$3; LABEL=$4
EXE=$PKG/junto
DISP=${DISP:-:97}
DB=$ROOT/home/.junto/state/junto.db
LOG=$ROOT/open-$LABEL
if ! node "$HERE/upgrade-proof-analyze.ts" check "$DB"; then
  echo "refusing to open: $DB has no populated sqlite_stat1" >&2
  exit 3
fi
mkdir -p "$LOG" "$ROOT/cache" "$ROOT/browser" "$ROOT/tmp"

started_xvfb=""
if ! [ -e "/tmp/.X11-unix/X${DISP#:}" ]; then
  Xvfb "$DISP" -screen 0 1920x1200x24 -nolisten tcp >"$LOG/xvfb.log" 2>&1 &
  started_xvfb=$!
  sleep 2
fi
echo "label=$LABEL root=$ROOT exe=$EXE display=$DISP xvfb_started_pid=${started_xvfb:-none}"
echo "user_version_before=$(sqlite3 -readonly "file:$DB?immutable=1" 'PRAGMA user_version' 2>&1)"
date -u +"start_utc=%FT%TZ"

env -i \
  DISPLAY="$DISP" HOME="$ROOT/home" USER="${USER:-user}" LOGNAME="${USER:-user}" \
  PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin SHELL=/bin/bash TMPDIR="$ROOT/tmp" \
  LANG=C.UTF-8 LC_ALL=C.UTF-8 XDG_CACHE_HOME="$ROOT/cache" \
  JUNTO_SECRET_STORE=file JUNTO_BROWSER_DIR="$ROOT/browser" JUNTO_BROWSER_HOME="$ROOT/home" \
  JUNTO_WORK_HOME="$ROOT/home/.junto/work" \
  setsid "$EXE" --no-sandbox --user-data-dir="$ROOT/user-data" --mute-audio \
    --use-angle=swiftshader-webgl --enable-unsafe-swiftshader \
    >"$LOG/stdout.log" 2>"$LOG/stderr.log" </dev/null &
PID=$!
echo "app_pid=$PID"

ok=""
for i in $(seq 1 180); do
  if ! kill -0 "$PID" 2>/dev/null; then echo "app exited early after ${i}s"; break; fi
  v=$(sqlite3 -readonly "$DB" 'PRAGMA user_version' 2>/dev/null || true)
  if [ "$v" = "$WANT" ] && [ -S "$ROOT/home/.junto/work/control.sock" ]; then ok=$i; break; fi
  sleep 1
done
echo "reached user_version=$WANT and work socket after ${ok:-never}s"
sleep 10   # let boot settle: renderer, seat reconcile, maintenance
echo "roles_alive: $(ps -eo pid,args | grep -E -- "$PKG/junto" | grep -v grep | grep -o -E -- '--type=[a-z-]+' | sort | uniq -c | tr '\n' ' ')"
kill -TERM "$PID" 2>/dev/null
for i in $(seq 1 60); do kill -0 "$PID" 2>/dev/null || break; sleep 1; done
if kill -0 "$PID" 2>/dev/null; then echo "STILL RUNNING after 60s SIGTERM"; EXIT=hung; else wait "$PID"; EXIT=$?; fi
echo "app_exit_code=$EXIT"
sleep 2
left=$(ps -eo pid,args | grep -F -- "$PKG/junto" | grep -v grep | wc -l)
echo "leftover_processes=$left"
[ -n "$started_xvfb" ] && kill "$started_xvfb" 2>/dev/null
date -u +"end_utc=%FT%TZ"
ls -la "$ROOT/home/.junto/state" "$ROOT/home/.junto/state/backups" 2>&1 | sed 's/^/  /'
