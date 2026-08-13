/** Closed SSH programs for deployment and confined Herdr transfers. */
import { Effect } from "effect";
import { makeRemoteCommand, type RemoteCommand, SshInputError } from "./domain";

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** Owner-only, capability-independent preflight. */
export const compileLinuxUserlandPreflightSource = (): string => String.raw`
set -eu
umask 077
fail() { printf 'LINUX_USERLAND_PREFLIGHT_V1 ok=0 reason=%s\n' "$1"; exit 0; }
UID_VALUE=$(/usr/bin/id -u) || fail identity
case "$UID_VALUE" in ''|0|*[!0-9]*) fail identity;; esac
/usr/bin/systemctl --user show-environment >/dev/null 2>&1 || fail systemd-user
[ ! -L "$HOME/.vellum-command" ] || fail home-link
mkdir -p "$HOME/.vellum-command/runtime/releases" "$HOME/.vellum-command/runtime/staging" || fail runtime
chmod 700 "$HOME/.vellum-command" "$HOME/.vellum-command/runtime" "$HOME/.vellum-command/runtime/releases" "$HOME/.vellum-command/runtime/staging" || fail runtime
FREE=$(/usr/bin/df -PB1 "$HOME" | /usr/bin/awk 'NR == 2 { print $4 }')
case "$FREE" in ''|*[!0-9]*) fail disk;; esac
printf 'LINUX_USERLAND_PREFLIGHT_V1 ok=1 uid=%s free=%s\n' "$UID_VALUE" "$FREE"
`.trim();

export const compileLinuxUserlandPreflight = (): Effect.Effect<RemoteCommand, SshInputError> =>
  makeRemoteCommand("/bin/sh", ["-c", compileLinuxUserlandPreflightSource(), "vellum-plan:linux-userland-preflight"]);

/**
 * One owner-home archive transaction. Header is fixed by the provider:
 * `LINUX_USERLAND_DEPLOY_V1 version=<semver> sha256=<hex> bytes=<n>\n`.
 * The runtime archive itself is the candidate; paths/modes are rejected by tar
 * before extraction, and activation happens only after staged extract and
 * sealed --install-user-service.
 */
export const compileLinuxUserlandDeploySource = (): string => String.raw`
set -eu
umask 077
fail() { printf 'LINUX_USERLAND_DEPLOY_V1 ok=0 state=%s\n' "$1"; exit 0; }
IFS= read -r HEADER || fail header
case "$HEADER" in LINUX_USERLAND_DEPLOY_V1\ version=*\ sha256=*\ bytes=*) ;; *) fail header;; esac
VERSION=$(printf '%s\n' "$HEADER" | /usr/bin/awk '{split($2,a,"="); print a[2]}')
SHA=$(printf '%s\n' "$HEADER" | /usr/bin/awk '{split($3,a,"="); print a[2]}')
BYTES=$(printf '%s\n' "$HEADER" | /usr/bin/awk '{split($4,a,"="); print a[2]}')
printf '%s\n' "$VERSION" | /usr/bin/awk -F. 'NF == 3 && $1 ~ /^(0|[1-9][0-9]*)$/ && $2 ~ /^(0|[1-9][0-9]*)$/ && $3 ~ /^(0|[1-9][0-9]*)$/ { ok=1 } END { exit ok ? 0 : 1 }' || fail header
case "$SHA" in ????????????????????????????????????????????????????????????????) ;; *) fail header;; esac
case "$BYTES" in ''|0|*[!0-9]*) fail header;; esac
[ "$BYTES" -le 3221225472 ] || fail header
ROOT="$HOME/.vellum-command/runtime"
[ ! -L "$HOME/.vellum-command" ] && [ ! -L "$ROOT" ] || fail home-link
mkdir -p "$ROOT/releases" "$ROOT/staging" || fail stage
chmod 700 "$ROOT" "$ROOT/releases" "$ROOT/staging" || fail stage
DEST="$ROOT/releases/$VERSION-$SHA"
case "$DEST" in "$ROOT"/releases/*) ;; *) fail path;; esac
UNIT="$HOME/.config/systemd/user/vellum-command-remote.service"
REMOTE_BIN="$DEST/resources/bin/vellum-command-remote"
LAUNCHER="$DEST/resources/systemd/vellum-command-remote-launch"
GENERATION_MARKER="releases/$VERSION-$SHA"
unit_pins_generation() {
  [ -f "$UNIT" ] && [ ! -L "$UNIT" ] || return 1
  /usr/bin/grep -F "ExecStart=" "$UNIT" | /usr/bin/grep -F "$GENERATION_MARKER/resources/systemd/vellum-command-remote-launch" >/dev/null 2>&1 || return 1
  /usr/bin/grep -F "ConditionFileIsExecutable=" "$UNIT" | /usr/bin/grep -F "$GENERATION_MARKER/resources/bin/vellum-command-remote" >/dev/null 2>&1 || return 1
  return 0
}
prove_activation() {
  /usr/bin/systemctl --user daemon-reload >/dev/null 2>&1 || return 1
  /usr/bin/systemctl --user restart vellum-command-remote.service >/dev/null 2>&1 || return 1
  /usr/bin/systemctl --user is-active --quiet vellum-command-remote.service || return 1
  SOCK="$HOME/.vellum-command/work/control.sock"
  TOKEN="$HOME/.vellum-command/work/token"
  WAIT=0
  while [ "$WAIT" -lt 30 ]; do
    if [ -S "$SOCK" ] && [ ! -L "$SOCK" ] \
      && [ -f "$TOKEN" ] && [ ! -L "$TOKEN" ] \
      && [ "$(/usr/bin/stat -c '%a' "$SOCK" 2>/dev/null || true)" = 600 ] \
      && [ "$(/usr/bin/stat -c '%a' "$TOKEN" 2>/dev/null || true)" = 600 ] \
      && /usr/bin/python3 -c 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.settimeout(2); s.connect(sys.argv[1]); s.close()' "$SOCK"
    then
      return 0
    fi
    WAIT=$((WAIT + 1))
    /bin/sleep 1
  done
  return 1
}
if [ -d "$DEST" ] && [ ! -L "$DEST" ] && [ -x "$REMOTE_BIN" ] && [ ! -L "$REMOTE_BIN" ] && [ -x "$LAUNCHER" ] && [ ! -L "$LAUNCHER" ]; then
  if unit_pins_generation; then
    prove_activation || fail readiness
    printf 'LINUX_USERLAND_DEPLOY_V1 ok=1 state=idempotent release=%s\n' "$VERSION-$SHA"
    exit 0
  fi
  # Generation directory exists but unit does not pin it — sealed reinstall of unit only.
  "$REMOTE_BIN" --install-user-service >/dev/null 2>&1 || fail service
  unit_pins_generation || fail service
  prove_activation || fail readiness
  printf 'LINUX_USERLAND_DEPLOY_V1 ok=1 state=ready release=%s\n' "$VERSION-$SHA"
  exit 0
fi
STAGE="$ROOT/staging/$VERSION-$SHA-$$"
ARCHIVE="$STAGE/runtime.tar.gz"
mkdir "$STAGE" || fail stage
chmod 700 "$STAGE"
/usr/bin/head -c "$BYTES" > "$ARCHIVE" || fail stream
[ "$(/usr/bin/stat -c '%s' "$ARCHIVE")" = "$BYTES" ] || fail size
[ "$(/usr/bin/sha256sum "$ARCHIVE" | /usr/bin/awk '{print $1}')" = "$SHA" ] || fail hash
/usr/bin/tar -tvzf "$ARCHIVE" | /usr/bin/awk '
  BEGIN { ok=1; root=""; remote=0; launch=0 }
  {
    if ($1 !~ /^[-d]/ || $0 ~ / -> / || $0 ~ / link to / || $NF ~ /^\// || $NF ~ /(^|\/)\.\.($|\/)/) { ok=0; next }
    if ($NF !~ /^vellum-runtime-[0-9]+\.[0-9]+\.[0-9]+-linux-x64(\/|$)/) { ok=0; next }
    if (root == "" && $1 ~ /^d/ && $NF ~ /^vellum-runtime-[0-9]+\.[0-9]+\.[0-9]+-linux-x64\/?$/) root=$NF
    if ($NF ~ /\/resources\/bin\/vellum-command-remote$/ && $1 ~ /^-/) remote=1
    if ($NF ~ /\/resources\/systemd\/vellum-command-remote-launch$/ && $1 ~ /^-/) launch=1
  }
  END { exit (ok && remote && launch) ? 0 : 1 }
' || fail members
/usr/bin/tar -xzf "$ARCHIVE" -C "$STAGE" --no-same-owner --no-same-permissions || fail extract
RELEASE="$STAGE/vellum-runtime-$VERSION-linux-x64"
CANDIDATE_REMOTE="$RELEASE/resources/bin/vellum-command-remote"
[ -d "$RELEASE" ] && [ ! -L "$RELEASE" ] && [ -x "$CANDIDATE_REMOTE" ] && [ ! -L "$CANDIDATE_REMOTE" ] || fail candidate
[ -x "$RELEASE/resources/systemd/vellum-command-remote-launch" ] && [ ! -L "$RELEASE/resources/systemd/vellum-command-remote-launch" ] || fail candidate
if [ -e "$DEST" ] || [ -L "$DEST" ]; then
  fail install
fi
mv "$RELEASE" "$DEST" || fail install
/bin/rm -f -- "$ARCHIVE" || fail cleanup
/bin/rmdir -- "$STAGE" || fail cleanup
[ -x "$REMOTE_BIN" ] && [ ! -L "$REMOTE_BIN" ] || fail candidate
"$REMOTE_BIN" --install-user-service >/dev/null 2>&1 || fail service
unit_pins_generation || fail service
prove_activation || fail readiness
printf 'LINUX_USERLAND_DEPLOY_V1 ok=1 state=ready release=%s\n' "$VERSION-$SHA"
`.trim();

export const compileLinuxUserlandDeploy = (): Effect.Effect<RemoteCommand, SshInputError> =>
  makeRemoteCommand("/bin/sh", ["-c", compileLinuxUserlandDeploySource(), "vellum-plan:linux-userland-deploy"]);

export const compileLinuxUserlandRestartSource = (): string => String.raw`
set -eu
umask 077
fail() { printf 'LINUX_USERLAND_RESTART_V1 ok=0 reason=%s\n' "$1"; exit 0; }
/usr/bin/systemctl --user show-environment >/dev/null 2>&1 || fail systemd-user
/usr/bin/systemctl --user daemon-reload >/dev/null 2>&1 || fail reload
/usr/bin/systemctl --user restart vellum-command-remote.service >/dev/null 2>&1 || fail restart
/usr/bin/systemctl --user is-active --quiet vellum-command-remote.service || fail inactive
printf 'LINUX_USERLAND_RESTART_V1 ok=1\n'
`.trim();

export const compileLinuxUserlandRestart = (): Effect.Effect<RemoteCommand, SshInputError> =>
  makeRemoteCommand("/bin/sh", ["-c", compileLinuxUserlandRestartSource(), "vellum-plan:linux-userland-restart"]);

export const HERDR_IMAGE_STAGE_DIR = "/tmp/vellum-command-herdr-images" as const;
const HERDR_NAME = /^vellum-command-clip-[a-z0-9]{1,24}-[a-f0-9]{8}\.(png|jpg|gif|webp|bmp)$/u;
export const confineHerdrStagePath = (name: string): Effect.Effect<string, SshInputError> =>
  typeof name === "string" && HERDR_NAME.test(name) && !name.includes("..")
    ? Effect.succeed(`${HERDR_IMAGE_STAGE_DIR}/${name}`)
    : Effect.fail(new SshInputError({ message: "herdr stage basename is not a product token" }));
export const compileHerdrImageStage = (name: string): Effect.Effect<{ readonly command: RemoteCommand; readonly path: string }, SshInputError> =>
  confineHerdrStagePath(name).pipe(Effect.flatMap((path) => makeRemoteCommand("/bin/sh", ["-c", `set -eu; umask 077; mkdir -p ${quote(HERDR_IMAGE_STAGE_DIR)}; cat > ${quote(path)}; chmod 600 ${quote(path)}`, "vellum-plan:herdr-image-stage"]).pipe(Effect.map((command) => ({ command, path })))));

export const compileDarwinRemoteDeployScript = (script: string): Effect.Effect<RemoteCommand, SshInputError> =>
  typeof script === "string" &&
    script.includes("begin_candidate_activation()") &&
    script.includes("NEW_LAUNCHD_PID_NOT_PROVEN")
    ? makeRemoteCommand("/bin/bash", ["-lc", script])
    : Effect.fail(new SshInputError({ message: "darwin deploy script is not a product stream program" }));

/** Compile the post-configure GUI-domain relaunch, kept separate from the
 * artifact transaction so an enrollment script cannot be mistaken for a
 * runtime activation command. */
export const compileDarwinRemoteActivationScript = (script: string): Effect.Effect<RemoteCommand, SshInputError> =>
  typeof script === "string" &&
    script.includes("RUNTIME_LAUNCHD_PID_NOT_PROVEN") &&
    script.includes("kickstart")
    ? makeRemoteCommand("/bin/bash", ["-lc", script])
    : Effect.fail(new SshInputError({ message: "darwin activation script is not a product runtime program" }));
