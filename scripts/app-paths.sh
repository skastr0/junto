#!/usr/bin/env bash
# Shared paths/constants for Vellum packaging scripts. Source only — not executable alone.
# shellcheck shell=bash

LABEL="${VELLUM_LAUNCHD_LABEL:-skastr0.vellum}"
PRODUCT_NAME="${VELLUM_PRODUCT_NAME:-Vellum}"
APP_BUNDLE_ID="${VELLUM_APP_ID:-skastr0.vellum}"

# Repo root = parent of scripts/
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# electron-builder mac pack output (arm64 Mac primary). Zip lives beside this
# under release/Vellum-*-mac.zip — see package.json artifactName.
# Override with VELLUM_APP_SRC if packaging a different arch artifact.
detect_app_src() {
  local candidates=(
    "$REPO_ROOT/release/mac-arm64/${PRODUCT_NAME}.app"
    "$REPO_ROOT/release/mac/${PRODUCT_NAME}.app"
    "$REPO_ROOT/release/mac-x64/${PRODUCT_NAME}.app"
  )
  local c
  for c in "${candidates[@]}"; do
    if [[ -d "$c" ]]; then
      printf '%s' "$c"
      return 0
    fi
  done
  # Prefer arm64 path for error messages on Apple Silicon.
  if [[ "$(uname -m)" == "arm64" ]]; then
    printf '%s' "$REPO_ROOT/release/mac-arm64/${PRODUCT_NAME}.app"
  else
    printf '%s' "$REPO_ROOT/release/mac/${PRODUCT_NAME}.app"
  fi
}

APP_SRC="${VELLUM_APP_SRC:-$(detect_app_src)}"
APP_DST="${VELLUM_APP_DST:-/Applications/${PRODUCT_NAME}.app}"
PLIST="${VELLUM_PLIST:-$HOME/Library/LaunchAgents/${LABEL}.plist}"
LOG_DIR="${VELLUM_LOG_DIR:-$HOME/Library/Logs/${PRODUCT_NAME}}"
DOMAIN="gui/$(id -u)"

log() { printf 'vellum: %s\n' "$*"; }
err() { printf 'vellum: error: %s\n' "$*" >&2; }

# True if a LaunchAgent for this label is loaded (any state).
launchd_loaded() {
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1
}

unload_launchd() {
  if ! launchd_loaded; then
    return 0
  fi
  log "unloading LaunchAgent $LABEL …"
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  # bootout returns before the job fully drains; swapping the binary under a
  # still-exiting process is unsafe. Wait for disappearance.
  local i
  for i in $(seq 1 30); do
    launchd_loaded || return 0
    sleep 0.5
  done
  err "$LABEL still loaded after 15s; refusing to replace the app"
  return 1
}

vellum_processes_running() {
  pgrep -xq "$PRODUCT_NAME" 2>/dev/null ||
    pgrep -f "${APP_DST}/" >/dev/null 2>&1
}

# Soft-quit any unsupervised Dock/Finder instances (not launchd — use unload).
quit_running_app() {
  if vellum_processes_running; then
    log "quitting running ${PRODUCT_NAME} (osascript) …"
    osascript -e "tell application \"${PRODUCT_NAME}\" to quit" 2>/dev/null || true
    local i
    for i in $(seq 1 20); do
      vellum_processes_running || return 0
      sleep 0.5
    done
    err "${PRODUCT_NAME} processes remain after 10s; refusing to replace the app"
    return 1
  fi
  return 0
}

# Validate a .app bundle looks installable.
assert_app_bundle() {
  local app="${1:-$APP_SRC}"
  [[ -d "$app" ]] || { err "missing app bundle: $app"; return 1; }
  [[ -x "$app/Contents/MacOS/${PRODUCT_NAME}" ]] || {
    err "missing executable: $app/Contents/MacOS/${PRODUCT_NAME}"
    return 1
  }
  [[ -f "$app/Contents/Info.plist" ]] || {
    err "missing Info.plist in $app"
    return 1
  }
  local id
  id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist" 2>/dev/null || true)"
  if [[ -n "$id" && "$id" != "$APP_BUNDLE_ID" ]]; then
    err "bundle id mismatch: got $id want $APP_BUNDLE_ID"
    return 1
  fi
  return 0
}
