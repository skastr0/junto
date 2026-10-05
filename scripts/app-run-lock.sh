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

junto_app_run_lock_release() {
  local lock_dir
  lock_dir="$(junto_app_run_lock_dir)"
  # Only the shell that took the lock gives it back.
  if [[ -r "$lock_dir/pid" && "$(cat "$lock_dir/pid" 2>/dev/null)" == "$$" ]]; then
    rm -rf "$lock_dir"
  fi
}

junto_app_run_lock_acquire() {
  local what="${1:-an app run}"
  if [[ "${JUNTO_APP_RUN_LOCK_HELD:-}" == "1" ]]; then
    return 0
  fi

  local lock_dir waited=0 wait_limit="${JUNTO_APP_RUN_LOCK_WAIT:-0}"
  lock_dir="$(junto_app_run_lock_dir)"
  mkdir -p "$(dirname "$lock_dir")"

  until mkdir "$lock_dir" 2>/dev/null; do
    local holder_pid=""
    holder_pid="$(cat "$lock_dir/pid" 2>/dev/null || true)"
    if [[ -n "$holder_pid" ]] && ! kill -0 "$holder_pid" 2>/dev/null; then
      printf 'junto: taking over the app-run lock; its holder (pid %s) is gone\n' "$holder_pid" >&2
      rm -rf "$lock_dir"
      continue
    fi
    if (( waited >= wait_limit )); then
      printf 'junto: error: another build or app run holds the machine: %s\n' "$(junto_app_run_lock_holder)" >&2
      printf 'junto: one at a time. Wait for it, or set JUNTO_APP_RUN_LOCK_WAIT=<seconds> to queue behind it.\n' >&2
      return 75
    fi
    if (( waited == 0 )); then
      printf 'junto: waiting up to %ss for the app-run lock, held by: %s\n' "$wait_limit" "$(junto_app_run_lock_holder)" >&2
    fi
    sleep 5
    waited=$(( waited + 5 ))
  done

  printf '%s\n' "$$" >"$lock_dir/pid"
  {
    printf 'what: %s\n' "$what"
    printf 'seat: %s\n' "${JUNTO_NODE_REF:-${USER:-unknown}}"
    printf 'pid: %s\n' "$$"
    printf 'dir: %s\n' "$PWD"
    printf 'since: %s\n' "$(date '+%H:%M:%S')"
  } >"$lock_dir/holder"

  export JUNTO_APP_RUN_LOCK_HELD=1
  trap junto_app_run_lock_release EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
}
