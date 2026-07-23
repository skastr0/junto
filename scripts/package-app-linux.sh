#!/usr/bin/env bash
# Native Ubuntu 24.04 x64 package seam. It emits the diagnostic unpacked tree
# and the canonical deb from the same target-native Electron rebuild.
set -euo pipefail
umask 0022

if [[ "$(uname -s)" != "Linux" ]]; then
  printf 'vellum: error: native linux packaging must run on Linux\n' >&2
  exit 1
fi
case "$(uname -m)" in
  x86_64) ;;
  *) printf 'vellum: error: Linux v1 packages require native x86_64\n' >&2; exit 1 ;;
esac
VERIFY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --verify) VERIFY=1 ;;
    *) printf 'vellum: error: unsupported Linux package option: %s\n' "$1" >&2; exit 1 ;;
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
  printf 'vellum: error: Linux packaging requires Node >=22.12.0 for @electron/rebuild\n' >&2
  exit 1
fi
NODE_MAJOR="${BASH_REMATCH[1]}"
NODE_MINOR="${BASH_REMATCH[2]}"
if (( NODE_MAJOR < 22 || (NODE_MAJOR == 22 && NODE_MINOR < 12) )); then
  printf 'vellum: error: Linux packaging requires Node >=22.12.0; found %s\n' "$NODE_VERSION" >&2
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

bunx --no-install electron-builder --linux dir deb --x64 \
  --config.npmRebuild=false \
  --config.linux.icon="$PACKAGE_ICON"
finalized="$(bun "$SCRIPT_DIR/finalize-linux-package.ts" --release-dir "$SCRIPT_DIR/../release")"
unpacked="$(printf '%s' "$finalized" | bun -e 'const value = await Bun.stdin.json(); if (typeof value.artifact !== "string") process.exit(1); process.stdout.write(value.artifact)')"
deb="$(printf '%s' "$finalized" | bun -e 'const value = await Bun.stdin.json(); if (typeof value.deb !== "string") process.exit(1); process.stdout.write(value.deb)')"
bun "$SCRIPT_DIR/audit-linux-package.ts" --unpacked "$unpacked" --deb "$deb"
if [[ "$VERIFY" -eq 1 ]]; then
  printf 'vellum: source/package audit passed; installed sandbox and PTY qualification still require the disposable Ubuntu gate.\n'
fi
printf 'vellum: built %s and %s\n' "$unpacked" "$deb"
