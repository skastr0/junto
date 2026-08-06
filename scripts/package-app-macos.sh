#!/usr/bin/env bash
# Native macOS package path. Signing, audit, and notarization stay mac-only.
set -euo pipefail
if [[ "$(uname -s)" != "Darwin" ]]; then
  printf 'vellum-command: error: native mac packaging must run on macOS\n' >&2
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
bun "$SCRIPT_DIR/electron-security-policy.ts" validate
if [[ "$(uname -m)" == "arm64" ]]; then
  TARGET_ARCH="arm64"
elif [[ "$(uname -m)" == "x86_64" ]]; then
  TARGET_ARCH="x64"
else
  TARGET_ARCH="$(uname -m)"
fi
BUN_EXECUTABLE="$(type -P bun || true)"
if [[ -z "$BUN_EXECUTABLE" || ! -x "$BUN_EXECUTABLE" ]]; then
  err "an executable Bun runtime is required"
  exit 1
fi
NODE_SHIM_DIR="$(mktemp -d /tmp/vellum-node-shim.XXXXXXXXXX)"
cleanup_node_shim() {
  if [[ -L "$NODE_SHIM_DIR/node" ]] && [[ "$(readlink -- "$NODE_SHIM_DIR/node")" == "$BUN_EXECUTABLE" ]]; then
    rm -f -- "$NODE_SHIM_DIR/node"
  fi
  rmdir -- "$NODE_SHIM_DIR" 2>/dev/null || true
}
trap cleanup_node_shim EXIT
ln -s -- "$BUN_EXECUTABLE" "$NODE_SHIM_DIR/node"
ELECTRON_VERSION="$(bun -e 'process.stdout.write(require("./node_modules/electron/package.json").version)')"
PATH="$NODE_SHIM_DIR:$PATH" bunx --bun electron-rebuild \
  --force \
  --build-from-source \
  --only node-pty \
  --arch "$TARGET_ARCH" \
  --version "$ELECTRON_VERSION" \
  --module-dir .
cleanup_node_shim
trap - EXIT
bunx electron-builder --mac
APP_SRC="$(detect_macos_app_src)"
assert_app_bundle "$APP_SRC"
ZIP_SRC="$(detect_release_zip)" || { err "missing shippable zip under $RELEASE_DIR"; exit 1; }
bun "$SCRIPT_DIR/audit-packaged-app.ts" "$APP_SRC"
if [[ "$VERIFY" -eq 1 ]]; then bun "$SCRIPT_DIR/packaged-runtime-smoke.ts" "$APP_SRC"; fi
if [[ "$NOTARIZE" -eq 1 ]]; then VELLUM_COMMAND_APP_SRC="$APP_SRC" VELLUM_COMMAND_ZIP_SRC="$ZIP_SRC" bash "$SCRIPT_DIR/notarize-app.sh"; fi
printf 'vellum-command: built %s\n' "$APP_SRC"
