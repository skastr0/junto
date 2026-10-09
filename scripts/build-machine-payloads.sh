#!/usr/bin/env bash
# Build the two native delivery payloads from this exact desktop source.
# JUNTO_MACHINE_LINUX_ORB names the native Linux x64 Orb builder.
# JUNTO_MACHINE_BUNDLES may supply an already built, matching complete pair.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
cd "$REPO_ROOT"
OUTPUT="$REPO_ROOT/dist/machines"
if [[ -e "$OUTPUT" || -L "$OUTPUT" ]]; then
  bun "$SCRIPT_DIR/machine-package.ts" "$OUTPUT"
  exit 0
fi
if [[ "${1:-}" == "--check" ]]; then
  printf 'junto: error: missing native machine payloads; run build-app.sh first\n' >&2
  exit 1
fi
if [[ -z "${JUNTO_MACHINE_BUNDLES:-}" ]]; then
  if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 || -z "${JUNTO_MACHINE_LINUX_ORB:-}" ]]; then
    printf 'junto: error: machine payloads require native macOS arm64 and JUNTO_MACHINE_LINUX_ORB, or JUNTO_MACHINE_BUNDLES\n' >&2
    exit 1
  fi
  command -v orb >/dev/null
fi
mkdir -p "$REPO_ROOT/dist"
ATTEMPT="$(mktemp -d "$REPO_ROOT/dist/.machine-payloads-XXXXXXXX")"
# Retain a failed attempt for diagnosis. Only a validated complete pair is moved
# into the directory admitted by the desktop packager.
if [[ -n "${JUNTO_MACHINE_BUNDLES:-}" ]]; then
  bun "$SCRIPT_DIR/machine-package.ts" "$JUNTO_MACHINE_BUNDLES"
  cp -R "$JUNTO_MACHINE_BUNDLES/." "$ATTEMPT/"
else
  FEATURE_ENV=()
  while IFS= read -r assignment; do FEATURE_ENV+=("$assignment"); done < <(
    bun -e 'import {resolveBuildFeatures} from "./scripts/build-features"; import {FEATURE_CATALOG} from "./src/shared/feature-catalog"; const r=resolveBuildFeatures(); console.log(`JUNTO_FEATURE_PROFILE=${r.profile}`); for(const [key,spec] of Object.entries(FEATURE_CATALOG)){const tier=r.features[key]; console.log(`${spec.env}=${tier===true?"1":tier===false?"0":"experimental"}`)}'
  )
  DARWIN_INPUT="$(bun -e 'console.log(JSON.stringify({target:"darwin-arm64",output:process.argv[1]}))' "$ATTEMPT/darwin-arm64")"
  env "${FEATURE_ENV[@]}" bun "$SCRIPT_DIR/build-machine.ts" "$DARWIN_INPUT"
  LINUX_INPUT="$(bun -e 'console.log(JSON.stringify({target:"linux-x64",output:process.argv[1]}))' "$ATTEMPT/linux-x64")"
  # Forward only feature choices, never seat tokens or other local credentials.
  orb -m "$JUNTO_MACHINE_LINUX_ORB" bash -lc '
    set -euo pipefail
    cd "$1"; shift
    export PATH="$HOME/.local/bin:$PATH"
    expected="$(bun -e '\''process.stdout.write(require("./package.json").packageManager.slice(4))'\'')"
    [[ "$(bun --version)" == "$expected" ]] || { printf "junto: error: Linux builder must use pinned Bun %s\n" "$expected" >&2; exit 1; }
    exec env "$@"
  ' -- "$REPO_ROOT" "${FEATURE_ENV[@]}" bun scripts/build-machine.ts "$LINUX_INPUT"
fi
bun "$SCRIPT_DIR/machine-package.ts" "$ATTEMPT"
[[ ! -e "$OUTPUT" && ! -L "$OUTPUT" ]] || { printf 'junto: error: machine payload output appeared during build\n' >&2; exit 1; }
mv "$ATTEMPT" "$OUTPUT"
bun "$SCRIPT_DIR/machine-package.ts" "$OUTPUT"
