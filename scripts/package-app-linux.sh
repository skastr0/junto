#!/usr/bin/env bash
# Native Linux package seam. LX-005 owns deb/sandbox/systemd policy.
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  printf 'vellum: error: native linux packaging must run on Linux\n' >&2
  exit 1
fi
if [[ $# -ne 0 ]]; then
  printf 'vellum: error: unsupported Linux package option: %s\n' "$1" >&2
  exit 1
fi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
bun rebuild node-pty
bunx electron-builder --linux --dir
bun "$SCRIPT_DIR/finalize-linux-package.ts" --release-dir "$SCRIPT_DIR/../release"
printf 'vellum: Linux unpacked package complete; deb policy is deferred to LX-005.\n'
