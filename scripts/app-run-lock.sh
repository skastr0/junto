#!/usr/bin/env bash

# One app run and one build at a time, machine-wide.
#
# Several seats share this machine. Builds and Electron test runs started side
# by side starve each other until launches and app closes time out, so both go
# through one lock. The lock is a directory (mkdir is atomic) holding a
# `holder` file that names who has it. A second caller refuses with a line
# naming the holder, or waits when JUNTO_APP_RUN_LOCK_WAIT is set to a number
# of seconds. A lock whose holder process is gone is taken over.
#
# Waiters are served first come, first served. Each takes a ticket (a file in
# app-run.queue beside the lock, named by arrival time and pid) and only tries
# for the lock while its ticket is the oldest one whose process is still
# alive. Tickets of waiters that died are removed, so they block nobody.
#
# Source this file, then call junto_app_run_lock_acquire "<what is running>".
# The lock is released when the calling shell exits. A caller that already
# holds it (a build wrapper that then runs the e2e script) passes through.

junto_app_run_lock_dir() {
  printf '%s/app-run.lock' "${JUNTO_APP_RUN_LOCK_HOME:-${HOME}/.junto/locks}"
}

junto_app_run_lock_holder() {
  local lock_dir
  lock_dir="$(junto_app_run_lock_dir)"
  if [[ -r "$lock_dir/holder" ]]; then
    tr '\n' ' ' <"$lock_dir/holder"
  else
    printf 'an unnamed holder'
  fi
}

junto_app_run_lock_queue_dir() {
  printf '%s/app-run.queue' "${JUNTO_APP_RUN_LOCK_HOME:-${HOME}/.junto/locks}"
}

# Arrival time to the microsecond, fixed width so tickets sort by name.
junto_app_run_lock_stamp() {
  perl -MTime::HiRes=time -e 'printf("%017.6f\n", time)' 2>/dev/null || printf '%010d.000000\n' "$(date +%s)"
}

# How many live tickets are older than `$1`; tickets of dead waiters are removed.
junto_app_run_lock_ahead() {
  local mine="$1" queue_dir ticket name pid ahead=0
  queue_dir="$(junto_app_run_lock_queue_dir)"
  for ticket in "$queue_dir"/*; do
    [[ -e "$ticket" ]] || continue
    name="$(basename "$ticket")"
    pid="${name##*-}"
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$ticket"
      continue
    fi
    if [[ "$name" < "$mine" ]]; then
      ahead=$(( ahead + 1 ))
    fi
  done
  printf '%s' "$ahead"
}

junto_app_run_lock_release() {
  local lock_dir
  lock_dir="$(junto_app_run_lock_dir)"
  if [[ -n "${JUNTO_APP_RUN_LOCK_TICKET:-}" ]]; then
    rm -f "$JUNTO_APP_RUN_LOCK_TICKET"
  fi
  # Only the shell that took the lock gives it back.
  if [[ -r "$lock_dir/pid" && "$(cat "$lock_dir/pid" 2>/dev/null)" == "$$" ]]; then
    rm -rf "$lock_dir"
  fi
}

# One try for the lock. A lock whose holder is gone is taken over.
junto_app_run_lock_try() {
  local lock_dir holder_pid
  lock_dir="$(junto_app_run_lock_dir)"
  if mkdir "$lock_dir" 2>/dev/null; then
    return 0
  fi
  holder_pid="$(cat "$lock_dir/pid" 2>/dev/null || true)"
  if [[ -n "$holder_pid" ]] && ! kill -0 "$holder_pid" 2>/dev/null; then
    printf 'junto: taking over the app-run lock; its holder (pid %s) is gone\n' "$holder_pid" >&2
    rm -rf "$lock_dir"
    mkdir "$lock_dir" 2>/dev/null
    return $?
  fi
  return 1
}

junto_app_run_lock_acquire() {
  local what="${1:-an app run}"
  if [[ "${JUNTO_APP_RUN_LOCK_HELD:-}" == "1" ]]; then
    return 0
  fi

  local lock_dir queue_dir wait_limit="${JUNTO_APP_RUN_LOCK_WAIT:-0}"
  lock_dir="$(junto_app_run_lock_dir)"
  queue_dir="$(junto_app_run_lock_queue_dir)"
  mkdir -p "$(dirname "$lock_dir")"

  trap junto_app_run_lock_release EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  if (( wait_limit <= 0 )); then
    if ! junto_app_run_lock_try; then
      printf 'junto: error: another build or app run holds the machine: %s\n' "$(junto_app_run_lock_holder)" >&2
      printf 'junto: one at a time. Wait for it, or set JUNTO_APP_RUN_LOCK_WAIT=<seconds> to queue behind it.\n' >&2
      return 75
    fi
  else
    # Take a ticket, then wait until it is the oldest live one and the lock is free.
    local started=$SECONDS ahead shown=""
    mkdir -p "$queue_dir"
    JUNTO_APP_RUN_LOCK_TICKET="$queue_dir/$(junto_app_run_lock_stamp)-$$"
    : >"$JUNTO_APP_RUN_LOCK_TICKET"
    while true; do
      ahead="$(junto_app_run_lock_ahead "$(basename "$JUNTO_APP_RUN_LOCK_TICKET")")"
      if (( ahead == 0 )) && junto_app_run_lock_try; then
        break
      fi
      if (( SECONDS - started >= wait_limit )); then
        printf 'junto: error: gave up after %ss waiting for the app-run lock, held by: %s\n' "$wait_limit" "$(junto_app_run_lock_holder)" >&2
        rm -f "$JUNTO_APP_RUN_LOCK_TICKET"
        JUNTO_APP_RUN_LOCK_TICKET=""
        return 75
      fi
      if [[ "$ahead" != "$shown" ]]; then
        printf 'junto: waiting for the app-run lock, %s ahead of this run, held by: %s\n' "$ahead" "$(junto_app_run_lock_holder)" >&2
        shown="$ahead"
      fi
      sleep 2
    done
    rm -f "$JUNTO_APP_RUN_LOCK_TICKET"
    JUNTO_APP_RUN_LOCK_TICKET=""
  fi

  printf '%s\n' "$$" >"$lock_dir/pid"
  {
    printf 'what: %s\n' "$what"
    printf 'seat: %s\n' "${JUNTO_NODE_REF:-${USER:-unknown}}"
    printf 'pid: %s\n' "$$"
    printf 'dir: %s\n' "$PWD"
    printf 'since: %s\n' "$(date '+%H:%M:%S')"
  } >"$lock_dir/holder"

  export JUNTO_APP_RUN_LOCK_HELD=1
}
