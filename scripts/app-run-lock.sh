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
# A holder watches its own hold: when its command has held the lock for
# JUNTO_APP_RUN_LOCK_MAX_HOLD seconds (default 1200) it says so in one loud
# line, so a run stuck on a dialog or a window that never comes is seen. It
# does not end the command: this tooling never signals a process by pid. A run
# that truly needs longer sets the variable higher on purpose. A waiter prints
# once a minute how long the current holder has held.

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

# The Mac mini rig keeps a book for measurement runs (~/junto-perf/book). While
# a seat holds it, a run from anywhere else waits for the book, so a
# correctness run never spends a measurement's minutes. The holder's own runs,
# started in its folder (~/junto-perf/seats/<seat>-<commit>), pass. Prints the
# holder and succeeds when this run must wait; a machine with no book never
# waits.
junto_app_run_lock_book_holder() {
  local rig="${JUNTO_RIG_HOME:-${HOME}/junto-perf}" seat until mine
  [[ -r "$rig/lock.d/seat" ]] || return 1
  seat="$(cat "$rig/lock.d/seat" 2>/dev/null || true)"
  until="$(cat "$rig/lock.d/until" 2>/dev/null || true)"
  [[ "$until" =~ ^[0-9]+$ ]] && (( until > $(date +%s) )) || return 1
  mine="${PWD#"$rig/seats/"}"
  if [[ "$mine" != "$PWD" ]]; then
    mine="${mine%%/*}"
    # Folder <seat>-<commit>; a seat books as <seat> or <seat>-<n>.
    [[ "${mine%-*}" == "${seat%-[0-9]*}" ]] && return 1
  fi
  printf '%s until %s' "$seat" "$(date -r "$until" +%H:%M 2>/dev/null || printf '%s' "$until")"
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

  local book=""
  if (( wait_limit <= 0 )); then
    if book="$(junto_app_run_lock_book_holder)"; then
      printf 'junto: error: the rig is booked for a measurement by %s\n' "$book" >&2
      printf 'junto: set JUNTO_APP_RUN_LOCK_WAIT=<seconds> to wait for the book.\n' >&2
      return 75
    fi
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
      if book="$(junto_app_run_lock_book_holder)"; then
        # Waiting on the book, this run holds no ticket, so the holder's own
        # runs are never queued behind it. The same ticket comes back after.
        rm -f "$JUNTO_APP_RUN_LOCK_TICKET"
        if [[ "$shown" != "book" ]]; then
          printf 'junto: waiting for the rig, booked for a measurement by %s\n' "$book" >&2
          shown="book"
        fi
      else
        [[ -e "$JUNTO_APP_RUN_LOCK_TICKET" ]] || : >"$JUNTO_APP_RUN_LOCK_TICKET"
        ahead="$(junto_app_run_lock_ahead "$(basename "$JUNTO_APP_RUN_LOCK_TICKET")")"
        if (( ahead == 0 )) && junto_app_run_lock_try; then
          break
        fi
      fi
      if (( SECONDS - started >= wait_limit )); then
        if [[ -n "$book" ]]; then
          printf 'junto: error: gave up after %ss waiting for the rig, booked for a measurement by %s\n' "$wait_limit" "$book" >&2
        else
          printf 'junto: error: gave up after %ss waiting for the app-run lock, held by: %s\n' "$wait_limit" "$(junto_app_run_lock_holder)" >&2
        fi
        rm -f "$JUNTO_APP_RUN_LOCK_TICKET"
        JUNTO_APP_RUN_LOCK_TICKET=""
        return 75
      fi
      if [[ -n "$book" ]]; then
        sleep 2
        continue
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

# Run the command the lock was taken for and return its status. The shell that
# took the lock says so, once, when the command has held it for
# JUNTO_APP_RUN_LOCK_MAX_HOLD seconds. A shell that passed through runs it as is.
junto_app_run_lock_run() {
  if [[ "${JUNTO_APP_RUN_LOCK_OWNER:-}" != "$$" ]]; then
    "$@"
    return $?
  fi

  local max_hold="${JUNTO_APP_RUN_LOCK_MAX_HOLD:-1200}" lock_dir
  local deadline=$(( JUNTO_APP_RUN_LOCK_SINCE + max_hold ))
  lock_dir="$(junto_app_run_lock_dir)"

  # The watcher ends by itself within a second of the lock being given back.
  (
    while [[ "$(cat "$lock_dir/pid" 2>/dev/null)" == "$$" ]]; do
      if (( SECONDS >= deadline )); then
        printf 'junto: WARNING: this run (%s, pid %s, seat %s) has held the app-run lock for %ss, its limit, and still holds it. It is not ended from here; if it is stuck, end it. A run that truly needs longer sets JUNTO_APP_RUN_LOCK_MAX_HOLD higher.\n' "$JUNTO_APP_RUN_LOCK_WHAT" "$$" "${JUNTO_NODE_REF:-${USER:-unknown}}" "$max_hold" >&2
        break
      fi
      sleep 1
    done
  ) </dev/null >/dev/null &

  "$@"
}
