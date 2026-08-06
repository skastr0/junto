#!/usr/bin/env bash
# Native Ubuntu x64 userland runtime seam. It emits a relocatable tree and
# archive; extracting it never requires package-manager or root authority.
set -euo pipefail
umask 0022

if [[ "$(uname -s)" != "Linux" ]]; then
  printf 'vellum-command: error: native linux packaging must run on Linux\n' >&2
  exit 1
fi
case "$(uname -m)" in
  x86_64) ;;
  *) printf 'vellum-command: error: Linux v1 packages require native x86_64\n' >&2; exit 1 ;;
esac
VERIFY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --verify) VERIFY=1 ;;
    *) printf 'vellum-command: error: unsupported Linux package option: %s\n' "$1" >&2; exit 1 ;;
  esac
  shift
done
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
bun "$SCRIPT_DIR/electron-security-policy.ts" validate

# @electron/rebuild 4 requires Node >=22.12 and node-gyp invokes that runtime
# while compiling. Fail before touching the dependency tree when the build host
# does not satisfy the declared tool contract.
NODE_EXECUTABLE="$(type -P node || true)"
NODE_VERSION=""
if [[ -n "$NODE_EXECUTABLE" && -x "$NODE_EXECUTABLE" ]]; then
  NODE_VERSION="$("$NODE_EXECUTABLE" --version 2>/dev/null || true)"
fi
if [[ ! "$NODE_VERSION" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  printf 'vellum-command: error: Linux packaging requires Node >=22.12.0 for @electron/rebuild\n' >&2
  exit 1
fi
NODE_MAJOR="${BASH_REMATCH[1]}"
NODE_MINOR="${BASH_REMATCH[2]}"
if (( NODE_MAJOR < 22 || (NODE_MAJOR == 22 && NODE_MINOR < 12) )); then
  printf 'vellum-command: error: Linux packaging requires Node >=22.12.0; found %s\n' "$NODE_VERSION" >&2
  exit 1
fi

# Rebuild only the one native production dependency. install-app-deps and
# electron-builder's default npmRebuild also traverse unrelated development
# addons, so the package command disables that broader second pass explicitly.
ELECTRON_VERSION="$(bun -e 'process.stdout.write(require("./node_modules/electron/package.json").version)')"
bunx --no-install electron-rebuild \
  --version "$ELECTRON_VERSION" \
  --arch x64 \
  --module-dir . \
  --only node-pty \
  --force \
  --sequential

# FPM preserves the mode of icon inputs. Stage a private copy so a checkout
# created under a permissive umask cannot leak group-write into the package.
PACKAGE_ASSET_DIR="$(mktemp -d -t vellum-linux-assets.XXXXXX)"
PACKAGE_ICON="$PACKAGE_ASSET_DIR/vellum-command-icon.png"
cleanup_package_assets() {
  rm -f -- "$PACKAGE_ICON"
  rmdir -- "$PACKAGE_ASSET_DIR"
}
trap cleanup_package_assets EXIT
install -m 0644 -- assets/brand/vellum-command-icon.png "$PACKAGE_ICON"

# Authoritative release packaging may only use the Electron tree from the
# frozen lockfile install — never an ambient ELECTRON_DIST path (provenance).
ELECTRON_DIST_ARGS=()
if [[ -x "node_modules/electron/dist/electron" ]]; then
  ELECTRON_DIST_ARGS+=(--config.electronDist=node_modules/electron/dist)
fi

bunx --no-install electron-builder --linux dir --x64 \
  --config.npmRebuild=false \
  "${ELECTRON_DIST_ARGS[@]}" \
  --config.linux.icon="$PACKAGE_ICON"

# Displayless product Remote: official Node linux-x64 + node-pty for that ABI +
# resources/bin/vellum-command-remote. Never ELECTRON_RUN_AS_NODE; never Bun-compile remote.
# Fails closed when out/remote/vellum-command-remote.js is missing.
printf 'vellum-command: staging Linux remote runtime (bundled Node + node-pty Node ABI) …\n'
bun "$SCRIPT_DIR/build-linux-remote-runtime.ts" \
  --runtime "$SCRIPT_DIR/../release/linux-unpacked" \
  --repo "$SCRIPT_DIR/.."

finalized="$(bun "$SCRIPT_DIR/finalize-linux-package.ts" --release-dir "$SCRIPT_DIR/../release")"
runtime="$(printf '%s' "$finalized" | bun -e 'const value = await Bun.stdin.json(); if (typeof value.artifact !== "string") process.exit(1); process.stdout.write(value.artifact)')"
archive="$(printf '%s' "$finalized" | bun -e 'const value = await Bun.stdin.json(); if (typeof value.archive !== "string") process.exit(1); process.stdout.write(value.archive)')"
bun "$SCRIPT_DIR/audit-linux-package.ts" --runtime "$runtime"
if [[ "$VERIFY" -eq 1 ]]; then
  printf 'vellum-command: source/package audit passed; installed sandbox and PTY qualification still require the disposable Ubuntu gate.\n'
fi
printf 'vellum-command: built relocatable runtime %s and %s\n' "$runtime" "$archive"
