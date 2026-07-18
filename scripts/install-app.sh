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
# Installs `vellum browser …` and `vellum-browser …` as atomic symlinks under
# $VELLUM_BIN_DIR (default: ~/.local/bin). Existing non-Vellum commands are
# never overwritten.
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

BIN_DIR="${VELLUM_BIN_DIR:-$HOME/.local/bin}"

preflight_cli_link() {
  local target="$1"
  local helper="$2"
  if [[ -e "$target" && ! -L "$target" ]]; then
    err "refusing to replace non-symlink command: $target"
    return 1
  fi
  if [[ -L "$target" ]]; then
    local existing
    existing="$(readlink "$target")"
    if [[ "$existing" != "$helper" ]]; then
      err "refusing to replace non-Vellum symlink: $target -> $existing"
      return 1
    fi
  fi
}

install_cli_link() {
  local name="$1"
  local helper="$2"
  local target="$BIN_DIR/$name"
  local stage="$BIN_DIR/.${name}.new.$$"
  ln -s "$helper" "$stage"
  # Same-filesystem rename keeps each command usable throughout reinstalls.
  mv -f "$stage" "$target"
}

install_browser_cli() {
  local helper="$APP_DST/Contents/Resources/bin/vellum-browser"
  if [[ ! -x "$helper" ]]; then
    err "installed browser CLI missing or not executable: $helper"
    return 1
  fi
  mkdir -p "$BIN_DIR"
  preflight_cli_link "$BIN_DIR/vellum" "$helper"
  preflight_cli_link "$BIN_DIR/vellum-browser" "$helper"
  install_cli_link "vellum" "$helper"
  install_cli_link "vellum-browser" "$helper"
  log "browser commands → $BIN_DIR/{vellum,vellum-browser}"
}

audit_app_bundle() {
  local app="$1"
  bun "$SCRIPT_DIR/audit-packaged-app.ts" "$app"
}

app_cdhash() {
  local app="$1"
  local metadata hash
  metadata="$(/usr/bin/codesign -d --verbose=4 "$app" 2>&1)"
  hash="$(printf '%s\n' "$metadata" | sed -n 's/^CDHash=//p')"
  if [[ ! "$hash" =~ ^[0-9A-Fa-f]{40,64}$ ]]; then
    err "invalid or ambiguous CDHash for $app"
    return 1
  fi
  printf '%s' "$hash"
}

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  build_flags=()
  [[ "$FAST" -eq 1 ]] && build_flags+=(--fast)
  [[ "$VERIFY" -eq 1 ]] && build_flags+=(--verify)
  bash "$SCRIPT_DIR/build-app.sh" "${build_flags[@]+"${build_flags[@]}"}"
fi

assert_app_bundle "$APP_SRC"

log "auditing candidate → $APP_SRC"
audit_app_bundle "$APP_SRC"
CANDIDATE_CDHASH="$(app_cdhash "$APP_SRC")"

HELPER_TARGET="$APP_DST/Contents/Resources/bin/vellum-browser"
preflight_cli_link "$BIN_DIR/vellum" "$HELPER_TARGET"
preflight_cli_link "$BIN_DIR/vellum-browser" "$HELPER_TARGET"

mkdir -p "$(dirname "$APP_DST")"
STAGE="${APP_DST}.new.$$"
BACKUP="${APP_DST}.previous.$$"
REJECTED="${APP_DST}.rejected.$$"
HAD_PREVIOUS=0
REPLACEMENT_ACTIVE=0
INSTALL_COMPLETE=0

rollback_previous_app() {
  if [[ -e "$APP_DST" ]]; then
    mv "$APP_DST" "$REJECTED" || return 1
  fi
  if [[ "$HAD_PREVIOUS" -eq 1 && -e "$BACKUP" ]]; then
    if ! mv "$BACKUP" "$APP_DST"; then
      if [[ -e "$REJECTED" && ! -e "$APP_DST" ]]; then
        mv "$REJECTED" "$APP_DST" || true
      fi
      return 1
    fi
  fi
  rm -rf "$REJECTED"
  REPLACEMENT_ACTIVE=0
}

cleanup_install() {
  local status=$?
  trap - EXIT
  set +e
  if [[ "$status" -ne 0 && "$REPLACEMENT_ACTIVE" -eq 1 ]]; then
    rollback_previous_app || err "failed to restore the previous app"
  fi
  rm -rf "$STAGE"
  if [[ "$INSTALL_COMPLETE" -eq 1 ]]; then
    rm -rf "$BACKUP" "$REJECTED"
  fi
  exit "$status"
}
trap cleanup_install EXIT

if [[ -e "$STAGE" || -e "$BACKUP" || -e "$REJECTED" ]]; then
  err "refusing to reuse an existing install transaction path"
  exit 1
fi

log "staging → $STAGE"
ditto --rsrc "$APP_SRC" "$STAGE"
assert_app_bundle "$STAGE"
log "auditing staged copy"
audit_app_bundle "$STAGE"
STAGED_CDHASH="$(app_cdhash "$STAGE")"
if [[ "$STAGED_CDHASH" != "$CANDIDATE_CDHASH" ]]; then
  err "staged app CDHash does not match the audited candidate"
  exit 1
fi

# Detach before binary swap: launchd unload + soft quit so before-quit runs
# and herdrStreams.detachAllOnQuit releases control (panes stay alive).
unload_launchd
quit_running_app
if launchd_loaded || vellum_processes_running; then
  err "Vellum did not quiesce; refusing to replace the app"
  exit 1
fi
# Brief settle so control clients exit and release PTYs.
sleep 0.5

log "installing → $APP_DST"
if [[ -e "$APP_DST" ]]; then
  mv "$APP_DST" "$BACKUP"
  HAD_PREVIOUS=1
fi
REPLACEMENT_ACTIVE=1
mv "$STAGE" "$APP_DST"

assert_app_bundle "$APP_DST"
log "auditing installed copy"
audit_app_bundle "$APP_DST"
INSTALLED_CDHASH="$(app_cdhash "$APP_DST")"
if [[ "$INSTALLED_CDHASH" != "$CANDIDATE_CDHASH" ]]; then
  err "installed app CDHash does not match the audited candidate"
  exit 1
fi
install_browser_cli
INSTALL_COMPLETE=1
REPLACEMENT_ACTIVE=0
log "installed $APP_DST"
log "installed CDHash $INSTALLED_CDHASH"

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
