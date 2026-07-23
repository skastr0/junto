#!/bin/sh
# Debian post-install hook for the Ubuntu 24.04 Vellum package.
set -eu
set -f

APP_DIR='/opt/Vellum Command'
EXECUTABLE="$APP_DIR/vellum"
CHROME_SANDBOX="$APP_DIR/chrome-sandbox"
WORK_CLI="$APP_DIR/resources/bin/vellum"
BROWSER_CLI="$APP_DIR/resources/bin/vellum-browser"
RELEASE_INSTALLER_SOURCE="$APP_DIR/resources/bin/vellum-release-installer"
RELEASE_BRIDGE_SOURCE="$APP_DIR/resources/bin/vellum-release-bridge"
PEER_PID_HELPER="$APP_DIR/resources/bin/unix-peer-pid.py"
PROFILE_SOURCE="$APP_DIR/resources/apparmor-profile"
PROFILE_TARGET='/etc/apparmor.d/vellum'
UNIT_SOURCE="$APP_DIR/resources/systemd/vellum-remote.service"
UNIT_TARGET='/usr/lib/systemd/user/vellum-remote.service'
UNIT_DIRECTORY='/usr/lib/systemd/user'
INSTALLER_TARGET='/usr/libexec/vellum-release-installer'
BRIDGE_TARGET='/usr/libexec/vellum-release-bridge'
BRIDGE_STAGE_ROOT='/var/tmp/vellum-release-bridge'
SUDOERS_TARGET='/etc/sudoers.d/vellum-release-installer'
INSTALLER_STATE='/var/lib/vellum-release-installer'
INSTALLER_MARKER="$INSTALLER_STATE/packaged-helper.sha256"
BRIDGE_MARKER="$INSTALLER_STATE/packaged-bridge.sha256"
BRIDGE_STAGE_MARKER="$INSTALLER_STATE/packaged-bridge-stage-root"
BRIDGE_STAGE_MARKER_VALUE='vellum/linux-release-bridge-stage-root/v1'
SUDOERS_MARKER="$INSTALLER_STATE/packaged-sudoers.sha256"
LEGACY_SUDOERS_SHA256='a6edc7952e89af7570f74c53390aeccb8b0fe61456248762330517c7031a2f72'

require_regular_file() {
  if [ ! -f "$1" ] || [ -L "$1" ]; then
    printf 'vellum: package file is missing or not regular: %s\n' "$1" >&2
    exit 1
  fi
}

for packaged_file in \
  "$EXECUTABLE" \
  "$CHROME_SANDBOX" \
  "$WORK_CLI" \
  "$BROWSER_CLI" \
  "$RELEASE_INSTALLER_SOURCE" \
  "$RELEASE_BRIDGE_SOURCE" \
  "$PEER_PID_HELPER" \
  "$PROFILE_SOURCE" \
  "$UNIT_SOURCE"
do
  require_regular_file "$packaged_file"
done

if [ ! -x /usr/sbin/apparmor_parser ]; then
  printf 'vellum: AppArmor parser is required on Ubuntu 24.04\n' >&2
  exit 1
fi
/usr/sbin/apparmor_parser --skip-kernel-load --debug "$PROFILE_SOURCE" >/dev/null

load_live_profile=1
if [ -x /usr/bin/ischroot ] && /usr/bin/ischroot; then
  load_live_profile=0
elif [ ! -x /usr/bin/aa-enabled ] || ! /usr/bin/aa-enabled; then
  printf 'vellum: AppArmor must be enabled for the supported Chromium sandbox\n' >&2
  exit 1
fi

# The supported sandbox path is AppArmor-qualified unprivileged userns. Keep
# Chromium's setuid helper inert instead of silently falling back to setuid.
chown root:root "$CHROME_SANDBOX"
chmod 0755 "$CHROME_SANDBOX"
chmod 0755 "$EXECUTABLE" "$WORK_CLI" "$BROWSER_CLI" "$PEER_PID_HELPER"
chmod 0755 "$RELEASE_INSTALLER_SOURCE"
chmod 0755 "$RELEASE_BRIDGE_SOURCE"
chmod 0644 "$UNIT_SOURCE"

ensure_root_directory() {
  directory="$1"
  expected_mode="$2"
  if [ -L "$directory" ]; then
    printf 'vellum: refusing a root authority directory symlink: %s\n' "$directory" >&2
    exit 1
  fi
  if [ ! -e "$directory" ]; then
    mkdir -m "$expected_mode" -- "$directory"
  fi
  if [ ! -d "$directory" ] ||
     [ "$(stat -c '%u:%g:%a' "$directory" 2>/dev/null || true)" != "0:0:$expected_mode" ]; then
    printf 'vellum: root authority directory is unsafe: %s\n' "$directory" >&2
    exit 1
  fi
}

sha256_file() {
  /usr/bin/sha256sum "$1" | /usr/bin/awk '{ print $1 }'
}

admit_package_owned_target() {
  target="$1"
  marker="$2"
  source_sha="$3"
  expected_mode="$4"
  if [ ! -e "$target" ] && [ ! -L "$target" ]; then
    return
  fi
  if [ -L "$target" ] || [ ! -f "$target" ] ||
     [ "$(stat -c '%u:%g:%a:%h' "$target" 2>/dev/null || true)" != "0:0:$expected_mode:1" ]; then
    printf 'vellum: refusing an unsafe root-owned installer target\n' >&2
    exit 1
  fi
  target_sha="$(sha256_file "$target")"
  if [ -e "$marker" ] || [ -L "$marker" ]; then
    if [ -L "$marker" ] || [ ! -f "$marker" ] ||
       [ "$(stat -c '%u:%g:%a:%h' "$marker" 2>/dev/null || true)" != '0:0:600:1' ]; then
      printf 'vellum: refusing a root target without its exact package custody marker\n' >&2
      exit 1
    fi
    marker_text="$(/bin/cat "$marker" 2>/dev/null || true)"
    set -- $marker_text
    marker_admitted=0
    if [ "$#" -eq 1 ] && [ "$marker_text" = "$1" ]; then
      first_sha="$1"
      second_sha=
    elif [ "$#" -eq 2 ] && [ "$marker_text" = "$1 $2" ]; then
      first_sha="$1"
      second_sha="$2"
    else
      first_sha=invalid
      second_sha=invalid
    fi
    case "$first_sha" in
      none) [ -n "$second_sha" ] || first_sha=invalid ;;
      ""|*[!0-9a-f]*) first_sha=invalid ;;
      *) [ "${#first_sha}" -eq 64 ] || first_sha=invalid ;;
    esac
    if [ -n "$second_sha" ]; then
      case "$second_sha" in ""|*[!0-9a-f]*) second_sha=invalid ;; esac
      [ "${#second_sha}" -eq 64 ] || second_sha=invalid
    fi
    [ "$first_sha" = "$target_sha" ] && marker_admitted=1
    [ "$second_sha" = "$target_sha" ] && marker_admitted=1
    if [ "$first_sha" = invalid ] || [ "$second_sha" = invalid ] ||
       [ "$marker_admitted" != 1 ]; then
      printf 'vellum: refusing a root target without its exact package custody marker\n' >&2
      exit 1
    fi
  elif [ "$target_sha" != "$source_sha" ]; then
    printf 'vellum: preserving an unclaimed root-owned installer target\n' >&2
    exit 1
  fi
}

publish_root_file() {
  source="$1"
  target="$2"
  expected_mode="$3"
  target_directory="$(dirname "$target")"
  # The temporary must share the target filesystem. A rename from /var into
  # /usr or /etc can degrade to copy+unlink and expose a torn root command.
  temporary="$(mktemp "$target_directory/.vellum-package.XXXXXXXX")"
  /usr/bin/install -o root -g root -m "$expected_mode" -- "$source" "$temporary"
  /bin/sync -f "$temporary"
  mv -- "$temporary" "$target"
  /bin/sync -f "$target_directory"
}

publish_marker() {
  digest_set="$1"
  marker="$2"
  temporary="$(mktemp "$INSTALLER_STATE/.package-marker.XXXXXXXX")"
  printf '%s\n' "$digest_set" > "$temporary"
  chown root:root "$temporary"
  chmod 0600 "$temporary"
  /bin/sync -f "$temporary"
  mv -- "$temporary" "$marker"
  /bin/sync -f "$INSTALLER_STATE"
}

ensure_package_bridge_stage_root() {
  created=0
  if [ -L "$BRIDGE_STAGE_ROOT" ]; then
    printf 'vellum: refusing a release bridge stage-root symlink\n' >&2
    exit 1
  fi
  if [ ! -e "$BRIDGE_STAGE_ROOT" ]; then
    mkdir -m 1733 -- "$BRIDGE_STAGE_ROOT"
    chown root:root "$BRIDGE_STAGE_ROOT"
    chmod 1733 "$BRIDGE_STAGE_ROOT"
    created=1
  fi
  if [ ! -d "$BRIDGE_STAGE_ROOT" ] ||
     [ "$(stat -c '%u:%g:%a' "$BRIDGE_STAGE_ROOT" 2>/dev/null || true)" != '0:0:1733' ]; then
    printf 'vellum: refusing an unsafe release bridge stage root\n' >&2
    exit 1
  fi

  if [ "$created" -eq 1 ]; then
    publish_marker "$BRIDGE_STAGE_MARKER_VALUE" "$BRIDGE_STAGE_MARKER"
    return
  fi
  if [ -L "$BRIDGE_STAGE_MARKER" ] || [ ! -f "$BRIDGE_STAGE_MARKER" ] ||
     [ "$(stat -c '%u:%g:%a:%h' "$BRIDGE_STAGE_MARKER" 2>/dev/null || true)" != '0:0:600:1' ] ||
     [ "$(/bin/cat "$BRIDGE_STAGE_MARKER" 2>/dev/null || true)" != "$BRIDGE_STAGE_MARKER_VALUE" ]; then
    printf 'vellum: preserving a foreign release bridge stage root\n' >&2
    exit 1
  fi
}

retire_legacy_sudoers_policy() {
  target="$1"
  marker="$2"
  expected_sha="$3"
  unknown_action="$4"

  if [ -e "$target" ] || [ -L "$target" ]; then
    if [ -L "$target" ] || [ ! -f "$target" ] ||
       [ "$(stat -c '%u:%g:%a:%h' "$target" 2>/dev/null || true)" != '0:0:440:1' ]; then
      printf 'vellum: preserving unsafe or foreign release-installer sudoers policy\n' >&2
      [ "$unknown_action" != fail ] || return 1
      return 0
    fi
    target_sha="$(sha256_file "$target")"
    if [ "$target_sha" != "$expected_sha" ]; then
      printf 'vellum: preserving modified or foreign release-installer sudoers policy\n' >&2
      [ "$unknown_action" != fail ] || return 1
      return 0
    fi
    rm -f -- "$target"
  fi

  if [ ! -e "$marker" ] && [ ! -L "$marker" ]; then
    return 0
  fi
  if [ -L "$marker" ] || [ ! -f "$marker" ] ||
     [ "$(stat -c '%u:%g:%a:%h' "$marker" 2>/dev/null || true)" != '0:0:600:1' ]; then
    printf 'vellum: preserving unsafe legacy sudoers custody marker\n' >&2
    return 0
  fi

  marker_text="$(/bin/cat "$marker" 2>/dev/null || true)"
  set -- $marker_text
  if [ "$#" -eq 1 ] && [ "$marker_text" = "$1" ]; then
    first_sha="$1"
    second_sha=
  elif [ "$#" -eq 2 ] && [ "$marker_text" = "$1 $2" ]; then
    first_sha="$1"
    second_sha="$2"
  else
    printf 'vellum: preserving malformed legacy sudoers custody marker\n' >&2
    return 0
  fi
  case "$first_sha" in
    none) [ -n "$second_sha" ] || first_sha=invalid ;;
    ""|*[!0-9a-f]*) first_sha=invalid ;;
    *) [ "${#first_sha}" -eq 64 ] || first_sha=invalid ;;
  esac
  if [ -n "$second_sha" ]; then
    case "$second_sha" in ""|*[!0-9a-f]*) second_sha=invalid ;; esac
    [ "${#second_sha}" -eq 64 ] || second_sha=invalid
  fi
  if [ "$first_sha" = invalid ] || [ "$second_sha" = invalid ]; then
    printf 'vellum: preserving malformed legacy sudoers custody marker\n' >&2
    return 0
  fi
  if [ "$first_sha" != "$expected_sha" ] &&
     [ "$second_sha" != "$expected_sha" ]; then
    printf 'vellum: preserving unrelated legacy sudoers custody marker\n' >&2
    return 0
  fi
  rm -f -- "$marker"
}

ensure_root_directory /usr/libexec 755
ensure_root_directory /etc/sudoers.d 750
ensure_root_directory "$INSTALLER_STATE" 700
ensure_package_bridge_stage_root
INSTALLER_SOURCE_SHA="$(sha256_file "$RELEASE_INSTALLER_SOURCE")"
BRIDGE_SOURCE_SHA="$(sha256_file "$RELEASE_BRIDGE_SOURCE")"
if ! retire_legacy_sudoers_policy \
  "$SUDOERS_TARGET" \
  "$SUDOERS_MARKER" \
  "$LEGACY_SUDOERS_SHA256" \
  fail
then
  exit 1
fi
admit_package_owned_target "$INSTALLER_TARGET" "$INSTALLER_MARKER" "$INSTALLER_SOURCE_SHA" 755
admit_package_owned_target "$BRIDGE_TARGET" "$BRIDGE_MARKER" "$BRIDGE_SOURCE_SHA" 755
if [ -f "$INSTALLER_TARGET" ] && [ ! -L "$INSTALLER_TARGET" ]; then
  INSTALLER_PRIOR_SHA="$(sha256_file "$INSTALLER_TARGET")"
else
  INSTALLER_PRIOR_SHA=none
fi
if [ -f "$BRIDGE_TARGET" ] && [ ! -L "$BRIDGE_TARGET" ]; then
  BRIDGE_PRIOR_SHA="$(sha256_file "$BRIDGE_TARGET")"
else
  BRIDGE_PRIOR_SHA=none
fi

created_profile_link=0
created_unit_link=0
registered_alternative=0
cleanup_new_links() {
  if [ "$registered_alternative" -eq 1 ] && command -v update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove vellum "$WORK_CLI" || true
  fi
  if [ "$created_unit_link" -eq 1 ] && [ -L "$UNIT_TARGET" ] && \
     [ "$(readlink "$UNIT_TARGET")" = "$UNIT_SOURCE" ]; then
    rm -f -- "$UNIT_TARGET"
  fi
  if [ "$created_profile_link" -eq 1 ] && [ -L "$PROFILE_TARGET" ] && \
     [ "$(readlink "$PROFILE_TARGET")" = "$PROFILE_SOURCE" ]; then
    rm -f -- "$PROFILE_TARGET"
  fi
}
trap cleanup_new_links EXIT HUP INT TERM

if ! command -v update-alternatives >/dev/null 2>&1; then
  printf 'vellum: update-alternatives is required to install the vellum command\n' >&2
  exit 1
fi
# A later registration/profile action can still fail. Record whether this run
# added the package alternative so the exit trap rolls back only that entry.
if ! update-alternatives --query vellum 2>/dev/null | /bin/grep -Fqx "Alternative: $WORK_CLI"; then
  update-alternatives --install /usr/bin/vellum vellum "$WORK_CLI" 100
  registered_alternative=1
fi

if command -v update-mime-database >/dev/null 2>&1; then
  update-mime-database /usr/share/mime >/dev/null 2>&1 || true
fi
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
fi

# The global registration is a qualified symlink to an immutable package file.
# Never overwrite administrator content or a link owned by another package.
if [ -L "$PROFILE_TARGET" ]; then
  if [ "$(readlink "$PROFILE_TARGET")" != "$PROFILE_SOURCE" ]; then
    printf 'vellum: refusing an AppArmor link not owned by this package\n' >&2
    exit 1
  fi
elif [ -e "$PROFILE_TARGET" ]; then
  printf 'vellum: refusing an existing administrator-owned AppArmor profile\n' >&2
  exit 1
else
  ln -s "$PROFILE_SOURCE" "$PROFILE_TARGET"
  created_profile_link=1
fi
if [ ! -d "$UNIT_DIRECTORY" ] || [ -L "$UNIT_DIRECTORY" ]; then
  printf 'vellum: canonical systemd user-unit directory is unavailable\n' >&2
  exit 1
fi
if [ -L "$UNIT_TARGET" ]; then
  if [ "$(readlink "$UNIT_TARGET")" != "$UNIT_SOURCE" ]; then
    printf 'vellum: refusing a systemd user unit link not owned by this package\n' >&2
    exit 1
  fi
elif [ -e "$UNIT_TARGET" ]; then
  printf 'vellum: refusing an existing administrator-owned systemd user unit\n' >&2
  exit 1
else
  ln -s "$UNIT_SOURCE" "$UNIT_TARGET"
  created_unit_link=1
fi

# A chroot/package-image build can validate but cannot load host policy. On a
# real installation, live AppArmor replacement is the final fallible action.
if [ "$load_live_profile" -eq 1 ]; then
  /usr/sbin/apparmor_parser --replace --write-cache --skip-read-cache "$PROFILE_SOURCE"
fi

# The helper remains a fixed root-owned executable, but the package grants no
# passwordless mutation authority. Every privileged invocation must cross the
# host's ordinary, visible sudo authentication boundary.
publish_marker "$INSTALLER_PRIOR_SHA $INSTALLER_SOURCE_SHA" "$INSTALLER_MARKER"
publish_root_file "$RELEASE_INSTALLER_SOURCE" "$INSTALLER_TARGET" 0755
publish_marker "$INSTALLER_SOURCE_SHA" "$INSTALLER_MARKER"
publish_marker "$BRIDGE_PRIOR_SHA $BRIDGE_SOURCE_SHA" "$BRIDGE_MARKER"
publish_root_file "$RELEASE_BRIDGE_SOURCE" "$BRIDGE_TARGET" 0755
publish_marker "$BRIDGE_SOURCE_SHA" "$BRIDGE_MARKER"
trap - EXIT HUP INT TERM
