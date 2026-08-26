#!/usr/bin/env bash
# Compile Vellum Command and package for one explicit native target.
#
#   scripts/build-app.sh --target mac|linux [--fast] [--verify] [--notarize]
#   scripts/build-app.sh --compile-only
#   scripts/build-app.sh --license-preflight-only
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"

TARGET=""
FAST=0
VERIFY=0
COMPILE_ONLY=0
NOTARIZE=0
LICENSE_PREFLIGHT_ONLY=0

usage() {
  sed -n '2,6p' "$0" | sed 's/^# \?//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      [[ $# -ge 2 && -n "$2" ]] || {
        printf 'vellum-command: error: --target requires mac or linux\n' >&2
        exit 1
      }
      TARGET="$2"
      shift 2
      ;;
    --mac) TARGET="mac"; shift ;;
    --linux) TARGET="linux"; shift ;;
    --fast) FAST=1; shift ;;
    --verify) VERIFY=1; shift ;;
    --notarize) NOTARIZE=1; shift ;;
    --compile-only) COMPILE_ONLY=1; shift ;;
    --license-preflight-only) LICENSE_PREFLIGHT_ONLY=1; shift ;;
    -h|--help) usage 0 ;;
    *) printf 'vellum-command: error: unknown flag: %s\n' "$1" >&2; usage 1 ;;
  esac
done

if [[ -z "$TARGET" ]]; then
  case "$(uname -s)" in
    Darwin) TARGET="mac" ;;
    Linux) TARGET="linux" ;;
    *) printf 'vellum-command: error: unsupported host OS: %s\n' "$(uname -s)" >&2; exit 1 ;;
  esac
fi
case "$TARGET" in mac|linux) ;; *) printf 'vellum-command: error: target must be mac or linux\n' >&2; exit 1 ;; esac
if [[ "$TARGET" == "mac" && "$(uname -s)" != "Darwin" ]] || [[ "$TARGET" == "linux" && "$(uname -s)" != "Linux" ]]; then
  printf 'vellum-command: error: native %s packaging must run on its target OS\n' "$TARGET" >&2
  exit 1
fi
if [[ "$NOTARIZE" -eq 1 && "$TARGET" != "mac" ]]; then
  printf 'vellum-command: error: notarization is only available for the mac target\n' >&2
  exit 1
fi

BUN_EXECUTABLE="$(type -P bun || true)"
if [[ -z "$BUN_EXECUTABLE" || ! -x "$BUN_EXECUTABLE" ]]; then
  printf 'vellum-command: error: Bun is required to resolve the license build profile\n' >&2
  exit 1
fi
if [[ -n "${VELLUM_COMMAND_LICENSE_CHANNEL:-}" && "$VELLUM_COMMAND_LICENSE_CHANNEL" != "production" ]]; then
  printf 'vellum-command: error: packaged builds require VELLUM_COMMAND_LICENSE_CHANNEL=production\n' >&2
  exit 1
fi
export VELLUM_COMMAND_LICENSE_CHANNEL="production"
LICENSE_PROFILE_FIELDS="$(
  "$BUN_EXECUTABLE" "$SCRIPT_DIR/license-build-profile.ts" --fields
)"
IFS=$'\t' read -r \
  VELLUM_COMMAND_LICENSE_CHANNEL \
  VELLUM_COMMAND_DODO_BUSINESS_ID \
  VELLUM_COMMAND_DODO_PRODUCT_IDS \
  <<< "$LICENSE_PROFILE_FIELDS"
if [[
  -z "$VELLUM_COMMAND_LICENSE_CHANNEL" ||
  -z "$VELLUM_COMMAND_DODO_BUSINESS_ID" ||
  -z "$VELLUM_COMMAND_DODO_PRODUCT_IDS"
 ]]; then
  printf 'vellum-command: error: license build profile resolver returned incomplete fields\n' >&2
  exit 1
fi
export VELLUM_COMMAND_LICENSE_CHANNEL
export VELLUM_COMMAND_DODO_BUSINESS_ID
export VELLUM_COMMAND_DODO_PRODUCT_IDS
export VELLUM_COMMAND_FEATURE_PROFILE="${VELLUM_COMMAND_FEATURE_PROFILE:-ship}"
FEATURE_DEVIATION="$(
  "$BUN_EXECUTABLE" "$SCRIPT_DIR/build-features.ts" --ship-deviation
)"
if [[ -n "$FEATURE_DEVIATION" && "${VELLUM_COMMAND_ALLOW_FEATURE_OVERRIDES:-}" != "1" ]]; then
  printf \
    'vellum-command: error: ship feature deviation requires VELLUM_COMMAND_ALLOW_FEATURE_OVERRIDES=1 (%s)\n' \
    "$FEATURE_DEVIATION" >&2
  exit 1
fi
FEATURE_RECEIPT="$(
  "$BUN_EXECUTABLE" "$SCRIPT_DIR/build-features.ts" --receipt
)"
printf \
  'vellum-command: license build profile %s → Dodo Live (%s / %s)\n' \
  "$VELLUM_COMMAND_LICENSE_CHANNEL" \
  "$VELLUM_COMMAND_DODO_BUSINESS_ID" \
  "$VELLUM_COMMAND_DODO_PRODUCT_IDS"
printf 'vellum-command: feature build receipt %s\n' "$FEATURE_RECEIPT"
if [[ "$LICENSE_PREFLIGHT_ONLY" -eq 1 ]]; then
  exit 0
fi

cd "$REPO_ROOT"
if [[ "$COMPILE_ONLY" -eq 0 ]]; then
  printf 'vellum-command: package source provenance preflight …\n'
  "$BUN_EXECUTABLE" "$SCRIPT_DIR/package-runtime-provenance.ts" \
    preflight --target "$TARGET"
fi
ELECTRON_INSTALLER="$REPO_ROOT/node_modules/electron/install.js"
NODE_EXECUTABLE="$(type -P node || true)"
if [[ "$TARGET" == "linux" ]]; then
  REQUIRED_NODE_VERSION="$("$BUN_EXECUTABLE" -e 'import { DEFAULT_NODE_REMOTE_VERSION } from "./scripts/build-linux-remote-runtime.ts"; process.stdout.write(DEFAULT_NODE_REMOTE_VERSION)')"
  NODE_VERSION=""
  if [[ -n "$NODE_EXECUTABLE" && -x "$NODE_EXECUTABLE" ]]; then
    NODE_VERSION="$("$NODE_EXECUTABLE" --version 2>/dev/null || true)"
  fi
  if [[ "$NODE_VERSION" != "v$REQUIRED_NODE_VERSION" ]]; then
    printf 'vellum-command: error: Linux build requires stock Node %s exactly; found %s\n' \
      "$REQUIRED_NODE_VERSION" "${NODE_VERSION:-missing}" >&2
    exit 1
  fi
elif [[ -z "$NODE_EXECUTABLE" || ! -x "$NODE_EXECUTABLE" ]]; then
  printf 'vellum-command: error: Node is required to materialize the pinned Electron runtime\n' >&2
  exit 1
fi

if [[ ! -f "$ELECTRON_INSTALLER" || -L "$ELECTRON_INSTALLER" ]]; then
  printf 'vellum-command: error: Electron installer missing — run: bun install --frozen-lockfile\n' >&2
  exit 1
fi
printf 'vellum-command: materializing pinned Electron runtime …\n'
"$NODE_EXECUTABLE" "$ELECTRON_INSTALLER"
if [[ ! -d node_modules/electron-builder ]]; then
  printf 'vellum-command: error: electron-builder missing — run: bun install\n' >&2
  exit 1
fi
if [[ "$VERIFY" -eq 1 ]]; then
  # Keep the ship path aligned with `bun run verify`: the public product name
  # is a customer-visible contract and must not be bypassable by packaging.
  bun run lint:product-name
  bun run typecheck
  # Tests that rebuild out/ (kernel headless probe) must not inherit the
  # packaged production license defines — those require activation in an
  # isolated HOME and deny headless Command Center startup. Packaging below
  # still builds with VELLUM_COMMAND_LICENSE_* set for the real ship bundle.
  env -u VELLUM_COMMAND_LICENSE_CHANNEL -u VELLUM_COMMAND_DODO_BUSINESS_ID -u VELLUM_COMMAND_DODO_PRODUCT_IDS \
    bun run test
  env -u VELLUM_COMMAND_LICENSE_CHANNEL -u VELLUM_COMMAND_DODO_BUSINESS_ID -u VELLUM_COMMAND_DODO_PRODUCT_IDS \
    bun run test:features:ship
elif [[ "$FAST" -eq 0 ]]; then
  bun run typecheck
fi

build_compiled_cli() {
  local output="$1" source="$2" stage="${1}.new.$$"
  local feature_define_args=()
  while IFS= read -r feature_define_arg; do
    [[ -n "$feature_define_arg" ]] && feature_define_args+=("$feature_define_arg")
  done < <("$BUN_EXECUTABLE" "$SCRIPT_DIR/build-features.ts" --bun-define-args)
  mkdir -p "$(dirname "$output")"
  bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig \
    --no-compile-autoload-tsconfig --no-compile-autoload-package-json \
    "${feature_define_args[@]}" --outfile "$stage" "$source"
  chmod 0755 "$stage"
  mv "$stage" "$output"
}

printf 'vellum-command: electron-vite build → out/ …\n'
bunx electron-vite build
printf 'vellum-command: standalone CLI → dist/vellum-command …\n'
build_compiled_cli "$REPO_ROOT/dist/vellum-command" src/cli/main.ts
if [[ "$COMPILE_ONLY" -eq 1 ]]; then
  printf 'vellum-command: compile-only done (out/ + standalone CLI). Skip packaging.\n'
  exit 0
fi

args=()
[[ "$VERIFY" -eq 1 ]] && args+=(--verify)
[[ "$NOTARIZE" -eq 1 ]] && args+=(--notarize)
case "$TARGET" in
  mac) exec bash "$SCRIPT_DIR/package-app-macos.sh" "${args[@]+"${args[@]}"}" ;;
  linux) exec bash "$SCRIPT_DIR/package-app-linux.sh" "${args[@]+"${args[@]}"}" ;;
esac
