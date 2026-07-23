#!/bin/sh
# Refuse to claim an administrator-owned AppArmor path before dpkg unpacks.
set -eu

PROFILE_SOURCE='/opt/Vellum Command/resources/apparmor-profile'
PROFILE_TARGET='/etc/apparmor.d/vellum'
UNIT_SOURCE='/opt/Vellum Command/resources/systemd/vellum-remote.service'
UNIT_TARGET='/usr/lib/systemd/user/vellum-remote.service'

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
