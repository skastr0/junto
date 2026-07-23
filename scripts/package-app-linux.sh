#!/usr/bin/env bash
# Native Ubuntu 24.04 x64 package seam. It emits the diagnostic unpacked tree
# and the canonical deb from the same target-native Electron rebuild.
set -euo pipefail

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
bun rebuild node-pty
bunx electron-builder --linux dir deb --x64
finalized="$(bun "$SCRIPT_DIR/finalize-linux-package.ts" --release-dir "$SCRIPT_DIR/../release")"
unpacked="$(printf '%s' "$finalized" | bun -e 'const value = await Bun.stdin.json(); if (typeof value.artifact !== "string") process.exit(1); process.stdout.write(value.artifact)')"
deb="$(printf '%s' "$finalized" | bun -e 'const value = await Bun.stdin.json(); if (typeof value.deb !== "string") process.exit(1); process.stdout.write(value.deb)')"
bun "$SCRIPT_DIR/audit-linux-package.ts" --unpacked "$unpacked" --deb "$deb"
if [[ "$VERIFY" -eq 1 ]]; then
  printf 'vellum: source/package audit passed; installed sandbox and PTY qualification still require the disposable Ubuntu gate.\n'
fi
printf 'vellum: built %s and %s\n' "$unpacked" "$deb"
