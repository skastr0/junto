#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd -P)"
playwright="$repo_root/node_modules/.bin/playwright"

if [[ ! -x "$playwright" ]]; then
  printf 'vellum-command: error: Playwright is missing — run .agents/setup\n' >&2
  exit 1
fi

cd "$repo_root"
command=("$playwright" test --config e2e/playwright.config.ts "$@")

if [[ "$(uname -s)" == "Linux" && -z "${DISPLAY:-}" ]]; then
  if ! command -v xvfb-run >/dev/null 2>&1; then
    printf 'vellum-command: error: Xvfb is required for Linux E2E — run .agents/setup\n' >&2
    exit 1
  fi
  # The isolated framebuffer cannot steal an operator's focus, so let Electron
  # paint a normal visible window instead of Chromium's throttled hidden path.
  export VELLUM_COMMAND_E2E_SHOW="${VELLUM_COMMAND_E2E_SHOW:-1}"
  exec xvfb-run -a -s '-screen 0 1920x1200x24 -nolisten tcp' "${command[@]}"
fi

exec "${command[@]}"
