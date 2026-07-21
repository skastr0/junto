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
# shellcheck source=app-paths.sh
source "$SCRIPT_DIR/app-paths.sh"

ZIP_SRC="${VELLUM_ZIP_SRC:-}"
APP_PATH="${VELLUM_APP_SRC:-}"
SKIP_SPCTL=0
TIMEOUT="${VELLUM_NOTARY_TIMEOUT:-45m}"
POLL="${VELLUM_NOTARY_POLL:-15s}"

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

if [[ -z "$APP_PATH" ]]; then
  APP_PATH="$(detect_app_src)"
fi
if [[ -z "$ZIP_SRC" ]]; then
  if ! ZIP_SRC="$(detect_release_zip)"; then
    err "no release zip under $RELEASE_DIR — run: bun run app:build"
    exit 1
  fi
fi

assert_app_bundle "$APP_PATH"
[[ -f "$ZIP_SRC" ]] || { err "missing zip: $ZIP_SRC"; exit 1; }

log "preflight: codesign --verify --deep --strict …"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"

log "preflight: asc auth …"
if ! asc doctor >/dev/null; then
  err "asc doctor failed — run: asc doctor && asc auth status"
  exit 1
fi

ZIP_SHA="$(shasum -a 256 "$ZIP_SRC" | awk '{print $1}')"
APP_CDHASH="$(
  codesign -dv --verbose=4 "$APP_PATH" 2>&1 | awk -F= '/^CDHash=/{print $2; exit}'
)"
RECEIPT_PATH="$RELEASE_DIR/notarization-receipt.json"
SUBMIT_LOG="$RELEASE_DIR/notarization-submit.json"
mkdir -p "$RELEASE_DIR"

log "submitting for notarization via asc …"
log "  zip: $ZIP_SRC"
log "  sha256: $ZIP_SHA"
log "  app: $APP_PATH"
log "  timeout: $TIMEOUT"

set +e
asc notarization submit \
  --file "$ZIP_SRC" \
  --wait \
  --timeout "$TIMEOUT" \
  --poll-interval "$POLL" \
  --output json \
  >"$SUBMIT_LOG" 2>"$RELEASE_DIR/notarization-submit.err"
submit_status=$?
set -e

if [[ "$submit_status" -ne 0 ]]; then
  err "asc notarization submit failed (exit $submit_status)"
  if [[ -s "$RELEASE_DIR/notarization-submit.err" ]]; then
    tail -n 40 "$RELEASE_DIR/notarization-submit.err" >&2 || true
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
      >"$RELEASE_DIR/notarization-log.json" 2>/dev/null || true
    if [[ -s "$RELEASE_DIR/notarization-log.json" ]]; then
      tail -n 80 "$RELEASE_DIR/notarization-log.json" >&2 || true
    fi
  fi
  exit 1
fi

log "stapling ticket onto app …"
xcrun stapler staple "$APP_PATH"
xcrun stapler validate "$APP_PATH"

log "re-zipping stapled app → $ZIP_SRC …"
# Zip cannot hold a staple; ship the ticket inside a fresh archive of the stapled .app.
stage_zip="${ZIP_SRC}.stapled.$$"
# Parent of .app is the directory to zip from so the archive root is Vellum.app.
app_parent="$(dirname "$APP_PATH")"
app_base="$(basename "$APP_PATH")"
(
  cd "$app_parent"
  ditto -c -k --keepParent "$app_base" "$stage_zip"
)
mv -f "$stage_zip" "$ZIP_SRC"
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

python3 - "$RECEIPT_PATH" <<PY
import json, datetime, pathlib
path = pathlib.Path("$RECEIPT_PATH")
receipt = {
    "product": "$PRODUCT_NAME",
    "bundleId": "$APP_BUNDLE_ID",
    "appPath": "$APP_PATH",
    "zipPath": "$ZIP_SRC",
    "zipSha256Submitted": "$ZIP_SHA",
    "zipSha256Stapled": "$ZIP_SHA_STAPLED",
    "appCdHash": "$APP_CDHASH",
    "submissionId": "$SUBMISSION_ID",
    "status": "$NOTARY_STATUS",
    "submittedName": "$SUBMIT_NAME",
    "tool": "asc notarization submit",
    "completedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
}
path.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
print(path)
PY

log "notarization complete"
log "  receipt: $RECEIPT_PATH"
log "  submission: $SUBMISSION_ID"
log "  stapled app: $APP_PATH"
log "  ship zip: $ZIP_SRC"
log "install stapled local build: bun run app:install:skip-build"
