#!/usr/bin/env bash
# Seed isolated dev state from production when schema versions match.
#
# Copies product durability only:
#   - ~/.vellum/state/vellum.db  →  $VELLUM_HOME/.vellum/state/vellum.db
#   - ~/.vellum/content/         →  $VELLUM_HOME/.vellum/content/
#
# Never copies install-ops.db (backfill ledgers). That file is install-local:
# a fresh install-ops on dev re-runs pending walks against the seeded product
# DB, or no-ops when projections already use ContentRefs.
#
# Only when prod's user_version equals this build's CURRENT_STATE_SCHEMA_VERSION.
# Otherwise leaves the isolated tree alone so schema work can migrate freely.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROD_HOME="${HOME}/.vellum"
PROD_DB="${PROD_HOME}/state/vellum.db"
PROD_CONTENT="${PROD_HOME}/content"
VELLUM_HOME="${VELLUM_HOME:-${HOME}/.vellum-dev}"
DEV_DB="${VELLUM_HOME}/.vellum/state/vellum.db"
DEV_CONTENT="${VELLUM_HOME}/.vellum/content"
DEV_OPS_DB="${VELLUM_HOME}/.vellum/state/install-ops.db"

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
# Never seed install-ops — always start ledger-local to this home.
rm -f "${DEV_OPS_DB}" "${DEV_OPS_DB}-wal" "${DEV_OPS_DB}-shm"

# Best-effort checkpoint when prod is unlocked; ignore lock failures.
sqlite3 "${PROD_DB}" 'PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null 2>&1 || true

cp -p "${PROD_DB}" "${DEV_DB}"
chmod 600 "${DEV_DB}" 2>/dev/null || true

# Content rows without object files claim as "missing". Keep product unit whole.
if [[ -d "${PROD_CONTENT}" ]]; then
  mkdir -p "${DEV_CONTENT}"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete "${PROD_CONTENT}/" "${DEV_CONTENT}/"
  else
    rm -rf "${DEV_CONTENT}"
    mkdir -p "${DEV_CONTENT}"
    cp -a "${PROD_CONTENT}/." "${DEV_CONTENT}/"
  fi
  log "seeded content store from production"
else
  log "no production content store; dev content left empty"
fi

log "seeded isolated product state from production (v${PROD_VERSION}); install-ops not copied"
