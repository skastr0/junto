#!/usr/bin/env bash
# Linux x64 execution seam. It emits a relocatable tree and archive; extracting
# it never requires package-manager or root authority. This does not claim a
# physical amd64 host: an emulated x64 process is an admitted runner.
set -euo pipefail
umask 0022

if [[ "$(uname -s)" != "Linux" ]]; then
  printf 'junto: error: Linux packaging requires a Linux execution environment\n' >&2
  exit 1
fi
case "$(uname -m)" in
  x86_64) ;;
  *) printf 'junto: error: Linux v1 packages require an x64 execution process\n' >&2; exit 1 ;;
esac
VERIFY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --verify) VERIFY=1 ;;
    *) printf 'junto: error: unsupported Linux package option: %s\n' "$1" >&2; exit 1 ;;
  esac
  shift
done
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
cd "$REPO_ROOT"
RELEASE_DIR="$REPO_ROOT/release"
if [[ -L "$RELEASE_DIR" || ( -e "$RELEASE_DIR" && ! -d "$RELEASE_DIR" ) ]]; then
  printf 'junto: error: release must be a non-symlink directory\n' >&2
  exit 1
fi
mkdir -p -- "$RELEASE_DIR"
RELEASE_DIR="$(cd "$RELEASE_DIR" && pwd -P)"
ATTEMPT_DIR="$(mktemp -d "$RELEASE_DIR/.vellum-package-attempt-XXXXXXXX")"
chmod 0700 "$ATTEMPT_DIR"
PACKAGE_ASSET_DIR=""
cleanup_package_attempt() {
  if [[ -n "$PACKAGE_ASSET_DIR" && -d "$PACKAGE_ASSET_DIR" && ! -L "$PACKAGE_ASSET_DIR" ]]; then
    rm -rf -- "$PACKAGE_ASSET_DIR"
  fi
  if [[ -n "$ATTEMPT_DIR" && -d "$ATTEMPT_DIR" && ! -L "$ATTEMPT_DIR" && "$(dirname "$ATTEMPT_DIR")" == "$RELEASE_DIR" && "$(basename "$ATTEMPT_DIR")" == .vellum-package-attempt-* ]]; then
    rm -rf -- "$ATTEMPT_DIR"
  elif [[ -e "$ATTEMPT_DIR" || -L "$ATTEMPT_DIR" ]]; then
    printf 'junto: warning: retained package attempt after identity change: %s\n' "$ATTEMPT_DIR" >&2
  fi
}
trap cleanup_package_attempt EXIT

# Rebuild only the one native production dependency. install-app-deps and
# electron-builder's default npmRebuild traverse unrelated development addons.
ELECTRON_VERSION="$(bun -e 'process.stdout.write(require("./node_modules/electron/package.json").version)')"
bunx --no-install electron-rebuild \
  --version "$ELECTRON_VERSION" \
  --arch x64 \
  --module-dir . \
  --only node-pty \
  --force \
  --sequential

# FPM preserves input modes. Keep its icon copy outside release and delete only
# that mktemp capability during cleanup.
PACKAGE_ASSET_DIR="$(mktemp -d -t vellum-linux-assets.XXXXXX)"
PACKAGE_ICON="$PACKAGE_ASSET_DIR/junto-icon.png"
install -m 0644 -- assets/brand/junto-icon.png "$PACKAGE_ICON"

ELECTRON_DIST_ARGS=()
if [[ -x "node_modules/electron/dist/electron" ]]; then
  ELECTRON_DIST_ARGS+=(--config.electronDist=node_modules/electron/dist)
fi

bunx --no-install electron-builder --linux dir --x64 --publish never \
  --config.npmRebuild=false \
  --config.directories.output="$ATTEMPT_DIR" \
  "${ELECTRON_DIST_ARGS[@]}" \
  --config.linux.icon="$PACKAGE_ICON"

DRAFT_RUNTIME="$ATTEMPT_DIR/linux-unpacked"
# Atomically replace the complete app-remote directory. The staging command
# includes the fresh provenance and rejects stale/excess Remote closure files.
printf 'junto: staging exact Linux Remote closure …\n'
bun "$SCRIPT_DIR/build-linux-remote-runtime.ts" \
  --runtime "$DRAFT_RUNTIME" \
  --repo "$REPO_ROOT" \
  --no-build-entry >/dev/null

# Final-shaped names exist only under the private attempt. Parity and dynamic
# audit run before any release/ final is published.
DRAFT_JSON="$(bun "$SCRIPT_DIR/finalize-linux-package.ts" draft --attempt-dir "$ATTEMPT_DIR")"
DRAFT_ARTIFACT="$(printf '%s' "$DRAFT_JSON" | bun -e 'const value = await Bun.stdin.json(); if (typeof value.artifact !== "string") process.exit(1); process.stdout.write(value.artifact)')"
DRAFT_ARCHIVE="$(printf '%s' "$DRAFT_JSON" | bun -e 'const value = await Bun.stdin.json(); if (typeof value.archive !== "string") process.exit(1); process.stdout.write(value.archive)')"
bun "$SCRIPT_DIR/package-runtime-provenance.ts" verify-package \
  --target linux \
  --runtime "$DRAFT_ARTIFACT" >/dev/null
AUDIT_RECEIPT="$ATTEMPT_DIR/$(basename "$DRAFT_ARTIFACT").audit.json"
bun "$SCRIPT_DIR/audit-linux-package.ts" --runtime "$DRAFT_ARTIFACT" \
  --receipt "$AUDIT_RECEIPT" >/dev/null

# No-clobber publication rejects every existing destination, including dangling
# symlinks. The EXIT trap can only clean this attempt directory.
bun "$SCRIPT_DIR/finalize-linux-package.ts" publish-attempt \
  --attempt-dir "$ATTEMPT_DIR" \
  --release-dir "$RELEASE_DIR" >/dev/null
FINAL_ARTIFACT="$RELEASE_DIR/$(basename "$DRAFT_ARTIFACT")"
FINAL_ARCHIVE="$RELEASE_DIR/$(basename "$DRAFT_ARCHIVE")"
ATTEMPT_DIR=""
if [[ "$VERIFY" -eq 1 ]]; then
  printf 'junto: source/package parity and Linux x64 execution audit passed; installed sandbox and PTY qualification still require the disposable Ubuntu gate.\n'
fi
printf 'junto: built relocatable runtime %s and %s\n' "$FINAL_ARTIFACT" "$FINAL_ARCHIVE"
