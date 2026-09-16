#!/usr/bin/env bash
# Install Junto as a crash-supervised LaunchAgent (KeepAlive only on non-zero exit).
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
# application state. Doctor surfaces preferred vs loaded.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=app-paths.sh
source "$SCRIPT_DIR/app-paths.sh"

assert_installer_path_capabilities
if [[ -n "$INSTALL_SANDBOX_ROOT" ]]; then
  err "LaunchAgent installation is unavailable in filesystem-only sandbox mode"
  exit 1
fi

if [[ "${1:-}" == "--uninstall" ]]; then
  PLIST_RETIREMENT_ROOT="${PLIST}.retired.$$"
  PLIST_RETIREMENT_ROOT_ID=""
  RETIRED_PLIST=""
  RETIRED_PLIST_ID=""
  PLIST_RETIREMENT_DISPOSABLE=0
  assert_launchd_retirement_root
  if [[ -e "$PLIST_RETIREMENT_ROOT" || -L "$PLIST_RETIREMENT_ROOT" ]]; then
    err "refusing to reuse the retiring LaunchAgent root"
    exit 1
  fi
  UNINSTALL_PLIST_ID=""
  if [[ -e "$PLIST" || -L "$PLIST" ]]; then
    UNINSTALL_PLIST_ID="$(path_identity "$PLIST")"
    assert_owned_launchd_plist "$UNINSTALL_PLIST_ID"
  fi
  unload_launchd
  if [[ -n "$UNINSTALL_PLIST_ID" ]]; then
    assert_owned_launchd_plist "$UNINSTALL_PLIST_ID"
    bind_launchd_retirement_root
    /bin/mv -n "$PLIST" "$PLIST_RETIREMENT_ROOT/"
    if [[ -L "$RETIRED_PLIST" || "$(path_identity "$RETIRED_PLIST" 2>/dev/null)" != "$UNINSTALL_PLIST_ID" ]]; then
      err "retiring LaunchAgent plist identity does not match the admitted Junto plist"
      exit 1
    fi
    RETIRED_PLIST_ID="$UNINSTALL_PLIST_ID"
    PLIST_RETIREMENT_DISPOSABLE=1
    safe_remove_launchd_retirement
  fi
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
PLIST_RETIREMENT_ROOT="${PLIST}.retired.$$"
assert_safe_scoped_file "LaunchAgent plist stage" "$PLIST_STAGE" "$LAUNCH_AGENTS_DIR/${LABEL}.plist.new.$$"
assert_launchd_retirement_root
if [[
  -e "$PLIST_STAGE" ||
  -L "$PLIST_STAGE" ||
  -e "$PLIST_RETIREMENT_ROOT" ||
  -L "$PLIST_RETIREMENT_ROOT"
]]; then
  err "refusing to reuse a LaunchAgent activation path"
  exit 1
fi
PLIST_STAGE_ID=""
CURRENT_PLIST_ID=""
RETIRING_PLIST_ID=""
PLIST_RETIREMENT_ROOT_ID=""
RETIRED_PLIST=""
RETIRED_PLIST_ID=""
PLIST_RETIREMENT_DISPOSABLE=0
LAUNCHD_ACTIVATION_STARTED=0
PLIST_PUBLISHED=0
PLIST_COMMIT_PENDING=0

resolve_plist_publish() {
  if [[ "$PLIST_COMMIT_PENDING" -ne 1 ]]; then
    return 0
  fi
  if [[
    -f "$PLIST" &&
    ! -L "$PLIST" &&
    "$(path_identity "$PLIST" 2>/dev/null)" == "${PLIST_STAGE_ID:-}"
  ]]; then
    PLIST_PUBLISHED=1
    PLIST_COMMIT_PENDING=0
    return 0
  fi
  if [[
    -f "$PLIST_STAGE" &&
    ! -L "$PLIST_STAGE" &&
    "$(path_identity "$PLIST_STAGE" 2>/dev/null)" == "${PLIST_STAGE_ID:-}"
  ]]; then
    PLIST_COMMIT_PENDING=0
    return 0
  fi
  err "cannot resolve LaunchAgent plist publication; explicit forward repair is required"
  return 1
}

cleanup_plist_activation() {
  local status=$?
  local cleanup_failed=0
  local retained_candidate=""
  trap - EXIT
  set +e
  exec 3>&- 2>/dev/null || true
  if ! resolve_plist_publish; then
    cleanup_failed=1
  fi
  if [[ "$LAUNCHD_ACTIVATION_STARTED" -eq 1 && "$PLIST_RETIREMENT_DISPOSABLE" -eq 1 ]] && ! safe_remove_launchd_retirement; then
    err "retiring LaunchAgent plist requires explicit disposal repair at $PLIST_RETIREMENT_ROOT"
    cleanup_failed=1
  fi
  if [[
    ( "$LAUNCHD_ACTIVATION_STARTED" -eq 0 || "$PLIST_PUBLISHED" -eq 1 ) &&
    ( -e "$PLIST_STAGE" || -L "$PLIST_STAGE" )
  ]]; then
    if [[ -z "${PLIST_STAGE_ID:-}" || -L "$PLIST_STAGE" || "$(path_identity "$PLIST_STAGE" 2>/dev/null)" != "$PLIST_STAGE_ID" ]]; then
      err "refusing to remove an unbound LaunchAgent plist stage"
      cleanup_failed=1
    else
      safe_remove_launchd_stage || cleanup_failed=1
    fi
  fi
  if [[ "$status" -ne 0 && "$LAUNCHD_ACTIVATION_STARTED" -eq 1 ]]; then
    if launchd_loaded && ! unload_launchd; then
      err "failed to stop the candidate LaunchAgent"
      cleanup_failed=1
    fi
    if [[ "$PLIST_PUBLISHED" -eq 1 ]]; then
      retained_candidate="$PLIST"
    else
      retained_candidate="$PLIST_STAGE"
    fi
    err "one-way LaunchAgent activation requires forward repair; candidate retained at $retained_candidate"
  fi
  if [[ "$cleanup_failed" -ne 0 && "$status" -eq 0 ]]; then
    status=1
  fi
  exit "$status"
}
trap cleanup_plist_activation EXIT

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
  <string>$LOG_DIR/junto.out.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/junto.err.log</string>
</dict>
</plist>
PLIST_EOF

assert_safe_scoped_file "LaunchAgent plist stage" "$PLIST_STAGE" "$LAUNCH_AGENTS_DIR/${LABEL}.plist.new.$$"
if [[ "$(path_identity "$PLIST_STAGE")" != "$PLIST_STAGE_ID" ]]; then
  err "LaunchAgent plist stage changed identity before commit"
  exit 1
fi
exec 3>&-
assert_safe_scoped_file "LaunchAgent plist" "$PLIST" "$LAUNCH_AGENTS_DIR/${LABEL}.plist"
if [[ -e "$PLIST" ]]; then
  CURRENT_PLIST_ID="$(path_identity "$PLIST")"
  assert_owned_launchd_plist "$CURRENT_PLIST_ID"
fi

# Recheck the exact current plist immediately before the atomic publication.
if [[ -n "$CURRENT_PLIST_ID" ]]; then
  assert_owned_launchd_plist "$CURRENT_PLIST_ID"
  bind_launchd_retirement_root
elif [[ -e "$PLIST" || -L "$PLIST" ]]; then
  err "LaunchAgent plist appeared after preflight"
  exit 1
fi
LAUNCHD_ACTIVATION_STARTED=1
if [[ -n "$CURRENT_PLIST_ID" ]]; then
  RETIRING_PLIST_ID="$CURRENT_PLIST_ID"
  /bin/mv -n "$PLIST" "$PLIST_RETIREMENT_ROOT/"
  if [[ -L "$RETIRED_PLIST" || "$(path_identity "$RETIRED_PLIST" 2>/dev/null)" != "$RETIRING_PLIST_ID" ]]; then
    err "retiring LaunchAgent plist identity does not match the admitted Junto plist"
    exit 1
  fi
  RETIRED_PLIST_ID="$RETIRING_PLIST_ID"
  PLIST_RETIREMENT_DISPOSABLE=1
  safe_remove_launchd_retirement
  PLIST_RETIREMENT_ROOT_ID=""
  RETIRED_PLIST_ID=""
  PLIST_RETIREMENT_DISPOSABLE=0
  RETIRING_PLIST_ID=""
fi
if [[ -e "$PLIST" || -L "$PLIST" ]]; then
  err "LaunchAgent plist destination became occupied before candidate publication"
  exit 1
fi
PLIST_COMMIT_PENDING=1
publish_launchd_candidate "$PLIST_STAGE_ID"
PLIST_PUBLISHED=1
PLIST_COMMIT_PENDING=0
if [[ "$(path_identity "$PLIST" 2>/dev/null)" != "$PLIST_STAGE_ID" ]]; then
  err "LaunchAgent plist changed identity during commit"
  exit 1
fi
assert_safe_scoped_file "LaunchAgent plist" "$PLIST" "$LAUNCH_AGENTS_DIR/${LABEL}.plist"

log "bootstrapping $DOMAIN/$LABEL …"
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl enable "$DOMAIN/$LABEL"

sleep 2
if launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -q "state = running"; then
  log "$LABEL loaded and running"
  log "  logs: $LOG_DIR"
else
    err "$LABEL loaded but not reported running — check $LOG_DIR/junto.err.log"
  launchctl print "$DOMAIN/$LABEL" 2>/dev/null | sed -n '1,12p' >&2 || true
  exit 1
fi
