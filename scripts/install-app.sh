#!/usr/bin/env bash
# Install a built Vellum.app into the fixed /Applications product path.
#
#   scripts/install-app.sh                 build then install
#   scripts/install-app.sh --skip-build    install existing release/*.app
#   scripts/install-app.sh --fast          build --fast then install
#   scripts/install-app.sh --verify        build --verify then install
#   scripts/install-app.sh --open          open the app after install
#   scripts/install-app.sh --supervised    also (re)load LaunchAgent (crash-only KeepAlive)
#
# Station preference (settings.station.supervisedPreferred):
#   Product intent only — this script does NOT read ~/.vellum/settings.json.
#   StationRoleGate sets supervisedPreferred=true when role=remote. The install
#   surface for that preference is --supervised (or bun run app:install:supervised).
#   Settings doctor metadata reports preferred vs LaunchAgent-loaded so Remote
#   deploy (later) can decide to pass --supervised. No third binary.
#
# Installs `vellum …`, `vellum-browser …`, and `vellum-station` as atomic
# symlinks under ~/.local/bin. Existing non-Vellum commands are
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
  sed -n '2,26p' "$0" | sed 's/^# \?//'
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

assert_installer_path_capabilities
if [[ -n "$INSTALL_SANDBOX_ROOT" && ( "$SUPERVISED" -eq 1 || "$OPEN" -eq 1 ) ]]; then
  err "sandbox installs cannot launch or supervise the app"
  exit 1
fi
PREVIOUS_LAUNCHD_LOADED=0
if launchd_loaded; then
  PREVIOUS_LAUNCHD_LOADED=1
fi

restore_previous_launchd_job() {
  if [[ "$PREVIOUS_LAUNCHD_LOADED" -ne 1 || launchd_loaded ]]; then
    return 0
  fi
  assert_safe_scoped_file "LaunchAgent plist" "$PLIST" "$INSTALL_USER_ROOT/Library/LaunchAgents/${LABEL}.plist" || return 1
  launchctl bootstrap "$DOMAIN" "$PLIST" || return 1
  launchctl enable "$DOMAIN/$LABEL"
}
cd "$REPO_ROOT"
bun "$SCRIPT_DIR/electron-security-policy.ts" validate

assert_cli_path() {
  local description="$1"
  local path="$2"
  local expected="$3"
  assert_exact_scoped_path "$description" "$path" "$expected" "$INSTALL_USER_ROOT" || return 1
}

CREATED_VELLUM_LINK=0
CREATED_VELLUM_BROWSER_LINK=0
CREATED_VELLUM_STATION_LINK=0

preflight_cli_link() {
  local target="$1"
  local helper="$2"
  local name="${target##*/}"
  assert_scoped_directory_capability "CLI directory" "$BIN_DIR" || return 1
  assert_cli_path "CLI link" "$target" "$BIN_DIR/$name" || return 1
  if [[
    "$name" != "vellum" &&
    "$name" != "vellum-browser" &&
    "$name" != "vellum-station"
  ]]; then
    err "refusing unexpected CLI link name: $name"
    return 1
  fi
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
  assert_cli_path "CLI link" "$target" "$BIN_DIR/$name" || return 1
  preflight_cli_link "$target" "$helper" || return 1
  # The helper path is stable across app swaps. An already-correct link needs no
  # mutation; an absent link is created with ln's exclusive create semantics.
  if [[ -L "$target" ]]; then
    return 0
  fi
  ln -s "$helper" "$target"
  if [[ ! -L "$target" || "$(readlink "$target")" != "$helper" ]]; then
    err "CLI link changed identity during creation: $target"
    return 1
  fi
  case "$name" in
    vellum) CREATED_VELLUM_LINK=1 ;;
    vellum-browser) CREATED_VELLUM_BROWSER_LINK=1 ;;
    vellum-station) CREATED_VELLUM_STATION_LINK=1 ;;
  esac
}

remove_created_cli_link() {
  local name="$1"
  local target helper created
  target="$BIN_DIR/$name"
  case "$name" in
    vellum) helper="$APP_DST/Contents/Resources/bin/vellum"; created="$CREATED_VELLUM_LINK" ;;
    vellum-browser) helper="$APP_DST/Contents/Resources/bin/vellum-browser"; created="$CREATED_VELLUM_BROWSER_LINK" ;;
    vellum-station) helper="$APP_DST/Contents/Resources/bin/vellum-station"; created="$CREATED_VELLUM_STATION_LINK" ;;
    *) err "unknown CLI link cleanup capability: $name"; return 1 ;;
  esac
  if [[ "$created" -ne 1 ]]; then
    return 0
  fi
  assert_cli_path "CLI link" "$target" "$BIN_DIR/$name" || return 1
  if [[ ! -L "$target" || "$(readlink "$target")" != "$helper" ]]; then
    err "refusing to remove a CLI link that changed identity: $target"
    return 1
  fi
  rm -f "$target"
}

install_cli_tools() {
  local work_helper="$APP_DST/Contents/Resources/bin/vellum"
  local browser_helper="$APP_DST/Contents/Resources/bin/vellum-browser"
  local station_helper="$APP_DST/Contents/Resources/bin/vellum-station"
  if [[
    ! -x "$work_helper" ||
    ! -x "$browser_helper" ||
    ! -x "$station_helper"
  ]]; then
    err "installed Vellum CLI helper missing or not executable"
    return 1
  fi
  ensure_scoped_directory "CLI directory" "$BIN_DIR"
  preflight_cli_link "$BIN_DIR/vellum" "$work_helper"
  preflight_cli_link "$BIN_DIR/vellum-browser" "$browser_helper"
  preflight_cli_link "$BIN_DIR/vellum-station" "$station_helper"
  install_cli_link "vellum" "$work_helper"
  install_cli_link "vellum-browser" "$browser_helper"
  install_cli_link "vellum-station" "$station_helper"
  log "commands → $BIN_DIR/{vellum,vellum-browser,vellum-station}"
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

WORK_HELPER_TARGET="$APP_DST/Contents/Resources/bin/vellum"
BROWSER_HELPER_TARGET="$APP_DST/Contents/Resources/bin/vellum-browser"
STATION_HELPER_TARGET="$APP_DST/Contents/Resources/bin/vellum-station"
preflight_cli_link "$BIN_DIR/vellum" "$WORK_HELPER_TARGET"
preflight_cli_link "$BIN_DIR/vellum-browser" "$BROWSER_HELPER_TARGET"
preflight_cli_link "$BIN_DIR/vellum-station" "$STATION_HELPER_TARGET"

derive_install_transaction_paths "$$"
HAD_PREVIOUS=0
REPLACEMENT_ACTIVE=0
NEW_APP_INSTALLED=0
NEW_APP_MOVE_PENDING=0
INSTALL_COMPLETE=0

rollback_previous_app() {
  local moved_identity
  if [[ "$NEW_APP_MOVE_PENDING" -eq 1 ]]; then
    if [[ -d "$APP_DST" && ! -L "$APP_DST" && "$(path_identity "$APP_DST" 2>/dev/null)" == "${STAGED_APP_ID:-}" ]]; then
      NEW_APP_INSTALLED=1
      NEW_APP_MOVE_PENDING=0
    elif [[ -d "$STAGE" && ! -L "$STAGE" ]]; then
      NEW_APP_MOVE_PENDING=0
    else
      err "cannot resolve the staged app move during rollback"
      return 1
    fi
  fi
  assert_install_transaction_capabilities || return 1
  if [[ "$NEW_APP_INSTALLED" -eq 1 && -e "$APP_DST" ]]; then
    assert_install_transaction_capabilities || return 1
    moved_identity="$(path_identity "$APP_DST")" || return 1
    REJECTED_ID="$moved_identity"
    mv "$APP_DST" "$REJECTED" || return 1
    if ! assert_install_transaction_capabilities; then
      err "rejected app changed identity during rollback"
      return 1
    fi
  fi
  if [[ "$HAD_PREVIOUS" -eq 1 && -e "$BACKUP" ]]; then
    assert_install_transaction_capabilities || return 1
    moved_identity="$BACKUP_ID"
    BACKUP_RESTORE_PENDING=1
    if ! mv "$BACKUP" "$APP_DST"; then
      if [[ -e "$REJECTED" && ! -e "$APP_DST" ]]; then
        assert_install_transaction_capabilities || return 1
        mv "$REJECTED" "$APP_DST" || true
        if [[ -d "$APP_DST" && "$(path_identity "$APP_DST" 2>/dev/null)" == "$REJECTED_ID" ]]; then
          REJECTED_ID=""
        fi
      fi
      return 1
    fi
    BACKUP_RESTORE_PENDING=0
    if [[ "$(path_identity "$APP_DST" 2>/dev/null)" != "$moved_identity" ]]; then
      err "previous app changed identity during rollback"
      return 1
    fi
    BACKUP_ID=""
  fi
  safe_remove_transaction_tree rejected || return 1
  REPLACEMENT_ACTIVE=0
}

cleanup_install() {
  local status=$?
  local cleanup_failed=0
  trap - EXIT
  set +e
  if [[ "$status" -ne 0 && "$REPLACEMENT_ACTIVE" -eq 1 && "$INSTALL_COMPLETE" -ne 1 ]]; then
    if ! rollback_previous_app; then
      err "failed to restore the previous app"
      cleanup_failed=1
    fi
  fi
  if [[ "$status" -ne 0 && "$INSTALL_COMPLETE" -ne 1 ]]; then
    if ! remove_created_cli_link vellum-station; then
      cleanup_failed=1
    fi
    if ! remove_created_cli_link vellum-browser; then
      cleanup_failed=1
    fi
    if ! remove_created_cli_link vellum; then
      cleanup_failed=1
    fi
  fi
  if [[ "$status" -ne 0 && "$PREVIOUS_LAUNCHD_LOADED" -eq 1 ]] && ! restore_previous_launchd_job; then
    err "failed to restore the previously loaded LaunchAgent"
    cleanup_failed=1
  fi
  if ! safe_remove_transaction_tree stage; then
    err "refusing unsafe install stage cleanup"
    cleanup_failed=1
  fi
  if [[ "$INSTALL_COMPLETE" -eq 1 ]]; then
    if ! safe_remove_transaction_tree backup; then
      err "refusing unsafe install backup cleanup"
      cleanup_failed=1
    fi
    if ! safe_remove_transaction_tree rejected; then
      err "refusing unsafe rejected-install cleanup"
      cleanup_failed=1
    fi
  fi
  if [[ "$cleanup_failed" -ne 0 && "$status" -eq 0 ]]; then
    status=1
  fi
  exit "$status"
}
trap cleanup_install EXIT

if [[ -e "$STAGE_ROOT" || -e "$BACKUP" || -e "$REJECTED" ]]; then
  err "refusing to reuse an existing install transaction path"
  exit 1
fi

log "staging → $STAGE"
assert_install_transaction_capabilities
mkdir -m 0700 "$STAGE_ROOT"
bind_transaction_tree stage
assert_install_transaction_capabilities
ditto --rsrc "$APP_SRC" "$STAGE"
assert_install_transaction_capabilities
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
assert_install_transaction_capabilities
REPLACEMENT_ACTIVE=1
if [[ -e "$APP_DST" ]]; then
  assert_install_transaction_capabilities
  PREVIOUS_APP_ID="$(path_identity "$APP_DST")"
  HAD_PREVIOUS=1
  BACKUP_ID="$PREVIOUS_APP_ID"
  mv "$APP_DST" "$BACKUP"
  if ! assert_install_transaction_capabilities; then
    err "previous app changed identity during backup"
    exit 1
  fi
fi
assert_install_transaction_capabilities
STAGED_APP_ID="$(path_identity "$STAGE")"
NEW_APP_MOVE_PENDING=1
mv "$STAGE" "$APP_DST"
NEW_APP_INSTALLED=1
NEW_APP_MOVE_PENDING=0
if [[ "$(path_identity "$APP_DST" 2>/dev/null)" != "$STAGED_APP_ID" ]]; then
  err "staged app changed identity during install"
  exit 1
fi

assert_install_transaction_capabilities
assert_app_bundle "$APP_DST"
log "auditing installed copy"
audit_app_bundle "$APP_DST"
INSTALLED_CDHASH="$(app_cdhash "$APP_DST")"
if [[ "$INSTALLED_CDHASH" != "$CANDIDATE_CDHASH" ]]; then
  err "installed app CDHash does not match the audited candidate"
  exit 1
fi
install_cli_tools
REPLACEMENT_ACTIVE=0 INSTALL_COMPLETE=1
log "installed $APP_DST"
log "installed CDHash $INSTALLED_CDHASH"

if [[ "$SUPERVISED" -eq 0 && "$PREVIOUS_LAUNCHD_LOADED" -eq 1 ]]; then
  restore_previous_launchd_job
fi

if [[ "$SUPERVISED" -eq 1 ]]; then
  log "loading LaunchAgent (supervised) …"
  VELLUM_INSTALL_PREVIOUS_LAUNCHD_LOADED="$PREVIOUS_LAUNCHD_LOADED" \
    bash "$SCRIPT_DIR/install-launchd.sh" --skip-build
elif [[ "$OPEN" -eq 1 ]]; then
  log "opening $APP_DST"
  open "$APP_DST"
else
  log "done. open with: open \"$APP_DST\""
  log "optional supervised: bun run app:install:supervised"
fi
