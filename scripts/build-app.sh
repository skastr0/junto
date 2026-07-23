#!/usr/bin/env bash
# Compile Vellum and package for one explicit native target.
#
#   scripts/build-app.sh --target mac|linux [--fast] [--verify] [--notarize]
#   scripts/build-app.sh --compile-only
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"

TARGET=""
FAST=0
VERIFY=0
COMPILE_ONLY=0
NOTARIZE=0

usage() {
  sed -n '2,6p' "$0" | sed 's/^# \?//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --mac) TARGET="mac"; shift ;;
    --linux) TARGET="linux"; shift ;;
    --fast) FAST=1; shift ;;
    --verify) VERIFY=1; shift ;;
    --notarize) NOTARIZE=1; shift ;;
    --compile-only) COMPILE_ONLY=1; shift ;;
    -h|--help) usage 0 ;;
    *) printf 'vellum: error: unknown flag: %s\n' "$1" >&2; usage 1 ;;
  esac
done

if [[ -z "$TARGET" ]]; then
  case "$(uname -s)" in
    Darwin) TARGET="mac" ;;
    Linux) TARGET="linux" ;;
    *) printf 'vellum: error: unsupported host OS: %s\n' "$(uname -s)" >&2; exit 1 ;;
  esac
fi
case "$TARGET" in mac|linux) ;; *) printf 'vellum: error: target must be mac or linux\n' >&2; exit 1 ;; esac
if [[ "$TARGET" == "mac" && "$(uname -s)" != "Darwin" ]] || [[ "$TARGET" == "linux" && "$(uname -s)" != "Linux" ]]; then
  printf 'vellum: error: native %s packaging must run on its target OS\n' "$TARGET" >&2
  exit 1
fi
if [[ "$NOTARIZE" -eq 1 && "$TARGET" != "mac" ]]; then
  printf 'vellum: error: notarization is only available for the mac target\n' >&2
  exit 1
fi

cd "$REPO_ROOT"
printf 'vellum: validating checked-in Electron security policy …\n'
bun "$SCRIPT_DIR/electron-security-policy.ts" validate
if [[ ! -d node_modules/electron-builder ]]; then
  printf 'vellum: error: electron-builder missing — run: bun install\n' >&2
  exit 1
fi
if [[ "$VERIFY" -eq 1 ]]; then
  bun run typecheck
  bun run test
elif [[ "$FAST" -eq 0 ]]; then
  bun run typecheck
fi

build_compiled_cli() {
  local output="$1" source="$2" stage="${1}.new.$$"
  mkdir -p "$(dirname "$output")"
  bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig \
    --no-compile-autoload-tsconfig --no-compile-autoload-package-json \
    --outfile "$stage" "$source"
  chmod 0755 "$stage"
  mv "$stage" "$output"
}

printf 'vellum: electron-vite build → out/ …\n'
bunx electron-vite build
printf 'vellum: standalone work CLI → dist/vellum …\n'
build_compiled_cli "$REPO_ROOT/dist/vellum" src/cli/main.ts
printf 'vellum: standalone browser CLI → dist/vellum-browser …\n'
build_compiled_cli "$REPO_ROOT/dist/vellum-browser" scripts/browser-cli.ts

if [[ "$COMPILE_ONLY" -eq 1 ]]; then
  printf 'vellum: compile-only done (out/ + dist/vellum + dist/vellum-browser). Skip packaging.\n'
  exit 0
fi

args=()
[[ "$VERIFY" -eq 1 ]] && args+=(--verify)
[[ "$NOTARIZE" -eq 1 ]] && args+=(--notarize)
case "$TARGET" in
  mac) exec bash "$SCRIPT_DIR/package-app-macos.sh" "${args[@]+"${args[@]}"}" ;;
  linux) exec bash "$SCRIPT_DIR/package-app-linux.sh" "${args[@]+"${args[@]}"}" ;;
esac
