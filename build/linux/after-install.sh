#!/bin/sh
# Debian post-install hook for the Ubuntu 24.04 Vellum package.
set -eu

APP_DIR='/opt/Vellum Command'
EXECUTABLE="$APP_DIR/vellum"
CHROME_SANDBOX="$APP_DIR/chrome-sandbox"
WORK_CLI="$APP_DIR/resources/bin/vellum"
BROWSER_CLI="$APP_DIR/resources/bin/vellum-browser"
RELEASE_INSTALLER_SOURCE="$APP_DIR/resources/bin/vellum-release-installer"
PEER_PID_HELPER="$APP_DIR/resources/bin/unix-peer-pid.py"
SUDOERS_SOURCE="$APP_DIR/resources/policy/vellum-release-installer.sudoers"
PROFILE_SOURCE="$APP_DIR/resources/apparmor-profile"
PROFILE_TARGET='/etc/apparmor.d/vellum'
UNIT_SOURCE="$APP_DIR/resources/systemd/vellum-remote.service"
UNIT_TARGET='/usr/lib/systemd/user/vellum-remote.service'
UNIT_DIRECTORY='/usr/lib/systemd/user'
INSTALLER_TARGET='/usr/libexec/vellum-release-installer'
SUDOERS_TARGET='/etc/sudoers.d/vellum-release-installer'
INSTALLER_STATE='/var/lib/vellum-release-installer'
INSTALLER_MARKER="$INSTALLER_STATE/packaged-helper.sha256"
SUDOERS_MARKER="$INSTALLER_STATE/packaged-sudoers.sha256"

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
  "$PEER_PID_HELPER" \
  "$SUDOERS_SOURCE" \
  "$PROFILE_SOURCE" \
  "$UNIT_SOURCE"
do
  require_regular_file "$packaged_file"
done

if [ ! -x /usr/sbin/apparmor_parser ]; then
  printf 'vellum: AppArmor parser is required on Ubuntu 24.04\n' >&2
  exit 1
fi
if [ ! -x /usr/sbin/visudo ]; then
  printf 'vellum: visudo is required to validate the fixed installer authority\n' >&2
  exit 1
fi

/usr/sbin/apparmor_parser --skip-kernel-load --debug "$PROFILE_SOURCE" >/dev/null
/usr/sbin/visudo -cf "$SUDOERS_SOURCE" >/dev/null

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
chmod 0440 "$SUDOERS_SOURCE"
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
    marker_admitted=0
    marker_valid=1
    marker_fields=0
    for marker_sha in $(/bin/cat "$marker" 2>/dev/null || true); do
      marker_fields=$((marker_fields + 1))
      case "$marker_sha" in
        none) ;;
        ""|*[!0-9a-f]*) marker_valid=0 ;;
        *)
          [ "${#marker_sha}" -eq 64 ] || marker_valid=0
          [ "$marker_sha" = "$target_sha" ] && marker_admitted=1
          ;;
      esac
    done
    if [ "$marker_valid" != 1 ] || [ "$marker_fields" -lt 1 ] ||
       [ "$marker_fields" -gt 2 ] || [ "$marker_admitted" != 1 ]; then
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
  temporary="$(mktemp "$INSTALLER_STATE/.package-file.XXXXXXXX")"
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

ensure_root_directory /usr/libexec 755
ensure_root_directory /etc/sudoers.d 750
ensure_root_directory "$INSTALLER_STATE" 700
INSTALLER_SOURCE_SHA="$(sha256_file "$RELEASE_INSTALLER_SOURCE")"
SUDOERS_SOURCE_SHA="$(sha256_file "$SUDOERS_SOURCE")"
admit_package_owned_target "$INSTALLER_TARGET" "$INSTALLER_MARKER" "$INSTALLER_SOURCE_SHA" 755
admit_package_owned_target "$SUDOERS_TARGET" "$SUDOERS_MARKER" "$SUDOERS_SOURCE_SHA" 440
if [ -f "$INSTALLER_TARGET" ] && [ ! -L "$INSTALLER_TARGET" ]; then
  INSTALLER_PRIOR_SHA="$(sha256_file "$INSTALLER_TARGET")"
else
  INSTALLER_PRIOR_SHA=none
fi
if [ -f "$SUDOERS_TARGET" ] && [ ! -L "$SUDOERS_TARGET" ]; then
  SUDOERS_PRIOR_SHA="$(sha256_file "$SUDOERS_TARGET")"
else
  SUDOERS_PRIOR_SHA=none
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

# Publish the command policy before the executable. The policy grants one
# no-argument, NOSETENV command from cwd=/; compile-time autoload is disabled.
publish_marker "$SUDOERS_PRIOR_SHA $SUDOERS_SOURCE_SHA" "$SUDOERS_MARKER"
publish_root_file "$SUDOERS_SOURCE" "$SUDOERS_TARGET" 0440
/usr/sbin/visudo -cf "$SUDOERS_TARGET" >/dev/null
publish_marker "$SUDOERS_SOURCE_SHA" "$SUDOERS_MARKER"
publish_marker "$INSTALLER_PRIOR_SHA $INSTALLER_SOURCE_SHA" "$INSTALLER_MARKER"
publish_root_file "$RELEASE_INSTALLER_SOURCE" "$INSTALLER_TARGET" 0755
publish_marker "$INSTALLER_SOURCE_SHA" "$INSTALLER_MARKER"
trap - EXIT HUP INT TERM
