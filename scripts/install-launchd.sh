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
# Herdr: reload/unload soft-quits Vellum → control streams detach; panes keep running.
# Never mass-kills herdr sessions.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=app-paths.sh
source "$SCRIPT_DIR/app-paths.sh"

if [[ "${1:-}" == "--uninstall" ]]; then
  unload_launchd
  rm -f "$PLIST"
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

assert_app_bundle "$APP_DST"

unload_launchd
mkdir -p "$LOG_DIR" "$(dirname "$PLIST")"

cat > "$PLIST" <<PLIST_EOF
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

log "bootstrapping $DOMAIN/$LABEL …"
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl enable "$DOMAIN/$LABEL"

sleep 2
if launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -q "state = running"; then
  log "$LABEL loaded and running"
  log "  logs: $LOG_DIR"
  log "  herdr panes are NOT killed by this reload (detach control only)"
else
  err "$LABEL loaded but not reported running — check $LOG_DIR/vellum.err.log"
  launchctl print "$DOMAIN/$LABEL" 2>/dev/null | sed -n '1,12p' >&2 || true
  exit 1
fi
