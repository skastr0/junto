#!/usr/bin/env bash
# Native macOS package path. Signing, audit, and notarization stay mac-only.
set -euo pipefail
if [[ "$(uname -s)" != "Darwin" ]]; then
  printf 'vellum-command: error: macOS packaging must run on macOS\n' >&2
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
if [[ "$(uname -m)" == "arm64" ]]; then
  TARGET_ARCH="arm64"
  APP_OUTPUT_DIR="mac-arm64"
elif [[ "$(uname -m)" == "x86_64" ]]; then
  TARGET_ARCH="x64"
  APP_OUTPUT_DIR="mac"
else
  err "unsupported macOS package architecture: $(uname -m)"
  exit 1
fi
BUN_EXECUTABLE="$(type -P bun || true)"
if [[ -z "$BUN_EXECUTABLE" || ! -x "$BUN_EXECUTABLE" ]]; then
  err "an executable Bun runtime is required"
  exit 1
fi
if [[ -L "$RELEASE_DIR" || ( -e "$RELEASE_DIR" && ! -d "$RELEASE_DIR" ) ]]; then
  err "release must be a non-symlink directory"
  exit 1
fi
mkdir -p -- "$RELEASE_DIR"
RELEASE_DIR="$(cd "$RELEASE_DIR" && pwd -P)"
ATTEMPT_DIR="$(mktemp -d "$RELEASE_DIR/.vellum-package-attempt-XXXXXXXX")"
chmod 0700 "$ATTEMPT_DIR"
NODE_SHIM_DIR=""
cleanup_package_attempt() {
  if [[ -n "$NODE_SHIM_DIR" && -d "$NODE_SHIM_DIR" && ! -L "$NODE_SHIM_DIR" ]]; then
    if [[ -L "$NODE_SHIM_DIR/node" ]] && [[ "$(readlink -- "$NODE_SHIM_DIR/node")" == "$BUN_EXECUTABLE" ]]; then
      rm -f -- "$NODE_SHIM_DIR/node"
    fi
    rmdir -- "$NODE_SHIM_DIR" 2>/dev/null || true
  fi
  if [[ -n "$ATTEMPT_DIR" && -d "$ATTEMPT_DIR" && ! -L "$ATTEMPT_DIR" && "$(dirname "$ATTEMPT_DIR")" == "$RELEASE_DIR" && "$(basename "$ATTEMPT_DIR")" == .vellum-package-attempt-* ]]; then
    rm -rf -- "$ATTEMPT_DIR"
  elif [[ -e "$ATTEMPT_DIR" || -L "$ATTEMPT_DIR" ]]; then
    err "retained package attempt after identity change: $ATTEMPT_DIR"
  fi
}
trap cleanup_package_attempt EXIT

PACKAGE_VERSION="$("$BUN_EXECUTABLE" -e 'process.stdout.write(require("./package.json").version)')"
NODE_SHIM_DIR="$(mktemp -d /tmp/vellum-command-node-shim.XXXXXXXXXX)"
ln -s -- "$BUN_EXECUTABLE" "$NODE_SHIM_DIR/node"
ELECTRON_VERSION="$(bun -e 'process.stdout.write(require("./node_modules/electron/package.json").version)')"
PATH="$NODE_SHIM_DIR:$PATH" bunx --bun electron-rebuild \
  --force \
  --build-from-source \
  --only node-pty \
  --arch "$TARGET_ARCH" \
  --version "$ELECTRON_VERSION" \
  --module-dir .
rm -f -- "$NODE_SHIM_DIR/node"
rmdir -- "$NODE_SHIM_DIR"
NODE_SHIM_DIR=""

bunx electron-builder --mac \
  --config.directories.output="$ATTEMPT_DIR"
DRAFT_APP="$ATTEMPT_DIR/$APP_OUTPUT_DIR/${PRODUCT_NAME}.app"
DRAFT_ZIP="$ATTEMPT_DIR/Vellum-Command-${PACKAGE_VERSION}-${TARGET_ARCH}-mac.zip"
DRAFT_DMG="$ATTEMPT_DIR/Vellum-Command-${PACKAGE_VERSION}-${TARGET_ARCH}-mac.dmg"
assert_app_bundle "$DRAFT_APP"
for candidate in "$DRAFT_ZIP" "$DRAFT_DMG"; do
  if [[ ! -f "$candidate" || -L "$candidate" ]]; then
    err "missing fresh shippable draft: $candidate"
    exit 1
  fi
done

# All gates operate on attempt-owned drafts. No release final exists yet.
APP_SRC="$DRAFT_APP"
"$BUN_EXECUTABLE" "$SCRIPT_DIR/package-runtime-provenance.ts" \
  verify-package --target mac --app "$APP_SRC" >/dev/null
bun "$SCRIPT_DIR/audit-packaged-app.ts" "$APP_SRC" >/dev/null
if [[ "$VERIFY" -eq 1 ]]; then
  bun "$SCRIPT_DIR/packaged-runtime-smoke.ts" "$APP_SRC"
fi

bun "$SCRIPT_DIR/finalize-linux-package.ts" publish-attempt \
  --attempt-dir "$ATTEMPT_DIR" \
  --release-dir "$RELEASE_DIR" >/dev/null
FINAL_APP="$RELEASE_DIR/$APP_OUTPUT_DIR/${PRODUCT_NAME}.app"
FINAL_ZIP="$RELEASE_DIR/$(basename "$DRAFT_ZIP")"
ATTEMPT_DIR=""
if [[ "$NOTARIZE" -eq 1 ]]; then
  VELLUM_COMMAND_APP_SRC="$FINAL_APP" VELLUM_COMMAND_ZIP_SRC="$FINAL_ZIP" \
    bash "$SCRIPT_DIR/notarize-app.sh"
fi
printf 'vellum-command: built %s\n' "$FINAL_APP"
