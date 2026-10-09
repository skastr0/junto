#!/usr/bin/env bash
# Production-shaped preview. Default: fresh state, never a production copy.
# --prepare builds without launching; --copy refuses launch until guaranteed inert.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
PREVIEW_HOME="${HOME}/.junto-preview"
COPY_HOME="${HOME}/.junto-preview-copy"
BUILD_ROOT="${HOME}/.junto-preview-builds"
MODE="launch"
case "${1:-}" in
  "") ;;
  --prepare) MODE="prepare" ;;
  --copy) printf '%s\n' 'Junto PREVIEW: copied-state launch refused. Main can wake copied seats and resume real harness sessions; no inert guarantee exists.' >&2; exit 1 ;;
  --check)
    cd "$ROOT"
    mkdir -p node_modules/.cache/junto-preview-tools
    bun build scripts/preview-db-check.ts --target=node --packages=external --outfile=node_modules/.cache/junto-preview-tools/preview-db-check.js --format=esm >&2
    JUNTO_HOME="$COPY_HOME" exec node node_modules/.cache/junto-preview-tools/preview-db-check.js
    ;;
  --snapshot)
    cd "$ROOT"
    exec node scripts/preview-snapshot.ts
    ;;
  --migrate)
    cd "$ROOT"
    mkdir -p node_modules/.cache/junto-preview-tools
    bun build scripts/preview-migrate.ts --target=node --packages=external --outfile=node_modules/.cache/junto-preview-tools/preview-migrate.js --format=esm >&2
    JUNTO_HOME="$COPY_HOME" exec node node_modules/.cache/junto-preview-tools/preview-migrate.js
    ;;
  --clean)
    if [[ -L "$COPY_HOME" || ( -e "$COPY_HOME" && ! -d "$COPY_HOME" ) ]]; then
      printf '%s\n' 'Junto PREVIEW: refusing cleanup of a symlink or non-directory.' >&2; exit 1
    fi
    # Explicit operator request only. Never remove the live or fresh homes.
    rm -rf -- "$COPY_HOME"
    printf 'Junto PREVIEW: removed credential-bearing migration copy %s\n' "$COPY_HOME"
    exit 0
    ;;
  --help|-h)
    printf '%s\n' 'Usage: scripts/preview.sh [--prepare|--snapshot|--migrate|--check|--copy|--clean]' \
      'Default: build and launch with fresh ~/.junto-preview, create a NEW canvas for QA.' \
      '--prepare: build only. --snapshot: read-only SQLite backups into ~/.junto-preview-copy.' \
      '--migrate: headless StateEngine on copy only. --check: compare it with untouched baseline. --copy: launch blocked.' \
      '--clean: delete only ~/.junto-preview-copy, including its copied credentials.'
    exit 0
    ;;
  *) printf 'Unknown preview option: %s\n' "$1" >&2; exit 1 ;;
esac
[[ $# -le 1 ]] || { printf '%s\n' 'Junto PREVIEW: one option at a time.' >&2; exit 1; }
[[ "$(uname -s)" == Darwin ]] || { printf '%s\n' 'Junto PREVIEW: this launcher packages macOS.' >&2; exit 1; }
for directory in "$PREVIEW_HOME" "$BUILD_ROOT" "$COPY_HOME"; do
  [[ ! -L "$directory" ]] || { printf 'Junto PREVIEW: refusing symlink %s\n' "$directory" >&2; exit 1; }
done
mkdir -p "$PREVIEW_HOME" "$BUILD_ROOT"
chmod 700 "$PREVIEW_HOME" "$BUILD_ROOT"
if [[ -d "$COPY_HOME" ]]; then
  chmod 700 "$COPY_HOME"
  printf 'Junto PREVIEW: migration copy %s is mode 700 and contains copied credentials; remove with --clean.\n' "$COPY_HOME"
fi
if [[ -e "$PREVIEW_HOME/snapshot.json" || -e "$PREVIEW_HOME/before" ]]; then
  printf '%s\n' 'Junto PREVIEW: refusing copied state in the fresh home.' >&2; exit 1
fi
# An existing home must have been minted by this fresh launcher, never adopted.
if [[ ! -f "$PREVIEW_HOME/.fresh-preview" ]]; then
  if [[ -n "$(find "$PREVIEW_HOME" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    printf '%s\n' 'Junto PREVIEW: fresh home is not empty; refusing to adopt it.' >&2; exit 1
  fi
  printf '%s\n' 'Fresh preview, no production seed.' > "$PREVIEW_HOME/.fresh-preview"
  chmod 600 "$PREVIEW_HOME/.fresh-preview"
fi
# Never inherit this seat's live control credentials or testing/runtime overrides.
PREVIEW_LOCK_HOME="${JUNTO_APP_RUN_LOCK_HOME:-$PREVIEW_HOME/locks}"
PREVIEW_MACHINE_BUNDLES="${JUNTO_PREVIEW_MACHINE_BUNDLES:-$ROOT/dist/machines}"
while IFS= read -r name; do unset "$name"; done < <(compgen -v JUNTO_)
export JUNTO_HOME="$PREVIEW_HOME" JUNTO_APP_RUN_LOCK_HOME="$PREVIEW_LOCK_HOME"
COMMIT="$(git -C "$ROOT" rev-parse refs/heads/main)"
CHECKOUT="$BUILD_ROOT/$COMMIT"
if [[ ! -d "$CHECKOUT" ]]; then
  EXPORT="$(mktemp -d "$BUILD_ROOT/.export-XXXXXX")"
  git -C "$ROOT" archive "$COMMIT" | tar -xf - -C "$EXPORT"
  # Keep the exact commit and index for package provenance, without a worktree
  # registration or branch. This directory is only a disposable build export.
  git -C "$EXPORT" init -q
  git -C "$EXPORT" fetch -q --no-tags --depth=1 "$ROOT" "$COMMIT"
  git -C "$EXPORT" update-ref --no-deref HEAD "$COMMIT"
  git -C "$EXPORT" read-tree "$COMMIT"
  mv "$EXPORT" "$CHECKOUT"
fi
if [[ ! -d "$CHECKOUT/node_modules" ]]; then
  # APFS clone: isolated native rebuilds cannot alter the shared tree's PTY binary.
  cp -cR "$ROOT/node_modules" "$CHECKOUT/node_modules"
fi
# A link back into the shared tree makes the bundler resolve a second React.
find "$CHECKOUT/node_modules" -maxdepth 1 -type l -name node_modules -delete
cd "$CHECKOUT"
PINNED_BUN="$(node -e 'process.stdout.write(require("./package.json").packageManager.replace(/^bun@/,""))')"
if [[ "$(bun --version)" != "$PINNED_BUN" ]]; then
  BUN_PREFIX="$(mise where "bun@$PINNED_BUN")"
  export PATH="$BUN_PREFIX/bin:$PATH"
fi
if [[ ! -f .preview-build-ready ]]; then
  # The window sends these exact builds, so validate both before packaging.
  JUNTO_FLEET_UI=1 bun -e '
    import { inspectMachineBundle } from "./src/main/junto/hosts/bundle";
    import { buildIdentity } from "./scripts/build-identity";
    const build = buildIdentity(process.cwd());
    for (const target of ["darwin-arm64", "linux-x64"]) {
      const manifest = await inspectMachineBundle(process.argv[1] + "/" + target);
      if (manifest.target !== target || manifest.build !== build) {
        throw new Error("Rebuild the " + target + " machine bundle from this commit with JUNTO_FLEET_UI=1");
      }
    }
  ' "$PREVIEW_MACHINE_BUNDLES"
  mkdir -p dist
  cp -cR "$PREVIEW_MACHINE_BUNDLES" dist/machines
  JUNTO_PREVIEW_BUILD=1 JUNTO_FLEET_UI=1 JUNTO_ALLOW_FEATURE_OVERRIDES=1 bash scripts/build-app.sh --target mac --fast
  printf '%s\n' "$COMMIT" > .preview-build-ready
fi
case "$(uname -m)" in arm64) ARCH_DIR=mac-arm64 ;; x86_64) ARCH_DIR=mac ;; *) exit 1 ;; esac
APP="$CHECKOUT/release/$ARCH_DIR/Junto.app"
[[ -d "$APP" ]] || { printf '%s\n' 'Junto PREVIEW: packaged app is missing.' >&2; exit 1; }
printf 'Junto PREVIEW: build %s, FRESH JUNTO_HOME=%s, Electron data isolated, HOME unchanged.\n' "$COMMIT" "$PREVIEW_HOME"
printf '%s\n' 'QA: create a NEW canvas. This fresh instance contains no real canvases, credentials or session IDs.'
if [[ "$MODE" == prepare ]]; then
  printf '%s\n' 'Prepared without launching. Run scripts/preview.sh to launch this build.'
  exit 0
fi
export JUNTO_HOME="$PREVIEW_HOME" JUNTO_PREVIEW=1
exec "$APP/Contents/MacOS/Junto" --junto-operator-control --user-data-dir="$PREVIEW_HOME/.junto/electron-user-data"
