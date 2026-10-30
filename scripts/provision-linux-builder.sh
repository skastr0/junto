#!/usr/bin/env bash
# Provisions the junto Orb machine, the native Linux x64 builder that
# build-machine-payloads.sh drives (JUNTO_MACHINE_LINUX_ORB=junto): Node, the
# pinned Bun, and rustup with the toolchain native/cli/rust-toolchain.toml pins.
#
#   orb create -a amd64 ubuntu:noble junto
#   orb -m junto bash scripts/provision-linux-builder.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
NODE_VERSION=24.18.0
NODE="node-v$NODE_VERSION-linux-x64"
BUN_VERSION="$(sed -n 's/.*"packageManager": "bun@\([^"]*\)".*/\1/p' "$REPO_ROOT/package.json")"
[[ -n "$BUN_VERSION" ]] || { printf 'junto: error: package.json pins no Bun\n' >&2; exit 1; }

sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq build-essential git python3 curl unzip xz-utils ca-certificates >/dev/null
mkdir -p "$HOME/.local/bin"
export PATH="$HOME/.local/bin:$PATH"

# Node, checked against nodejs.org's SHASUMS256.
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
curl -fsSL -o "$scratch/$NODE.tar.xz" "https://nodejs.org/dist/v$NODE_VERSION/$NODE.tar.xz"
curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" | grep " $NODE.tar.xz\$" | (cd "$scratch" && sha256sum -c -)
tar -xJf "$scratch/$NODE.tar.xz" -C "$HOME/.local"
for bin in node npm npx corepack; do ln -sf "$HOME/.local/$NODE/bin/$bin" "$HOME/.local/bin/$bin"; done

# Bun, as package.json's packageManager pins it.
curl -fsSL https://bun.sh/install | BUN_INSTALL="$HOME/.bun" bash -s "bun-v$BUN_VERSION" >/dev/null
ln -sf "$HOME/.bun/bin/bun" "$HOME/.local/bin/bun"
ln -sf "$HOME/.bun/bin/bun" "$HOME/.local/bin/bunx"

# rustup with no default: the crate's rust-toolchain.toml names the toolchain.
curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none --no-modify-path >/dev/null
for bin in rustup cargo rustc; do ln -sf "$HOME/.cargo/bin/$bin" "$HOME/.local/bin/$bin"; done
(cd "$REPO_ROOT/native/cli" && rustup toolchain install >/dev/null)

printf 'node %s, bun %s, %s\n' "$(node --version)" "$(bun --version)" "$(cd "$REPO_ROOT/native/cli" && cargo --version)"
