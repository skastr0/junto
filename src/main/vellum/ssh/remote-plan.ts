/**
 * Named SSH programs for Vellum-owned remote runtime capabilities.
 *
 * This module deliberately has no generic remote filesystem plan. Durable
 * station state moves through the Station API into the app-owned SQLite
 * database; SSH remains only a bootstrap/deployment transport plus the
 * confined Herdr image handoff.
 */

import { Effect } from "effect";
import { makeRemoteCommand, type RemoteCommand, SshInputError } from "./domain";

const SAFE_ABS_PATH = /^\/(?:[A-Za-z0-9._+-]+\/)*[A-Za-z0-9._+-]+$/u;

const isSafeAbsPath = (value: string): boolean =>
  SAFE_ABS_PATH.test(value) &&
  !value.includes("..") &&
  !value.includes("\0") &&
  Buffer.byteLength(value, "utf8") <= 512;

const shellSingleQuote = (value: string): string =>
  `'${value.replace(/'/g, `'\\''`)}'`;

// ---------------------------------------------------------------------------
// Linux remote preflight (fixed V3 product program)
// ---------------------------------------------------------------------------
//
// Named compiler: no free path/command args from callers. Stdin supplies
// bundle bytes + version + package hashes; stdout is exactly one
// LINUX_REMOTE_PREFLIGHT_V3 (or REFUSED_V3) line. Generation readiness is a
// plain `${INVOCATION}\n` receipt under ready-$INVOCATION (exact 33 bytes via
// wc + cmp against printf) plus work sock/token — never deep JSON, never term/browser.

/** Product paths for release helper/bridge — never caller-controlled. */
const LINUX_RELEASE_INSTALLER_PATH = "/usr/libexec/vellum-release-installer";
const LINUX_RELEASE_BRIDGE_PATH = "/usr/libexec/vellum-release-bridge";

/**
 * Pure compile of the fixed Ubuntu Remote preflight shell source.
 * Source of truth for the V3 protocol body; deploy-linux must not re-author it.
 */
export const compileLinuxRemotePreflightSource = (): string => {
  // Local names only for String.raw path interpolation — product constants.
  const HELPER = LINUX_RELEASE_INSTALLER_PATH;
  const BRIDGE = LINUX_RELEASE_BRIDGE_PATH;
  // `${"$"}` escapes shell `${…}` so TypeScript does not consume `$`.
  return String.raw`
set -eu
umask 077
refuse() {
  echo "LINUX_REMOTE_PREFLIGHT_REFUSED_V3 reason=$1"
  exit 0
}
private_file() {
  [ -f "$1" ] && [ ! -L "$1" ] && [ -O "$1" ] &&
    [ "$(/usr/bin/stat -c '%a' "$1" 2>/dev/null || true)" = 600 ]
}
private_socket() {
  [ -S "$1" ] && [ ! -L "$1" ] && [ -O "$1" ] &&
    [ "$(/usr/bin/stat -c '%a' "$1" 2>/dev/null || true)" = 600 ]
}
exact_field() {
  echo "$1" | /usr/bin/awk -F= -v wanted="$2" '
    $1 == wanted { count += 1; value = substr($0, length(wanted) + 2) }
    END { if (count == 1 && length(value) > 0) print value; else exit 1 }
  '
}
IFS= read -r BUNDLE_BYTES || refuse disk
IFS= read -r EXPECTED_VERSION || refuse version
IFS= read -r EXPECTED_DEB_SHA || refuse package
IFS= read -r EXPECTED_MANIFEST_SHA || refuse package
case "$BUNDLE_BYTES" in ""|*[!0-9]*) refuse disk ;; esac
[ "$BUNDLE_BYTES" -gt 0 ] && [ "$BUNDLE_BYTES" -le 3221225472 ] || refuse disk
case "$EXPECTED_VERSION" in
  0|*[!0-9.]*|.*|*.) refuse version ;;
esac
echo "$EXPECTED_VERSION" | /usr/bin/awk -F. '
  NF == 3 && $1 ~ /^(0|[1-9][0-9]*)$/ &&
  $2 ~ /^(0|[1-9][0-9]*)$/ &&
  $3 ~ /^(0|[1-9][0-9]*)$/ { ok = 1 }
  END { exit(ok ? 0 : 1) }
' || refuse version
case "$EXPECTED_DEB_SHA:$EXPECTED_MANIFEST_SHA" in
  *[!0-9a-f:]*|*:*:* ) refuse package ;;
esac
[ "${"$"}{#EXPECTED_DEB_SHA}" -eq 64 ] || refuse package
[ "${"$"}{#EXPECTED_MANIFEST_SHA}" -eq 64 ] || refuse package
for REQUIRED_COMMAND in \
  /bin/hostname \
  /usr/bin/awk \
  /usr/bin/cat \
  /usr/bin/cmp \
  /usr/bin/df \
  /usr/bin/dpkg \
  /usr/bin/dpkg-query \
  /usr/bin/getconf \
  /usr/bin/grep \
  /usr/bin/id \
  /usr/bin/loginctl \
  /usr/bin/stat \
  /usr/bin/sudo \
  /usr/bin/systemctl \
  /usr/bin/tr \
  /usr/bin/uname \
  /usr/bin/wc
do
  [ -x "$REQUIRED_COMMAND" ] || refuse commands
done
OS_ID=$(/usr/bin/awk -F= '$1 == "ID" { gsub(/^"|"$/, "", $2); print $2 }' /etc/os-release)
OS_RELEASE=$(/usr/bin/awk -F= '$1 == "VERSION_ID" { gsub(/^"|"$/, "", $2); print $2 }' /etc/os-release)
[ "$OS_ID" = ubuntu ] || refuse os
[ "$OS_RELEASE" = 24.04 ] || refuse release
[ "$(/usr/bin/uname -m)" = x86_64 ] || refuse architecture
GLIBC_FACT=$(/usr/bin/getconf GNU_LIBC_VERSION 2>/dev/null || true)
case "$GLIBC_FACT" in "glibc "[0-9]*.[0-9]*) ;; *) refuse libc ;; esac
LIBC_VERSION=${"$"}{GLIBC_FACT#glibc }
LIBC_VERSION=$(/usr/bin/awk -F. '{ print $1 "." $2 }' <<EOF
$LIBC_VERSION
EOF
)
LIBC_MAJOR=${"$"}{LIBC_VERSION%%.*}
LIBC_MINOR=${"$"}{LIBC_VERSION#*.}
case "$LIBC_MAJOR:$LIBC_MINOR" in *[!0-9:]*) refuse libc ;; esac
if [ "$LIBC_MAJOR" -lt 2 ] ||
   { [ "$LIBC_MAJOR" -eq 2 ] && [ "$LIBC_MINOR" -lt 39 ]; }; then
  refuse libc
fi
UID_VALUE=$(/usr/bin/id -u)
GID_VALUE=$(/usr/bin/id -g)
HOST_VALUE=$(/bin/hostname)
case "$UID_VALUE:$GID_VALUE" in
  0:*|*:0|*[!0-9:]*) refuse identity ;;
esac
case "$HOST_VALUE" in
  ""|*[!a-z0-9.-]*|.*|*.) refuse identity ;;
esac
[ "${"$"}{#HOST_VALUE}" -le 253 ] || refuse identity
/usr/bin/systemctl --user show-environment >/dev/null 2>&1 || refuse systemd-user
AVAILABLE_BYTES=$(
  /usr/bin/df -PB1 /var /opt "$HOME" |
    /usr/bin/awk 'NR > 1 && $4 ~ /^[0-9]+$/ {
      if (minimum == "" || $4 < minimum) minimum = $4
    } END { print minimum }'
)
case "$AVAILABLE_BYTES" in ""|*[!0-9]*) refuse disk ;; esac
REQUIRED_BYTES=$((BUNDLE_BYTES * 3 + 536870912))
[ "$AVAILABLE_BYTES" -ge "$REQUIRED_BYTES" ] || refuse disk
PACKAGE_STATE=$(/usr/bin/dpkg-query -W -f='${"$"}{Status}\t${"$"}{Version}\n' vellum 2>/dev/null || true)
if [ -z "$PACKAGE_STATE" ]; then
  CURRENT_VERSION=none
else
  CURRENT_VERSION=$(echo "$PACKAGE_STATE" | /usr/bin/awk -F '\t' '$1 == "install ok installed" && NF == 2 { print $2 }')
  if [ -n "$CURRENT_VERSION" ]; then
    echo "$CURRENT_VERSION" | /usr/bin/awk -F. '
      NF == 3 && $1 ~ /^(0|[1-9][0-9]*)$/ &&
      $2 ~ /^(0|[1-9][0-9]*)$/ &&
      $3 ~ /^(0|[1-9][0-9]*)$/ { ok = 1 }
      END { exit(ok ? 0 : 1) }
    ' || refuse package
  elif echo "$PACKAGE_STATE" | /usr/bin/awk -F '\t' '
    $1 == "deinstall ok config-files" && NF == 2 { found = 1 }
    END { exit(found ? 0 : 1) }
  '; then
    CURRENT_VERSION=none
  else
    refuse package
  fi
fi
ENABLE_STATE=$(/usr/bin/systemctl --user is-enabled vellum-remote.service 2>/dev/null || true)
ACTIVE_STATE=$(/usr/bin/systemctl --user is-active vellum-remote.service 2>/dev/null || true)
if [ "$CURRENT_VERSION" = none ]; then
  [ "$ENABLE_STATE" = not-found ] || refuse systemd-user
  [ "$ACTIVE_STATE" = inactive ] || refuse systemd-user
  ENABLED=0
  ACTIVE=0
  UNIT_STATE=not-found
else
  case "$ENABLE_STATE" in enabled) ENABLED=1 ;; disabled) ENABLED=0 ;; *) refuse systemd-user ;; esac
  case "$ACTIVE_STATE" in active) ACTIVE=1 ;; inactive) ACTIVE=0 ;; *) refuse systemd-user ;; esac
  UNIT_STATE=present
fi
LINGER_VALUE=$(/usr/bin/loginctl show-user "$UID_VALUE" -p Linger --value 2>/dev/null || true)
case "$LINGER_VALUE" in yes) LINGER=1 ;; no) LINGER=0 ;; *) refuse linger ;; esac
HELPER_READY=0
if [ -f "${HELPER}" ] && [ ! -L "${HELPER}" ] &&
   [ "$(/usr/bin/stat -c '%u:%g:%a:%h' "${HELPER}" 2>/dev/null || true)" = "0:0:755:1" ]; then
  HELPER_READY=1
fi
BRIDGE_READY=0
if [ -f "${BRIDGE}" ] && [ ! -L "${BRIDGE}" ] &&
   [ "$(/usr/bin/stat -c '%u:%g:%a:%h' "${BRIDGE}" 2>/dev/null || true)" = "0:0:755:1" ]; then
  BRIDGE_READY=1
fi
CURRENT_READY=0
CURRENT_GENERATION=none
if [ "$ENABLED" = 1 ] && [ "$ACTIVE" = 1 ]; then
  SHOW=$(/usr/bin/systemctl --user show vellum-remote.service -p ActiveState -p SubState -p MainPID -p InvocationID 2>/dev/null || true)
  ACTIVE_DETAIL=$(exact_field "$SHOW" ActiveState 2>/dev/null || true)
  SUB_STATE=$(exact_field "$SHOW" SubState 2>/dev/null || true)
  MAIN_PID=$(exact_field "$SHOW" MainPID 2>/dev/null || true)
  INVOCATION=$(exact_field "$SHOW" InvocationID 2>/dev/null || true)
  case "$MAIN_PID" in ""|*[!0-9]*) MAIN_PID=0 ;; esac
  case "$INVOCATION" in *[!0-9a-f]*|"") INVOCATION=invalid ;; esac
  READY_RECEIPT="/run/user/$UID_VALUE/vellum-remote/ready-$INVOCATION"
  PACKAGE_VERIFY=
  if PACKAGE_VERIFY=$(/usr/bin/dpkg --verify vellum 2>/dev/null); then
    PACKAGE_VERIFY_OK=1
  else
    PACKAGE_VERIFY_OK=0
  fi
  if [ "$ACTIVE_DETAIL" = active ] && [ "$SUB_STATE" = running ] &&
     [ "$MAIN_PID" -gt 1 ] && [ "${"$"}{#INVOCATION}" -eq 32 ] &&
     [ "$PACKAGE_VERIFY_OK" = 1 ] && [ -z "$PACKAGE_VERIFY" ] &&
     private_file "$READY_RECEIPT" &&
     [ "$(/usr/bin/wc -c < "$READY_RECEIPT" 2>/dev/null | /usr/bin/tr -d ' ')" = 33 ] &&
     /usr/bin/printf '%s\n' "$INVOCATION" | /usr/bin/cmp -s - "$READY_RECEIPT" &&
     /usr/bin/tr '\0' '\n' < "/proc/$MAIN_PID/cmdline" |
       /usr/bin/grep -Fqx '/opt/Vellum Command/resources/systemd/vellum-remote-launch-v1' &&
     private_socket "$HOME/.vellum/work/control.sock" &&
     private_file "$HOME/.vellum/work/token"; then
    CURRENT_READY=1
    CURRENT_GENERATION="$INVOCATION"
  fi
fi
echo "LINUX_REMOTE_PREFLIGHT_V3 disk=$AVAILABLE_BYTES current=$CURRENT_VERSION enabled=$ENABLED active=$ACTIVE linger=$LINGER helper=$HELPER_READY bridge=$BRIDGE_READY ready=$CURRENT_READY generation=$CURRENT_GENERATION uid=$UID_VALUE gid=$GID_VALUE host=$HOST_VALUE libc=$LIBC_VERSION unit=$UNIT_STATE"
`.trim();
};

/**
 * Compile the fixed Ubuntu Remote preflight into a branded RemoteCommand.
 * No free path/command injection — product constants only.
 */
export const compileLinuxRemotePreflight = (): Effect.Effect<
  RemoteCommand,
  SshInputError
> => {
  try {
    const source = compileLinuxRemotePreflightSource();
    return makeRemoteCommand("/bin/sh", [
      "-c",
      source,
      "vellum-plan:linux-remote-preflight",
    ]);
  } catch (error) {
    return Effect.fail(
      new SshInputError({
        message:
          error instanceof Error
            ? error.message
            : "linux remote preflight compile failed",
      }),
    );
  }
};

// ---------------------------------------------------------------------------
// Herdr clipboard-image staging (product path under /tmp/vellum-herdr-images)
// ---------------------------------------------------------------------------

/** Fixed remote staging root for herdr clipboard images — never caller-supplied. */
export const HERDR_IMAGE_STAGE_DIR = "/tmp/vellum-herdr-images" as const;

/**
 * Product basenames only (`vellum-clip-<ts36>-<8hex>.<ext>` from stage-image.ts).
 * No slashes, no shell metacharacters, no free-form names.
 */
const HERDR_STAGE_BASENAME =
  /^vellum-clip-[a-z0-9]{1,24}-[a-f0-9]{8}\.(png|jpg|gif|webp|bmp)$/u;

/**
 * Admit a product herdr stage basename and return the confined absolute path.
 */
export const confineHerdrStagePath = (
  remoteName: string,
): Effect.Effect<string, SshInputError> => {
  if (
    typeof remoteName !== "string" ||
    remoteName.length === 0 ||
    remoteName.length > 96 ||
    !HERDR_STAGE_BASENAME.test(remoteName) ||
    remoteName.includes("/") ||
    remoteName.includes("\\") ||
    remoteName.includes("\0") ||
    remoteName.includes("..")
  ) {
    return Effect.fail(
      new SshInputError({
        message: "herdr stage basename is not a product token",
      }),
    );
  }
  const path = `${HERDR_IMAGE_STAGE_DIR}/${remoteName}`;
  if (!isSafeAbsPath(path) || !path.startsWith(`${HERDR_IMAGE_STAGE_DIR}/`)) {
    return Effect.fail(
      new SshInputError({ message: "herdr stage path is not confining" }),
    );
  }
  return Effect.succeed(path);
};

/**
 * Compile the sole remote shell for herdr image staging:
 * umask → ensure stage dir → exclusive stdin write → mode 0600.
 *
 * Paths are product-confined; transport must not hand-author shell strings.
 */
export const compileHerdrImageStage = (
  remoteName: string,
): Effect.Effect<
  { readonly command: RemoteCommand; readonly path: string },
  SshInputError
> =>
  confineHerdrStagePath(remoteName).pipe(
    Effect.flatMap((path) => {
      const dir = shellSingleQuote(HERDR_IMAGE_STAGE_DIR);
      const file = shellSingleQuote(path);
      const source = [
        "set -eu",
        "umask 077",
        `if [ -L ${dir} ]; then printf '%s\\n' 'vellum-remote-plan: stage dir is a symlink' >&2; exit 73; fi`,
        `/bin/mkdir -p -- ${dir}`,
        `if [ -L ${dir} ] || [ ! -d ${dir} ]; then printf '%s\\n' 'vellum-remote-plan: stage dir unsafe' >&2; exit 73; fi`,
        `if [ -L ${file} ]; then printf '%s\\n' 'vellum-remote-plan: stage path is a symlink' >&2; exit 73; fi`,
        `if [ -e ${file} ]; then printf '%s\\n' 'vellum-remote-plan: stage path already exists' >&2; exit 73; fi`,
        // noclobber exclusive create — refuse clobber on name collision.
        "set -C",
        `cat > ${file} || { set +C; /bin/rm -f -- ${file}; exit 73; }`,
        "set +C",
        `/bin/chmod 600 -- ${file}`,
        "",
      ].join("\n");
      return makeRemoteCommand("/bin/sh", [
        "-c",
        source,
        "vellum-plan:herdr-image-stage",
      ]).pipe(Effect.map((command) => ({ command, path })));
    }),
  );

// ---------------------------------------------------------------------------
// Named product compilers for host deploy (mutating / privileged remotes)
// ---------------------------------------------------------------------------

/**
 * Fixed Ubuntu release-bridge executable — no caller argv, no free path.
 * Sole mutation surface for Linux Remote deploy streams.
 */
export const compileLinuxReleaseBridge = (): Effect.Effect<
  RemoteCommand,
  SshInputError
> => makeRemoteCommand(LINUX_RELEASE_BRIDGE_PATH, []);

/**
 * Darwin app stream receiver: product deploy script as `/bin/bash -lc <source>`.
 *
 * **Beta residual (Cut 3):** not on the public `ssh` barrel. Product load of
 * the Darwin provider is refused first via `RELEASE_CAPABILITIES.darwinRemoteDeploy`
 * (see `hosts/deploy-remote.ts` + `deploy-darwin.ts` entry gate). This compiler
 * remains for dormant Darwin code + unit tests; free-form shell is refused by
 * product markers. Single WeakMap mint (`makeRemoteCommand`) — no parallel
 * command brands for bash vs argv recipes.
 *
 * Source must be the Vellum Darwin deploy program (product markers required).
 * Free-form shell — including `rm -rf -- /` — is not a product deploy script.
 */
export const compileDarwinRemoteDeployScript = (
  remoteScript: string,
): Effect.Effect<RemoteCommand, SshInputError> => {
  if (
    typeof remoteScript !== "string" ||
    remoteScript.length === 0 ||
    Buffer.byteLength(remoteScript, "utf8") > 256 * 1024
  ) {
    return Effect.fail(
      new SshInputError({
        message: "darwin deploy script exceeds product bounds",
      }),
    );
  }
  // Product markers from buildRemoteDeployScript — refuse arbitrary shell.
  if (
    !remoteScript.includes("begin_candidate_activation()") ||
    !remoteScript.includes("UNBOUND_DEPLOY_PATH_PRESENT") ||
    !remoteScript.includes("IN_STATION_EXE=") ||
    !remoteScript.includes("STATION_READY") ||
    !remoteScript.includes("CONTROL_SOCKET_TIMEOUT")
  ) {
    return Effect.fail(
      new SshInputError({
        message: "darwin deploy script is not a product stream program",
      }),
    );
  }
  return makeRemoteCommand("/bin/bash", ["-lc", remoteScript]);
};
