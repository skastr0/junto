#!/bin/sh
# Debian post-removal hook. User-authored ~/.vellum data is never in scope.
set -eu

PROFILE_TARGET='/etc/apparmor.d/vellum'

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
