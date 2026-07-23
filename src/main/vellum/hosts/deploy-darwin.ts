/**
 * Darwin deployment provider: install/update Vellum Command.app over SSH and start it.
 *
 * Streams tar over ssh stdin. After install: LaunchAgent + start station + probe
 * term + browser control sockets.
 *
 * Starts WITHOUT --vellum-headless so BrowserWindow exists for WebContentsView
 * (host-local browser automation). Headless-only is terminal-capable but not
 * browser-capable until an offscreen parent window lands.
 */

import { constants as fsConstants, existsSync } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Context } from "effect";
import { Effect, Stream } from "effect";
import { controlSocketPath as browserControlSocketPath } from "@shared/browser-control";
import { TERM_REMOTE_SOCK_REL } from "@shared/term-control";
import { makeRemoteCommand, type SshEndpoint } from "../ssh/domain";
import { homeDirectoryLookup, oneShot, sharedStream } from "../ssh/program";
import { SshTransferExitError, SshTransport } from "../ssh/service";
import {
  appProcessPlane,
  type AppChildIo,
} from "../app-process-plane";
import { runProcess } from "../../services/process";
import {
  readinessFromDisposition,
  rollbackFromDisposition,
  type DeployRemoteResult,
  type RemoteDeploymentProvider,
  type RemoteDeploymentProviderInput,
} from "./remote-deployment";
import {
  decodeRemoteHomeDirectoryOutput,
  isSafeRemoteHomePath,
} from "./remote-home";

const PRODUCT_NAME = "Vellum Command";
const APP_BUNDLE_NAME = `${PRODUCT_NAME}.app`;
const LABEL = "skastr0.vellum";
const TEAM_IDENTIFIER = "EXAMP12345";
const SIGNING_AUTHORITY =
  "Developer ID Application: Example Maintainer (EXAMP12345)";
const DEVELOPER_ID_REQUIREMENT =
  '=anchor apple generic and identifier "skastr0.vellum" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "EXAMP12345"';
const DEPLOY_TIMEOUT_MS = 20 * 60 * 1000;
const REMOTE_APP_PATH = `/Applications/${APP_BUNDLE_NAME}`;

const shellLiteral = (value: string): string =>
  `'${value.replaceAll("'", `'"'"'`)}'`;

const xmlText = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

export type LocalBundleProvenanceReceipt = {
  readonly appPath: string;
  readonly bundleIdentifier: typeof LABEL;
  readonly bundleExecutable: typeof PRODUCT_NAME;
  readonly version: string;
  readonly teamIdentifier: typeof TEAM_IDENTIFIER;
  readonly signingAuthority: typeof SIGNING_AUTHORITY;
  readonly cdHash: string;
};

export {
  decodeRemoteHomeDirectoryOutput,
  isSafeRemoteHomePath,
} from "./remote-home";

const singleCodesignValue = (output: string, key: string): string => {
  const prefix = `${key}=`;
  const values = output
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length).trim())
    .filter((value) => value.length > 0);
  if (values.length !== 1) {
    throw new Error(`code signature must contain exactly one ${key}`);
  }
  return values[0];
};

export const validateLocalBundleProvenance = (input: {
  readonly appPath: string;
  readonly executablePath: string;
  readonly bundleIdentifier: string;
  readonly bundleExecutable: string;
  readonly bundleVersion: string;
  readonly codesignMetadata: string;
}): LocalBundleProvenanceReceipt => {
  if (basename(input.appPath) !== APP_BUNDLE_NAME) {
    throw new Error(`local bundle must be named ${APP_BUNDLE_NAME}`);
  }
  if (input.bundleIdentifier.trim() !== LABEL) {
    throw new Error("local bundle identifier does not match Vellum");
  }
  if (input.bundleExecutable.trim() !== PRODUCT_NAME) {
    throw new Error("local bundle executable identity does not match Vellum");
  }
  const bundleVersion = input.bundleVersion.trim();
  if (!/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u.test(bundleVersion)) {
    throw new Error("local bundle version is missing or invalid");
  }
  if (
    singleCodesignValue(input.codesignMetadata, "Executable") !==
    input.executablePath
  ) {
    throw new Error("code signature executable path does not match the bundle");
  }
  if (singleCodesignValue(input.codesignMetadata, "Identifier") !== LABEL) {
    throw new Error("code signature identifier does not match Vellum");
  }
  if (
    singleCodesignValue(input.codesignMetadata, "TeamIdentifier") !==
    TEAM_IDENTIFIER
  ) {
    throw new Error("code signature team does not match Vellum");
  }
  const codeDirectories = input.codesignMetadata
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("CodeDirectory "));
  if (codeDirectories.length !== 1) {
    throw new Error("code signature must contain exactly one CodeDirectory");
  }
  const flags = codeDirectories[0];
  if (!/\([^)]*\bruntime\b[^)]*\)/u.test(flags) || /\badhoc\b/u.test(flags)) {
    throw new Error("code signature must use hardened runtime and may not be ad-hoc");
  }
  const authorities = input.codesignMetadata
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("Authority="))
    .map((line) => line.slice("Authority=".length).trim());
  if (authorities[0] !== SIGNING_AUTHORITY) {
    throw new Error("code signature authority does not match Vellum policy");
  }
  const signatureSize = singleCodesignValue(
    input.codesignMetadata,
    "Signature size",
  );
  if (!/^[1-9][0-9]*$/u.test(signatureSize)) {
    throw new Error("code signature must be a non-empty Developer ID signature");
  }
  const cdHash = singleCodesignValue(input.codesignMetadata, "CDHash");
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(cdHash)) {
    throw new Error("code signature must contain one valid code-directory hash");
  }
  return Object.freeze({
    appPath: input.appPath,
    bundleIdentifier: LABEL,
    bundleExecutable: PRODUCT_NAME,
    version: bundleVersion,
    teamIdentifier: TEAM_IDENTIFIER,
    signingAuthority: SIGNING_AUTHORITY,
    cdHash: cdHash.toLowerCase(),
  });
};

const runBundleAdmissionCommand = async (
  command: string,
  args: readonly string[],
): Promise<{ readonly stdout: string; readonly stderr: string }> => {
  const result = await runProcess(command, args, {
    timeoutMs: 30_000,
    maxOutputBytes: 128 * 1024,
  });
  if (result.code !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`.trim().slice(0, 1_000);
    throw new Error(
      `${basename(command)} rejected local bundle${detail ? `: ${detail}` : ""}`,
    );
  }
  return result;
};

export const admitLocalAppBundle = async (
  requestedPath: string,
): Promise<LocalBundleProvenanceReceipt> => {
  const requestedAbsolute = resolve(requestedPath);
  const canonicalPath = await realpath(requestedAbsolute);
  if (canonicalPath !== requestedAbsolute) {
    throw new Error("local bundle root may not be a symlink or path alias");
  }
  const root = await lstat(canonicalPath);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error("local bundle root must be a directory");
  }
  if (basename(canonicalPath) !== APP_BUNDLE_NAME) {
    throw new Error(`local bundle must be named ${APP_BUNDLE_NAME}`);
  }

  const infoPlistPath = join(canonicalPath, "Contents", "Info.plist");
  const executablePath = join(
    canonicalPath,
    "Contents",
    "MacOS",
    PRODUCT_NAME,
  );
  const [plistMetadata, executableMetadata] = await Promise.all([
    lstat(infoPlistPath),
    lstat(executablePath),
  ]);
  if (
    !plistMetadata.isFile() ||
    plistMetadata.isSymbolicLink() ||
    !executableMetadata.isFile() ||
    executableMetadata.isSymbolicLink()
  ) {
    throw new Error("local bundle identity files must be regular files");
  }
  await access(executablePath, fsConstants.X_OK);

  await runBundleAdmissionCommand("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    "-R",
    DEVELOPER_ID_REQUIREMENT,
    canonicalPath,
  ]);
  const [codesign, bundleIdentifier, bundleExecutable, bundleVersion] = await Promise.all([
    runBundleAdmissionCommand("/usr/bin/codesign", [
      "-d",
      "--verbose=4",
      canonicalPath,
    ]),
    runBundleAdmissionCommand("/usr/bin/plutil", [
      "-extract",
      "CFBundleIdentifier",
      "raw",
      "-o",
      "-",
      infoPlistPath,
    ]),
    runBundleAdmissionCommand("/usr/bin/plutil", [
      "-extract",
      "CFBundleExecutable",
      "raw",
      "-o",
      "-",
      infoPlistPath,
    ]),
    runBundleAdmissionCommand("/usr/bin/plutil", [
      "-extract",
      "CFBundleShortVersionString",
      "raw",
      "-o",
      "-",
      infoPlistPath,
    ]),
  ]);
  return validateLocalBundleProvenance({
    appPath: canonicalPath,
    executablePath,
    bundleIdentifier: bundleIdentifier.stdout,
    bundleExecutable: bundleExecutable.stdout,
    bundleVersion: bundleVersion.stdout,
    codesignMetadata: `${codesign.stdout}\n${codesign.stderr}`,
  });
};

/** Lazy electron app — avoid import-time electron in unit tests. */
const tryPackagedAppPath = (): string | null => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require("electron") as typeof import("electron");
    if (!app?.isPackaged) return null;
    let dir = dirname(process.execPath);
    for (let i = 0; i < 6; i += 1) {
      if (
        dir.endsWith(".app") &&
        existsSync(join(dir, "Contents", "MacOS", PRODUCT_NAME))
      ) {
        return dir;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* not in electron */
  }
  return null;
};

type Ssh = Context.Tag.Service<typeof SshTransport>;

const push = (stages: string[], line: string): void => {
  stages.push(line);
  console.info(`[deploy-remote] ${line}`);
};

/** Resolve the local .app bundle Command Center will push. */
export const resolveLocalAppBundle = (): string | null => {
  const env = process.env.VELLUM_APP_SRC?.trim();
  if (env && existsSync(join(env, "Contents", "MacOS", PRODUCT_NAME)))
    return env;

  const packaged = tryPackagedAppPath();
  if (packaged) return packaged;

  for (const c of [
    `/Applications/${APP_BUNDLE_NAME}`,
    join(process.cwd(), "release", "mac-arm64", APP_BUNDLE_NAME),
    join(process.cwd(), "release", "mac", APP_BUNDLE_NAME),
    join(process.cwd(), "release", "mac-x64", APP_BUNDLE_NAME),
  ]) {
    if (existsSync(join(c, "Contents", "MacOS", PRODUCT_NAME))) return c;
  }
  return null;
};

export const parseDeployTransferResult = (input: {
  readonly stdout: string;
  readonly stderr: string;
}): { readonly ok: boolean; readonly detail: string } => {
  if (/^STATION_READY pid=[1-9][0-9]* term=1 browser=1$/mu.test(input.stdout)) {
    return {
      ok: true,
      detail: "app installed; term + browser control sockets ready",
    };
  }
  return {
    ok: false,
    detail:
      "remote install did not prove a fresh launchd process generation and control socket",
  };
};

export type TarExitSettlement =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: Error };

export type TarExitWatch = {
  readonly settlement: Promise<TarExitSettlement>;
  readonly closed: Promise<void>;
  readonly isClosed: () => boolean;
};

const TAR_STDERR_LIMIT_BYTES = 64 * 1024;

/** Attach both listeners at spawn time: an error is not proof the child has exited. */
export const watchTarExit = (
  tar: Pick<AppChildIo, "onError" | "onClose">,
): TarExitWatch => {
  let settle: (result: TarExitSettlement) => void = () => {};
  let close: () => void = () => {};
  const settlement = new Promise<TarExitSettlement>((resolve) => {
    settle = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    close = resolve;
  });
  let reported = false;
  let didClose = false;
  let removeError = (): void => {};
  let removeClose = (): void => {};
  const report = (result: TarExitSettlement): void => {
    if (reported) return;
    reported = true;
    settle(result);
  };

  const onError = (error: Error): void => {
    report({ ok: false, error });
  };
  const onCloseEvent = (event: { readonly code: number | null }): void => {
    didClose = true;
    removeError();
    removeClose();
    report(
      event.code === 0
        ? { ok: true }
        : {
            ok: false,
            error: new Error(`local tar exited ${String(event.code)}`),
          },
    );
    close();
  };
  removeError = tar.onError(onError);
  removeClose = tar.onClose(onCloseEvent);
  // A child may close between central admission and observer registration.
  // The facade immediately replays that witness, before the unsubscribe
  // closures above have both been assigned.
  if (didClose) {
    removeError();
    removeClose();
  }
  return {
    settlement,
    closed,
    isClosed: () => didClose,
  };
};

/** Native timer race: completes even while an Effect finalizer is uninterruptible. */
export const awaitTarCloseBounded = (exit: TarExitWatch, timeoutMs: number): Promise<void> =>
  new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    void exit.closed.then(finish);
  });

export const captureTarStderr = (stream: {
  readonly on: (event: "data", listener: (chunk: Buffer) => void) => unknown;
}): (() => string) => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  stream.on("data", (chunk) => {
    const remaining = TAR_STDERR_LIMIT_BYTES - bytes;
    if (remaining <= 0) return;
    const bounded = Buffer.from(chunk).subarray(0, remaining);
    chunks.push(bounded);
    bytes += bounded.byteLength;
  });
  return () => Buffer.concat(chunks, bytes).toString("utf8");
};

export const describeDeployTransferFailure = (error: unknown): string => {
  if (error instanceof SshTransferExitError) {
    const diagnostic = (error.stderr || error.stdout).trim().slice(0, 900);
    if (diagnostic.includes("REMOTE_NOT_DARWIN")) {
      return "remote host is not macOS — full-app Deploy Remote is Darwin-only (Linux Electron station is a separate track)";
    }
    return diagnostic || error.message;
  }
  return error instanceof Error ? error.message : String(error);
};

export const classifyDeployTransferDisposition = (
  error: unknown,
): NonNullable<DeployRemoteResult["disposition"]> => {
  if (!(error instanceof SshTransferExitError)) return "indeterminate";
  if (error.code === 10) return "ready";
  if (error.code === 8 || error.code === 9) return "indeterminate";
  return "rolled-back";
};

type RemoteDeployScriptCommands = {
  readonly uname: string;
  readonly id: string;
  readonly launchctl: string;
  readonly lsof: string;
  readonly uuidgen: string;
  readonly tar: string;
  readonly codesign: string;
  readonly plutil: string;
  readonly osascript: string;
  readonly sleep: string;
};

type RemoteDeployScriptRuntime = {
  readonly appPath: string;
  readonly lockPath: string;
  readonly commands: RemoteDeployScriptCommands;
};

const PRODUCTION_DEPLOY_SCRIPT_RUNTIME: RemoteDeployScriptRuntime = {
  appPath: REMOTE_APP_PATH,
  lockPath: "/Applications/.vellum-command-deploy.lock",
  commands: {
    uname: "/usr/bin/uname",
    id: "/usr/bin/id",
    launchctl: "/bin/launchctl",
    lsof: "/usr/sbin/lsof",
    uuidgen: "/usr/bin/uuidgen",
    tar: "/usr/bin/tar",
    codesign: "/usr/bin/codesign",
    plutil: "/usr/bin/plutil",
    osascript: "/usr/bin/osascript",
    sleep: "/bin/sleep",
  },
};

/** Explicit hermetic seam; production always uses the frozen runtime above. */
export type RemoteDeployScriptTestRuntime = RemoteDeployScriptRuntime & {
  readonly testOnly: true;
};

const buildRemoteDeployScriptWithRuntime = (
  remoteHome: string,
  expectedCdHash: string,
  runtime: RemoteDeployScriptRuntime,
): string => {
  if (!isSafeRemoteHomePath(remoteHome)) {
    throw new Error("remote home must be a canonical absolute path");
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(expectedCdHash)) {
    throw new Error("expected code-directory hash is invalid");
  }
  const remoteAppPath = runtime.appPath;
  const remoteExecutablePath = `${remoteAppPath}/Contents/MacOS/${PRODUCT_NAME}`;
  const appParentPath = dirname(remoteAppPath);
  const plistPath = `${remoteHome}/Library/LaunchAgents/${LABEL}.plist`;
  const logDir = `${remoteHome}/Library/Logs/${PRODUCT_NAME}`;
  const termSock = `${remoteHome}/${TERM_REMOTE_SOCK_REL}`;
  const browserSock = browserControlSocketPath(remoteHome);
  const incomingPath = `${remoteAppPath}.incoming`;

  // No --vellum-headless: WebContentsView needs a GUI-domain LaunchAgent.
  const plistBody = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array>
<string>${xmlText(remoteExecutablePath)}</string>
</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ProcessType</key><string>Interactive</string>
<key>StandardOutPath</key><string>${xmlText(logDir)}/vellum.out.log</string>
<key>StandardErrorPath</key><string>${xmlText(logDir)}/vellum.err.log</string>
</dict></plist>
`;
  const plistB64 = Buffer.from(plistBody, "utf8").toString("base64");

  // Every interpolated path is a shell-safe literal. APP/IN/EXE are compile-
  // time product paths; remoteHome only scopes Vellum's own plist/log/sockets.
  return `
set -euo pipefail
umask 022
UNAME=${shellLiteral(runtime.commands.uname)}
ID=${shellLiteral(runtime.commands.id)}
LAUNCHCTL=${shellLiteral(runtime.commands.launchctl)}
LSOF=${shellLiteral(runtime.commands.lsof)}
UUIDGEN=${shellLiteral(runtime.commands.uuidgen)}
TAR=${shellLiteral(runtime.commands.tar)}
CODESIGN=${shellLiteral(runtime.commands.codesign)}
PLUTIL=${shellLiteral(runtime.commands.plutil)}
OSASCRIPT=${shellLiteral(runtime.commands.osascript)}
SLEEP=${shellLiteral(runtime.commands.sleep)}
test "$("$UNAME" -s)" = "Darwin" || { echo "REMOTE_NOT_DARWIN $("$UNAME" -s)" >&2; exit 3; }
APP=${shellLiteral(remoteAppPath)}
IN=${shellLiteral(incomingPath)}
BUNDLE=${shellLiteral(APP_BUNDLE_NAME)}
EXE=${shellLiteral(remoteExecutablePath)}
IN_EXE=${shellLiteral(`${incomingPath}/${APP_BUNDLE_NAME}/Contents/MacOS/${PRODUCT_NAME}`)}
TERM_SOCK=${shellLiteral(termSock)}
BROWSER_SOCK=${shellLiteral(browserSock)}
PLIST=${shellLiteral(plistPath)}
PLIST_IN=${shellLiteral(`${plistPath}.incoming`)}
PLIST_PREVIOUS=${shellLiteral(`${plistPath}.previous`)}
LOGDIR=${shellLiteral(logDir)}
APP_PARENT=${shellLiteral(appParentPath)}
APP_PREVIOUS=${shellLiteral(`${remoteAppPath}.previous`)}
DEPLOY_LOCK=${shellLiteral(runtime.lockPath)}
DEPLOY_LOCK_OWNER=${shellLiteral(`${runtime.lockPath}/owner`)}
LSOF_ERROR=${shellLiteral(`${runtime.lockPath}/lsof.error`)}
EXPECTED_CDHASH=${shellLiteral(expectedCdHash.toLowerCase())}
DEVELOPER_ID_REQUIREMENT=${shellLiteral(DEVELOPER_ID_REQUIREMENT)}
UID_VALUE="$("$ID" -u)"
DOMAIN="gui/$UID_VALUE"
JOB="$DOMAIN/${LABEL}"
LOCK_HELD=0
ROLLBACK_ARMED=0
COMMITTED=0
APP_BACKED_UP=0
PLIST_BACKED_UP=0
NEW_APP_INSTALLED=0
NEW_PLIST_INSTALLED=0
OLD_JOB_PRESENT=0
OLD_PID=""

valid_pid() {
  case "$1" in
    ""|*[!0-9]*) return 1 ;;
  esac
  [ "$1" -gt 1 ]
}

job_exists() {
  "$LAUNCHCTL" print "$JOB" >/dev/null 2>&1
}

exact_exe_pids() {
  ALL_LSOF_OUTPUT="$("$LSOF" -n -d txt -Fp -Fn 2>"$LSOF_ERROR")" || return 2
  [ ! -s "$LSOF_ERROR" ] || return 2
  printf '%s\n' "$ALL_LSOF_OUTPUT" | /usr/bin/awk -v exe="$EXE" '
    /^p[0-9]+$/ { pid = substr($0, 2); next }
    /^n/ {
      name = substr($0, 2)
      if ((name == exe || name == exe " (deleted)") && !seen[pid]++) print pid
    }
  '
}

exact_exe_has_pid() {
  PID_LSOF_OUTPUT="$("$LSOF" -n -a -p "$1" -d txt -Fn 2>"$LSOF_ERROR")" || return 1
  [ ! -s "$LSOF_ERROR" ] || return 1
  printf '%s\n' "$PID_LSOF_OUTPUT" | /usr/bin/awk -v exe="$EXE" '
    /^n/ {
      name = substr($0, 2)
      if (name == exe || name == exe " (deleted)") found = 1
    }
    END { exit(found ? 0 : 1) }
  '
}

single_metadata_value() {
  METADATA="$1"
  METADATA_KEY="$2"
  printf '%s\n' "$METADATA" | /usr/bin/awk -v prefix="$METADATA_KEY=" '
    index($0, prefix) == 1 {
      count += 1
      value = substr($0, length(prefix) + 1)
    }
    END {
      if (count == 1 && length(value) > 0) print value
      else exit 1
    }
  '
}

first_signing_authority() {
  printf '%s\n' "$1" | /usr/bin/awk '
    /^Authority=/ && !found {
      print substr($0, length("Authority=") + 1)
      found = 1
    }
    END { if (!found) exit 1 }
  '
}

remove_fixed_socket() {
  SOCKET_PATH="$1"
  if [ -e "$SOCKET_PATH" ] || [ -L "$SOCKET_PATH" ]; then
    if [ ! -S "$SOCKET_PATH" ]; then
      echo "CONTROL_PATH_NOT_SOCKET $SOCKET_PATH" >&2
      exit 5
    fi
    /bin/rm -f -- "$SOCKET_PATH"
  fi
  if [ -e "$SOCKET_PATH" ] || [ -L "$SOCKET_PATH" ]; then
    echo "CONTROL_SOCKET_REMOVE_FAILED $SOCKET_PATH" >&2
    exit 5
  fi
}

socket_owned_by_pid() {
  [ -S "$1" ] || return 1
  "$LSOF" -n -a -U -Fp -- "$1" 2>/dev/null | /usr/bin/grep -F -x -q -- "p$2"
}

wait_until_job_and_executable_gone() {
  WAIT_LIMIT="$1"
  WAIT_INDEX=0
  while [ "$WAIT_INDEX" -lt "$WAIT_LIMIT" ]; do
    if ! job_exists; then
      OBSERVED_EXE_PIDS=""
      if ! OBSERVED_EXE_PIDS="$(exact_exe_pids)"; then
        echo "PROCESS_OBSERVATION_FAILED" >&2
        return 2
      fi
      if [ -z "$OBSERVED_EXE_PIDS" ]; then return 0; fi
    fi
    WAIT_INDEX=$((WAIT_INDEX + 1))
    "$SLEEP" 1
  done
  return 1
}

release_deploy_lock() {
  if [ "$LOCK_HELD" != "1" ]; then return 0; fi
  CURRENT_LOCK_TOKEN="$(/bin/cat "$DEPLOY_LOCK_OWNER" 2>/dev/null || true)"
  if [ -n "$CURRENT_LOCK_TOKEN" ] && [ "$CURRENT_LOCK_TOKEN" = "$LOCK_TOKEN" ]; then
    /bin/rm -f -- "$LSOF_ERROR" || return 1
    /bin/rm -f -- "$DEPLOY_LOCK_OWNER" || return 1
    /bin/rmdir "$DEPLOY_LOCK" || return 1
  elif [ ! -e "$DEPLOY_LOCK_OWNER" ] && [ ! -L "$DEPLOY_LOCK_OWNER" ]; then
    /bin/rmdir "$DEPLOY_LOCK" 2>/dev/null || return 1
  else
    return 1
  fi
  LOCK_HELD=0
  return 0
}

rollback_deploy() {
  if [ "$ROLLBACK_ARMED" != "1" ] || [ "$COMMITTED" = "1" ]; then return 0; fi
  "$LAUNCHCTL" bootout "$JOB" >/dev/null 2>&1 || true
  if ! wait_until_job_and_executable_gone 30; then
    echo "ROLLBACK_REFUSED_LIVE_GENERATION app_backup=$APP_PREVIOUS plist_backup=$PLIST_PREVIOUS" >&2
    return 1
  fi
  if [ -e "$APP_PREVIOUS" ] || [ -L "$APP_PREVIOUS" ]; then
    if [ -e "$APP" ] || [ -L "$APP" ]; then
      /bin/rm -rf -- "$APP" || return 1
    fi
    /bin/mv "$APP_PREVIOUS" "$APP" || return 1
  elif [ "$APP_BACKED_UP" = "1" ]; then
    echo "ROLLBACK_APP_BACKUP_MISSING $APP_PREVIOUS" >&2
    return 1
  elif [ "$NEW_APP_INSTALLED" = "1" ] && { [ -e "$APP" ] || [ -L "$APP" ]; }; then
    /bin/rm -rf -- "$APP" || return 1
  fi
  if [ -e "$PLIST_PREVIOUS" ] || [ -L "$PLIST_PREVIOUS" ]; then
    if [ -e "$PLIST" ] || [ -L "$PLIST" ]; then
      /bin/rm -f -- "$PLIST" || return 1
    fi
    /bin/mv "$PLIST_PREVIOUS" "$PLIST" || return 1
  elif [ "$PLIST_BACKED_UP" = "1" ]; then
    echo "ROLLBACK_PLIST_BACKUP_MISSING $PLIST_PREVIOUS" >&2
    return 1
  elif [ "$NEW_PLIST_INSTALLED" = "1" ] && { [ -e "$PLIST" ] || [ -L "$PLIST" ]; }; then
    /bin/rm -f -- "$PLIST" || return 1
  fi
  if [ "$OLD_JOB_PRESENT" = "1" ]; then
    [ -d "$APP" ] && [ -f "$PLIST" ] || return 1
    "$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST" >/dev/null 2>&1 || return 1
    RESTORED_PID="$("$LAUNCHCTL" kickstart -p "$JOB" 2>/dev/null)" || return 1
    valid_pid "$RESTORED_PID" && exact_exe_has_pid "$RESTORED_PID" || return 1
  fi
  ROLLBACK_ARMED=0
  return 0
}

on_deploy_exit() {
  EXIT_CODE=$?
  trap - EXIT
  trap '' HUP INT TERM
  set +e
  if [ "$EXIT_CODE" -ne 0 ] && ! rollback_deploy; then EXIT_CODE=9; fi
  if [ "$EXIT_CODE" -ne 0 ]; then
    /bin/rm -rf -- "$IN" >/dev/null 2>&1 || true
    /bin/rm -f -- "$PLIST_IN" >/dev/null 2>&1 || true
  fi
  if ! release_deploy_lock; then
    echo "DEPLOY_LOCK_RELEASE_FAILED $DEPLOY_LOCK" >&2
    if [ "$EXIT_CODE" -eq 0 ]; then EXIT_CODE=10; fi
  fi
  exit "$EXIT_CODE"
}

commit_deploy() {
  COMMITTED=1
  /bin/rm -rf -- "$APP_PREVIOUS" >/dev/null 2>&1 || echo "APP_BACKUP_CLEANUP_FAILED $APP_PREVIOUS" >&2
  /bin/rm -f -- "$PLIST_PREVIOUS" >/dev/null 2>&1 || echo "PLIST_BACKUP_CLEANUP_FAILED $PLIST_PREVIOUS" >&2
}

[ -x "$LSOF" ] || { echo "PROCESS_OBSERVER_UNAVAILABLE" >&2; exit 3; }
LOCK_TOKEN="$("$UUIDGEN")"
test -n "$LOCK_TOKEN"
if ! /bin/mkdir "$DEPLOY_LOCK" 2>/dev/null; then
  echo "DEPLOY_ALREADY_IN_PROGRESS $DEPLOY_LOCK" >&2
  exit 8
fi
LOCK_HELD=1
trap on_deploy_exit EXIT
trap 'exit 130' HUP INT TERM
/usr/bin/printf '%s\n' "$LOCK_TOKEN" > "$DEPLOY_LOCK_OWNER"
/bin/chmod 600 "$DEPLOY_LOCK_OWNER"

if [ -e "$APP_PREVIOUS" ] || [ -L "$APP_PREVIOUS" ] || [ -e "$PLIST_PREVIOUS" ] || [ -L "$PLIST_PREVIOUS" ]; then
  echo "DEPLOY_RECOVERY_REQUIRED app_backup=$APP_PREVIOUS plist_backup=$PLIST_PREVIOUS" >&2
  exit 8
fi

# Extract and verify the incoming signed artifact while the old generation is
# still running. Archive or signature failures therefore leave it untouched.
/bin/mkdir -p "$APP_PARENT"
/bin/rm -rf -- "$IN"
/bin/mkdir -p "$IN/$BUNDLE"
"$TAR" -C "$IN/$BUNDLE" -xf -
test -x "$IN_EXE"
"$CODESIGN" --verify --deep --strict --verbose=2 -R "$DEVELOPER_ID_REQUIREMENT" "$IN/$BUNDLE"
REMOTE_CODESIGN_METADATA="$("$CODESIGN" -d --verbose=4 "$IN/$BUNDLE" 2>&1)" || {
  echo "REMOTE_SIGNATURE_METADATA_UNAVAILABLE" >&2
  exit 3
}
REMOTE_SIGNED_EXE="$(single_metadata_value "$REMOTE_CODESIGN_METADATA" "Executable")" || {
  echo "REMOTE_SIGNATURE_EXECUTABLE_AMBIGUOUS" >&2
  exit 3
}
REMOTE_SIGNED_ID="$(single_metadata_value "$REMOTE_CODESIGN_METADATA" "Identifier")" || {
  echo "REMOTE_SIGNATURE_IDENTIFIER_AMBIGUOUS" >&2
  exit 3
}
REMOTE_SIGNED_TEAM="$(single_metadata_value "$REMOTE_CODESIGN_METADATA" "TeamIdentifier")" || {
  echo "REMOTE_SIGNATURE_TEAM_AMBIGUOUS" >&2
  exit 3
}
REMOTE_SIGNED_CDHASH="$(single_metadata_value "$REMOTE_CODESIGN_METADATA" "CDHash")" || {
  echo "REMOTE_SIGNATURE_CDHASH_AMBIGUOUS" >&2
  exit 3
}
REMOTE_SIGNED_AUTHORITY="$(first_signing_authority "$REMOTE_CODESIGN_METADATA")" || {
  echo "REMOTE_SIGNATURE_AUTHORITY_MISSING" >&2
  exit 3
}
[ "$REMOTE_SIGNED_EXE" = "$IN_EXE" ] || { echo "REMOTE_SIGNATURE_EXECUTABLE_MISMATCH" >&2; exit 3; }
[ "$REMOTE_SIGNED_ID" = "${LABEL}" ] || { echo "REMOTE_SIGNATURE_IDENTIFIER_MISMATCH" >&2; exit 3; }
[ "$REMOTE_SIGNED_TEAM" = "${TEAM_IDENTIFIER}" ] || { echo "REMOTE_SIGNATURE_TEAM_MISMATCH" >&2; exit 3; }
[ "$REMOTE_SIGNED_AUTHORITY" = "${SIGNING_AUTHORITY}" ] || { echo "REMOTE_SIGNATURE_AUTHORITY_MISMATCH" >&2; exit 3; }
[ "$(/usr/bin/printf '%s' "$REMOTE_SIGNED_CDHASH" | /usr/bin/tr '[:upper:]' '[:lower:]')" = "$EXPECTED_CDHASH" ] || {
  echo "REMOTE_SIGNATURE_GENERATION_MISMATCH" >&2
  exit 3
}
REMOTE_BUNDLE_ID="$("$PLUTIL" -extract CFBundleIdentifier raw -o - "$IN/$BUNDLE/Contents/Info.plist")"
REMOTE_BUNDLE_EXE="$("$PLUTIL" -extract CFBundleExecutable raw -o - "$IN/$BUNDLE/Contents/Info.plist")"
[ "$REMOTE_BUNDLE_ID" = "${LABEL}" ] && [ "$REMOTE_BUNDLE_EXE" = "${PRODUCT_NAME}" ]

# print output is intentionally never parsed. kickstart -p is the documented
# PID-producing launchctl operation and starts a loaded-but-idle old job so its
# generation can be captured before bootout.
if job_exists; then
  OLD_JOB_PRESENT=1
  OLD_PID="$("$LAUNCHCTL" kickstart -p "$JOB")" || { echo "OLD_LAUNCHD_PID_NOT_PROVEN" >&2; exit 4; }
  valid_pid "$OLD_PID" || { echo "OLD_LAUNCHD_PID_INVALID $OLD_PID" >&2; exit 4; }
  OLD_IDENTITY_OK=0
  WAIT_INDEX=0
  while [ "$WAIT_INDEX" -lt 10 ]; do
    if exact_exe_has_pid "$OLD_PID"; then OLD_IDENTITY_OK=1; break; fi
    WAIT_INDEX=$((WAIT_INDEX + 1))
    "$SLEEP" 1
  done
  [ "$OLD_IDENTITY_OK" = "1" ] || { echo "OLD_LAUNCHD_EXECUTABLE_NOT_PROVEN pid=$OLD_PID" >&2; exit 4; }
fi

# Ask both the app and launchd to retire the old generation. Neither command is
# treated as proof; the bounded observation below is the destructive gate.
ROLLBACK_ARMED=1
"$OSASCRIPT" -e ${shellLiteral(`with timeout of 5 seconds
  tell application "${PRODUCT_NAME}" to quit
end timeout`)} >/dev/null 2>&1 || true
"$LAUNCHCTL" bootout "$JOB" >/dev/null 2>&1 || true

if ! wait_until_job_and_executable_gone 30; then
  CURRENT_EXE_PIDS="$(exact_exe_pids | /usr/bin/tr '\n' ',' || true)"
  echo "OLD_GENERATION_STILL_PRESENT exe_pids=$CURRENT_EXE_PIDS" >&2
  exit 4
fi

# Stale sockets are removed only after the old job and exact executable are
# both absent. Their later existence therefore witnesses a new listener.
remove_fixed_socket "$TERM_SOCK"
remove_fixed_socket "$BROWSER_SOCK"

# Preserve the exact old bundle and plist until the new generation proves
# readiness. Any later failure runs rollback_deploy from the EXIT trap.
if [ -e "$APP" ] || [ -L "$APP" ]; then
  /bin/mv "$APP" "$APP_PREVIOUS"
  APP_BACKED_UP=1
fi
if [ -e "$PLIST" ] || [ -L "$PLIST" ]; then
  /bin/mv "$PLIST" "$PLIST_PREVIOUS"
  PLIST_BACKED_UP=1
fi
NEW_APP_INSTALLED=1
/bin/mv "$IN/$BUNDLE" "$APP"
/bin/rm -rf -- "$IN"
test -x "$EXE"

/bin/mkdir -p "$(/usr/bin/dirname "$PLIST")" "$LOGDIR"
/bin/rm -f -- "$PLIST_IN"
/usr/bin/printf '%s' ${shellLiteral(plistB64)} | /usr/bin/base64 -d > "$PLIST_IN"
NEW_PLIST_INSTALLED=1
/bin/mv "$PLIST_IN" "$PLIST"
if ! "$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST" 2>/dev/null; then
  "$LAUNCHCTL" load -w "$PLIST"
fi

NEW_PID="$("$LAUNCHCTL" kickstart -p "$JOB")" || { echo "NEW_LAUNCHD_PID_NOT_PROVEN" >&2; exit 6; }
valid_pid "$NEW_PID" || { echo "NEW_LAUNCHD_PID_INVALID $NEW_PID" >&2; exit 6; }
if [ -n "$OLD_PID" ] && [ "$NEW_PID" = "$OLD_PID" ]; then
  echo "NEW_LAUNCHD_PID_REUSED old_pid=$OLD_PID" >&2
  exit 6
fi
NEW_IDENTITY_OK=0
WAIT_INDEX=0
while [ "$WAIT_INDEX" -lt 30 ]; do
  if exact_exe_has_pid "$NEW_PID"; then NEW_IDENTITY_OK=1; break; fi
  WAIT_INDEX=$((WAIT_INDEX + 1))
  "$SLEEP" 1
done
[ "$NEW_IDENTITY_OK" = "1" ] || {
  echo "NEW_LAUNCHD_GENERATION_NOT_PROVEN old_pid=$OLD_PID" >&2
  exit 6
}

TERM_OK=0
BROWSER_OK=0
WAIT_INDEX=0
while [ "$WAIT_INDEX" -lt 60 ]; do
  if ! job_exists || ! exact_exe_has_pid "$NEW_PID"; then
    echo "NEW_LAUNCHD_GENERATION_LOST expected_pid=$NEW_PID" >&2
    exit 7
  fi
  TERM_OK=0
  BROWSER_OK=0
  if socket_owned_by_pid "$TERM_SOCK" "$NEW_PID"; then TERM_OK=1; fi
  if socket_owned_by_pid "$BROWSER_SOCK" "$NEW_PID"; then BROWSER_OK=1; fi
  if [ "$TERM_OK" = "1" ] && [ "$BROWSER_OK" = "1" ]; then
    if job_exists && exact_exe_has_pid "$NEW_PID" && socket_owned_by_pid "$TERM_SOCK" "$NEW_PID" && socket_owned_by_pid "$BROWSER_SOCK" "$NEW_PID"; then
      commit_deploy
      echo "STATION_READY pid=$NEW_PID term=1 browser=1"
      exit 0
    fi
  fi
  WAIT_INDEX=$((WAIT_INDEX + 1))
  "$SLEEP" 1
done
if ! job_exists || ! exact_exe_has_pid "$NEW_PID"; then
  echo "NEW_LAUNCHD_GENERATION_LOST expected_pid=$NEW_PID" >&2
  exit 7
fi
TERM_OK=0
BROWSER_OK=0
if socket_owned_by_pid "$TERM_SOCK" "$NEW_PID"; then TERM_OK=1; fi
if socket_owned_by_pid "$BROWSER_SOCK" "$NEW_PID"; then BROWSER_OK=1; fi
echo "STATION_PARTIAL pid=$NEW_PID term=$TERM_OK browser=$BROWSER_OK" >&2
echo "CONTROL_SOCKET_TIMEOUT pid=$NEW_PID term=$TERM_OK browser=$BROWSER_OK" >&2
exit 2
`.trim();
};

export const buildRemoteDeployScript = (
  remoteHome: string,
  expectedCdHash: string,
): string =>
  buildRemoteDeployScriptWithRuntime(
    remoteHome,
    expectedCdHash,
    PRODUCTION_DEPLOY_SCRIPT_RUNTIME,
  );

export const buildRemoteDeployScriptForTest = (
  remoteHome: string,
  expectedCdHash: string,
  runtime: RemoteDeployScriptTestRuntime,
): string => {
  if (process.env.NODE_ENV !== "test" || runtime.testOnly !== true) {
    throw new Error("remote deploy runtime overrides are test-only");
  }
  if (
    !runtime.appPath.startsWith("/") ||
    basename(runtime.appPath) !== APP_BUNDLE_NAME ||
    !runtime.lockPath.startsWith("/") ||
    Object.values(runtime.commands).some((command) => !command.startsWith("/"))
  ) {
    throw new Error("test deploy runtime requires absolute fixed paths");
  }
  return buildRemoteDeployScriptWithRuntime(remoteHome, expectedCdHash, runtime);
};

const streamAppToRemote = (
  ssh: Ssh,
  endpoint: SshEndpoint,
  input: {
    readonly localApp: LocalBundleProvenanceReceipt;
    readonly remoteHome: string;
  },
): Effect.Effect<
  { readonly ok: boolean; readonly detail: string },
  Error | import("../ssh/domain").SshError
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const remoteScript = buildRemoteDeployScript(
        input.remoteHome,
        input.localApp.cdHash,
      );

      const tar = yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            const lease = appProcessPlane.spawnChild({
              source: "hosts.deploy-remote.tar",
              purpose: "stream app bundle to remote host",
              command: "tar",
              args: ["-C", input.localApp.appPath, "-cf", "-", "."],
            });
            return {
              lease,
              exit: watchTarExit(lease.io),
              stderr: captureTarStderr(lease.io.stderr),
            };
          },
          catch: (error) =>
            error instanceof Error ? error : new Error(String(error)),
        }),
        ({ lease, exit }) =>
          exit.isClosed()
            ? Effect.void
            : Effect.sync(() =>
                appProcessPlane.forceTerminate(
                  lease,
                  "deploy tar scope finalized",
                ),
              ).pipe(
                Effect.zipRight(Effect.promise(() => awaitTarCloseBounded(exit, 2_000))),
              ),
      );
      const command = yield* makeRemoteCommand("bash", ["-lc", remoteScript]);
      const output = yield* ssh.transfer(
        sharedStream(endpoint, command),
        Stream.fromAsyncIterable(
          tar.lease.io.stdout,
          (error) =>
            new Error(
              `local tar stream failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
        ).pipe(Stream.map((chunk) => Uint8Array.from(chunk))),
        DEPLOY_TIMEOUT_MS,
      );
      const tarResult = yield* Effect.promise(() => tar.exit.settlement);
      if (!tarResult.ok) {
        return yield* Effect.fail(
          new Error(
            `local tar failed: ${tarResult.error.message}${tar.stderr() ? `: ${tar.stderr()}` : ""}`,
          ),
        );
      }
      return parseDeployTransferResult(output);
    }),
  );

const deployDarwinRemote = (
  input: RemoteDeploymentProviderInput,
): Effect.Effect<DeployRemoteResult, never> =>
  Effect.gen(function* () {
    const stages: string[] = [];
    const { ssh, target } = input;
    const { host } = target;
    if (target.platform.platform !== "darwin") {
      return {
        ok: false,
        detail: `${host.label}: Darwin deployment provider refused ${target.platform.kernelName}`,
        code: "validation" as const,
        message: "remote not Darwin",
        stages,
        disposition: "not-started" as const,
        unsupportedTarget: {
          kind: "unsupported-target" as const,
          evidence: "unsupported" as const,
          reportedKernel: target.platform.kernelName,
          platform: target.platform.platform,
        },
      };
    }
    if (process.platform !== "darwin") {
      return {
        ok: false,
        detail:
          "Deploy Remote must run from a macOS Command Center (local .app source)",
        code: "validation" as const,
        stages,
        disposition: "not-started" as const,
      };
    }
    const resolvedLocalApp = resolveLocalAppBundle();
    if (!resolvedLocalApp) {
      return {
        ok: false,
        detail:
          "no local Vellum Command.app found — package/install on Command Center first (/Applications or release/mac-arm64)",
        code: "not_found" as const,
        message: "local app bundle missing",
        stages,
        disposition: "not-started" as const,
      };
    }
    push(stages, `local bundle candidate ${resolvedLocalApp}`);

    const admittedLocalApp = yield* Effect.tryPromise({
      try: () => admitLocalAppBundle(resolvedLocalApp),
      catch: (error) =>
        error instanceof Error ? error : new Error(String(error)),
    }).pipe(Effect.either);
    if (admittedLocalApp._tag === "Left") {
      return {
        ok: false,
        detail: `${host.label}: local bundle provenance refused — ${admittedLocalApp.left.message}`,
        code: "validation" as const,
        message: admittedLocalApp.left.message,
        stages,
        disposition: "not-started" as const,
      };
    }
    const localApp = admittedLocalApp.right;
    push(
      stages,
      `local bundle admitted id=${admittedLocalApp.right.bundleIdentifier} team=${admittedLocalApp.right.teamIdentifier}`,
    );
    for (const stage of target.progress) push(stages, stage);

    const homeResult = yield* ssh
      .run(homeDirectoryLookup(target.endpoint))
      .pipe(Effect.either);
    if (homeResult._tag === "Left") {
      return {
        ok: false,
        detail: `${host.label}: remote home lookup failed`,
        code: "io" as const,
        stages,
        disposition: "not-started" as const,
      };
    }
    const home = decodeRemoteHomeDirectoryOutput(homeResult.right.stdout);
    if (home === null) {
      return {
        ok: false,
        detail: `${host.label}: remote home is not a canonical absolute path`,
        code: "io" as const,
        stages,
        disposition: "not-started" as const,
      };
    }
    push(stages, `remote home ${home}`);

    const streamed = yield* streamAppToRemote(ssh, target.endpoint, {
      localApp,
      remoteHome: home,
    }).pipe(Effect.either);

    if (streamed._tag === "Left") {
      const disposition = classifyDeployTransferDisposition(streamed.left);
      return {
        ok: false,
        detail: `${host.label}: ${describeDeployTransferFailure(streamed.left)}`,
        code: "io" as const,
        message: describeDeployTransferFailure(streamed.left),
        stages,
        disposition,
        version: localApp.version,
      };
    }
    push(stages, streamed.right.detail);
    if (!streamed.right.ok) {
      return {
        ok: false,
        detail: `${host.label}: ${streamed.right.detail}`,
        code: "io" as const,
        message: streamed.right.detail,
        stages,
        disposition: "indeterminate" as const,
        version: localApp.version,
      };
    }

    const tokenPath = join(home, ".vellum", "term", "token");
    const tokenCmd = yield* makeRemoteCommand("/bin/test", [
      "-f",
      tokenPath,
    ]).pipe(Effect.either);
    if (tokenCmd._tag === "Right") {
      const tokenProbe = yield* ssh
        .run(oneShot(target.endpoint, tokenCmd.right, { budget: "short" }))
        .pipe(Effect.either);
      if (tokenProbe._tag === "Right")
        push(stages, "term control token present");
      else push(stages, "term control token not yet visible");
    }

    return {
      ok: true,
      detail: `${host.label} (${host.endpoint}): ${streamed.right.detail}`,
      stages,
      disposition: "ready",
      version: localApp.version,
    } satisfies DeployRemoteResult;
  });

export const darwinRemoteDeploymentProvider: RemoteDeploymentProvider = {
  platform: "darwin",
  deploy: (input) =>
    deployDarwinRemote(input).pipe(
      Effect.map((result) => ({
        result,
        targetPlatform: "darwin" as const,
        ...(result.version
          ? {
              artifact: {
                identity: PRODUCT_NAME,
                version: result.version,
                source: "command-center" as const,
              },
            }
          : {}),
        stationConfiguration: input.stationConfiguration,
        authorizationRequirement: "none" as const,
        readiness: readinessFromDisposition(result.disposition),
        rollback: rollbackFromDisposition(result.disposition),
      })),
    ),
};
