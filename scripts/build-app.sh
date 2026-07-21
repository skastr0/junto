#!/usr/bin/env bash
# Build a packaged macOS Vellum distribution under release/.
#
#   scripts/build-app.sh              typecheck + Electron + standalone browser CLI + package
#   scripts/build-app.sh --fast       skip typecheck (package only; still compiles both)
#   scripts/build-app.sh --verify     typecheck + unit tests + compile + package + runtime smoke
#   scripts/build-app.sh --notarize   after package: asc notary + staple + re-zip (scripts/notarize-app.sh)
#   scripts/build-app.sh --compile-only   compile Electron + browser CLI, no .app
#
# Safe: never writes to /Applications. Never kills herdr sessions.
# Outputs:
#   release/mac-arm64/Vellum.app          (or release/mac/) — signed .app for audit/install
#   release/Vellum-<ver>-arm64-mac.zip    — shippable archive (electron-builder zip target)
#   release/Vellum-<ver>-arm64-mac.dmg    — human installer (plate B + fullbleed amber icon)
#   release/notarization-receipt.json     — when --notarize succeeds
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=app-paths.sh
source "$SCRIPT_DIR/app-paths.sh"

FAST=0
VERIFY=0
COMPILE_ONLY=0
NOTARIZE=0

usage() {
  sed -n '2,14p' "$0" | sed 's/^# \?//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fast) FAST=1; shift ;;
    --verify) VERIFY=1; shift ;;
    --notarize) NOTARIZE=1; shift ;;
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

verify_browser_cli_dead_runtime() {
  local probe_root control_root output status case_name stage_socket expected
  probe_root="$(mktemp -d /tmp/vellum-browser-cli-dead.XXXXXX)"
  control_root="$probe_root/.vellum/browser"
  stage_socket="$control_root/stage.sock"
  expected='{"ok":false,"error":{"_tag":"runtime_down","message":"vellum app is not running"}}'
  mkdir -p "$control_root"
  chmod 0700 "$probe_root" "$probe_root/.vellum" "$control_root"
  printf '%s\n' 'retained-transport-token' > "$control_root/control.token"
  chmod 0600 "$control_root/control.token"

  for case_name in absent stale; do
    if [[ "$case_name" == "stale" ]]; then
      VELLUM_STALE_STAGE="$stage_socket" \
        VELLUM_STALE_TARGET="$control_root/control.sock" \
        bun -e '
          import { rename } from "node:fs/promises";
          import { createServer } from "node:net";
          const stage = process.env.VELLUM_STALE_STAGE;
          const target = process.env.VELLUM_STALE_TARGET;
          if (!stage || !target) process.exit(2);
          const server = createServer();
          await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(stage, resolve);
          });
          await rename(stage, target);
          await new Promise((resolve) => server.close(resolve));
        '
      [[ -S "$control_root/control.sock" ]] || {
        err "standalone browser CLI stale-socket fixture failed"
        return 1
      }
    fi

    set +e
    output="$(env -u VELLUM_BROWSER_CAPABILITY \
      HOME="$probe_root" \
      VELLUM_BROWSER_HOME="$probe_root" \
      "$BROWSER_CLI_OUT" doctor --json 2>&1)"
    status=$?
    set -e

    if [[ "$status" -ne 1 || "$output" != "$expected" ]]; then
      rm -f "$control_root/control.sock" "$control_root/control.token"
      rmdir "$control_root" "$probe_root/.vellum" "$probe_root" 2>/dev/null || true
      err "standalone browser CLI failed the $case_name dead-runtime contract"
      return 1
    fi
  done

  rm -f "$control_root/control.sock" "$control_root/control.token"
  rmdir "$control_root" "$probe_root/.vellum" "$probe_root"
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
log "standalone browser CLI dead-runtime contract …"
verify_browser_cli_dead_runtime

if [[ "$COMPILE_ONLY" -eq 1 ]]; then
  log "compile-only done (out/ + dist/vellum-browser). Skip packaging."
  exit 0
fi

log "electron-builder --mac → release/ (.app + zip + dmg) …"
# package.json mac.target: zip (notary unit) + dmg (human installer with plate B).
# Builder still materializes the signed .app under release/mac-*/ for audit + install.
bunx electron-builder --mac

APP_SRC="$(detect_app_src)"
assert_app_bundle "$APP_SRC"

if ! ZIP_SRC="$(detect_release_zip)"; then
  err "missing shippable zip under $RELEASE_DIR (mac.target should include zip)"
  exit 1
fi

log "package security audit (signature + ASAR + Electron fuses) …"
bun "$SCRIPT_DIR/audit-packaged-app.ts" "$APP_SRC"

if [[ "$VERIFY" -eq 1 ]]; then
  log "packaged runtime smoke (isolated HOME + UDS doctor + no TCP/debug) …"
  bun "$SCRIPT_DIR/packaged-runtime-smoke.ts" "$APP_SRC"
fi

if [[ "$NOTARIZE" -eq 1 ]]; then
  log "notarize + staple (asc) …"
  VELLUM_APP_SRC="$APP_SRC" VELLUM_ZIP_SRC="$ZIP_SRC" bash "$SCRIPT_DIR/notarize-app.sh"
  # Zip path is stable; re-detect in case tool rewrote the archive in place.
  ZIP_SRC="$(detect_release_zip || printf '%s' "$ZIP_SRC")"
fi

VERSION="$(
  /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP_SRC/Contents/Info.plist" 2>/dev/null || true
)"
DMG_SRC=""
shopt -s nullglob
dmg_candidates=("$RELEASE_DIR"/Vellum-*-mac.dmg "$RELEASE_DIR"/*.dmg)
shopt -u nullglob
for candidate in "${dmg_candidates[@]}"; do
  if [[ -f "$candidate" ]]; then
    DMG_SRC="$candidate"
    break
  fi
done

log "built $(basename "$APP_SRC")"
log "  app:  $APP_SRC"
log "  zip:  $ZIP_SRC"
if [[ -n "$DMG_SRC" ]]; then
  log "  dmg:  $DMG_SRC"
fi
if [[ -n "$VERSION" ]]; then
  log "  version: $VERSION"
fi
if [[ "$NOTARIZE" -eq 1 ]]; then
  log "  notarization: $RELEASE_DIR/notarization-receipt.json"
fi
log "install with: bun run app:install   # or scripts/install-app.sh"
if [[ "$NOTARIZE" -eq 0 ]]; then
  log "notarize with: bun run app:notarize   # or build with --notarize"
fi
