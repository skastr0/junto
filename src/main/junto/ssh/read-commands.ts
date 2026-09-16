/**
 * Closed allowlisted remote command constructors for product modules.
 *
 * Product code (hosts/, hermes/, term/, browser/) must
 * mint RemoteCommands only through these factories or named plan compilers in
 * remote-plan.ts. Free-form executable+args (including
 * `/bin/sh -c …`) is unrepresentable here — that is the seal.
 *
 * Doctrine: brand means “safe product operation,” not merely “created by Junto.”
 */

import { Effect, Schema } from "effect";
import { CONTENT_TRANSFER_COMMAND } from "../content/helper-contract";
import {
  STATION_PROTOCOL_NEGOTIATION_ARG,
  STATION_STDIO_COMMAND,
} from "../station/helper-contract";
import {
  inspectSshTarget,
  makeRemoteCommand,
  type RemoteCommand,
  type SshEndpoint,
  type SshTarget,
  type SshError,
  SshInputError,
} from "./domain";
import { homeDirectoryLookup, oneShot } from "./program";
import type { SshTransportShape } from "./service";

// Clean absolute POSIX path: no shell metacharacters, no `..`, no NULs.
const SAFE_ABS_PATH = /^\/(?:[A-Za-z0-9._+-]+\/)*[A-Za-z0-9._+-]+$/u;

/** Single packaged CLI binary — station/browser/content-transfer are subcommands. */
export const DARWIN_PACKAGED_CLI_EXECUTABLE =
  "/Applications/Junto.app/Contents/Resources/bin/junto";
/** @deprecated Use DARWIN_PACKAGED_CLI_EXECUTABLE — same binary. */
export const DARWIN_PACKAGED_STATION_EXECUTABLE = DARWIN_PACKAGED_CLI_EXECUTABLE;
/** @deprecated Use DARWIN_PACKAGED_CLI_EXECUTABLE — same binary. */
export const DARWIN_PACKAGED_BROWSER_EXECUTABLE = DARWIN_PACKAGED_CLI_EXECUTABLE;
/** @deprecated Use DARWIN_PACKAGED_CLI_EXECUTABLE — same binary. */
export const DARWIN_PACKAGED_CONTENT_EXECUTABLE = DARWIN_PACKAGED_CLI_EXECUTABLE;
export const DARWIN_PACKAGED_APP_EXECUTABLE =
  "/Applications/Junto.app/Contents/MacOS/Junto";
export { STATION_PROTOCOL_NEGOTIATION_ARG, STATION_STDIO_COMMAND, CONTENT_TRANSFER_COMMAND };

/** negotiation is the enroll/preface helper; session is the peer helper. */
const stationStdioArgs = (
  mode: "session" | "negotiation",
): ReadonlyArray<string> =>
  mode === "negotiation"
    ? [STATION_STDIO_COMMAND, STATION_PROTOCOL_NEGOTIATION_ARG]
    : [STATION_STDIO_COMMAND];

const contentTransferArgs = (
  args: ReadonlyArray<string>,
): ReadonlyArray<string> => [CONTENT_TRANSFER_COMMAND, ...args];

const SAFE_REMOTE_HOME = /^\/(?:[^/\u0000-\u001f\u007f]+\/)*[^/\u0000-\u001f\u007f]+$/u;

const RemotePackagedPlatformTypeId: unique symbol = Symbol(
  "@junto/ssh/RemotePackagedPlatform",
);

/**
 * Runtime witness minted only from one current, exact `uname -s` observation.
 * A platform string supplied by a caller cannot select a remote executable.
 */
export interface RemotePackagedPlatform {
  readonly [RemotePackagedPlatformTypeId]:
    typeof RemotePackagedPlatformTypeId;
}

type RemotePackagedPlatformName = "darwin" | "linux";

const RemoteLinuxUserlandTypeId: unique symbol = Symbol(
  "@junto/ssh/RemoteLinuxUserland",
);

/** A Linux platform observation bound to its independently observed owner home. */
export interface RemoteLinuxUserland {
  readonly [RemoteLinuxUserlandTypeId]: typeof RemoteLinuxUserlandTypeId;
}

const remoteLinuxUserlands = new WeakMap<RemoteLinuxUserland, string>();

const remotePackagedPlatforms = new WeakMap<
  RemotePackagedPlatform,
  RemotePackagedPlatformName
>();

type Ssh = SshTransportShape;

export class RemotePlatformProbeError extends Schema.TaggedError<RemotePlatformProbeError>()(
  "RemotePlatformProbeError",
  {
    endpoint: Schema.String,
    reason: Schema.Literals(["malformed", "unsupported"]),
    message: Schema.String,
  },
) {}

const mintRemotePackagedPlatform = (
  platform: RemotePackagedPlatformName,
): RemotePackagedPlatform => {
  const witness = Object.freeze({
    [RemotePackagedPlatformTypeId]: RemotePackagedPlatformTypeId,
  }) as RemotePackagedPlatform;
  remotePackagedPlatforms.set(witness, platform);
  return witness;
};

/**
 * Mints fixed owner-local helper authority after both Linux platform and HOME
 * have been independently observed. Callers cannot provide an executable path.
 */
export const bindLinuxRemoteUserland = (
  platform: RemotePackagedPlatform,
  homeDirectory: string,
): Effect.Effect<RemoteLinuxUserland, SshInputError> => {
  if (remotePackagedPlatforms.get(platform) !== "linux") {
    return Effect.fail(new SshInputError({
      message: "remote Linux userland requires a Linux platform witness",
    }));
  }
  if (!SAFE_REMOTE_HOME.test(homeDirectory) || homeDirectory === "/") {
    return Effect.fail(new SshInputError({
      message: "remote Linux home must be a clean absolute path",
    }));
  }
  const userland = Object.freeze({
    [RemoteLinuxUserlandTypeId]: RemoteLinuxUserlandTypeId,
  }) as RemoteLinuxUserland;
  remoteLinuxUserlands.set(userland, homeDirectory);
  return Effect.succeed(userland);
};

/** Name of a minted platform witness. Callers cannot invent the name. */
export const inspectRemotePackagedPlatform = (
  platform: RemotePackagedPlatform,
): RemotePackagedPlatformName => {
  const name = remotePackagedPlatforms.get(platform);
  if (name === undefined) {
    throw new TypeError("remote packaged platform was not minted by the probe");
  }
  return name;
};

const decodeRemotePackagedPlatform = (
  endpoint: SshEndpoint,
  output: string,
): Effect.Effect<RemotePackagedPlatform, RemotePlatformProbeError> => {
  if (output === "Darwin\n") {
    return Effect.succeed(mintRemotePackagedPlatform("darwin"));
  }
  if (output === "Linux\n") {
    return Effect.succeed(mintRemotePackagedPlatform("linux"));
  }
  const canonicalUnsupported =
    output.endsWith("\n") &&
    output.indexOf("\n") === output.length - 1 &&
    /^[A-Za-z][A-Za-z0-9._-]{0,31}\n$/u.test(output);
  return Effect.fail(
    RemotePlatformProbeError.make({
      endpoint,
      reason: canonicalUnsupported ? "unsupported" : "malformed",
      message: canonicalUnsupported
        ? "remote platform does not have the Junto Remote package installed"
        : "remote platform probe did not return one canonical uname record",
    }),
  );
};

const admitReadPath = (path: string): Effect.Effect<string, SshInputError> => {
  if (
    typeof path !== "string" ||
    !SAFE_ABS_PATH.test(path) ||
    path.includes("..") ||
    path.includes("\0") ||
    Buffer.byteLength(path, "utf8") > 512
  ) {
    return Effect.fail(
      new SshInputError({
        message: "remote read path must be a clean absolute POSIX path",
      }),
    );
  }
  return Effect.succeed(path);
};

/**
 * Product CLI argv: executable is fixed by the factory; args stay argv tokens
 * (no shell). Bounds match makeRemoteCommand (NUL / size); empty tokens rejected.
 */
const admitCliArgs = (
  args: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, SshInputError> => {
  if (args.length > 64) {
    return Effect.fail(
      new SshInputError({ message: "remote CLI argument count exceeds product bound" }),
    );
  }
  for (const arg of args) {
    if (
      typeof arg !== "string" ||
      arg.length === 0 ||
      arg.includes("\0") ||
      Buffer.byteLength(arg, "utf8") > 64 * 1024
    ) {
      return Effect.fail(
        new SshInputError({ message: "remote CLI argument is not a safe product token" }),
      );
    }
  }
  return Effect.succeed(args);
};

/** Fixed OS probe: `uname -s`. */
export const remoteUname = (): Effect.Effect<RemoteCommand, SshInputError> =>
  makeRemoteCommand("/usr/bin/uname", ["-s"]);

/**
 * Resolve the installed product platform from the target itself. The probe
 * carries no Station request or browser delegation, and malformed/unsupported
 * evidence fails before either payload can cross SSH.
 */
export const resolveRemotePackagedPlatform = (
  ssh: Ssh,
  target: SshTarget,
): Effect.Effect<
  RemotePackagedPlatform,
  SshError | RemotePlatformProbeError
> =>
  Effect.gen(function* () {
    const endpoint = inspectSshTarget(target).endpoint;
    const command = yield* remoteUname();
    const observed = yield* ssh.run(
      oneShot(target, command, { budget: "short" }),
    );
    return yield* decodeRemotePackagedPlatform(endpoint, observed.stdout);
  }).pipe(Effect.withSpan("ssh.remote-packaged-platform"));

/**
 * Read a confined absolute path with `/bin/cat`.
 * Path is re-admitted; free-form shell is not representable.
 */
export const remoteCat = (
  path: string,
): Effect.Effect<RemoteCommand, SshInputError> =>
  admitReadPath(path).pipe(
    Effect.flatMap((safe) => makeRemoteCommand("/bin/cat", [safe])),
  );

/**
 * File existence probe: `/bin/test -f <path>`.
 * Only the fixed `-f` shape is admitted — no free-form test expressions.
 */
export const remoteTestFileExists = (
  path: string,
): Effect.Effect<RemoteCommand, SshInputError> =>
  admitReadPath(path).pipe(
    Effect.flatMap((safe) => makeRemoteCommand("/bin/test", ["-f", safe])),
  );

/** Socket existence probe: `/bin/test -S <path>`. */
export const remoteTestSocketExists = (
  path: string,
): Effect.Effect<RemoteCommand, SshInputError> =>
  admitReadPath(path).pipe(
    Effect.flatMap((safe) => makeRemoteCommand("/bin/test", ["-S", safe])),
  );

/** Fixed package-presence probe; callers cannot redirect it to a host path. */
export const remoteDarwinPackageExists = (): Effect.Effect<
  RemoteCommand,
  SshInputError
> =>
  makeRemoteCommand("/bin/test", ["-f", DARWIN_PACKAGED_APP_EXECUTABLE]);

export const remoteDarwinDeployLockExists = (): Effect.Effect<
  RemoteCommand,
  SshInputError
> =>
  makeRemoteCommand("/bin/test", [
    "-d",
    "/Applications/.junto-deploy.lock",
  ]);

export const remoteDarwinIncomingExists = (): Effect.Effect<
  RemoteCommand,
  SshInputError
> =>
  makeRemoteCommand("/bin/test", [
    "-d",
    "/Applications/Junto.app.incoming",
  ]);

export const remoteDarwinLaunchAgentIncomingRemove = (
  homeDirectory: string,
): Effect.Effect<RemoteCommand, SshInputError> => {
  const path = `${homeDirectory}/Library/LaunchAgents/com.skastr0.junto.plist.incoming`;
  return admitReadPath(path).pipe(
    Effect.flatMap((safe) => makeRemoteCommand("/bin/rm", ["-f", safe])),
  );
};

/**
 * Product Hermes CLI on the remote PATH.
 * Executable is fixed to `hermes`; args are revalidated tokens only.
 */
export const remoteHermesCli = (
  args: ReadonlyArray<string>,
): Effect.Effect<RemoteCommand, SshInputError> =>
  admitCliArgs(args).pipe(
    Effect.flatMap((safe) => makeRemoteCommand("hermes", safe)),
  );

/** Version probe for doctor: fixed argv per product binary. */
export const remoteProductVersion = (
  _binary: "hermes",
): Effect.Effect<RemoteCommand, SshInputError> => remoteHermesCli(["version"]);

/*
 * One fixed, read-only host fact program for Linux capability Doctor.
 *
 * It emits a closed key/value protocol, never paths, identities, environment
 * values, or command output. The only active viability check creates a
 * short-lived user namespace around `/bin/true`; it does not change host
 * policy or persistent state.
 */
const LINUX_CAPABILITY_DOCTOR_PROGRAM = String.raw`LC_ALL=C
export LC_ALL
emit() { printf '%s=%s\n' "$1" "$2"; }
missing_binaries=
missing_libraries=
add_missing_binary() {
  if [ -n "$missing_binaries" ]; then
    missing_binaries="$missing_binaries,$1"
  else
    missing_binaries="$1"
  fi
}
add_missing_library() {
  if [ -n "$missing_libraries" ]; then
    missing_libraries="$missing_libraries,$1"
  else
    missing_libraries="$1"
  fi
}

emit probe_version 1

platform=unknown
if [ -x /usr/bin/uname ]; then
  kernel=$(/usr/bin/uname -s 2>/dev/null)
  case "$kernel" in
    Linux) platform=linux ;;
    ?*) platform=non-linux ;;
  esac
fi
emit platform "$platform"

architecture=unknown
if [ -x /usr/bin/uname ]; then
  architecture=$(/usr/bin/uname -m 2>/dev/null)
  [ -n "$architecture" ] || architecture=unknown
fi
emit architecture "$architecture"

os_id=unknown
os_version=unknown
if [ -r /etc/os-release ]; then
  while IFS='=' read -r key value; do
    case "$key:$value" in
      ID:ubuntu|ID:\"ubuntu\"|ID:\'ubuntu\') os_id=ubuntu ;;
      ID:*) os_id=other ;;
      VERSION_ID:24.04|VERSION_ID:\"24.04\"|VERSION_ID:\'24.04\') os_version=24.04 ;;
      VERSION_ID:*) os_version=other ;;
    esac
  done < /etc/os-release
fi
emit os_id "$os_id"
emit os_version "$os_version"

glibc_version=unknown
if [ -x /usr/bin/getconf ]; then
  glibc=$(/usr/bin/getconf GNU_LIBC_VERSION 2>/dev/null)
  case "$glibc" in
    "glibc "*)
      set -- $glibc
      [ "$1" = glibc ] && glibc_version="$2"
      ;;
  esac
fi
emit glibc_version "$glibc_version"

home_state=unknown
home_exec=unknown
disk_free_mib=unknown
if [ -n "$HOME" ] && [ -d "$HOME" ]; then
  if [ -L "$HOME" ]; then
    home_state=unsafe
  elif [ -x /usr/bin/stat ] && [ -x /usr/bin/id ]; then
    home_owner=$(/usr/bin/stat -c %u -- "$HOME" 2>/dev/null)
    current_uid=$(/usr/bin/id -u 2>/dev/null)
    if [ -n "$home_owner" ] && [ "$home_owner" = "$current_uid" ]; then
      if [ -w "$HOME" ]; then home_state=safe-writable; else home_state=read-only; fi
    else
      home_state=unsafe
    fi
  fi
  if [ -x /usr/bin/findmnt ]; then
    mount_options=$(/usr/bin/findmnt -n -o OPTIONS --target "$HOME" 2>/dev/null)
    case ",$mount_options," in
      *,noexec,*) home_exec=noexec ;;
      ,,) home_exec=unknown ;;
      *) home_exec=ready ;;
    esac
  fi
  if [ -x /usr/bin/df ]; then
    while read -r filesystem blocks used available capacity mounted; do
      case "$available" in
        ''|*[!0-9]*) ;;
        *) disk_free_mib=$((available / 1024)) ;;
      esac
    done <<EOF
$(/usr/bin/df -Pk -- "$HOME" 2>/dev/null)
EOF
  fi
fi
emit home "$home_state"
emit home_exec "$home_exec"
emit disk_free_mib "$disk_free_mib"

core_userland=ready
[ -x /bin/sh ] || { add_missing_binary sh; core_userland=incomplete; }
[ -x /usr/bin/env ] || { add_missing_binary env; core_userland=incomplete; }
[ -x /usr/bin/uname ] || { add_missing_binary uname; core_userland=incomplete; }
[ -x /usr/bin/id ] || { add_missing_binary id; core_userland=incomplete; }
[ -x /usr/bin/stat ] || { add_missing_binary stat; core_userland=incomplete; }
[ -x /usr/bin/df ] || { add_missing_binary df; core_userland=incomplete; }
[ -x /usr/bin/findmnt ] || { add_missing_binary findmnt; core_userland=incomplete; }
[ -x /usr/bin/systemctl ] || { add_missing_binary systemctl; core_userland=incomplete; }
[ -x /usr/bin/loginctl ] || add_missing_binary loginctl
[ -x /usr/bin/getconf ] || { add_missing_binary getconf; core_userland=incomplete; }
if [ ! -x /usr/sbin/ldconfig ] && [ ! -x /sbin/ldconfig ]; then
  add_missing_binary ldconfig
  core_userland=incomplete
fi
[ -x /usr/bin/ssh ] || { add_missing_binary ssh; core_userland=incomplete; }
[ -x /usr/bin/Xvfb ] || add_missing_binary xvfb
[ -x /usr/bin/xauth ] || add_missing_binary xauth
[ -x /usr/bin/mcookie ] || add_missing_binary mcookie
[ -x /usr/bin/unshare ] || add_missing_binary unshare
[ -x /usr/bin/secret-tool ] || add_missing_binary secret-tool
emit core_userland "$core_userland"
if [ -n "$missing_binaries" ]; then emit missing_binaries "$missing_binaries"; else emit missing_binaries none; fi

runtime_libraries=unknown
library_inventory=
if [ -x /usr/sbin/ldconfig ]; then
  library_inventory=$(/usr/sbin/ldconfig -p 2>/dev/null)
elif [ -x /sbin/ldconfig ]; then
  library_inventory=$(/sbin/ldconfig -p 2>/dev/null)
fi
if [ -n "$library_inventory" ]; then
  runtime_libraries=ready
  case "$library_inventory" in *libc.so.6*) ;; *) add_missing_library libc ;; esac
  case "$library_inventory" in *libstdc++.so.6*) ;; *) add_missing_library libstdc++ ;; esac
  case "$library_inventory" in *libgcc_s.so.1*) ;; *) add_missing_library libgcc ;; esac
  case "$library_inventory" in *libnss3.so*) ;; *) add_missing_library libnss3 ;; esac
  case "$library_inventory" in *libatk-1.0.so*) ;; *) add_missing_library libatk ;; esac
  case "$library_inventory" in *libatk-bridge-2.0.so*) ;; *) add_missing_library libatk-bridge ;; esac
  case "$library_inventory" in *libcups.so*) ;; *) add_missing_library libcups ;; esac
  case "$library_inventory" in *libdrm.so*) ;; *) add_missing_library libdrm ;; esac
  case "$library_inventory" in *libgbm.so*) ;; *) add_missing_library libgbm ;; esac
  case "$library_inventory" in *libgtk-3.so*) ;; *) add_missing_library libgtk-3 ;; esac
  case "$library_inventory" in *libasound.so*) ;; *) add_missing_library libasound ;; esac
  case "$library_inventory" in *libX11-xcb.so*) ;; *) add_missing_library libx11-xcb ;; esac
  case "$library_inventory" in *libXcomposite.so*) ;; *) add_missing_library libxcomposite ;; esac
  case "$library_inventory" in *libXdamage.so*) ;; *) add_missing_library libxdamage ;; esac
  case "$library_inventory" in *libXfixes.so*) ;; *) add_missing_library libxfixes ;; esac
  case "$library_inventory" in *libXrandr.so*) ;; *) add_missing_library libxrandr ;; esac
  case "$library_inventory" in *libxshmfence.so*) ;; *) add_missing_library libxshmfence ;; esac
  case "$library_inventory" in *libxkbcommon.so*) ;; *) add_missing_library libxkbcommon ;; esac
  [ -z "$missing_libraries" ] || runtime_libraries=incomplete
fi
emit runtime_libraries "$runtime_libraries"
if [ -n "$missing_libraries" ]; then emit missing_libraries "$missing_libraries"; else emit missing_libraries none; fi

user_systemd=missing
remote_service=unknown
if [ -x /usr/bin/systemctl ]; then
  if /usr/bin/systemctl --user show-environment >/dev/null 2>&1; then
    user_systemd=ready
  else
    user_systemd=not-running
  fi
  load_state=$(/usr/bin/systemctl --user show junto-remote.service --property=LoadState --value 2>/dev/null)
  active_state=$(/usr/bin/systemctl --user is-active junto-remote.service 2>/dev/null)
  case "$load_state:$active_state" in
    not-found:*) remote_service=missing ;;
    *:active) remote_service=active ;;
    *:failed) remote_service=failed ;;
    *:inactive|*:activating|*:deactivating) remote_service=inactive ;;
  esac
fi
emit user_systemd "$user_systemd"
emit remote_service "$remote_service"

linger=unknown
if [ -x /usr/bin/loginctl ] && [ -x /usr/bin/id ]; then
  linger_value=$(/usr/bin/loginctl show-user "$(/usr/bin/id -u)" --property=Linger --value 2>/dev/null)
  case "$linger_value" in
    yes) linger=enabled ;;
    no) linger=disabled ;;
  esac
fi
emit linger "$linger"

ptmx=unavailable
if [ -c /dev/ptmx ]; then
  if [ -r /dev/ptmx ] && [ -w /dev/ptmx ]; then ptmx=ready; else ptmx=misconfigured; fi
fi
devpts=unavailable
if [ -d /dev/pts ]; then
  if [ -x /usr/bin/findmnt ]; then
    if /usr/bin/findmnt -n -t devpts --target /dev/pts >/dev/null 2>&1; then
      devpts=ready
    else
      devpts=misconfigured
    fi
  else
    devpts=unknown
  fi
fi
native_pty=unavailable
if [ "$ptmx" = ready ] && [ "$devpts" = ready ]; then
  native_pty=ready
elif [ "$ptmx" = misconfigured ] || [ "$devpts" = misconfigured ]; then
  native_pty=misconfigured
elif [ "$ptmx" = unknown ] || [ "$devpts" = unknown ]; then
  native_pty=unknown
fi
emit ptmx "$ptmx"
emit devpts "$devpts"
emit native_pty "$native_pty"

xvfb=missing
xauth=missing
mcookie=missing
[ -x /usr/bin/Xvfb ] && xvfb=present
[ -x /usr/bin/xauth ] && xauth=present
[ -x /usr/bin/mcookie ] && mcookie=present
emit xvfb "$xvfb"
emit xauth "$xauth"
emit mcookie "$mcookie"

apparmor=unavailable
apparmor_profile=not-required
if [ -r /sys/module/apparmor/parameters/enabled ]; then
  read -r apparmor_enabled < /sys/module/apparmor/parameters/enabled
  case "$apparmor_enabled" in
    Y|y)
      if [ -d /sys/kernel/security/apparmor ]; then apparmor=enforcing; else apparmor=available; fi
      apparmor_profile=missing
      if [ -r /sys/kernel/security/apparmor/profiles ]; then
        while IFS= read -r profile; do
          case "$profile" in
            junto\ *|junto\(*|*/junto\ *|*/junto\(*) apparmor_profile=loaded ;;
          esac
        done < /sys/kernel/security/apparmor/profiles
      elif [ -e /sys/kernel/security/apparmor/profiles ]; then
        apparmor_profile=unreadable
      fi
      ;;
    N|n) apparmor=disabled; apparmor_profile=not-required ;;
    *) apparmor=unknown; apparmor_profile=unknown ;;
  esac
elif [ -d /sys/kernel/security/apparmor ]; then
  apparmor=unknown
  apparmor_profile=unknown
fi
emit apparmor "$apparmor"
emit apparmor_profile "$apparmor_profile"

userns=unavailable
if [ -x /usr/bin/unshare ]; then
  userns=unknown
  clone_policy=1
  if [ -r /proc/sys/kernel/unprivileged_userns_clone ]; then
    read -r clone_policy < /proc/sys/kernel/unprivileged_userns_clone
  fi
  if [ "$clone_policy" = 0 ]; then
    userns=disabled
  elif /usr/bin/unshare --user --map-root-user /bin/true >/dev/null 2>&1; then
    userns=ready
  else
    userns=disabled
  fi
fi
emit userns "$userns"

sandbox=unavailable
if [ "$userns" = ready ]; then
  case "$apparmor:$apparmor_profile" in
    enforcing:loaded|available:loaded|disabled:not-required|unavailable:not-required) sandbox=ready ;;
    enforcing:missing|available:missing) sandbox=unavailable ;;
    *) sandbox=misconfigured ;;
  esac
elif [ "$userns" = unknown ]; then
  sandbox=unknown
fi
emit sandbox "$sandbox"

secret_storage=unavailable
if [ -x /usr/bin/secret-tool ]; then
  secret_storage=headless
  if [ -n "$DBUS_SESSION_BUS_ADDRESS" ]; then
    secret_storage=ready
  elif [ -x /usr/bin/systemctl ] && /usr/bin/systemctl --user is-active gnome-keyring-daemon.service >/dev/null 2>&1; then
    secret_storage=ready
  fi
fi
emit secret_storage "$secret_storage"
`;

/**
 * Closed Linux Doctor probe. The caller cannot add argv or shell source.
 */
export const remoteLinuxCapabilityDoctor = (): Effect.Effect<
  RemoteCommand,
  SshInputError
> => makeRemoteCommand("/bin/sh", ["-c", LINUX_CAPABILITY_DOCTOR_PROGRAM]);

/**
 * Fixed host LISTEN probe for host service discovery.
 * `pidList` must be a comma-joined positive integer list only.
 */
export const remoteLsofTcpListen = (
  pidList: string,
): Effect.Effect<RemoteCommand, SshInputError> => {
  if (
    typeof pidList !== "string" ||
    pidList.length === 0 ||
    pidList.length > 4_096 ||
    !/^[1-9][0-9]{0,9}(?:,[1-9][0-9]{0,9}){0,255}$/u.test(pidList)
  ) {
    return Effect.fail(
      new SshInputError({
        message: "lsof pid list must be a bounded comma-joined positive integer list",
      }),
    );
  }
  return makeRemoteCommand("lsof", [
    "-nP",
    "-iTCP",
    "-sTCP:LISTEN",
    "-a",
    "-p",
    pidList,
  ]);
};

/** Fixed Tailscale serve status JSON probe. */
export const remoteTailscaleServeStatus = (): Effect.Effect<
  RemoteCommand,
  SshInputError
> => makeRemoteCommand("tailscale", ["serve", "status", "--json"]);

/**
 * Closed host-shell argv admission for host probes.
 * Only the two product LISTEN / serve shapes are representable.
 */
export const remoteHostProbe = (
  argv: ReadonlyArray<string>,
): Effect.Effect<RemoteCommand, SshInputError> => {
  if (
    argv.length === 4 &&
    argv[0] === "tailscale" &&
    argv[1] === "serve" &&
    argv[2] === "status" &&
    argv[3] === "--json"
  ) {
    return remoteTailscaleServeStatus();
  }
  if (
    argv.length === 6 &&
    argv[0] === "lsof" &&
    argv[1] === "-nP" &&
    argv[2] === "-iTCP" &&
    argv[3] === "-sTCP:LISTEN" &&
    argv[4] === "-a" &&
    argv[5] !== undefined
  ) {
    return remoteLsofTcpListen(argv[5]);
  }
  return Effect.fail(
    new SshInputError({
      message: "host probe argv is not an allowlisted product shape",
    }),
  );
};

/**
 * Fixed Station API stdin wrapper. Fleet traffic is one typed request on
 * stdin and one typed response on stdout. Only the immutable packaged resource
 * selected by current host evidence can receive that request.
 */
const remoteJuntoStationCommand = (
  platform: RemotePackagedPlatform,
  args: ReadonlyArray<string>,
): Effect.Effect<
  RemoteCommand,
  SshInputError
> => {
  const observed = remotePackagedPlatforms.get(platform);
  if (observed === undefined) {
    return Effect.fail(
      new SshInputError({
        message: "remote packaged platform witness is invalid",
      }),
    );
  }
  if (observed !== "darwin") {
    return Effect.fail(
      new SshInputError({
        message:
          "Linux Station helpers require owner-home userland authority",
      }),
    );
  }
  return makeRemoteCommand(DARWIN_PACKAGED_CLI_EXECUTABLE, args);
};

const remoteLinuxUserlandStationCommand = (
  userland: RemoteLinuxUserland,
  args: ReadonlyArray<string>,
): Effect.Effect<RemoteCommand, SshInputError> => {
  const home = remoteLinuxUserlands.get(userland);
  if (home === undefined) {
    return Effect.fail(new SshInputError({
      message: "remote Linux userland witness is invalid",
    }));
  }
  return makeRemoteCommand(`${home}/.local/bin/junto`, args);
};

/** Exact owner-local Station helper, pinned by platform + HOME witnesses. */
export const remoteLinuxUserlandJuntoStation = (
  userland: RemoteLinuxUserland,
): Effect.Effect<RemoteCommand, SshInputError> =>
  remoteLinuxUserlandStationCommand(userland, stationStdioArgs("session"));

/** Owner-local exact Station protocol preface helper. */
export const remoteLinuxUserlandJuntoStationNegotiation = (
  userland: RemoteLinuxUserland,
): Effect.Effect<RemoteCommand, SshInputError> =>
  remoteLinuxUserlandStationCommand(userland, stationStdioArgs("negotiation"));

/** Exact pre-negotiation-v2 helper invocation. */
export const remoteJuntoStation = (
  platform: RemotePackagedPlatform,
): Effect.Effect<RemoteCommand, SshInputError> =>
  remoteJuntoStationCommand(platform, stationStdioArgs("session"));

/**
 * Fixed compatibility-preface helper invocation.
 *
 * This is intentionally a separate closed constructor. No caller can turn
 * the Station helper into a generic remote argv surface.
 */
export const remoteJuntoStationNegotiation = (
  platform: RemotePackagedPlatform,
): Effect.Effect<RemoteCommand, SshInputError> =>
  remoteJuntoStationCommand(platform, stationStdioArgs("negotiation"));

const decodeObservedRemoteHome = (
  output: string,
): Effect.Effect<string, SshInputError> => {
  if (!output.endsWith("\n")) {
    return Effect.fail(
      new SshInputError({
        message: "remote Linux home probe did not return one clean absolute path",
      }),
    );
  }
  const homeDirectory = output.slice(0, -1);
  if (
    homeDirectory.includes("\n") ||
    homeDirectory.trim() !== homeDirectory ||
    !SAFE_REMOTE_HOME.test(homeDirectory) ||
    homeDirectory === "/"
  ) {
    return Effect.fail(
      new SshInputError({
        message: "remote Linux home probe did not return one clean absolute path",
      }),
    );
  }
  return Effect.succeed(homeDirectory);
};

/**
 * Resolve the fixed Station helper for an observed platform. Darwin uses the
 * packaged app path; Linux independently observes `$HOME` and binds the
 * owner-local userland helper. Callers never supply an executable path.
 */
export const resolveRemoteStationHelper = (
  ssh: Ssh,
  target: SshTarget,
  platform: RemotePackagedPlatform,
  mode: "session" | "negotiation",
): Effect.Effect<RemoteCommand, SshError | SshInputError> =>
  Effect.gen(function* () {
    const observed = remotePackagedPlatforms.get(platform);
    if (observed === "darwin") {
      return yield* remoteJuntoStationCommand(
        platform,
        stationStdioArgs(mode),
      );
    }
    if (observed !== "linux") {
      return yield* Effect.fail(
        new SshInputError({
          message: "remote packaged platform witness is invalid",
        }),
      );
    }
    const homeResult = yield* ssh.run(homeDirectoryLookup(target));
    const homeDirectory = yield* decodeObservedRemoteHome(homeResult.stdout);
    const userland = yield* bindLinuxRemoteUserland(platform, homeDirectory);
    return yield* remoteLinuxUserlandStationCommand(
      userland,
      stationStdioArgs(mode),
    );
  }).pipe(Effect.withSpan("ssh.remote-station-helper"));

const CONTENT_HELPER_MODE = new Set(["receive", "send", "stat"]);
const CONTENT_HELPER_SHA256 = /^[a-f0-9]{64}$/u;
const CONTENT_HELPER_UINT = /^(0|[1-9][0-9]{0,15})$/u;

/**
 * Admit only the closed content-helper argv surface.  Free-form paths and
 * shell tokens are unrepresentable here.
 */
const assertContentHelperArgs = (
  args: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, SshInputError> => {
  if (args.length < 1 || !CONTENT_HELPER_MODE.has(args[0]!)) {
    return Effect.fail(
      new SshInputError({ message: "content helper mode is not admitted" }),
    );
  }
  if (args.length < 3 || args.length > 4) {
    return Effect.fail(
      new SshInputError({ message: "content helper argv arity is invalid" }),
    );
  }
  if (!CONTENT_HELPER_SHA256.test(args[1]!) || !CONTENT_HELPER_UINT.test(args[2]!)) {
    return Effect.fail(
      new SshInputError({ message: "content helper identity tokens are invalid" }),
    );
  }
  if (args.length === 4 && !CONTENT_HELPER_UINT.test(args[3]!)) {
    return Effect.fail(
      new SshInputError({ message: "content helper offset is invalid" }),
    );
  }
  if (args[0] === "stat" && args.length !== 3) {
    return Effect.fail(
      new SshInputError({ message: "content helper stat arity is invalid" }),
    );
  }
  return Effect.succeed(args);
};

const remoteJuntoContentCommand = (
  platform: RemotePackagedPlatform,
  args: ReadonlyArray<string>,
): Effect.Effect<RemoteCommand, SshInputError> => {
  const observed = remotePackagedPlatforms.get(platform);
  if (observed === undefined) {
    return Effect.fail(
      new SshInputError({
        message: "remote packaged platform witness is invalid",
      }),
    );
  }
  if (observed !== "darwin") {
    return Effect.fail(
      new SshInputError({
        message: "Linux content helpers require owner-home userland authority",
      }),
    );
  }
  return Effect.gen(function* () {
    const safeArgs = yield* assertContentHelperArgs(args);
    return yield* makeRemoteCommand(
      DARWIN_PACKAGED_CLI_EXECUTABLE,
      contentTransferArgs(safeArgs),
    );
  });
};

const remoteLinuxUserlandContentCommand = (
  userland: RemoteLinuxUserland,
  args: ReadonlyArray<string>,
): Effect.Effect<RemoteCommand, SshInputError> => {
  const home = remoteLinuxUserlands.get(userland);
  if (home === undefined) {
    return Effect.fail(
      new SshInputError({
        message: "remote Linux userland witness is invalid",
      }),
    );
  }
  return Effect.gen(function* () {
    const safeArgs = yield* assertContentHelperArgs(args);
    return yield* makeRemoteCommand(
      `${home}/.local/bin/junto`,
      contentTransferArgs(safeArgs),
    );
  });
};

/**
 * Resolve the fixed packaged content helper for an observed platform.
 * Callers supply only the closed content-helper argv (receive/send/stat);
 * they never supply an executable path.
 */
export const resolveRemoteContentHelper = (
  ssh: Ssh,
  target: SshTarget,
  platform: RemotePackagedPlatform,
  args: ReadonlyArray<string>,
): Effect.Effect<RemoteCommand, SshError | SshInputError> =>
  Effect.gen(function* () {
    const observed = remotePackagedPlatforms.get(platform);
    if (observed === "darwin") {
      return yield* remoteJuntoContentCommand(platform, args);
    }
    if (observed !== "linux") {
      return yield* Effect.fail(
        new SshInputError({
          message: "remote packaged platform witness is invalid",
        }),
      );
    }
    const homeResult = yield* ssh.run(homeDirectoryLookup(target));
    const homeDirectory = yield* decodeObservedRemoteHome(homeResult.stdout);
    const userland = yield* bindLinuxRemoteUserland(platform, homeDirectory);
    return yield* remoteLinuxUserlandContentCommand(userland, args);
  }).pipe(Effect.withSpan("ssh.remote-content-helper"));
