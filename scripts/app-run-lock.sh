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
# Source this file, call junto_app_run_lock_acquire "<what is running>", then
# run the command with junto_app_run_lock_run <command> [args...]. The lock is
# released when the calling shell exits. A caller that already holds it (a
# build wrapper that then runs the e2e script) passes through.
#
# A holder limits itself: when its command has held the lock for
# JUNTO_APP_RUN_LOCK_MAX_HOLD seconds (default 1200) it says so in one line,
# ends its own command, gives the lock back and exits 124, so a run stuck on a
# dialog or a window that never comes cannot sit on the machine. A run that
# truly needs longer sets the variable higher on purpose. A waiter prints once
# a minute how long the current holder has held.

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

# How long the current holder has held, in words; its start is the epoch second
# in the lock's `since` file.
junto_app_run_lock_held_for() {
  local lock_dir since
  lock_dir="$(junto_app_run_lock_dir)"
  since="$(cat "$lock_dir/since" 2>/dev/null || true)"
  if [[ "$since" =~ ^[0-9]+$ ]]; then
    printf '%ss' "$(( $(date +%s) - since ))"
  else
    printf 'an unknown time'
  fi
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
  if [[ ! "${JUNTO_APP_RUN_LOCK_MAX_HOLD:-1200}" =~ ^[1-9][0-9]*$ ]]; then
    printf 'junto: error: JUNTO_APP_RUN_LOCK_MAX_HOLD must be a whole number of seconds above zero, got: %s\n' "$JUNTO_APP_RUN_LOCK_MAX_HOLD" >&2
    return 64
  fi
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
    local started=$SECONDS ahead shown="" told=$SECONDS
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
      if (( SECONDS - told >= 60 )); then
        printf 'junto: still waiting for the app-run lock after %ss; its holder has held it for %s: %s\n' "$(( SECONDS - started ))" "$(junto_app_run_lock_held_for)" "$(junto_app_run_lock_holder)" >&2
        told=$SECONDS
      fi
      sleep 2
    done
    rm -f "$JUNTO_APP_RUN_LOCK_TICKET"
    JUNTO_APP_RUN_LOCK_TICKET=""
  fi

  printf '%s\n' "$$" >"$lock_dir/pid"
  date +%s >"$lock_dir/since"
  {
    printf 'what: %s\n' "$what"
    printf 'seat: %s\n' "${JUNTO_NODE_REF:-${USER:-unknown}}"
    printf 'pid: %s\n' "$$"
    printf 'dir: %s\n' "$PWD"
    printf 'since: %s\n' "$(date '+%H:%M:%S')"
  } >"$lock_dir/holder"

  export JUNTO_APP_RUN_LOCK_HELD=1
  # Not exported: only the shell that took the lock limits its hold.
  JUNTO_APP_RUN_LOCK_OWNER="$$"
  JUNTO_APP_RUN_LOCK_SINCE=$SECONDS
  JUNTO_APP_RUN_LOCK_WHAT="$what"
}

# End the command this shell runs under the lock: TERM, then KILL after ten
# seconds. Its own child only, never anything else on the machine.
junto_app_run_lock_end_command() {
  local child="${JUNTO_APP_RUN_LOCK_CHILD:-}" deadline=$(( SECONDS + 10 ))
  if [[ -n "${JUNTO_APP_RUN_LOCK_TIMER:-}" ]]; then
    kill "$JUNTO_APP_RUN_LOCK_TIMER" 2>/dev/null || true
    JUNTO_APP_RUN_LOCK_TIMER=""
  fi
  [[ -n "$child" ]] || return 0
  kill -TERM "$child" 2>/dev/null || true
  while kill -0 "$child" 2>/dev/null && (( SECONDS < deadline )); do
    sleep 0.2
  done
  kill -KILL "$child" 2>/dev/null || true
  wait "$child" 2>/dev/null || true
  JUNTO_APP_RUN_LOCK_CHILD=""
}

# Run the command the lock was taken for and return its status. The shell that
# took the lock holds it for at most JUNTO_APP_RUN_LOCK_MAX_HOLD seconds, then
# ends the command and exits 124. A shell that passed through runs it as is.
junto_app_run_lock_run() {
  if [[ "${JUNTO_APP_RUN_LOCK_OWNER:-}" != "$$" ]]; then
    "$@"
    return $?
  fi

  local max_hold="${JUNTO_APP_RUN_LOCK_MAX_HOLD:-1200}" status
  local deadline=$(( JUNTO_APP_RUN_LOCK_SINCE + max_hold ))
  JUNTO_APP_RUN_LOCK_OVERHELD=""

  # In the background so the limit can interrupt the wait; stdin stays the caller's.
  "$@" <&0 &
  JUNTO_APP_RUN_LOCK_CHILD=$!
  trap 'JUNTO_APP_RUN_LOCK_OVERHELD=1' USR1
  trap 'junto_app_run_lock_end_command; exit 130' INT
  trap 'junto_app_run_lock_end_command; exit 143' TERM
  (
    while (( SECONDS < deadline )); do sleep 1; done
    kill -USR1 "$$" 2>/dev/null
  ) </dev/null >/dev/null 2>&1 &
  JUNTO_APP_RUN_LOCK_TIMER=$!

  while true; do
    status=0
    wait "$JUNTO_APP_RUN_LOCK_CHILD" || status=$?
    if [[ -n "$JUNTO_APP_RUN_LOCK_OVERHELD" ]]; then
      printf 'junto: error: this run (%s, pid %s, seat %s) has held the app-run lock for %ss, its limit; ending its command and giving the lock back. A run that truly needs longer sets JUNTO_APP_RUN_LOCK_MAX_HOLD higher.\n' "$JUNTO_APP_RUN_LOCK_WHAT" "$$" "${JUNTO_NODE_REF:-${USER:-unknown}}" "$max_hold" >&2
      junto_app_run_lock_end_command
      exit 124
    fi
    kill -0 "$JUNTO_APP_RUN_LOCK_CHILD" 2>/dev/null || break
  done

  kill "$JUNTO_APP_RUN_LOCK_TIMER" 2>/dev/null || true
  wait "$JUNTO_APP_RUN_LOCK_TIMER" 2>/dev/null || true
  JUNTO_APP_RUN_LOCK_TIMER=""
  JUNTO_APP_RUN_LOCK_CHILD=""
  trap - USR1
  trap 'exit 130' INT
  trap 'exit 143' TERM
  return "$status"
}
