#!/usr/bin/env bash
# Install Vellum as an always-running launchd LaunchAgent.
#
#   scripts/install-launchd.sh              build, install to /Applications, load agent
#   scripts/install-launchd.sh --skip-build reuse release/mac-arm64/Vellum.app as-is
#   scripts/install-launchd.sh --uninstall  unload agent, remove plist (keeps /Applications/Vellum.app)
#
# KeepAlive semantics: a crash (non-zero exit) relaunches the app; a deliberate
# quit (Cmd-Q, exit 0) stays quit until next login or `launchctl kickstart`.
set -euo pipefail

LABEL="skastr0.vellum"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_SRC="$REPO_ROOT/release/mac-arm64/Vellum.app"
APP_DST="/Applications/Vellum.app"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/Vellum"
DOMAIN="gui/$(id -u)"

unload() {
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
}

if [[ "${1:-}" == "--uninstall" ]]; then
  unload
  rm -f "$PLIST"
  echo "unloaded $LABEL and removed $PLIST (app left at $APP_DST)"
  exit 0
fi

if [[ "${1:-}" != "--skip-build" ]]; then
  (cd "$REPO_ROOT" && bun run build)
fi

[[ -d "$APP_SRC" ]] || { echo "missing $APP_SRC — run bun run build first" >&2; exit 1; }

# Replace any loaded agent before swapping the binary out from under it.
unload

ditto --rsrc "$APP_SRC" "$APP_DST"
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
    <string>$APP_DST/Contents/MacOS/Vellum</string>
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

launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl enable "$DOMAIN/$LABEL"

sleep 2
if launchctl print "$DOMAIN/$LABEL" | grep -q "state = running"; then
  echo "$LABEL loaded and running (logs: $LOG_DIR)"
else
  echo "$LABEL loaded but not reported running — check $LOG_DIR/vellum.err.log" >&2
  launchctl print "$DOMAIN/$LABEL" | sed -n '1,12p' >&2
  exit 1
fi
