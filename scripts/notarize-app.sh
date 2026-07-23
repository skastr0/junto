#!/usr/bin/env bash
# Notarize + staple a packaged Vellum macOS release (repeatable ship step).
#
#   scripts/notarize-app.sh
#   scripts/notarize-app.sh --zip PATH --app PATH
#   scripts/notarize-app.sh --skip-spctl   # skip Gatekeeper assess (CI edge cases)
#
# Prerequisites:
#   - Packaged release: release/mac-*/Vellum.app + release/Vellum-*-mac.zip
#     (from scripts/build-app.sh / bun run app:build)
#   - `asc` authenticated (asc doctor) with Notary API access
#   - Developer ID-signed app (already enforced by packaging)
#
# Flow:
#   1. resolve + verify signed .app and shippable zip
#   2. asc notarization submit --wait
#   3. require status Accepted
#   4. stapler staple the .app; re-zip so the ticket ships inside the archive
#   5. stapler validate + optional spctl assess
#   6. write release/notarization-receipt.json
#
# Never installs to /Applications. Safe to re-run after a failed submit
# (re-submits; Apple is idempotent on content hash when applicable).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Notarization is allowed to replace only the artifacts produced in this
# checkout's release directory.  Do not let an ambient RELEASE_DIR redirect
# the write authority inherited from app-paths.sh.
if [[ -n "${VELLUM_RELEASE_DIR+x}" ]]; then
  printf 'vellum: error: VELLUM_RELEASE_DIR is not configurable for notarization\n' >&2
  exit 1
fi

# These are read-only candidate selectors, not destination capabilities.  Keep
# their values long enough to parse the CLI, then hide them from app-paths.sh
# so its general-purpose APP_SRC selection cannot widen this script's scope.
ENV_ZIP_SOURCE="${VELLUM_ZIP_SRC:-}"
ENV_APP_SOURCE="${VELLUM_APP_SRC:-}"
unset VELLUM_ZIP_SRC VELLUM_APP_SRC
# shellcheck source=app-paths.sh
source "$SCRIPT_DIR/app-paths.sh"

ZIP_SRC="$ENV_ZIP_SOURCE"
APP_PATH="$ENV_APP_SOURCE"
SKIP_SPCTL=0
TIMEOUT="${VELLUM_NOTARY_TIMEOUT:-45m}"
POLL="${VELLUM_NOTARY_POLL:-15s}"
RELEASE_ROOT="$REPO_ROOT/release"
STAGING_DIR=""

usage() {
  sed -n '2,24p' "$0" | sed 's/^# \?//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --zip)
      ZIP_SRC="${2:-}"
      shift 2
      ;;
    --app)
      APP_PATH="${2:-}"
      shift 2
      ;;
    --skip-spctl) SKIP_SPCTL=1; shift ;;
    --timeout)
      TIMEOUT="${2:-}"
      shift 2
      ;;
    -h|--help) usage 0 ;;
    *) err "unknown flag: $1"; usage 1 ;;
  esac
done

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    err "missing required command: $1"
    exit 1
  }
}

require_cmd asc
require_cmd xcrun
require_cmd python3
require_cmd ditto
require_cmd shasum

canonical_existing_nonlink_directory() {
  local description="$1"
  local path="$2"
  local canonical
  [[ "$path" == /* && -d "$path" && ! -L "$path" ]] || {
    err "$description must be an existing absolute non-symlink directory"
    return 1
  }
  canonical="$(cd "$path" && pwd -P)" || return 1
  [[ "$canonical" == "$path" ]] || {
    err "$description must already be canonical: $path -> $canonical"
    return 1
  }
  printf '%s' "$canonical"
}

RELEASE_ROOT="$(canonical_existing_nonlink_directory "release root" "$RELEASE_ROOT")" || exit 1
RELEASE_ROOT_ID="$(path_identity "$RELEASE_ROOT")"
# app-paths.sh is intentionally reusable by installer tooling; notarization is
# stricter and always writes the canonical release root.
RELEASE_DIR="$RELEASE_ROOT"

assert_release_zip_capability() {
  local path="$1"
  local canonical base parent
  [[ -f "$path" && ! -L "$path" ]] || {
    err "zip must be an existing non-symlink file"
    return 1
  }
  parent="$(cd "$(dirname "$path")" && pwd -P)" || return 1
  canonical="$parent/$(basename "$path")"
  [[ "$path" == "$canonical" && "$parent" == "$RELEASE_ROOT" ]] || {
    err "zip must be a canonical direct child of $RELEASE_ROOT"
    return 1
  }
  base="$(basename "$path")"
  [[ "$base" == "${PRODUCT_NAME}-"*-mac.zip ]] || {
    err "zip must be a Vellum macOS release artifact"
    return 1
  }
}

assert_release_app_capability() {
  local path="$1"
  local canonical parent parent_base
  [[ -d "$path" && ! -L "$path" ]] || {
    err "app must be an existing non-symlink bundle"
    return 1
  }
  canonical="$(cd "$path" && pwd -P)" || return 1
  [[ "$canonical" == "$path" ]] || {
    err "app must already be canonical: $path -> $canonical"
    return 1
  }
  parent="$(dirname "$path")"
  parent_base="${parent##*/}"
  [[ "$parent" == "$RELEASE_ROOT"/mac-arm64 || "$parent" == "$RELEASE_ROOT"/mac || "$parent" == "$RELEASE_ROOT"/mac-x64 ]] || {
    err "app must be a direct bundle in a canonical release mac directory"
    return 1
  }
  [[ "$(basename "$path")" == "${PRODUCT_NAME}.app" && "$parent_base" != . ]] || {
    err "app must have the exact product bundle name ${PRODUCT_NAME}.app"
    return 1
  }
  assert_app_bundle "$path"
}

path_id() {
  path_identity "$1"
}

assert_same_identity() {
  local description="$1"
  local path="$2"
  local expected="$3"
  [[ -n "$expected" && ! -L "$path" && "$(path_id "$path" 2>/dev/null)" == "$expected" ]] || {
    err "$description changed identity; refusing replacement"
    return 1
  }
}

output_identity() {
  local path="$1"
  if [[ -e "$path" ]]; then
    [[ -f "$path" && ! -L "$path" ]] || {
      err "release output must be absent or a non-symlink regular file: $path"
      return 1
    }
    path_id "$path"
  else
    printf '%s' "absent"
  fi
}

assert_output_unchanged() {
  local path="$1"
  local expected="$2"
  local actual
  actual="$(output_identity "$path")" || return 1
  [[ "$actual" == "$expected" ]] || {
    err "release output changed identity; refusing replacement: $path"
    return 1
  }
}

cleanup_staging() {
  local staging_id
  [[ -n "$STAGING_DIR" ]] || return 0
  staging_id="${STAGING_ID:-}"
  if [[ -n "$staging_id" && -d "$STAGING_DIR" && ! -L "$STAGING_DIR" && "$(path_id "$STAGING_DIR" 2>/dev/null)" == "$staging_id" ]]; then
    rm -rf -- "$STAGING_DIR"
  else
    err "notarization staging changed identity; retaining $STAGING_DIR"
  fi
}
trap cleanup_staging EXIT

if [[ -z "$APP_PATH" ]]; then
  APP_PATH="$(detect_app_src)"
fi
if [[ -z "$ZIP_SRC" ]]; then
  if ! ZIP_SRC="$(detect_release_zip)"; then
    err "no release zip under $RELEASE_DIR — run: bun run app:build"
    exit 1
  fi
fi

assert_release_app_capability "$APP_PATH" || exit 1
assert_release_zip_capability "$ZIP_SRC" || exit 1
bun "$SCRIPT_DIR/audit-packaged-app.ts" "$APP_PATH"
APP_ID="$(path_id "$APP_PATH")"
ZIP_ID="$(path_id "$ZIP_SRC")"
RECEIPT_PATH="$RELEASE_ROOT/notarization-receipt.json"
SUBMIT_RECEIPT_PATH="$RELEASE_ROOT/notarization-submit.json"
assert_release_zip_capability "$ZIP_SRC" || exit 1
assert_same_identity "release app" "$APP_PATH" "$APP_ID" || exit 1
STAGING_DIR="$(mktemp -d "$RELEASE_ROOT/.notarize-stage.XXXXXXXX")"
chmod 700 "$STAGING_DIR"
STAGING_ID="$(path_id "$STAGING_DIR")"
STAGED_APP="$STAGING_DIR/${PRODUCT_NAME}.app"
STAGED_ZIP="$STAGING_DIR/$(basename "$ZIP_SRC")"
SUBMITTED_ZIP="$STAGING_DIR/submitted.zip"
SUBMIT_LOG="$STAGING_DIR/notarization-submit.json"
SUBMIT_ERR="$STAGING_DIR/notarization-submit.err"
NOTARY_LOG="$STAGING_DIR/notarization-log.json"
STAGED_RECEIPT="$STAGING_DIR/notarization-receipt.json"
SUBMIT_RECEIPT_ID="$(output_identity "$SUBMIT_RECEIPT_PATH")"
RECEIPT_ID="$(output_identity "$RECEIPT_PATH")"
ZIP_SHA="$(shasum -a 256 "$ZIP_SRC" | awk '{print $1}')"

# The submitted/stapled artifacts are private copies.  Everything that is
# verified, uploaded, stapled, and published originates from this 0700 stage;
# the release paths are only later replacement targets.
ditto --rsrc "$APP_PATH" "$STAGED_APP"
assert_same_identity "release app" "$APP_PATH" "$APP_ID" || exit 1
assert_app_bundle "$STAGED_APP"
log "preflight staged app: codesign --verify --deep --strict …"
codesign --verify --deep --strict --verbose=2 "$STAGED_APP"
STAGED_APP_CDHASH="$(codesign -dv --verbose=4 "$STAGED_APP" 2>&1 | awk -F= '/^CDHash=/{print $2}')"
STAGED_APP_CDHASH="$(printf '%s\n' "$STAGED_APP_CDHASH" | head -n1)"
APP_CDHASH="$STAGED_APP_CDHASH"
# Freeze the exact archive that authorization submits.  The public release zip
# is read-only input until the final publish transaction; a replaced artifact
# cannot become an accidental notarization upload.
ditto "$ZIP_SRC" "$SUBMITTED_ZIP"
assert_same_identity "release zip" "$ZIP_SRC" "$ZIP_ID" || exit 1
[[ -f "$SUBMITTED_ZIP" && ! -L "$SUBMITTED_ZIP" ]] || { err "submitted zip missing or unsafe"; exit 1; }
[[ "$(shasum -a 256 "$SUBMITTED_ZIP" | awk '{print $1}')" == "$ZIP_SHA" ]] || {
  err "submitted zip did not preserve the admitted release content"
  exit 1
}

log "preflight: asc auth …"
if ! asc doctor >/dev/null; then
  err "asc doctor failed — run: asc doctor && asc auth status"
  exit 1
fi

log "submitting for notarization via asc …"
log "  zip: $ZIP_SRC"
log "  sha256: $ZIP_SHA"
log "  app: $APP_PATH"
log "  timeout: $TIMEOUT"

set +e
asc notarization submit \
  --file "$SUBMITTED_ZIP" \
  --wait \
  --timeout "$TIMEOUT" \
  --poll-interval "$POLL" \
  --output json \
  >"$SUBMIT_LOG" 2>"$SUBMIT_ERR"
submit_status=$?
set -e

if [[ "$submit_status" -ne 0 ]]; then
  err "asc notarization submit failed (exit $submit_status)"
  if [[ -s "$SUBMIT_ERR" ]]; then
    tail -n 40 "$SUBMIT_ERR" >&2 || true
  fi
  if [[ -s "$SUBMIT_LOG" ]]; then
    tail -n 40 "$SUBMIT_LOG" >&2 || true
  fi
  exit 1
fi

# Parse submission id + status from asc JSON (handles data object or list).
parse_submit() {
  python3 - "$SUBMIT_LOG" <<'PY'
import json, sys
path = sys.argv[1]
with open(path, encoding="utf-8") as f:
    raw = f.read().strip()
if not raw:
    print("EMPTY", file=sys.stderr)
    sys.exit(2)
# Some CLIs emit multiple JSON values; take the last object.
decoder = json.JSONDecoder()
idx = 0
obj = None
while idx < len(raw):
    while idx < len(raw) and raw[idx].isspace():
        idx += 1
    if idx >= len(raw):
        break
    obj, end = decoder.raw_decode(raw, idx)
    idx = end
if obj is None:
    print("NO_JSON", file=sys.stderr)
    sys.exit(2)
data = obj.get("data", obj) if isinstance(obj, dict) else obj
if isinstance(data, list):
    if not data:
        print("EMPTY_DATA", file=sys.stderr)
        sys.exit(2)
    data = data[0]
if not isinstance(data, dict):
    print("BAD_SHAPE", file=sys.stderr)
    sys.exit(2)
attrs = data.get("attributes") or {}
status = attrs.get("status") or data.get("status") or ""
sid = data.get("id") or attrs.get("id") or ""
name = attrs.get("name") or ""
print(f"{sid}\t{status}\t{name}")
PY
}

if ! submit_line="$(parse_submit)"; then
  err "could not parse asc notarization submit JSON → $SUBMIT_LOG"
  tail -n 50 "$SUBMIT_LOG" >&2 || true
  exit 1
fi

SUBMISSION_ID="$(printf '%s' "$submit_line" | cut -f1)"
NOTARY_STATUS="$(printf '%s' "$submit_line" | cut -f2)"
SUBMIT_NAME="$(printf '%s' "$submit_line" | cut -f3)"

log "submission id: ${SUBMISSION_ID:-unknown}"
log "status: ${NOTARY_STATUS:-unknown}"

if [[ "$NOTARY_STATUS" != "Accepted" ]]; then
  err "notarization not Accepted (got: ${NOTARY_STATUS:-empty})"
  if [[ -n "$SUBMISSION_ID" ]]; then
    log "fetching notary log …"
    asc notarization log --id "$SUBMISSION_ID" --output json \
      >"$NOTARY_LOG" 2>/dev/null || true
    if [[ -s "$NOTARY_LOG" ]]; then
      tail -n 80 "$NOTARY_LOG" >&2 || true
    fi
  fi
  exit 1
fi

log "stapling ticket onto staged app …"
xcrun stapler staple "$STAGED_APP"
xcrun stapler validate "$STAGED_APP"

log "re-zipping stapled app into exclusive staging …"
# Zip cannot hold a staple; ship the ticket inside a fresh archive of the stapled .app.
# Parent of .app is the directory to zip from so the archive root is Vellum.app.
app_parent="$STAGING_DIR"
app_base="$(basename "$STAGED_APP")"
(
  cd "$app_parent"
  ditto -c -k --keepParent "$app_base" "$STAGED_ZIP"
)
[[ -f "$STAGED_ZIP" && ! -L "$STAGED_ZIP" ]] || { err "staged zip missing or unsafe"; exit 1; }
STAGED_APP_ID="$(path_id "$STAGED_APP")"
STAGED_ZIP_ID="$(path_id "$STAGED_ZIP")"

# Re-check the named canonical targets immediately before their rename
# transaction.  A replaced/symlinked target never receives a staple or zip.
assert_release_app_capability "$APP_PATH" || exit 1
assert_same_identity "release app" "$APP_PATH" "$APP_ID" || exit 1
assert_release_zip_capability "$ZIP_SRC" || exit 1
assert_same_identity "release zip" "$ZIP_SRC" "$ZIP_ID" || exit 1
assert_same_identity "release root" "$RELEASE_ROOT" "$RELEASE_ROOT_ID" || exit 1

APP_BACKUP="$STAGING_DIR/original.app"
mv "$APP_PATH" "$APP_BACKUP"
if ! mv "$STAGED_APP" "$APP_PATH"; then
  mv "$APP_BACKUP" "$APP_PATH" || err "could not restore original release app"
  exit 1
fi
assert_same_identity "replaced release app" "$APP_PATH" "$STAGED_APP_ID" || exit 1
mv -f "$STAGED_ZIP" "$ZIP_SRC"
assert_same_identity "replaced release zip" "$ZIP_SRC" "$STAGED_ZIP_ID" || exit 1
ZIP_SHA_STAPLED="$(shasum -a 256 "$ZIP_SRC" | awk '{print $1}')"

if [[ "$SKIP_SPCTL" -eq 0 ]]; then
  log "Gatekeeper assess …"
  set +e
  spctl_out="$(spctl --assess -vv --type execute "$APP_PATH" 2>&1)"
  spctl_status=$?
  set -e
  printf '%s\n' "$spctl_out"
  if [[ "$spctl_status" -ne 0 ]]; then
    err "spctl --assess failed (exit $spctl_status)"
    err "staple is present; if this is a false negative on a local path, re-check with quarantine set"
    exit 1
  fi
else
  log "skipping spctl (--skip-spctl)"
fi

python3 - "$STAGED_RECEIPT" "$PRODUCT_NAME" "$APP_BUNDLE_ID" "$APP_PATH" "$ZIP_SRC" "$ZIP_SHA" "$ZIP_SHA_STAPLED" "$APP_CDHASH" "$SUBMISSION_ID" "$NOTARY_STATUS" "$SUBMIT_NAME" <<'PY'
import datetime
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
receipt = {
    "product": sys.argv[2],
    "bundleId": sys.argv[3],
    "appPath": sys.argv[4],
    "zipPath": sys.argv[5],
    "zipSha256Submitted": sys.argv[6],
    "zipSha256Stapled": sys.argv[7],
    "appCdHash": sys.argv[8],
    "submissionId": sys.argv[9],
    "status": sys.argv[10],
    "submittedName": sys.argv[11],
    "tool": "asc notarization submit",
    "completedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
}
path.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
print(path)
PY

assert_output_unchanged "$SUBMIT_RECEIPT_PATH" "$SUBMIT_RECEIPT_ID" || exit 1
assert_output_unchanged "$RECEIPT_PATH" "$RECEIPT_ID" || exit 1
assert_same_identity "release root" "$RELEASE_ROOT" "$RELEASE_ROOT_ID" || exit 1
mv -f "$SUBMIT_LOG" "$SUBMIT_RECEIPT_PATH"
mv -f "$STAGED_RECEIPT" "$RECEIPT_PATH"

log "notarization complete"
log "  receipt: $RECEIPT_PATH"
log "  submission: $SUBMISSION_ID"
log "  stapled app: $APP_PATH"
log "  ship zip: $ZIP_SRC"
log "install stapled local build: bun run app:install:skip-build"
