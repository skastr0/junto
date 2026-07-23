#!/bin/sh
# Debian post-install hook for the Ubuntu 24.04 Vellum package.
set -eu

APP_DIR='/opt/Vellum Command'
EXECUTABLE="$APP_DIR/vellum"
CHROME_SANDBOX="$APP_DIR/chrome-sandbox"
WORK_CLI="$APP_DIR/resources/bin/vellum"
BROWSER_CLI="$APP_DIR/resources/bin/vellum-browser"
PEER_PID_HELPER="$APP_DIR/resources/bin/unix-peer-pid.py"
PROFILE_SOURCE="$APP_DIR/resources/apparmor-profile"
PROFILE_TARGET='/etc/apparmor.d/vellum'

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
  "$PEER_PID_HELPER" \
  "$PROFILE_SOURCE"
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

if ! command -v update-alternatives >/dev/null 2>&1; then
  printf 'vellum: update-alternatives is required to install the vellum command\n' >&2
  exit 1
fi
update-alternatives --install /usr/bin/vellum vellum "$WORK_CLI" 100

if command -v update-mime-database >/dev/null 2>&1; then
  update-mime-database /usr/share/mime >/dev/null 2>&1 || true
fi
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
fi

# The global registration is a qualified symlink to an immutable package file.
# Never overwrite administrator content or a link owned by another package.
created_profile_link=0
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
cleanup_new_profile_link() {
  if [ "$created_profile_link" -eq 1 ] && [ -L "$PROFILE_TARGET" ] && \
     [ "$(readlink "$PROFILE_TARGET")" = "$PROFILE_SOURCE" ]; then
    rm -f -- "$PROFILE_TARGET"
  fi
}
trap cleanup_new_profile_link EXIT HUP INT TERM

# A chroot/package-image build can validate but cannot load host policy. On a
# real installation, live AppArmor replacement is the final fallible action.
if [ "$load_live_profile" -eq 1 ]; then
  /usr/sbin/apparmor_parser --replace --write-cache --skip-read-cache "$PROFILE_SOURCE"
fi
trap - EXIT HUP INT TERM
