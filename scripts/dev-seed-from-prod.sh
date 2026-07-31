#!/usr/bin/env bash
# Seed isolated dev state from production when schema versions match.
#
# Copies ~/.vellum/state/vellum.db into $VELLUM_HOME/.vellum/state/ only when
# prod's user_version equals this build's CURRENT_STATE_SCHEMA_VERSION.
# Otherwise leaves the isolated tree alone so schema work can migrate freely.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROD_DB="${HOME}/.vellum/state/vellum.db"
VELLUM_HOME="${VELLUM_HOME:-${HOME}/.vellum-dev}"
DEV_DB="${VELLUM_HOME}/.vellum/state/vellum.db"

log() {
  printf 'vellum dev: %s\n' "$*" >&2
}

if [[ ! -f "${PROD_DB}" ]]; then
  log "no production database; keeping isolated state"
  exit 0
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  log "sqlite3 not available; keeping isolated state"
  exit 0
fi

CURRENT="$(
  sed -nE 's/^export const CURRENT_STATE_SCHEMA_VERSION = ([0-9]+);$/\1/p' \
    "${ROOT}/src/main/vellum/state/migrations.ts" | head -1
)"
if [[ -z "${CURRENT}" ]]; then
  log "could not read CURRENT_STATE_SCHEMA_VERSION; keeping isolated state"
  exit 0
fi

PROD_VERSION="$(sqlite3 "${PROD_DB}" 'PRAGMA user_version;')"
if [[ "${PROD_VERSION}" != "${CURRENT}" ]]; then
  log "prod schema v${PROD_VERSION} ≠ current v${CURRENT}; keeping isolated state"
  exit 0
fi

mkdir -p "$(dirname "${DEV_DB}")"
# Drop any prior isolated WAL/SHM so the copy is the whole story.
rm -f "${DEV_DB}" "${DEV_DB}-wal" "${DEV_DB}-shm"

# Best-effort checkpoint when prod is unlocked; ignore lock failures.
sqlite3 "${PROD_DB}" 'PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null 2>&1 || true

cp -p "${PROD_DB}" "${DEV_DB}"
chmod 600 "${DEV_DB}" 2>/dev/null || true
log "seeded isolated state from production (v${PROD_VERSION})"
