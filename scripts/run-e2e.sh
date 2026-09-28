#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd -P)"
playwright="$repo_root/node_modules/.bin/playwright"

# shellcheck source=scripts/linux-display.sh
source "$script_dir/linux-display.sh"

if [[ ! -x "$playwright" ]]; then
  printf 'junto: error: Playwright is missing — run .agents/setup\n' >&2
  exit 1
fi

cd "$repo_root"

# Spec selection: `--all` runs the full regression suite; explicit spec paths
# run those specs; no arguments defaults to the startup smoke spec so an
# unqualified invocation never sweeps every scenario.
if [[ "${1:-}" == "--all" ]]; then
  shift
elif [[ $# -eq 0 ]]; then
  printf 'junto: no spec paths given — running startup smoke (e2e/scenarios/free-startup.spec.ts). Pass spec paths, or use --all for the full suite.\n' >&2
  set -- e2e/scenarios/free-startup.spec.ts
fi

command=("$playwright" test --config e2e/playwright.config.ts "$@")

if [[ "$(uname -s)" == "Linux" ]] && junto_use_available_desktop; then
  if [[ -n "${AMP_DIRECT_DESKTOP:-}" ]]; then
    printf 'junto: Electron E2E is using the active Amp Desktop\n' >&2
    export JUNTO_E2E_SHOW="${JUNTO_E2E_SHOW:-1}"
  fi
elif [[ "$(uname -s)" == "Linux" ]]; then
  if ! command -v xvfb-run >/dev/null 2>&1; then
    printf 'junto: error: no desktop or Xvfb fallback is available — run .agents/setup\n' >&2
    exit 1
  fi
  printf 'junto: Electron E2E is using the headless Xvfb fallback\n' >&2
  export JUNTO_E2E_SHOW="${JUNTO_E2E_SHOW:-1}"
  exec xvfb-run -a -s '-screen 0 1920x1200x24 -nolisten tcp' "${command[@]}"
fi

exec "${command[@]}"
