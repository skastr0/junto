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

# One stock Node line owns both the Linux release toolchain and the displayless
# Remote ABI. Resolve the reviewed version from the runtime staging contract and
# require the build host to match it exactly; a permissive minimum silently
# resurrects obsolete Node majors and makes native qualification ambiguous.
REQUIRED_NODE_VERSION="$(bun -e 'import { DEFAULT_NODE_REMOTE_VERSION } from "./scripts/build-linux-remote-runtime.ts"; process.stdout.write(DEFAULT_NODE_REMOTE_VERSION)')"
NODE_EXECUTABLE="$(type -P node || true)"
NODE_VERSION=""
if [[ -n "$NODE_EXECUTABLE" && -x "$NODE_EXECUTABLE" ]]; then
  NODE_VERSION="$("$NODE_EXECUTABLE" --version 2>/dev/null || true)"
fi
if [[ "$NODE_VERSION" != "v$REQUIRED_NODE_VERSION" ]]; then
  printf 'vellum-command: error: Linux packaging requires stock Node %s exactly; found %s\n' \
    "$REQUIRED_NODE_VERSION" "${NODE_VERSION:-missing}" >&2
  exit 1
fi

# This exact owned path is reset and rebuilt on every package invocation. The
# command also binds both runtime payload hashes to one clean source commit.
printf 'vellum-command: rebuilding Remote and binding package provenance …\n'
bun "$SCRIPT_DIR/package-runtime-provenance.ts" prepare --target linux

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
# The staged entry must be the just-built default. Missing output is fatal.
printf 'vellum-command: staging Linux remote runtime (bundled Node + node-pty Node ABI) …\n'
bun "$SCRIPT_DIR/build-linux-remote-runtime.ts" \
  --runtime "$SCRIPT_DIR/../release/linux-unpacked" \
  --repo "$SCRIPT_DIR/.." \
  --no-build-entry
REMOTE_PROVENANCE_SOURCE="$SCRIPT_DIR/../out/remote/package-runtime-provenance.json"
REMOTE_PROVENANCE_DESTINATION="$SCRIPT_DIR/../release/linux-unpacked/resources/app-remote/package-runtime-provenance.json"
if [[ ! -f "$REMOTE_PROVENANCE_SOURCE" || -L "$REMOTE_PROVENANCE_SOURCE" ]]; then
  printf 'vellum-command: error: fresh Remote provenance is missing\n' >&2
  exit 1
fi
install -m 0644 -- "$REMOTE_PROVENANCE_SOURCE" "$REMOTE_PROVENANCE_DESTINATION"
bun "$SCRIPT_DIR/package-runtime-provenance.ts" verify-package \
  --target linux \
  --runtime "$SCRIPT_DIR/../release/linux-unpacked"

finalized="$(bun "$SCRIPT_DIR/finalize-linux-package.ts" --release-dir "$SCRIPT_DIR/../release")"
runtime="$(printf '%s' "$finalized" | bun -e 'const value = await Bun.stdin.json(); if (typeof value.artifact !== "string") process.exit(1); process.stdout.write(value.artifact)')"
archive="$(printf '%s' "$finalized" | bun -e 'const value = await Bun.stdin.json(); if (typeof value.archive !== "string") process.exit(1); process.stdout.write(value.archive)')"
bun "$SCRIPT_DIR/audit-linux-package.ts" --runtime "$runtime"
if [[ "$VERIFY" -eq 1 ]]; then
  printf 'vellum-command: source/package audit passed; installed sandbox and PTY qualification still require the disposable Ubuntu gate.\n'
fi
printf 'vellum-command: built relocatable runtime %s and %s\n' "$runtime" "$archive"
