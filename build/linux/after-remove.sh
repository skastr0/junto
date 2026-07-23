#!/bin/sh
# Debian post-removal hook. User-authored ~/.vellum data is never in scope.
set -eu

PROFILE_TARGET='/etc/apparmor.d/vellum'
UNIT_TARGET='/usr/lib/systemd/user/vellum-remote.service'
UNIT_SOURCE='/opt/Vellum Command/resources/systemd/vellum-remote.service'

case "${1:-remove}" in
  upgrade|failed-upgrade|abort-install|abort-upgrade|disappear)
    exit 0
    ;;
  remove|purge)
    ;;
  *)
    printf 'vellum: unsupported package removal phase: %s\n' "$1" >&2
    exit 1
    ;;
esac

if command -v update-alternatives >/dev/null 2>&1; then
  update-alternatives --remove vellum '/opt/Vellum Command/resources/bin/vellum'
fi

# Remove only the canonical registration Vellum minted. A unit file or foreign
# link in the discovery directory is administrator-owned and remains intact.
if [ -L "$UNIT_TARGET" ]; then
  if [ "$(readlink "$UNIT_TARGET")" = "$UNIT_SOURCE" ]; then
    rm -f -- "$UNIT_TARGET"
  else
    printf 'vellum: preserving a systemd user unit link not owned by this package\n' >&2
  fi
elif [ -e "$UNIT_TARGET" ]; then
  printf 'vellum: preserving an administrator-owned systemd user unit\n' >&2
fi

# Delete only the exact registration symlink Vellum minted. Any administrator
# replacement is preserved. The pre-removal hook already proved kernel unload.
if [ -L "$PROFILE_TARGET" ]; then
  if [ "$(readlink "$PROFILE_TARGET")" = '/opt/Vellum Command/resources/apparmor-profile' ]; then
    rm -f -- "$PROFILE_TARGET"
  else
    printf 'vellum: preserving an AppArmor link not owned by this package\n' >&2
  fi
elif [ -e "$PROFILE_TARGET" ]; then
  printf 'vellum: preserving administrator-owned AppArmor configuration\n' >&2
fi
