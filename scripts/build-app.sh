#!/usr/bin/env bash
# Build a packaged macOS Vellum.app under release/mac-*/Vellum.app.
#
#   scripts/build-app.sh              typecheck + Electron + standalone browser CLI + package
#   scripts/build-app.sh --fast       skip typecheck (package only; still compiles both)
#   scripts/build-app.sh --verify     typecheck + unit tests + compile both + package
#   scripts/build-app.sh --compile-only   compile Electron + browser CLI, no .app
#
# Safe: never writes to /Applications. Never kills herdr sessions.
# Output path: release/mac-arm64/Vellum.app (Apple Silicon) or release/mac/.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=app-paths.sh
source "$SCRIPT_DIR/app-paths.sh"

FAST=0
VERIFY=0
COMPILE_ONLY=0

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \?//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fast) FAST=1; shift ;;
    --verify) VERIFY=1; shift ;;
    --compile-only) COMPILE_ONLY=1; shift ;;
    -h|--help) usage 0 ;;
    *) err "unknown flag: $1"; usage 1 ;;
  esac
done

cd "$REPO_ROOT"

BROWSER_CLI_OUT="$REPO_ROOT/dist/vellum-browser"

build_browser_cli() {
  local stage="${BROWSER_CLI_OUT}.new.$$"
  mkdir -p "$(dirname "$BROWSER_CLI_OUT")"
  log "standalone browser CLI → dist/vellum-browser …"
  # Disable every ambient config/autoload source. Runtime authority comes only
  # from the fixed, validated VELLUM_BROWSER_* environment inputs.
  bun build \
    --compile \
    --no-compile-autoload-dotenv \
    --no-compile-autoload-bunfig \
    --no-compile-autoload-tsconfig \
    --no-compile-autoload-package-json \
    --outfile "$stage" \
    scripts/browser-cli.ts
  chmod 0755 "$stage"
  mv "$stage" "$BROWSER_CLI_OUT"
}

if [[ ! -d node_modules/electron-builder ]]; then
  err "electron-builder missing — run: bun install"
  exit 1
fi

if [[ "$VERIFY" -eq 1 ]]; then
  log "verify: typecheck + test …"
  bun run typecheck
  bun run test
elif [[ "$FAST" -eq 0 ]]; then
  log "typecheck …"
  bun run typecheck
fi

log "electron-vite build → out/ …"
bunx electron-vite build
build_browser_cli

if [[ "$COMPILE_ONLY" -eq 1 ]]; then
  log "compile-only done (out/ + dist/vellum-browser). Skip packaging."
  exit 0
fi

log "electron-builder --dir → release/ …"
# --dir = unpacked .app only (fast; no dmg/zip). Matches package.json "build".
bunx electron-builder --dir --mac

APP_SRC="$(detect_app_src)"
assert_app_bundle "$APP_SRC"

log "package security audit (signature + ASAR + Electron fuses) …"
bun "$SCRIPT_DIR/audit-packaged-app.ts" "$APP_SRC"

log "built $(basename "$APP_SRC")"
log "  path: $APP_SRC"
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP_SRC/Contents/Info.plist" 2>/dev/null \
  | sed 's/^/  version: /' || true
log "install with: bun run app:install   # or scripts/install-app.sh"
