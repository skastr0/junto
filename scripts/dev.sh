#!/usr/bin/env bash
# Official Junto dev entry.
#
# Side-by-side with production:
# - VELLUM_COMMAND_HOME=~/.vellum-command-dev isolates state + control sockets from ~/.vellum-command
# - main pins Electron userData under that home so the single-instance lock
#   does not fight /Applications/Junto.app
# When production already matches this build's current schema, prod state is
# copied into the isolated tree so you get real data; otherwise the isolated
# tree migrates on its own. HOME stays the real user home so child shells and
# tools behave normally.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ISOLATED_HOME="${HOME}/.vellum-command-dev"

# shellcheck source=scripts/linux-display.sh
source "$ROOT/scripts/linux-display.sh"

if [[ "$(uname -s)" == "Linux" ]] && ! vellum_use_available_desktop; then
  printf '%s\n' \
    'vellum-command: error: an interactive X11 or Wayland desktop is required' \
    'Open the orb Desktop before running the Junto development app.' >&2
  exit 1
fi

mkdir -p "${ISOLATED_HOME}"

printf 'vellum-command dev → VELLUM_COMMAND_HOME=%s (HOME unchanged; Electron userData isolated)\n' "${ISOLATED_HOME}" >&2

export VELLUM_COMMAND_HOME="${ISOLATED_HOME}"
# Advanced diagnostics (install provenance, logs explorer) — never on ship/prod.
export VELLUM_COMMAND_DEV_TOOLS="${VELLUM_COMMAND_DEV_TOOLS:-1}"
cd "${ROOT}"
bash scripts/dev-seed-from-prod.sh

export PATH="${ROOT}/node_modules/.bin:${PATH}"
exec electron-vite dev "$@"
