#!/usr/bin/env bash
# Compile Junto and package for one explicit native target.
#
#   scripts/build-app.sh --target mac|linux [--fast] [--verify] [--sign] [--notarize]
#   scripts/build-app.sh --compile-only
#   scripts/build-app.sh --preflight-only
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"

TARGET=""
FAST=0
VERIFY=0
COMPILE_ONLY=0
NOTARIZE=0
SIGN=0
PREFLIGHT_ONLY=0

usage() {
  sed -n '2,6p' "$0" | sed 's/^# \?//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      [[ $# -ge 2 && -n "$2" ]] || {
        printf 'junto: error: --target requires mac or linux\n' >&2
        exit 1
      }
      TARGET="$2"
      shift 2
      ;;
    --mac) TARGET="mac"; shift ;;
    --linux) TARGET="linux"; shift ;;
    --fast) FAST=1; shift ;;
    --verify) VERIFY=1; shift ;;
    --notarize) NOTARIZE=1; SIGN=1; shift ;;
    --sign) SIGN=1; shift ;;
    --compile-only) COMPILE_ONLY=1; shift ;;
    --preflight-only) PREFLIGHT_ONLY=1; shift ;;
    -h|--help) usage 0 ;;
    *) printf 'junto: error: unknown flag: %s\n' "$1" >&2; usage 1 ;;
  esac
done

if [[ -z "$TARGET" ]]; then
  case "$(uname -s)" in
    Darwin) TARGET="mac" ;;
    Linux) TARGET="linux" ;;
    *) printf 'junto: error: unsupported host OS: %s\n' "$(uname -s)" >&2; exit 1 ;;
  esac
fi
case "$TARGET" in mac|linux) ;; *) printf 'junto: error: target must be mac or linux\n' >&2; exit 1 ;; esac
if [[ "$TARGET" == "mac" && "$(uname -s)" != "Darwin" ]] || [[ "$TARGET" == "linux" && "$(uname -s)" != "Linux" ]]; then
  printf 'junto: error: %s packaging must run in its target OS execution environment\n' "$TARGET" >&2
  exit 1
fi
if [[ "$NOTARIZE" -eq 1 && "$TARGET" != "mac" ]]; then
  printf 'junto: error: notarization is only available for the mac target\n' >&2
  exit 1
fi
if [[ "$SIGN" -eq 1 && "$TARGET" != "mac" ]]; then
  printf 'junto: error: --sign selects macOS signing; Linux release manifests use linux-release-tool.ts\n' >&2
  exit 1
fi
BUN_EXECUTABLE="$(type -P bun || true)"
if [[ -z "$BUN_EXECUTABLE" || ! -x "$BUN_EXECUTABLE" ]]; then
  printf 'junto: error: Bun is required to compile Junto\n' >&2
  exit 1
fi
if [[ "$SIGN" -eq 1 ]]; then
  "$BUN_EXECUTABLE" "$SCRIPT_DIR/mac-signing-config.mjs" --check
fi
export JUNTO_FEATURE_PROFILE="${JUNTO_FEATURE_PROFILE:-ship}"
FEATURE_DEVIATION="$(
  "$BUN_EXECUTABLE" "$SCRIPT_DIR/build-features.ts" --ship-deviation
)"
if [[ -n "$FEATURE_DEVIATION" && "${JUNTO_ALLOW_FEATURE_OVERRIDES:-}" != "1" ]]; then
  printf \
    'junto: error: ship feature deviation requires JUNTO_ALLOW_FEATURE_OVERRIDES=1 (%s)\n' \
    "$FEATURE_DEVIATION" >&2
  exit 1
fi
FEATURE_RECEIPT="$(
  "$BUN_EXECUTABLE" "$SCRIPT_DIR/build-features.ts" --receipt
)"
printf 'junto: feature build receipt %s\n' "$FEATURE_RECEIPT"
if [[ "$PREFLIGHT_ONLY" -eq 1 ]]; then
  exit 0
fi

cd "$REPO_ROOT"
# Compiled CLIs embed Bun itself. Keep its runtime and redistributed notices
# aligned with the reviewed compiler version, even on a newer developer shell.
PINNED_BUN_VERSION="$("$BUN_EXECUTABLE" -e 'const manager = require("./package.json").packageManager; if (!/^bun@[0-9]+\.[0-9]+\.[0-9]+$/.test(manager)) throw new Error("packageManager must pin Bun"); process.stdout.write(manager.slice(4))')"
COMPILER_BUN_VERSION="$("$BUN_EXECUTABLE" --version)"
if [[ "$COMPILER_BUN_VERSION" != "$PINNED_BUN_VERSION" ]]; then
  printf 'junto: error: packaging embeds Bun; use the pinned Bun %s (found %s) so runtime notices match\n' "$PINNED_BUN_VERSION" "$COMPILER_BUN_VERSION" >&2
  exit 1
fi
ELECTRON_INSTALLER="$REPO_ROOT/node_modules/electron/install.js"
NODE_EXECUTABLE="$(type -P node || true)"
if [[ -z "$NODE_EXECUTABLE" || ! -x "$NODE_EXECUTABLE" ]]; then
  printf 'junto: error: Node is required to materialize the pinned Electron runtime\n' >&2
  exit 1
fi

if [[ ! -f "$ELECTRON_INSTALLER" || -L "$ELECTRON_INSTALLER" ]]; then
  printf 'junto: error: Electron installer missing — run: bun install --frozen-lockfile\n' >&2
  exit 1
fi
printf 'junto: materializing pinned Electron runtime …\n'
"$NODE_EXECUTABLE" "$ELECTRON_INSTALLER"
if [[ ! -d node_modules/electron-builder ]]; then
  printf 'junto: error: electron-builder missing — run: bun install\n' >&2
  exit 1
fi
if [[ "$VERIFY" -eq 1 ]]; then
  # Keep the ship path aligned with `bun run verify`: the public product name
  # is a customer-visible contract and must not be bypassable by packaging.
  bun run lint:product-name
  bun run typecheck
  bun run test
  bun run test:features:ship
elif [[ "$FAST" -eq 0 ]]; then
  bun run typecheck
fi

printf 'junto: building fresh package runtimes …\n'
"$BUN_EXECUTABLE" "$SCRIPT_DIR/package-runtime-provenance.ts" \
  prepare --target "$TARGET" >/dev/null
printf 'junto: standalone CLI → dist/junto …\n'
"$BUN_EXECUTABLE" "$SCRIPT_DIR/build-standalone-cli.ts" junto
if [[ "$COMPILE_ONLY" -eq 1 ]]; then
  printf 'junto: compile-only done (fresh runtime cohort + standalone CLI). Skip packaging.\n'
  exit 0
fi

args=()
[[ "$VERIFY" -eq 1 ]] && args+=(--verify)
[[ "$NOTARIZE" -eq 1 ]] && args+=(--notarize)
[[ "$SIGN" -eq 1 ]] && args+=(--sign)
case "$TARGET" in
  mac) exec bash "$SCRIPT_DIR/package-app-macos.sh" "${args[@]+"${args[@]}"}" ;;
  linux) exec bash "$SCRIPT_DIR/package-app-linux.sh" "${args[@]+"${args[@]}"}" ;;
esac
