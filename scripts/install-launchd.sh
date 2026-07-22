#!/usr/bin/env bash
# Install Vellum as a crash-supervised LaunchAgent (KeepAlive only on non-zero exit).
#
#   scripts/install-launchd.sh              build, install to /Applications, load agent
#   scripts/install-launchd.sh --skip-build reuse existing release app / already-installed
#   scripts/install-launchd.sh --uninstall  unload agent, remove plist (keeps /Applications app)
#
# Prefer day-to-day:
#   bun run app:install              # plain /Applications install
#   bun run app:install:supervised   # install + this LaunchAgent
#
# Product link: settings.station.supervisedPreferred is the durable preference
# (true for Remote). This script is the apply surface — it does not read
# settings.json. Doctor (settings service) surfaces preferred vs loaded.
#
# Herdr: reload/unload soft-quits Vellum → control streams detach; panes keep running.
# Never mass-kills herdr sessions.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=app-paths.sh
source "$SCRIPT_DIR/app-paths.sh"

assert_installer_path_capabilities
if [[ -n "$INSTALL_SANDBOX_ROOT" ]]; then
  err "LaunchAgent installation is unavailable in filesystem-only sandbox mode"
  exit 1
fi

PREVIOUS_LAUNCHD_LOADED="${VELLUM_INSTALL_PREVIOUS_LAUNCHD_LOADED:-0}"
if [[ "$PREVIOUS_LAUNCHD_LOADED" != "0" && "$PREVIOUS_LAUNCHD_LOADED" != "1" ]]; then
  err "invalid prior LaunchAgent state"
  exit 1
fi
if launchd_loaded; then
  PREVIOUS_LAUNCHD_LOADED=1
fi

restore_previous_launchd_job() {
  if [[ "$PREVIOUS_LAUNCHD_LOADED" -ne 1 || launchd_loaded || ! -f "$PLIST" || -L "$PLIST" ]]; then
    return 0
  fi
  assert_safe_scoped_file "LaunchAgent plist" "$PLIST" "$INSTALL_USER_ROOT/Library/LaunchAgents/${LABEL}.plist" || return 1
  launchctl bootstrap "$DOMAIN" "$PLIST" || return 1
  launchctl enable "$DOMAIN/$LABEL"
}

cleanup_early_launchd_failure() {
  local status=$?
  trap - EXIT
  set +e
  if [[ "$status" -ne 0 ]] && ! restore_previous_launchd_job; then
    err "failed to restore the previously loaded LaunchAgent"
  fi
  exit "$status"
}
trap cleanup_early_launchd_failure EXIT

if [[ "${1:-}" == "--uninstall" ]]; then
  trap - EXIT
  unload_launchd
  safe_remove_installer_file plist
  log "unloaded $LABEL and removed $PLIST (app left at $APP_DST)"
  exit 0
fi

if [[ "${1:-}" != "--skip-build" ]]; then
  bash "$SCRIPT_DIR/install-app.sh"
else
  # Ensure /Applications is current when skipping full rebuild.
  if [[ -d "$(detect_app_src)" ]]; then
    bash "$SCRIPT_DIR/install-app.sh" --skip-build
  else
    assert_app_bundle "$APP_DST" || {
      err "no release app and no $APP_DST — run scripts/build-app.sh first"
      exit 1
    }
    unload_launchd
    quit_running_app
  fi
fi

assert_installer_path_capabilities
assert_app_bundle "$APP_DST"

unload_launchd
ensure_scoped_directory "log directory" "$LOG_DIR"
LAUNCH_AGENTS_DIR="$INSTALL_USER_ROOT/Library/LaunchAgents"
ensure_scoped_directory "LaunchAgents directory" "$LAUNCH_AGENTS_DIR"
assert_safe_scoped_file "LaunchAgent plist" "$PLIST" "$LAUNCH_AGENTS_DIR/${LABEL}.plist"
PLIST_STAGE="${PLIST}.new.$$"
PLIST_BACKUP="${PLIST}.previous.$$"
assert_safe_scoped_file "LaunchAgent plist stage" "$PLIST_STAGE" "$LAUNCH_AGENTS_DIR/${LABEL}.plist.new.$$"
assert_safe_scoped_file "LaunchAgent plist backup" "$PLIST_BACKUP" "$LAUNCH_AGENTS_DIR/${LABEL}.plist.previous.$$"
if [[ -e "$PLIST_STAGE" || -L "$PLIST_STAGE" || -e "$PLIST_BACKUP" || -L "$PLIST_BACKUP" ]]; then
  err "refusing to reuse a LaunchAgent plist transaction path"
  exit 1
fi
PLIST_STAGE_ID=""
PLIST_BACKUP_ID=""
HAD_PREVIOUS_PLIST=0
PLIST_COMMITTED=0
PLIST_COMMIT_PENDING=0
PLIST_TRANSACTION_COMPLETE=0

cleanup_plist_transaction() {
  local status=$?
  local cleanup_failed=0
  trap - EXIT
  set +e
  exec 3>&- 2>/dev/null || true
  if [[ "$PLIST_COMMIT_PENDING" -eq 1 && "$PLIST_COMMITTED" -eq 0 ]]; then
    if [[ -f "$PLIST" && ! -L "$PLIST" && "$(path_identity "$PLIST" 2>/dev/null)" == "$PLIST_STAGE_ID" ]]; then
      PLIST_COMMITTED=1
      PLIST_COMMIT_PENDING=0
    elif [[ ! -e "$PLIST" && ! -L "$PLIST" && -f "$PLIST_STAGE" ]]; then
      PLIST_COMMIT_PENDING=0
    else
      err "cannot resolve the LaunchAgent plist commit during rollback"
      cleanup_failed=1
    fi
  fi
  if [[ -e "$PLIST_STAGE" || -L "$PLIST_STAGE" ]]; then
    if [[ -z "${PLIST_STAGE_ID:-}" || -L "$PLIST_STAGE" || "$(path_identity "$PLIST_STAGE" 2>/dev/null)" != "$PLIST_STAGE_ID" ]]; then
      err "refusing to remove an unbound LaunchAgent plist stage"
      cleanup_failed=1
    else
      safe_remove_installer_file plist-stage || cleanup_failed=1
    fi
  fi
  if [[ "$PLIST_TRANSACTION_COMPLETE" -eq 1 ]]; then
    if [[ -e "$PLIST_BACKUP" || -L "$PLIST_BACKUP" ]]; then
      if [[ -z "$PLIST_BACKUP_ID" || -L "$PLIST_BACKUP" || "$(path_identity "$PLIST_BACKUP" 2>/dev/null)" != "$PLIST_BACKUP_ID" ]]; then
        err "refusing to remove an unbound LaunchAgent plist backup"
        cleanup_failed=1
      else
        safe_remove_installer_file plist-backup || cleanup_failed=1
      fi
    fi
  elif [[ "$PLIST_COMMITTED" -eq 1 ]]; then
    unload_launchd || cleanup_failed=1
    if [[ -e "$PLIST" || -L "$PLIST" ]]; then
      if [[ -z "$PLIST_STAGE_ID" || -L "$PLIST" || "$(path_identity "$PLIST" 2>/dev/null)" != "$PLIST_STAGE_ID" ]]; then
        err "refusing to remove a LaunchAgent plist that changed identity"
        cleanup_failed=1
      else
        safe_remove_installer_file plist || cleanup_failed=1
      fi
    fi
  fi
  if [[ "$PLIST_TRANSACTION_COMPLETE" -ne 1 && "$HAD_PREVIOUS_PLIST" -eq 1 ]]; then
    if [[ -e "$PLIST" || -L "$PLIST" ]]; then
      err "cannot restore the previous LaunchAgent plist over an unowned path"
      cleanup_failed=1
    elif [[ -z "$PLIST_BACKUP_ID" || -L "$PLIST_BACKUP" || "$(path_identity "$PLIST_BACKUP" 2>/dev/null)" != "$PLIST_BACKUP_ID" ]]; then
      err "previous LaunchAgent plist changed identity before rollback"
      cleanup_failed=1
    else
      PLIST_RESTORE_PENDING=1
      if mv "$PLIST_BACKUP" "$PLIST" && [[ "$(path_identity "$PLIST" 2>/dev/null)" == "$PLIST_BACKUP_ID" ]]; then
        PLIST_RESTORE_PENDING=0
        PLIST_BACKUP_ID=""
      else
        err "failed to restore the previous LaunchAgent plist"
        cleanup_failed=1
      fi
    fi
  fi
  if [[ "$PLIST_TRANSACTION_COMPLETE" -ne 1 && "$PREVIOUS_LAUNCHD_LOADED" -eq 1 ]] && ! restore_previous_launchd_job; then
    err "failed to restore the previously loaded LaunchAgent"
    cleanup_failed=1
  fi
  if [[ "$cleanup_failed" -ne 0 && "$status" -eq 0 ]]; then
    status=1
  fi
  exit "$status"
}
trap cleanup_plist_transaction EXIT

umask 077
set -o noclobber
if ! exec 3> "$PLIST_STAGE"; then
  set +o noclobber
  err "refusing to open LaunchAgent plist stage"
  exit 1
fi
set +o noclobber
PLIST_STAGE_ID="$(path_identity /dev/fd/3)"
if [[ "$(path_identity "$PLIST_STAGE")" != "$PLIST_STAGE_ID" ]]; then
  err "LaunchAgent plist stage changed identity while opening"
  exit 1
fi
cat >&3 <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$APP_DST/Contents/MacOS/${PRODUCT_NAME}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>AssociatedBundleIdentifiers</key>
  <string>$LABEL</string>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/vellum.out.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/vellum.err.log</string>
</dict>
</plist>
PLIST_EOF

assert_safe_scoped_file "LaunchAgent plist stage" "$PLIST_STAGE" "$LAUNCH_AGENTS_DIR/${LABEL}.plist.new.$$"
if [[ "$(path_identity "$PLIST_STAGE")" != "$PLIST_STAGE_ID" ]]; then
  err "LaunchAgent plist stage changed identity before commit"
  exit 1
fi
assert_safe_scoped_file "LaunchAgent plist" "$PLIST" "$LAUNCH_AGENTS_DIR/${LABEL}.plist"
if [[ -e "$PLIST" ]]; then
  PLIST_BACKUP_ID="$(path_identity "$PLIST")"
  HAD_PREVIOUS_PLIST=1
  mv "$PLIST" "$PLIST_BACKUP"
  if [[ "$(path_identity "$PLIST_BACKUP" 2>/dev/null)" != "$PLIST_BACKUP_ID" ]]; then
    err "previous LaunchAgent plist changed identity during backup"
    exit 1
  fi
fi
PLIST_COMMIT_PENDING=1
mv "$PLIST_STAGE" "$PLIST"
PLIST_COMMITTED=1
PLIST_COMMIT_PENDING=0
if [[ "$(path_identity "$PLIST" 2>/dev/null)" != "$PLIST_STAGE_ID" ]]; then
  err "LaunchAgent plist changed identity during commit"
  exit 1
fi
exec 3>&-
assert_safe_scoped_file "LaunchAgent plist" "$PLIST" "$LAUNCH_AGENTS_DIR/${LABEL}.plist"

log "bootstrapping $DOMAIN/$LABEL …"
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl enable "$DOMAIN/$LABEL"

sleep 2
if launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -q "state = running"; then
  PLIST_TRANSACTION_COMPLETE=1
  log "$LABEL loaded and running"
  log "  logs: $LOG_DIR"
  log "  herdr panes are NOT killed by this reload (detach control only)"
else
  err "$LABEL loaded but not reported running — check $LOG_DIR/vellum.err.log"
  launchctl print "$DOMAIN/$LABEL" 2>/dev/null | sed -n '1,12p' >&2 || true
  exit 1
fi
