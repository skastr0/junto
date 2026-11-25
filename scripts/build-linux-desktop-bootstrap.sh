#!/usr/bin/env bash
# Build the native Linux desktop first-install bootstrap and publish it under
# the release name. The bootstrap is Rust (native/linux-desktop-bootstrap);
# no Bun-compiled binary remains.
#
# Builds on Linux only: the release workflow and the checks run on a Linux VM.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TARGET=x86_64-unknown-linux-gnu
NAME=junto-desktop-bootstrap-linux-x64

if [[ "$(uname -s)" != "Linux" ]]; then
  printf 'build-linux-desktop-bootstrap: the bootstrap builds on Linux; run this on the VM or the release workflow\n' >&2
  exit 1
fi

# Run inside the crate so rustup selects its pinned toolchain.
cd "$ROOT/native/linux-desktop-bootstrap"
cargo build --release --locked --target "$TARGET"

mkdir -p "$ROOT/dist"
install -m 0755 "target/$TARGET/release/$NAME" "$ROOT/dist/$NAME"
