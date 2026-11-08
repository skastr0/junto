#!/usr/bin/env bash
# Preserve electron-builder's Finder layout while stapling the app in its DMG.
# Runs headlessly after notarize-app.sh has stapled the matching release app.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/app-paths.sh"
APP_PATH=""
OUT_PATH=""
VOL_NAME=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app) APP_PATH="${2:?}"; shift 2 ;;
    --out) OUT_PATH="${2:?}"; shift 2 ;;
    --volname) VOL_NAME="${2:?}"; shift 2 ;;
    *) err "unknown DMG option: $1"; exit 1 ;;
  esac
done

assert_app_bundle "$APP_PATH"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP_PATH/Contents/Info.plist")"
EXPECTED_OUT="$REPO_ROOT/release/Junto-${VERSION}-arm64-mac.dmg"
[[ "$OUT_PATH" == "$EXPECTED_OUT" && -f "$OUT_PATH" && ! -L "$OUT_PATH" ]] || {
  err "DMG must be the existing version-matched release artifact"; exit 1;
}
[[ "$VOL_NAME" == "$PRODUCT_NAME $VERSION" ]] || {
  err "DMG volume name must match the release"; exit 1;
}
OUT_ID="$(path_identity "$OUT_PATH")"
codesign --verify --deep --strict "$APP_PATH"
xcrun stapler validate "$APP_PATH"
APP_HASH="$(codesign -dv --verbose=4 "$APP_PATH" 2>&1 | awk -F= '/^CDHash=/{print $2}')"
[[ -n "$APP_HASH" ]] || { err "app has no CDHash"; exit 1; }

WORK="$(mktemp -d "$REPO_ROOT/release/.dmg-work.XXXXXXXX")"
chmod 0700 "$WORK"
MOUNT="$WORK/mount"
MOUNTED=0
cleanup() {
  if [[ "$MOUNTED" -eq 1 ]]; then
    if ! hdiutil detach "$MOUNT" >/dev/null; then
      err "retaining owned DMG staging after detach failure: $WORK"
      return
    fi
  fi
  rm -rf -- "$WORK"
}
trap cleanup EXIT
mkdir "$MOUNT"
hdiutil verify "$OUT_PATH" >/dev/null
hdiutil convert "$OUT_PATH" -format UDRW -o "$WORK/writable.dmg" >/dev/null
hdiutil attach "$WORK/writable.dmg" -readwrite -nobrowse -noautoopen \
  -mountpoint "$MOUNT" >/dev/null
MOUNTED=1
MOUNT_APP="$MOUNT/$PRODUCT_NAME.app"
assert_app_bundle "$MOUNT_APP"
# electron-builder pairs dmg-background@2x.png into a HiDPI .background.tiff.
[[ -f "$MOUNT/.DS_Store" && ( -f "$MOUNT/.background.png" || -f "$MOUNT/.background.tiff" ) && \
   -L "$MOUNT/Applications" && "$(readlink "$MOUNT/Applications")" == /Applications && \
   ! -e "$MOUNT/mac-arm64" ]] || {
  err "DMG must retain the app, Applications link, and Finder layout at its root"; exit 1;
}
codesign --verify --deep --strict "$MOUNT_APP"
DMG_HASH="$(codesign -dv --verbose=4 "$MOUNT_APP" 2>&1 | awk -F= '/^CDHash=/{print $2}')"
[[ "$DMG_HASH" == "$APP_HASH" ]] || {
  err "DMG contains a different signed app"; exit 1;
}
# The existing image holds this exact signed app. Add its accepted ticket only;
# preserve the original background, icon positions, and Applications symlink.
xcrun stapler staple "$MOUNT_APP"
xcrun stapler validate "$MOUNT_APP"
codesign --verify --deep --strict "$MOUNT_APP"
hdiutil detach "$MOUNT" >/dev/null
MOUNTED=0
hdiutil convert "$WORK/writable.dmg" -format UDZO -imagekey zlib-level=9 \
  -o "$WORK/final.dmg" >/dev/null
hdiutil verify "$WORK/final.dmg" >/dev/null
hdiutil attach "$WORK/final.dmg" -readonly -nobrowse -noautoopen \
  -mountpoint "$MOUNT" >/dev/null
MOUNTED=1
xcrun stapler validate "$MOUNT_APP"
codesign --verify --deep --strict "$MOUNT_APP"
hdiutil detach "$MOUNT" >/dev/null
MOUNTED=0
[[ ! -L "$OUT_PATH" && "$(path_identity "$OUT_PATH")" == "$OUT_ID" ]] || {
  err "release DMG changed during finalization"; exit 1;
}
mv -f "$WORK/final.dmg" "$OUT_PATH"
log "DMG ready: $OUT_PATH"
