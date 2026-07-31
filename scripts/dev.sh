#!/usr/bin/env bash
# Official Vellum Command dev entry.
#
# Side-by-side with production:
# - VELLUM_HOME=~/.vellum-dev isolates state + control sockets from ~/.vellum
# - main pins Electron userData under that home so the single-instance lock
#   does not fight /Applications/Vellum Command.app
# When production already matches this build's current schema, prod state is
# copied into the isolated tree so you get real data; otherwise the isolated
# tree migrates on its own. HOME stays the real user home so child shells and
# tools behave normally.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ISOLATED_HOME="${HOME}/.vellum-dev"

mkdir -p "${ISOLATED_HOME}"

printf 'vellum dev → VELLUM_HOME=%s (HOME unchanged; Electron userData isolated)\n' "${ISOLATED_HOME}" >&2

export VELLUM_HOME="${ISOLATED_HOME}"
cd "${ROOT}"
bash scripts/dev-seed-from-prod.sh

export PATH="${ROOT}/node_modules/.bin:${PATH}"
exec electron-vite dev
