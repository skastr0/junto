#!/usr/bin/env bash
# Dev entry that exercises the real production license gate.
#
# Why this exists:
#   `bun run dev` compiles VELLUM_COMMAND_LICENSE_CHANNEL=development, which
#   grants access via development-bypass — LicenseGate is unreachable.
#   This script pins the production Dodo profile, isolates state under
#   ~/.vellum-command-dev-license, seeds product state from production when
#   schemas match, then strips the local entitlement so you land on the
#   activation screen.
#
# Side-by-side with production and normal dev:
#   - production:  ~/.vellum-command
#   - normal dev:  ~/.vellum-command-dev
#   - license dev: ~/.vellum-command-dev-license
#
# License tools:
#   bun run license:status
#   bun run license:backup
#   bun run license:clear
#   bun run license:restore -- <backup.json>
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ISOLATED_HOME="${HOME}/.vellum-command-dev-license"
export VELLUM_COMMAND_HOME="${ISOLATED_HOME}"
export VELLUM_COMMAND_LICENSE_CHANNEL="production"
# Business/product IDs come from scripts/license-build-profile.ts when channel=production.

mkdir -p "${ISOLATED_HOME}"

printf 'vellum-command dev-license → VELLUM_COMMAND_HOME=%s LICENSE_CHANNEL=production\n' \
  "${ISOLATED_HOME}" >&2

cd "${ROOT}"
# Seed canvases/content from production when schema matches (same as normal dev).
bash scripts/dev-seed-from-prod.sh

# Strip local entitlement so LicenseGate is the first surface.
# Auto-backups live under the installation's license-backups/.
if [[ -f "${ISOLATED_HOME}/.vellum-command/state/vellum-command.db" ]]; then
  bun scripts/license-state.ts clear --home "${ISOLATED_HOME}" --yes
elif [[ -f "${ISOLATED_HOME}/state/vellum-command.db" ]]; then
  bun scripts/license-state.ts clear --home "${ISOLATED_HOME}" --yes
else
  printf 'vellum-command dev-license: no state db yet — cold start will show LicenseGate\n' >&2
fi

export PATH="${ROOT}/node_modules/.bin:${PATH}"
exec electron-vite dev
