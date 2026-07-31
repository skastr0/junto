#!/bin/sh
# Unload the exact package policy before dpkg removes its immutable source.
set -eu

PROFILE_SOURCE='/opt/Vellum Command/resources/apparmor-profile'
APPARMOR_ENABLED='/sys/module/apparmor/parameters/enabled'
APPARMOR_SECURITY='/sys/kernel/security/apparmor'

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

if [ -e "$APPARMOR_ENABLED" ]; then
  if [ ! -r "$APPARMOR_ENABLED" ]; then
    printf 'vellum: AppArmor kernel state is unreadable\n' >&2
    exit 1
  fi
  if [ "$(/bin/cat "$APPARMOR_ENABLED")" != Y ]; then
    printf 'vellum: AppArmor is present but disabled; refusing to bypass a broken sandbox installation\n' >&2
    exit 1
  fi
  if [ ! -x /usr/bin/aa-enabled ] || ! /usr/bin/aa-enabled ||
     [ ! -x /usr/sbin/apparmor_parser ]; then
    printf 'vellum: AppArmor is enabled but its required userspace is unavailable\n' >&2
    exit 1
  fi
  if [ ! -f "$PROFILE_SOURCE" ] || [ -L "$PROFILE_SOURCE" ]; then
    printf 'vellum: packaged AppArmor source is unavailable for safe unload\n' >&2
    exit 1
  fi
  /usr/sbin/apparmor_parser --remove "$PROFILE_SOURCE"
elif [ -e "$APPARMOR_SECURITY" ]; then
  printf 'vellum: AppArmor kernel state is incomplete; refusing to bypass a broken sandbox installation\n' >&2
  exit 1
fi
