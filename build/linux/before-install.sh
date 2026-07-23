#!/bin/sh
# Refuse to claim an administrator-owned AppArmor path before dpkg unpacks.
set -eu

PROFILE_SOURCE='/opt/Vellum Command/resources/apparmor-profile'
PROFILE_TARGET='/etc/apparmor.d/vellum'
UNIT_SOURCE='/opt/Vellum Command/resources/systemd/vellum-remote.service'
UNIT_TARGET='/usr/lib/systemd/user/vellum-remote.service'
INSTALLER_TARGET='/usr/libexec/vellum-release-installer'
BRIDGE_TARGET='/usr/libexec/vellum-release-bridge'
BRIDGE_STAGE_ROOT='/var/tmp/vellum-release-bridge'
SUDOERS_TARGET='/etc/sudoers.d/vellum-release-installer'
INSTALLER_STATE='/var/lib/vellum-release-installer'
BRIDGE_STAGE_MARKER="$INSTALLER_STATE/packaged-bridge-stage-root"
BRIDGE_STAGE_MARKER_VALUE='vellum/linux-release-bridge-stage-root/v1'

qualify_root_file_if_present() {
  target="$1"
  expected_mode="$2"
  label="$3"
  if [ -L "$target" ]; then
    printf 'vellum: refusing a symlink at the %s boundary\n' "$label" >&2
    exit 1
  fi
  if [ -e "$target" ] && {
    [ ! -f "$target" ] ||
    [ "$(stat -c '%u:%g:%a:%h' "$target" 2>/dev/null || true)" != "0:0:$expected_mode:1" ]
  }; then
    printf 'vellum: refusing an unsafe existing %s\n' "$label" >&2
    exit 1
  fi
}

qualify_root_file_if_present "$INSTALLER_TARGET" 755 'release installer'
qualify_root_file_if_present "$BRIDGE_TARGET" 755 'release bridge'
qualify_root_file_if_present "$SUDOERS_TARGET" 440 'release installer sudoers policy'

if [ -L "$BRIDGE_STAGE_ROOT" ]; then
  printf 'vellum: refusing a release bridge stage-root symlink\n' >&2
  exit 1
fi
if [ -e "$BRIDGE_STAGE_ROOT" ]; then
  if [ ! -d "$BRIDGE_STAGE_ROOT" ] ||
     [ "$(stat -c '%u:%g:%a' "$BRIDGE_STAGE_ROOT" 2>/dev/null || true)" != '0:0:1733' ] ||
     [ -L "$BRIDGE_STAGE_MARKER" ] || [ ! -f "$BRIDGE_STAGE_MARKER" ] ||
     [ "$(stat -c '%u:%g:%a:%h' "$BRIDGE_STAGE_MARKER" 2>/dev/null || true)" != '0:0:600:1' ] ||
     [ "$(/bin/cat "$BRIDGE_STAGE_MARKER" 2>/dev/null || true)" != "$BRIDGE_STAGE_MARKER_VALUE" ]; then
    printf 'vellum: refusing a foreign release bridge stage root\n' >&2
    exit 1
  fi
elif [ -e "$BRIDGE_STAGE_MARKER" ] || [ -L "$BRIDGE_STAGE_MARKER" ]; then
  printf 'vellum: refusing a release bridge stage marker without its root\n' >&2
  exit 1
fi

if [ -L "$PROFILE_TARGET" ]; then
  if [ "$(readlink "$PROFILE_TARGET")" != "$PROFILE_SOURCE" ]; then
    printf 'vellum: refusing an AppArmor link not owned by this package\n' >&2
    exit 1
  fi
elif [ -e "$PROFILE_TARGET" ]; then
  printf 'vellum: refusing an existing administrator-owned AppArmor profile\n' >&2
  exit 1
fi

# The canonical discovery path is a qualified link to the immutable package
# asset. Do not replace an administrator's unit or a link owned elsewhere.
if [ -L "$UNIT_TARGET" ]; then
  if [ "$(readlink "$UNIT_TARGET")" != "$UNIT_SOURCE" ]; then
    printf 'vellum: refusing a systemd user unit link not owned by this package\n' >&2
    exit 1
  fi
elif [ -e "$UNIT_TARGET" ]; then
  printf 'vellum: refusing an existing administrator-owned systemd user unit\n' >&2
  exit 1
fi
