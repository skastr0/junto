#!/usr/bin/env bash
set -euo pipefail

# Run one command under the machine-wide app-run lock, for example a build:
#   scripts/with-app-run-lock.sh node_modules/.bin/electron-vite build
# See scripts/app-run-lock.sh.

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=scripts/app-run-lock.sh
source "$script_dir/app-run-lock.sh"

if [[ $# -eq 0 ]]; then
  printf 'junto: usage: scripts/with-app-run-lock.sh <command> [args...]\n' >&2
  exit 64
fi

junto_app_run_lock_acquire "$*"
"$@"
