#!/bin/sh
# Debian post-removal hook. User-authored ~/.vellum data is never in scope.
set -eu
set -f

PROFILE_TARGET='/etc/apparmor.d/vellum'
UNIT_TARGET='/usr/lib/systemd/user/vellum-remote.service'
UNIT_SOURCE='/opt/Vellum Command/resources/systemd/vellum-remote.service'
INSTALLER_TARGET='/usr/libexec/vellum-release-installer'
SUDOERS_TARGET='/etc/sudoers.d/vellum-release-installer'
INSTALLER_STATE='/var/lib/vellum-release-installer'
INSTALLER_MARKER="$INSTALLER_STATE/packaged-helper.sha256"
SUDOERS_MARKER="$INSTALLER_STATE/packaged-sudoers.sha256"

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

remove_package_owned_root_file() {
  target="$1"
  marker="$2"
  expected_mode="$3"
  if [ ! -e "$marker" ] && [ ! -L "$marker" ]; then
    return
  fi
  if [ -L "$marker" ] || [ ! -f "$marker" ] ||
     [ "$(stat -c '%u:%g:%a:%h' "$marker" 2>/dev/null || true)" != '0:0:600:1' ]; then
    printf 'vellum: preserving root authority with an unsafe custody marker: %s\n' "$target" >&2
    return
  fi
  marker_text="$(/bin/cat "$marker" 2>/dev/null || true)"
  # Stable custody is one digest. A crash-safe publication transition is
  # exactly "<old-or-none> <new>". Reconstructing the line rejects tabs,
  # duplicate spaces, embedded newlines, and extra fields.
  set -- $marker_text
  if [ "$#" -eq 1 ] && [ "$marker_text" = "$1" ]; then
    first_sha="$1"
    second_sha=
  elif [ "$#" -eq 2 ] && [ "$marker_text" = "$1 $2" ]; then
    first_sha="$1"
    second_sha="$2"
  else
    printf 'vellum: preserving root authority with a malformed custody marker: %s\n' "$target" >&2
    return
  fi
  case "$first_sha" in
    none) [ -n "$second_sha" ] || return ;;
    ""|*[!0-9a-f]*) return ;;
    *) [ "${#first_sha}" -eq 64 ] || return ;;
  esac
  if [ -n "$second_sha" ]; then
    case "$second_sha" in ""|*[!0-9a-f]*) return ;; esac
    [ "${#second_sha}" -eq 64 ] || return
  fi

  if [ ! -e "$target" ] && [ ! -L "$target" ]; then
    if [ "$first_sha" = none ]; then
      rm -f -- "$marker"
      return
    fi
    printf 'vellum: preserving custody marker for a missing root authority: %s\n' "$target" >&2
    return
  fi
  if [ -L "$target" ] || [ ! -f "$target" ] ||
     [ "$(stat -c '%u:%g:%a:%h' "$target" 2>/dev/null || true)" != "0:0:$expected_mode:1" ]; then
    printf 'vellum: preserving modified root authority: %s\n' "$target" >&2
    return
  fi
  target_sha="$(/usr/bin/sha256sum "$target" | /usr/bin/awk '{ print $1 }')"
  if [ "$target_sha" != "$first_sha" ] && [ "$target_sha" != "$second_sha" ]; then
    printf 'vellum: preserving modified root authority: %s\n' "$target" >&2
    return
  fi
  rm -f -- "$target"
  rm -f -- "$marker"
}

# Preserve journals and rollback caches. Remove only exact package-minted
# executable/policy inodes whose private custody markers still match.
remove_package_owned_root_file "$SUDOERS_TARGET" "$SUDOERS_MARKER" 440
remove_package_owned_root_file "$INSTALLER_TARGET" "$INSTALLER_MARKER" 755

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
