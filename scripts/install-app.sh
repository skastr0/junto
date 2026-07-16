#!/usr/bin/env bash
# Install a built Vellum.app into /Applications (or $VELLUM_APP_DST).
#
#   scripts/install-app.sh                 build then install
#   scripts/install-app.sh --skip-build    install existing release/*.app
#   scripts/install-app.sh --fast          build --fast then install
#   scripts/install-app.sh --verify        build --verify then install
#   scripts/install-app.sh --open          open the app after install
#   scripts/install-app.sh --supervised    also (re)load LaunchAgent (crash-only KeepAlive)
#
# Safety:
#   - Unloads LaunchAgent before replacing the binary
#   - Soft-quits running app so herdr control streams can detach (never pane-kill)
#   - Validates .app structure + bundle id before ditto
#   - Never runs herdr pane close / session stop
#
# Herdr: quitting Vellum detaches control streams only — your herdr sessions survive.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=app-paths.sh
source "$SCRIPT_DIR/app-paths.sh"

SKIP_BUILD=0
FAST=0
VERIFY=0
OPEN=0
SUPERVISED=0

usage() {
  sed -n '2,18p' "$0" | sed 's/^# \?//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1; shift ;;
    --fast) FAST=1; shift ;;
    --verify) VERIFY=1; shift ;;
    --open) OPEN=1; shift ;;
    --supervised) SUPERVISED=1; shift ;;
    -h|--help) usage 0 ;;
    *) err "unknown flag: $1"; usage 1 ;;
  esac
done

cd "$REPO_ROOT"

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  build_flags=()
  [[ "$FAST" -eq 1 ]] && build_flags+=(--fast)
  [[ "$VERIFY" -eq 1 ]] && build_flags+=(--verify)
  bash "$SCRIPT_DIR/build-app.sh" "${build_flags[@]+"${build_flags[@]}"}"
fi

APP_SRC="$(detect_app_src)"
assert_app_bundle "$APP_SRC"

# Detach before binary swap: launchd unload + soft quit so before-quit runs
# and herdrStreams.detachAllOnQuit releases control (panes stay alive).
unload_launchd
quit_running_app
# Brief settle so control clients exit and release PTYs.
sleep 0.5

log "installing → $APP_DST"
# ditto preserves resource forks / codesign attributes better than cp -R
mkdir -p "$(dirname "$APP_DST")"
if [[ -d "$APP_DST" ]]; then
  # Replace in place via staging to avoid a half-deleted Applications entry.
  STAGE="${APP_DST}.new.$$"
  rm -rf "$STAGE"
  ditto --rsrc "$APP_SRC" "$STAGE"
  rm -rf "$APP_DST"
  mv "$STAGE" "$APP_DST"
else
  ditto --rsrc "$APP_SRC" "$APP_DST"
fi

assert_app_bundle "$APP_DST"
log "installed $APP_DST"

if [[ "$SUPERVISED" -eq 1 ]]; then
  log "loading LaunchAgent (supervised) …"
  bash "$SCRIPT_DIR/install-launchd.sh" --skip-build
elif [[ "$OPEN" -eq 1 ]]; then
  log "opening $APP_DST"
  open "$APP_DST"
else
  log "done. open with: open \"$APP_DST\""
  log "optional supervised: bun run app:install:supervised"
fi
