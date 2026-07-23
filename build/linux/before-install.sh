#!/bin/sh
# Refuse to claim an administrator-owned AppArmor path before dpkg unpacks.
set -eu

PROFILE_SOURCE='/opt/Vellum Command/resources/apparmor-profile'
PROFILE_TARGET='/etc/apparmor.d/vellum'

if [ -L "$PROFILE_TARGET" ]; then
  if [ "$(readlink "$PROFILE_TARGET")" = "$PROFILE_SOURCE" ]; then
    exit 0
  fi
  printf 'vellum: refusing an AppArmor link not owned by this package\n' >&2
  exit 1
fi
if [ -e "$PROFILE_TARGET" ]; then
  printf 'vellum: refusing an existing administrator-owned AppArmor profile\n' >&2
  exit 1
fi
