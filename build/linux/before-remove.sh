#!/bin/sh
# Unload the exact package policy before dpkg removes its immutable source.
set -eu

PROFILE_SOURCE='/opt/Vellum Command/resources/apparmor-profile'

case "${1:-remove}" in
  upgrade|deconfigure|failed-upgrade)
    exit 0
    ;;
  remove)
    ;;
  *)
    printf 'vellum: unsupported package pre-removal phase: %s\n' "$1" >&2
    exit 1
    ;;
esac

if [ -x /usr/bin/aa-enabled ] && /usr/bin/aa-enabled; then
  if [ ! -f "$PROFILE_SOURCE" ] || [ -L "$PROFILE_SOURCE" ]; then
    printf 'vellum: packaged AppArmor source is unavailable for safe unload\n' >&2
    exit 1
  fi
  /usr/sbin/apparmor_parser --remove "$PROFILE_SOURCE"
fi
