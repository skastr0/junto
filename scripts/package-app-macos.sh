#!/usr/bin/env bash
# Native macOS package path. Signing, audit, and notarization stay mac-only.
set -euo pipefail
if [[ "$(uname -s)" != "Darwin" ]]; then
  printf 'vellum: error: native mac packaging must run on macOS\n' >&2
  exit 1
fi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=app-paths.sh
source "$SCRIPT_DIR/app-paths.sh"
VERIFY=0
NOTARIZE=0
while [[ $# -gt 0 ]]; do
  case "$1" in --verify) VERIFY=1 ;; --notarize) NOTARIZE=1 ;; *) err "unknown flag: $1"; exit 1 ;; esac
  shift
done
cd "$REPO_ROOT"
bun rebuild node-pty
bunx electron-builder --mac
APP_SRC="$(detect_macos_app_src)"
assert_app_bundle "$APP_SRC"
ZIP_SRC="$(detect_release_zip)" || { err "missing shippable zip under $RELEASE_DIR"; exit 1; }
bun "$SCRIPT_DIR/audit-packaged-app.ts" "$APP_SRC"
if [[ "$VERIFY" -eq 1 ]]; then bun "$SCRIPT_DIR/packaged-runtime-smoke.ts" "$APP_SRC"; fi
if [[ "$NOTARIZE" -eq 1 ]]; then VELLUM_APP_SRC="$APP_SRC" VELLUM_ZIP_SRC="$ZIP_SRC" bash "$SCRIPT_DIR/notarize-app.sh"; fi
printf 'vellum: built %s\n' "$APP_SRC"
