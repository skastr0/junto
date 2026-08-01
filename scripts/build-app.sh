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
        printf 'vellum: error: --target requires mac or linux\n' >&2
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

BUN_EXECUTABLE="$(type -P bun || true)"
if [[ -z "$BUN_EXECUTABLE" || ! -x "$BUN_EXECUTABLE" ]]; then
  printf 'vellum: error: Bun is required to resolve the license build profile\n' >&2
  exit 1
fi
if [[ -n "${VELLUM_LICENSE_CHANNEL:-}" && "$VELLUM_LICENSE_CHANNEL" != "production" ]]; then
  printf 'vellum: error: packaged builds require VELLUM_LICENSE_CHANNEL=production\n' >&2
  exit 1
fi
export VELLUM_LICENSE_CHANNEL="production"
LICENSE_PROFILE_FIELDS="$(
  "$BUN_EXECUTABLE" "$SCRIPT_DIR/license-build-profile.ts" --fields
)"
IFS=$'\t' read -r \
  VELLUM_LICENSE_CHANNEL \
  VELLUM_LICENSE_ENVIRONMENT \
  VELLUM_DODO_BUSINESS_ID \
  VELLUM_DODO_PRODUCT_ID \
  <<< "$LICENSE_PROFILE_FIELDS"
if [[
  -z "$VELLUM_LICENSE_CHANNEL" ||
  -z "$VELLUM_LICENSE_ENVIRONMENT" ||
  -z "$VELLUM_DODO_BUSINESS_ID" ||
  -z "$VELLUM_DODO_PRODUCT_ID"
 ]]; then
  printf 'vellum: error: license build profile resolver returned incomplete fields\n' >&2
  exit 1
fi
export VELLUM_LICENSE_CHANNEL
export VELLUM_DODO_BUSINESS_ID
export VELLUM_DODO_PRODUCT_ID
printf \
  'vellum: license build profile %s → Dodo %s (%s / %s)\n' \
  "$VELLUM_LICENSE_CHANNEL" \
  "$VELLUM_LICENSE_ENVIRONMENT" \
  "$VELLUM_DODO_BUSINESS_ID" \
  "$VELLUM_DODO_PRODUCT_ID"
if [[ "$LICENSE_PREFLIGHT_ONLY" -eq 1 ]]; then
  exit 0
fi

cd "$REPO_ROOT"
ELECTRON_INSTALLER="$REPO_ROOT/node_modules/electron/install.js"
NODE_EXECUTABLE="$(type -P node || true)"
if [[ -z "$NODE_EXECUTABLE" || ! -x "$NODE_EXECUTABLE" ]]; then
  printf 'vellum: error: Node is required to materialize the pinned Electron runtime\n' >&2
  exit 1
fi
if [[ ! -f "$ELECTRON_INSTALLER" || -L "$ELECTRON_INSTALLER" ]]; then
  printf 'vellum: error: Electron installer missing — run: bun install --frozen-lockfile\n' >&2
  exit 1
fi
printf 'vellum: materializing pinned Electron runtime …\n'
"$NODE_EXECUTABLE" "$ELECTRON_INSTALLER"
printf 'vellum: validating checked-in Electron security policy …\n'
bun "$SCRIPT_DIR/electron-security-policy.ts" validate
if [[ ! -d node_modules/electron-builder ]]; then
  printf 'vellum: error: electron-builder missing — run: bun install\n' >&2
  exit 1
fi
if [[ "$VERIFY" -eq 1 ]]; then
  # Keep the ship path aligned with `bun run verify`: the public product name
  # is a customer-visible contract and must not be bypassable by packaging.
  bun run lint:product-name
  bun run typecheck
  # Tests that rebuild out/ (kernel headless probe) must not inherit the
  # packaged beta/production license defines — those require activation in an
  # isolated HOME and deny headless Command Center startup. Packaging below
  # still builds with VELLUM_LICENSE_* set for the real ship bundle.
  env -u VELLUM_LICENSE_CHANNEL -u VELLUM_DODO_BUSINESS_ID -u VELLUM_DODO_PRODUCT_ID \
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
printf 'vellum: auditing compiled license binding …\n'
bun "$SCRIPT_DIR/audit-license-build.ts" \
  --bundle "$REPO_ROOT/out/main/index.js" \
  --expected-production
printf 'vellum: standalone work CLI → dist/vellum …\n'
build_compiled_cli "$REPO_ROOT/dist/vellum" src/cli/main.ts
printf 'vellum: standalone browser CLI → dist/vellum-browser …\n'
build_compiled_cli "$REPO_ROOT/dist/vellum-browser" scripts/browser-cli.ts
printf 'vellum: standalone station CLI → dist/vellum-station …\n'
build_compiled_cli "$REPO_ROOT/dist/vellum-station" scripts/station-cli.ts
printf 'vellum: standalone content CLI → dist/vellum-content …\n'
build_compiled_cli "$REPO_ROOT/dist/vellum-content" scripts/content-cli.ts
if [[ "$COMPILE_ONLY" -eq 1 ]]; then
  printf 'vellum: compile-only done (out/ + standalone controls). Skip packaging.\n'
  exit 0
fi

args=()
[[ "$VERIFY" -eq 1 ]] && args+=(--verify)
[[ "$NOTARIZE" -eq 1 ]] && args+=(--notarize)
case "$TARGET" in
  mac) exec bash "$SCRIPT_DIR/package-app-macos.sh" "${args[@]+"${args[@]}"}" ;;
  linux) exec bash "$SCRIPT_DIR/package-app-linux.sh" "${args[@]+"${args[@]}"}" ;;
esac
