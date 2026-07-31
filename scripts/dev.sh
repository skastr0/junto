#!/usr/bin/env bash
# Official Vellum dev entry.
#
# Always runs against an isolated VELLUM_HOME (~/.vellum-dev) so schema work
# never touches production ~/.vellum. When production already matches this
# build's current schema, prod state is copied into the isolated tree so you
# get real data; otherwise the isolated tree is left alone to migrate on its
# own. HOME stays the real user home so child shells/tools behave normally.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ISOLATED_HOME="${HOME}/.vellum-dev"

mkdir -p "${ISOLATED_HOME}"

printf 'vellum dev → VELLUM_HOME=%s (HOME unchanged)\n' "${ISOLATED_HOME}" >&2

export VELLUM_HOME="${ISOLATED_HOME}"
cd "${ROOT}"
bash scripts/dev-seed-from-prod.sh

export PATH="${ROOT}/node_modules/.bin:${PATH}"
exec electron-vite dev
