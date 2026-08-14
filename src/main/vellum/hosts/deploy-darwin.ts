/**
 * Darwin deployment provider: install/update Vellum Command.app over SSH and start it.
 * HostRuntime owns observe → gap → act. This file is the Darwin package glue.
 */

import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  createReadStream,
  existsSync,
} from "node:fs";
import {
  access,
  lstat,
  mkdtemp,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Effect, Stream } from "effect";
import { controlSocketPath as browserControlSocketPath } from "@shared/browser-control";
import {
  DARWIN_REMOTE_DEPLOY_DISABLED_DETAIL,
  RELEASE_CAPABILITIES,
} from "@shared/release-capabilities";
import { REMOTE_UPDATE_IDLE_PRODUCT_COPY } from "@shared/remote-update-status";
import { stationControlDir, stationControlSocketPath } from "@shared/station-ssh-control";
import { TERM_REMOTE_SOCK_REL } from "@shared/term-control";
import { formatSshFailure } from "../ssh/format";
import { SshExitError, type SshError, type SshTarget } from "../ssh/domain";
import { deploymentStream, homeDirectoryLookup, oneShot } from "../ssh/program";
import {
  DARWIN_PACKAGED_BROWSER_EXECUTABLE,
  DARWIN_PACKAGED_STATION_EXECUTABLE,
  remoteDarwinPackageExists,
  remoteTestSocketExists,
} from "../ssh/read-commands";
import {
  compileDarwinRemoteActivationScript,
  compileDarwinRemoteDeployScript,
} from "../ssh/remote-plan";
import {
  SshTransferExitError,
  type SshTransportShape,
} from "../ssh/service";
import {
  appProcessPlane,
  type AppChildIo,
} from "../app-process-plane";
import { runProcess } from "../../services/process";
import {
  type DeployRemoteResult,
  type RemoteDeploymentProvider,
  type RemoteDeploymentProviderInput,
  type RemoteDeploymentTarget,
} from "./remote-deployment";
import {
  decodeRemoteHomeDirectoryOutput,
  isSafeRemoteHomePath,
} from "./remote-home";

const PRODUCT_NAME = "Vellum Command";
const APP_BUNDLE_NAME = `${PRODUCT_NAME}.app`;
const LABEL = "skastr0.vellumcommand";
const TEAM_IDENTIFIER = "EXAMP12345";
const SIGNING_AUTHORITY =
  "Developer ID Application: Example Maintainer (EXAMP12345)";
const DEVELOPER_ID_REQUIREMENT =
  '=anchor apple generic and identifier "skastr0.vellumcommand" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "EXAMP12345"';
const DEPLOY_TIMEOUT_MS = 20 * 60 * 1000;
const REMOTE_APP_PATH = `/Applications/${APP_BUNDLE_NAME}`;
const REMOTE_CLI_EXECUTABLE =
  `${REMOTE_APP_PATH}/Contents/Resources/bin/vellum-command`;
const DARWIN_DEPLOY_READY_WITH_LOCK_WARNING_EXIT = 10;
const DARWIN_DEPLOY_NOT_STARTED_EXIT = 12;
const DARWIN_DEPLOY_INDETERMINATE_EXIT = 13;

if (
  REMOTE_CLI_EXECUTABLE !== DARWIN_PACKAGED_STATION_EXECUTABLE ||
  REMOTE_CLI_EXECUTABLE !== DARWIN_PACKAGED_BROWSER_EXECUTABLE
) {
  throw new Error("Darwin deployment and packaged CLI paths diverged");
}

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

/**
 * Artifact input for Darwin Remote deploy.
 * - `live-app` packages the admitted .app directory (running CC / local release).
 * - `release-zip` is the final shippable ZIP (Cloudflare feed / notarized artifact).
 */
export type DarwinDeployArtifactInput =
  | {
      readonly kind: "live-app";
      readonly appPath?: string;
    }
  | {
      readonly kind: "release-zip";
      readonly zipPath: string;
      /** Expected SHA-256 of the ZIP bytes (lowercase hex). */
      readonly sha256: string;
      /** Optional version pin cross-checked after local admission. */
      readonly version?: string;
    };

export type DarwinDeployArtifactAdmission = {
  readonly kind: "live-app" | "release-zip";
  readonly localApp: LocalBundleProvenanceReceipt;
  /** Present when the transfer streams a release ZIP for remote expansion. */
  readonly archive?: {
    readonly zipPath: string;
    readonly sha256: string;
  };
  /** Dispose staging directories (expanded ZIP). */
  readonly dispose: () => Promise<void>;
};

export type DarwinRemoteArtifactAuthority = {
  readonly resolve: () => Promise<DarwinDeployArtifactAdmission>;
};

export type DarwinRemoteLiveWorkEvidence = {
  readonly activeTerminalSessions: number;
  readonly observationId: string;
};

export type DarwinRemoteLiveWorkAdmission =
  | {
      readonly acquired: true;
      readonly evidence: DarwinRemoteLiveWorkEvidence & {
        readonly activeTerminalSessions: 0;
      };
      readonly release: Effect.Effect<void, never>;
    }
  | {
      readonly acquired: false;
      readonly reason:
        | "active-terminal-sessions"
        | "maintenance-held"
        | "shutting-down";
      readonly evidence: DarwinRemoteLiveWorkEvidence;
    };

export type DarwinRemoteLiveWorkAuthority = {
  readonly acquire: (
    input: RemoteDeploymentProviderInput,
  ) => Effect.Effect<DarwinRemoteLiveWorkAdmission, Error>;
};

const SHA256_HEX = /^[0-9a-f]{64}$/u;

export {
  decodeRemoteHomeDirectoryOutput,
  isSafeRemoteHomePath,
} from "./remote-home";

/** Pure path/shape checks for a release ZIP artifact (no I/O). */
export const validateReleaseZipArtifactInput = (input: {
  readonly zipPath: string;
  readonly sha256: string;
  readonly version?: string;
}): { readonly zipPath: string; readonly sha256: string; readonly version?: string } => {
  const zipPath = input.zipPath.trim();
  if (!zipPath.startsWith("/") || zipPath.includes("\0")) {
    throw new Error("release ZIP path must be an absolute path");
  }
  if (!zipPath.toLowerCase().endsWith(".zip")) {
    throw new Error("release ZIP path must end in .zip");
  }
  const sha256 = input.sha256.trim().toLowerCase();
  if (!SHA256_HEX.test(sha256)) {
    throw new Error("release ZIP sha256 must be 64 lowercase hex characters");
  }
  const version = input.version?.trim();
  if (version !== undefined && version.length === 0) {
    throw new Error("release ZIP version pin must be non-empty when provided");
  }
  return {
    zipPath,
    sha256,
    ...(version !== undefined ? { version } : {}),
  };
};

export const hashFileSha256Hex = async (path: string): Promise<string> =>
  new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => {
      hash.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => {
      resolveHash(hash.digest("hex"));
    });
  });

/**
 * Admit a notarized release ZIP: digest match, native expand (`ditto`), then
 * local Developer ID / bundle / team provenance. Remote re-expands the same
 * ZIP and re-verifies signature + archive digest before generation swap.
 */
export const admitReleaseZipArtifact = async (
  input: Extract<DarwinDeployArtifactInput, { readonly kind: "release-zip" }>,
): Promise<DarwinDeployArtifactAdmission> => {
  const validated = validateReleaseZipArtifactInput(input);
  const requestedAbsolute = resolve(validated.zipPath);
  const canonicalZip = await realpath(requestedAbsolute);
  if (canonicalZip !== requestedAbsolute) {
    throw new Error("release ZIP may not be a symlink or path alias");
  }
  const meta = await lstat(canonicalZip);
  if (!meta.isFile() || meta.isSymbolicLink()) {
    throw new Error("release ZIP must be a regular file");
  }
  if (meta.size <= 0) {
    throw new Error("release ZIP is empty");
  }

  const digest = await hashFileSha256Hex(canonicalZip);
  if (digest !== validated.sha256) {
    throw new Error("release ZIP digest does not match expected sha256");
  }

  const stageRoot = await mkdtemp(join(tmpdir(), "vellum-command-darwin-release-zip-"));
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    await rm(stageRoot, { recursive: true, force: true });
  };

  try {
    const expand = await runProcess(
      "/usr/bin/ditto",
      ["-x", "-k", canonicalZip, stageRoot],
      { timeoutMs: 10 * 60 * 1000, maxOutputBytes: 64 * 1024 },
    );
    if (expand.code !== 0) {
      throw new Error(
        `ditto failed to expand release ZIP${expand.stderr ? `: ${expand.stderr.slice(0, 500)}` : ""}`,
      );
    }
    const appPath = join(stageRoot, APP_BUNDLE_NAME);
    if (!existsSync(join(appPath, "Contents", "MacOS", PRODUCT_NAME))) {
      throw new Error(
        `release ZIP must contain ${APP_BUNDLE_NAME} at archive root`,
      );
    }
    const localApp = await admitLocalAppBundle(appPath);
    if (
      validated.version !== undefined &&
      localApp.version !== validated.version
    ) {
      throw new Error(
        `release ZIP version ${localApp.version} does not match pin ${validated.version}`,
      );
    }
    return Object.freeze({
      kind: "release-zip" as const,
      localApp,
      archive: Object.freeze({
        zipPath: canonicalZip,
        sha256: validated.sha256,
      }),
      dispose,
    });
  } catch (error) {
    await dispose();
    throw error;
  }
};

export const admitLiveAppArtifact = async (
  appPath?: string,
): Promise<DarwinDeployArtifactAdmission> => {
  const resolved = appPath?.trim() || resolveLocalAppBundle();
  if (!resolved) {
    throw new Error(
      "no local Vellum Command.app found — package/install on Command Center first (/Applications or release/mac-arm64)",
    );
  }
  const localApp = await admitLocalAppBundle(resolved);
  return Object.freeze({
    kind: "live-app" as const,
    localApp,
    dispose: async () => undefined,
  });
};

/** Resolve and admit either live-app or release-zip artifact input. */
export const admitDarwinDeployArtifact = async (
  input: DarwinDeployArtifactInput,
): Promise<DarwinDeployArtifactAdmission> => {
  if (input.kind === "release-zip") {
    return admitReleaseZipArtifact(input);
  }
  return admitLiveAppArtifact(input.appPath);
};

/**
 * Production artifact source: explicit env release ZIP (feed download path)
 * else live local .app. Env is a test/operator seam; fleet feed download
 * will mint the same release-zip input shape.
 */
export const resolveProductionDarwinArtifactInput =
  (): DarwinDeployArtifactInput => {
    const zipPath = process.env.VELLUM_COMMAND_REMOTE_RELEASE_ZIP?.trim();
    const sha256 = process.env.VELLUM_COMMAND_REMOTE_RELEASE_ZIP_SHA256?.trim();
    if (zipPath && sha256) {
      return { kind: "release-zip", zipPath, sha256 };
    }
    return { kind: "live-app" };
  };

export const makeProductionDarwinArtifactAuthority = (
  resolveInput: () => DarwinDeployArtifactInput = resolveProductionDarwinArtifactInput,
): DarwinRemoteArtifactAuthority =>
  Object.freeze({
    resolve: () => admitDarwinDeployArtifact(resolveInput()),
  });

/**
 * Terminal-session idle gate for Darwin Remote package activation.
 * Existing installations only: first install has no Remote terminal plane to
 * quiesce, while updates must prove zero active sessions before replacement.
 */
const describeLiveWorkAcquireFailure = (error: unknown): string => {
  if (error !== null && typeof error === "object" && "_tag" in error) {
    return formatSshFailure(error as SshError);
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "terminal route maintenance failed";
};

export const makeProductionDarwinLiveWorkAuthority =
  (): DarwinRemoteLiveWorkAuthority =>
    Object.freeze({
      acquire: (providerInput) =>
        Effect.tryPromise({
          try: async () => {
            const { termPlane } = await import("../term/plane");
            const admission =
              await termPlane.router.acquireRemoteHostMaintenance(
                providerInput.target.host.id,
              );
            if (!admission.acquired) {
              const reason = {
                active_sessions: "active-terminal-sessions",
                maintenance_held: "maintenance-held",
                shutting_down: "shutting-down",
              } as const;
              return {
                acquired: false as const,
                reason: reason[admission.reason],
                evidence: admission.evidence,
              };
            }
            return {
              acquired: true as const,
              evidence: admission.evidence,
              release: Effect.sync(() => {
                admission.lease.release();
              }),
            };
          },
          catch: (error) => new Error(describeLiveWorkAcquireFailure(error)),
        }),
    });

/**
 * Map live-work refusal into DeployRemoteResult.
 * Fleet status: `mapIdleGateToUpdateStatus` / `waitingForIdleUpdateStatus`
 * (shared) — never force-close active Remote terminals.
 */
export const darwinLiveWorkRefusalResult = (input: {
  readonly hostLabel: string;
  readonly stages: readonly string[];
  readonly version?: string;
  readonly refusal: Extract<
    DarwinRemoteLiveWorkAdmission,
    { readonly acquired: false }
  >;
}): DeployRemoteResult => {
  if (input.refusal.reason === "active-terminal-sessions") {
    return {
      ok: false,
      detail:
        `${input.hostLabel}: package activation deferred — ` +
        `${input.refusal.evidence.activeTerminalSessions} Vellum Command terminal session(s) active. ` +
        REMOTE_UPDATE_IDLE_PRODUCT_COPY,
      code: "conflict",
      message: REMOTE_UPDATE_IDLE_PRODUCT_COPY,
      stages: [...input.stages],
      disposition: "not-started",
      ...(input.version !== undefined ? { version: input.version } : {}),
      recoveryAction: {
        kind: "close-active-vellum-terminals",
        activeTerminalSessions: input.refusal.evidence.activeTerminalSessions,
      },
    };
  }
  return {
    ok: false,
    detail:
      input.refusal.reason === "maintenance-held"
        ? `${input.hostLabel}: another package activation holds the Remote terminal route cut`
        : `${input.hostLabel}: the Remote terminal plane is shutting down`,
    code: "conflict",
    stages: [...input.stages],
    disposition: "not-started",
    ...(input.version !== undefined ? { version: input.version } : {}),
  };
};


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
    throw new Error("local bundle identifier does not match Vellum Command");
  }
  if (input.bundleExecutable.trim() !== PRODUCT_NAME) {
    throw new Error("local bundle executable identity does not match Vellum Command");
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
    throw new Error("code signature identifier does not match Vellum Command");
  }
  if (
    singleCodesignValue(input.codesignMetadata, "TeamIdentifier") !==
    TEAM_IDENTIFIER
  ) {
    throw new Error("code signature team does not match Vellum Command");
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
    throw new Error("code signature authority does not match Vellum Command policy");
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
  const cliExecutablePath = join(
    canonicalPath,
    "Contents",
    "Resources",
    "bin",
    basename(REMOTE_CLI_EXECUTABLE),
  );
  const [
    plistMetadata,
    executableMetadata,
    cliExecutableMetadata,
  ] = await Promise.all([
    lstat(infoPlistPath),
    lstat(executablePath),
    lstat(cliExecutablePath),
  ]);
  if (
    !plistMetadata.isFile() ||
    plistMetadata.isSymbolicLink() ||
    !executableMetadata.isFile() ||
    executableMetadata.isSymbolicLink() ||
    !cliExecutableMetadata.isFile() ||
    cliExecutableMetadata.isSymbolicLink()
  ) {
    throw new Error(
      "local bundle identity and packaged CLI must be regular files",
    );
  }
  await Promise.all([
    access(executablePath, fsConstants.X_OK),
    access(cliExecutablePath, fsConstants.X_OK),
  ]);

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

type Ssh = SshTransportShape;

const push = (stages: string[], line: string): void => {
  stages.push(line);
  console.info(`[deploy-remote] ${line}`);
};

/** Resolve the local .app bundle Command Center will push. */
export const resolveLocalAppBundle = (): string | null => {
  const env = process.env.VELLUM_COMMAND_APP_SRC?.trim();
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

export type DeployTransferParse =
  | {
      readonly ok: true;
      readonly phase: "enrollment" | "runtime";
      readonly detail: string;
    }
  | {
      readonly ok: false;
      readonly detail: string;
    };

/**
 * Read install stdout after SSH already exited 0.
 * Exit 0 is not enough: ENROLLMENT_READY or STATION_READY must be present.
 * ENROLLMENT_PARTIAL and empty stdout are not a finished install.
 */
export const parseDeployTransferResult = (input: {
  readonly stdout: string;
  readonly stderr: string;
}): DeployTransferParse => {
  if (
    /^ENROLLMENT_READY pid=[1-9][0-9]* station=1$/mu.test(input.stdout)
  ) {
    return {
      ok: true,
      phase: "enrollment",
      detail: "Vellum Command is installed and waiting to join the fleet",
    };
  }
  if (/^STATION_READY pid=[1-9][0-9]* term=1 browser=1$/mu.test(input.stdout)) {
    return {
      ok: true,
      phase: "runtime",
      detail: "Vellum Command is running on this Mac",
    };
  }
  const diagnostic = input.stderr.trim() || input.stdout.trim();
  return {
    ok: false,
    detail:
      diagnostic.slice(0, 900) ||
      "Vellum Command install did not prove enrollment or runtime readiness",
  };
};

export const parseRuntimeActivateResult = (input: {
  readonly stdout: string;
  readonly stderr: string;
}): { readonly ok: boolean; readonly detail: string } => {
  if (/^STATION_READY pid=[1-9][0-9]* term=1 browser=1$/mu.test(input.stdout)) {
    return {
      ok: true,
      detail: "Vellum Command is running on this Mac",
    };
  }
  const diagnostic = input.stderr.trim() || input.stdout.trim();
  return {
    ok: false,
    detail:
      diagnostic.slice(0, 900) ||
      "Vellum Command did not prove it is running on this Mac",
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

const lastDeployScriptTag = (text: string): string | undefined => {
  const tags = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^[A-Z][A-Z0-9_]{3,}/u.test(line));
  return tags.length === 0 ? undefined : tags[tags.length - 1];
};

export const describeDeployTransferFailure = (error: unknown): string => {
  if (error instanceof SshTransferExitError) {
    const diagnostic = (error.stderr || error.stdout).trim();
    if (diagnostic.includes("REMOTE_NOT_DARWIN")) {
      return "remote host is not macOS — full-app Deploy Remote is Darwin-only (Linux Electron station is a separate track)";
    }
    const tagged = lastDeployScriptTag(diagnostic);
    if (tagged !== undefined) return tagged.slice(0, 900);
    return diagnostic.slice(0, 900) || error.message;
  }
  return error instanceof Error ? error.message : String(error);
};

export const classifyDeployTransferDisposition = (
  error: unknown,
): DeployRemoteResult["disposition"] => {
  if (!(error instanceof SshTransferExitError)) return "indeterminate";
  if (error.code === DARWIN_DEPLOY_READY_WITH_LOCK_WARNING_EXIT) return "ready";
  if (error.code === DARWIN_DEPLOY_NOT_STARTED_EXIT || error.code === 3)
    return "not-started";
  return "indeterminate";
};

type RemoteDeployScriptCommands = {
  readonly uname: string;
  readonly id: string;
  readonly env: string;
  readonly launchctl: string;
  readonly lsof: string;
  readonly uuidgen: string;
  readonly tar: string;
  readonly ditto: string;
  readonly shasum: string;
  readonly codesign: string;
  readonly find: string;
  readonly plutil: string;
  readonly stat: string;
  readonly osascript: string;
  readonly sleep: string;
};

/** Transfer encoding: app-directory tar (live-app) or notarized release ZIP. */
export type DarwinRemoteArtifactTransfer =
  | {
      readonly kind: "app-tar";
      readonly expectedPackageState: "absent" | "present";
    }
  | {
      readonly kind: "release-zip";
      readonly expectedArchiveSha256: string;
      readonly expectedPackageState: "absent" | "present";
    };

/** Compile first-install vs restart. Station applied is present even if the package is gone. */
export const compileExpectedPackageState = (
  observed: "absent" | "present" | "unknown",
  compiled?: "absent" | "present",
): "absent" | "present" =>
  compiled ?? (observed === "absent" ? "absent" : "present");

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
    env: "/usr/bin/env",
    launchctl: "/bin/launchctl",
    lsof: "/usr/sbin/lsof",
    uuidgen: "/usr/bin/uuidgen",
    tar: "/usr/bin/tar",
    ditto: "/usr/bin/ditto",
    shasum: "/usr/bin/shasum",
    codesign: "/usr/bin/codesign",
    find: "/usr/bin/find",
    plutil: "/usr/bin/plutil",
    stat: "/usr/bin/stat",
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
  transfer: DarwinRemoteArtifactTransfer,
): string => {
  if (!isSafeRemoteHomePath(remoteHome)) {
    throw new Error("remote home must be a canonical absolute path");
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(expectedCdHash)) {
    throw new Error("expected code-directory hash is invalid");
  }
  if (
    transfer.kind === "release-zip" &&
    !SHA256_HEX.test(transfer.expectedArchiveSha256)
  ) {
    throw new Error("expected release ZIP sha256 is invalid");
  }
  const remoteAppPath = runtime.appPath;
  const remoteExecutablePath = `${remoteAppPath}/Contents/MacOS/${PRODUCT_NAME}`;
  const remoteCliExecutablePath =
    `${remoteAppPath}/Contents/Resources/bin/vellum-command`;
  const appParentPath = dirname(remoteAppPath);
  const plistPath = `${remoteHome}/Library/LaunchAgents/${LABEL}.plist`;
  const logDir = `${remoteHome}/Library/Logs/${PRODUCT_NAME}`;
  const termSock = `${remoteHome}/${TERM_REMOTE_SOCK_REL}`;
  const browserSock = browserControlSocketPath(remoteHome);
  const stationSock = stationControlSocketPath(stationControlDir(remoteHome));
  const incomingPath = `${remoteAppPath}.incoming`;
  // Hermetic tests stub `sleep` to return immediately, so full production poll
  // budgets only add subprocess churn and can exceed the outer spawn timeout
  // under suite contention. Keep production unchanged; shorten test-only loops.
  const waitLimits =
    "testOnly" in runtime
      ? {
          generationGone: 3,
          executableGone: 3,
          generationProof: 3,
          socketReady: 6,
        }
      : {
          generationGone: 30,
          executableGone: 30,
          generationProof: 30,
          socketReady: 60,
        };
  // Keep the production script's fixed bounds visible to the source-contract
  // tests while allowing hermetic test runtimes to use their shorter limits.
  const generationGoneLimit = String(waitLimits.generationGone);
  const executableGoneLimit = String(waitLimits.executableGone);
  const generationProofLimit = String(waitLimits.generationProof);
  const socketReadyLimit = String(waitLimits.socketReady);

  // First install only: --vellum-headless so an unconfigured package never
  // hits the Command Center license gate. Update stays Remote — redeploy
  // is not unenroll. expectedPackageState is that compile decision, not
  // raw disk presence (enrolled missing .app stays present).
  const firstInstall = transfer.expectedPackageState === "absent";
  const enrollmentFlag = firstInstall ? "--vellum-headless" : "";
  const programArguments = firstInstall
    ? `<string>${xmlText(remoteExecutablePath)}</string>
<string>${xmlText("--vellum-headless")}</string>`
    : `<string>${xmlText(remoteExecutablePath)}</string>`;
  const plistBody = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array>
${programArguments}
</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ProcessType</key><string>Interactive</string>
<key>StandardOutPath</key><string>${xmlText(logDir)}/vellum-command.out.log</string>
<key>StandardErrorPath</key><string>${xmlText(logDir)}/vellum-command.err.log</string>
</dict></plist>
`;
  const plistB64 = Buffer.from(plistBody, "utf8").toString("base64");

  // Every interpolated path is a shell-safe literal. APP/IN/EXE are compile-
  // time product paths; remoteHome only scopes Vellum Command's own plist/log/sockets.
  return `
set -euo pipefail
umask 022
UNAME=${shellLiteral(runtime.commands.uname)}
ID=${shellLiteral(runtime.commands.id)}
ENV=${shellLiteral(runtime.commands.env)}
LAUNCHCTL=${shellLiteral(runtime.commands.launchctl)}
LSOF=${shellLiteral(runtime.commands.lsof)}
UUIDGEN=${shellLiteral(runtime.commands.uuidgen)}
TAR=${shellLiteral(runtime.commands.tar)}
DITTO=${shellLiteral(runtime.commands.ditto)}
SHASUM=${shellLiteral(runtime.commands.shasum)}
CODESIGN=${shellLiteral(runtime.commands.codesign)}
FIND=${shellLiteral(runtime.commands.find)}
PLUTIL=${shellLiteral(runtime.commands.plutil)}
STAT=${shellLiteral(runtime.commands.stat)}
OSASCRIPT=${shellLiteral(runtime.commands.osascript)}
SLEEP=${shellLiteral(runtime.commands.sleep)}
test "$("$UNAME" -s)" = "Darwin" || { echo "REMOTE_NOT_DARWIN $("$UNAME" -s)" >&2; exit 3; }
APP=${shellLiteral(remoteAppPath)}
IN=${shellLiteral(incomingPath)}
BUNDLE=${shellLiteral(APP_BUNDLE_NAME)}
EXE=${shellLiteral(remoteExecutablePath)}
IN_EXE=${shellLiteral(`${incomingPath}/${APP_BUNDLE_NAME}/Contents/MacOS/${PRODUCT_NAME}`)}
CLI_EXE=${shellLiteral(remoteCliExecutablePath)}
IN_CLI_EXE=${shellLiteral(`${incomingPath}/${APP_BUNDLE_NAME}/Contents/Resources/bin/vellum-command`)}
TERM_SOCK=${shellLiteral(termSock)}
BROWSER_SOCK=${shellLiteral(browserSock)}
STATION_SOCK=${shellLiteral(stationSock)}
ENROLLMENT_FLAG=${shellLiteral(enrollmentFlag)}
PLIST=${shellLiteral(plistPath)}
PLIST_IN=${shellLiteral(`${plistPath}.incoming`)}
FORBIDDEN_PLIST_PREVIOUS=${shellLiteral(`${plistPath}.previous`)}
FORBIDDEN_PLIST_REJECTED=${shellLiteral(`${plistPath}.rejected`)}
LOGDIR=${shellLiteral(logDir)}
APP_PARENT=${shellLiteral(appParentPath)}
FORBIDDEN_APP_PREVIOUS=${shellLiteral(`${remoteAppPath}.previous`)}
FORBIDDEN_APP_REJECTED=${shellLiteral(`${remoteAppPath}.rejected`)}
DEPLOY_LOCK=${shellLiteral(runtime.lockPath)}
DEPLOY_LOCK_OWNER=${shellLiteral(`${runtime.lockPath}/owner`)}
DEPLOY_LOCK_HOLDER=${shellLiteral(`${runtime.lockPath}/holder`)}
RETIRED_APP=${shellLiteral(`${runtime.lockPath}/retired-app`)}
RETIRED_PLIST=${shellLiteral(`${runtime.lockPath}/retired-plist`)}
RETIRED_TERM_SOCKET=${shellLiteral(`${runtime.lockPath}/retired-term-socket`)}
RETIRED_BROWSER_SOCKET=${shellLiteral(`${runtime.lockPath}/retired-browser-socket`)}
EXPECTED_CDHASH=${shellLiteral(expectedCdHash.toLowerCase())}
EXPECTED_PACKAGE_STATE=${shellLiteral(transfer.expectedPackageState)}
${
  transfer.kind === "release-zip"
    ? `ARTIFACT_KIND=release-zip
EXPECTED_ARCHIVE_SHA256=${shellLiteral(transfer.expectedArchiveSha256)}
ARCHIVE=${shellLiteral(`${incomingPath}.release.zip`)}
`
    : `ARTIFACT_KIND=app-tar
`
}
DEVELOPER_ID_REQUIREMENT=${shellLiteral(DEVELOPER_ID_REQUIREMENT)}
UID_VALUE="$("$ID" -u)"
DOMAIN="gui/$UID_VALUE"
JOB="$DOMAIN/${LABEL}"
LOCK_HELD=0
ACTIVATION_STARTED=0
IN_CREATED=0
PLIST_IN_CREATED=0
IN_ID=""
PLIST_IN_ID=""
APP_ID=""
APP_CONTENTS_ID=""
PLIST_ID=""
CANDIDATE_APP_ID=""
CANDIDATE_CONTENTS_ID=""
CANDIDATE_EXE_ID=""
PUBLISHED_APP_ID=""
PUBLISHED_PLIST_ID=""
RETIRED_APP_ID=""
LOCK_ID=""
LOCK_OWNER_ID=""
OLD_PID=""
OLD_JOB_WAS_LOADED=0
INCUMBENT_STOP_REQUESTED=0

valid_pid() {
  case "$1" in
    ""|*[!0-9]*) return 1 ;;
  esac
  [ "$1" -gt 1 ]
}

path_identity() {
  "$STAT" -f '%d:%i:%u:%HT' "$1"
}

owned_directory_identity() {
  OWNED_PATH="$1"
  [ -d "$OWNED_PATH" ] && [ ! -L "$OWNED_PATH" ] || return 1
  OWNED_IDENTITY="$(path_identity "$OWNED_PATH")" || return 1
  case "$OWNED_IDENTITY" in
    *:"$UID_VALUE":Directory) ;;
    *) return 1 ;;
  esac
  /usr/bin/printf '%s' "$OWNED_IDENTITY"
}

owned_file_identity() {
  OWNED_PATH="$1"
  [ -f "$OWNED_PATH" ] && [ ! -L "$OWNED_PATH" ] || return 1
  OWNED_IDENTITY="$(path_identity "$OWNED_PATH")" || return 1
  case "$OWNED_IDENTITY" in
    *:"$UID_VALUE":"Regular File") ;;
    *) return 1 ;;
  esac
  /usr/bin/printf '%s' "$OWNED_IDENTITY"
}

owned_socket_identity() {
  OWNED_PATH="$1"
  [ -S "$OWNED_PATH" ] && [ ! -L "$OWNED_PATH" ] || return 1
  OWNED_IDENTITY="$(path_identity "$OWNED_PATH")" || return 1
  case "$OWNED_IDENTITY" in
    *:"$UID_VALUE":Socket) ;;
    *) return 1 ;;
  esac
  /usr/bin/printf '%s' "$OWNED_IDENTITY"
}

same_directory_identity() {
  [ -n "$2" ] &&
    [ "$(owned_directory_identity "$1" 2>/dev/null || true)" = "$2" ]
}

same_file_identity() {
  [ -n "$2" ] &&
    [ "$(owned_file_identity "$1" 2>/dev/null || true)" = "$2" ]
}

same_socket_identity() {
  [ -n "$2" ] &&
    [ "$(owned_socket_identity "$1" 2>/dev/null || true)" = "$2" ]
}

remove_bound_directory() {
  REMOVE_PATH="$1"
  REMOVE_IDENTITY="$2"
  same_directory_identity "$REMOVE_PATH" "$REMOVE_IDENTITY" || return 1
  /bin/rm -rf -- "$REMOVE_PATH" || return 1
  [ ! -e "$REMOVE_PATH" ] && [ ! -L "$REMOVE_PATH" ]
}

remove_bound_file() {
  REMOVE_PATH="$1"
  REMOVE_IDENTITY="$2"
  same_file_identity "$REMOVE_PATH" "$REMOVE_IDENTITY" || return 1
  /bin/rm -f -- "$REMOVE_PATH" || return 1
  [ ! -e "$REMOVE_PATH" ] && [ ! -L "$REMOVE_PATH" ]
}

remove_bound_socket() {
  REMOVE_PATH="$1"
  REMOVE_IDENTITY="$2"
  same_socket_identity "$REMOVE_PATH" "$REMOVE_IDENTITY" || return 1
  /bin/rm -f -- "$REMOVE_PATH" || return 1
  [ ! -e "$REMOVE_PATH" ] && [ ! -L "$REMOVE_PATH" ]
}

bundle_has_only_contents() {
  BUNDLE_ROOT="$1"
  BUNDLE_ROOT_ENTRIES="$("$FIND" "$BUNDLE_ROOT" -mindepth 1 -maxdepth 1 -print)" || return 1
  [ "$BUNDLE_ROOT_ENTRIES" = "$BUNDLE_ROOT/Contents" ]
}

remove_bound_app_bundle() {
  REMOVE_APP_PATH="$1"
  REMOVE_APP_IDENTITY="$2"
  REMOVE_CONTENTS_IDENTITY="$3"
  same_directory_identity "$REMOVE_APP_PATH" "$REMOVE_APP_IDENTITY" &&
    bundle_has_only_contents "$REMOVE_APP_PATH" &&
    same_directory_identity "$REMOVE_APP_PATH/Contents" "$REMOVE_CONTENTS_IDENTITY" ||
    return 1
  /bin/rm -rf -- "$REMOVE_APP_PATH" || return 1
  [ ! -e "$REMOVE_APP_PATH" ] && [ ! -L "$REMOVE_APP_PATH" ]
}

admit_existing_app() {
  APP_ID="$(owned_directory_identity "$APP" 2>/dev/null || true)"
  [ -n "$APP_ID" ] || {
    echo "EXISTING_APP_NOT_OWNED $APP" >&2
    return 1
  }
  APP_CONTENTS_ID="$(owned_directory_identity "$APP/Contents" 2>/dev/null || true)"
  [ -n "$APP_CONTENTS_ID" ] || {
    echo "EXISTING_APP_CONTENTS_NOT_OWNED $APP/Contents" >&2
    return 1
  }
  [ -f "$APP/Contents/Info.plist" ] &&
    [ ! -L "$APP/Contents/Info.plist" ] &&
    [ -f "$EXE" ] &&
    [ ! -L "$EXE" ] &&
    [ -x "$EXE" ] || {
      echo "EXISTING_APP_IDENTITY_FILES_INVALID $APP" >&2
      return 1
    }
  "$CODESIGN" --verify --deep --strict --verbose=2 -R "$DEVELOPER_ID_REQUIREMENT" "$APP" || {
    echo "EXISTING_APP_SIGNATURE_INVALID $APP" >&2
    return 1
  }
  EXISTING_BUNDLE_ID="$("$PLUTIL" -extract CFBundleIdentifier raw -o - "$APP/Contents/Info.plist")" || return 1
  EXISTING_BUNDLE_EXE="$("$PLUTIL" -extract CFBundleExecutable raw -o - "$APP/Contents/Info.plist")" || return 1
  [ "$EXISTING_BUNDLE_ID" = "${LABEL}" ] &&
    [ "$EXISTING_BUNDLE_EXE" = "${PRODUCT_NAME}" ] || {
      echo "EXISTING_APP_PRODUCT_IDENTITY_MISMATCH $APP" >&2
      return 1
    }
  bundle_has_only_contents "$APP" || {
    echo "EXISTING_APP_ROOT_SHAPE_INVALID $APP" >&2
    return 1
  }
  same_directory_identity "$APP" "$APP_ID" || {
    echo "EXISTING_APP_CHANGED_DURING_ADMISSION $APP" >&2
    return 1
  }
  same_directory_identity "$APP/Contents" "$APP_CONTENTS_ID" || {
    echo "EXISTING_APP_CONTENTS_CHANGED_DURING_ADMISSION $APP/Contents" >&2
    return 1
  }
}

# Admit product LaunchAgent: exe only, or exe + exact enrollment flag.
# No other argv shapes (no third arg, no non-enrollment second arg).
admit_plist_program_arguments() {
  local plist_path="$1"
  local label_value exe_value arg1_value
  label_value="$("$PLUTIL" -extract Label raw -o - "$plist_path")" || return 1
  exe_value="$("$PLUTIL" -extract ProgramArguments.0 raw -o - "$plist_path")" || return 1
  [ "$label_value" = "${LABEL}" ] && [ "$exe_value" = "$EXE" ] || return 1
  if "$PLUTIL" -extract ProgramArguments.2 raw -o - "$plist_path" >/dev/null 2>&1; then
    return 1
  fi
  if arg1_value="$("$PLUTIL" -extract ProgramArguments.1 raw -o - "$plist_path" 2>/dev/null)"; then
    [ "$arg1_value" = "$ENROLLMENT_FLAG" ] || return 1
  fi
  return 0
}

admit_existing_plist() {
  PLIST_ID="$(owned_file_identity "$PLIST" 2>/dev/null || true)"
  [ -n "$PLIST_ID" ] || {
    echo "EXISTING_PLIST_NOT_OWNED $PLIST" >&2
    return 1
  }
  admit_plist_program_arguments "$PLIST" || {
    echo "EXISTING_PLIST_PRODUCT_IDENTITY_MISMATCH $PLIST" >&2
    return 1
  }
  same_file_identity "$PLIST" "$PLIST_ID" || {
    echo "EXISTING_PLIST_CHANGED_DURING_ADMISSION $PLIST" >&2
    return 1
  }
}

job_exists() {
  "$LAUNCHCTL" print "$JOB" >/dev/null 2>&1
}

exact_path_pids() {
  OBSERVED_EXECUTABLE="$1"
  ALL_LSOF_OUTPUT="$("$LSOF" -n -d txt -Fp -Fn 2>&1)" || return 2
  printf '%s\n' "$ALL_LSOF_OUTPUT" | /usr/bin/awk -v exe="$OBSERVED_EXECUTABLE" '
    /^$/ { next }
    /^p[0-9]+$/ { pid = substr($0, 2); next }
    /^ftxt$/ { next }
    /^n/ {
      name = substr($0, 2)
      if ((name == exe || name == exe " (deleted)") && !seen[pid]++) print pid
      next
    }
    { invalid = 1 }
    END { if (invalid) exit 2 }
  '
}

exact_exe_pids() {
  exact_path_pids "$EXE"
}

exact_path_has_pid() {
  OBSERVED_PID="$1"
  OBSERVED_EXECUTABLE="$2"
  PID_LSOF_OUTPUT="$("$LSOF" -n -a -p "$OBSERVED_PID" -d txt -Fn 2>&1)" || return 1
  printf '%s\n' "$PID_LSOF_OUTPUT" | /usr/bin/awk -v exe="$OBSERVED_EXECUTABLE" '
    /^$/ { next }
    /^p[0-9]+$/ { next }
    /^ftxt$/ { next }
    /^n/ {
      name = substr($0, 2)
      if (name == exe || name == exe " (deleted)") found = 1
      next
    }
    { invalid = 1 }
    END { exit(found && !invalid ? 0 : 1) }
  '
}

exact_exe_has_pid() {
  exact_path_has_pid "$1" "$EXE"
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

retire_stale_socket() {
  SOCKET_PATH="$1"
  RETIRED_SOCKET_PATH="$2"
  if [ ! -e "$SOCKET_PATH" ] && [ ! -L "$SOCKET_PATH" ]; then return 0; fi
  SOCKET_ID="$(owned_socket_identity "$SOCKET_PATH" 2>/dev/null || true)"
  [ -n "$SOCKET_ID" ] || {
    echo "CONTROL_PATH_NOT_OWNED_SOCKET $SOCKET_PATH" >&2
    return 1
  }
  if SOCKET_LSOF_OUTPUT="$("$LSOF" -n -a -U -Fp -- "$SOCKET_PATH" 2>&1)"; then
    SOCKET_LSOF_STATUS=0
  else
    SOCKET_LSOF_STATUS=$?
  fi
  case "$SOCKET_LSOF_STATUS" in
    0|1) ;;
    *)
      echo "CONTROL_SOCKET_OBSERVATION_FAILED $SOCKET_PATH" >&2
      return 1
      ;;
  esac
  if /usr/bin/printf '%s\n' "$SOCKET_LSOF_OUTPUT" | /usr/bin/grep -E -q '^p[1-9][0-9]*$'; then
    echo "CONTROL_SOCKET_STILL_LIVE $SOCKET_PATH" >&2
    return 1
  fi
  if [ -n "$SOCKET_LSOF_OUTPUT" ]; then
    echo "CONTROL_SOCKET_OBSERVATION_AMBIGUOUS $SOCKET_PATH" >&2
    return 1
  fi
  same_socket_identity "$SOCKET_PATH" "$SOCKET_ID" || {
    echo "CONTROL_SOCKET_CHANGED_BEFORE_RETIREMENT $SOCKET_PATH" >&2
    return 1
  }
  [ ! -e "$RETIRED_SOCKET_PATH" ] && [ ! -L "$RETIRED_SOCKET_PATH" ] || return 1
  /bin/mv -n "$SOCKET_PATH" "$RETIRED_SOCKET_PATH"
  [ ! -e "$SOCKET_PATH" ] && [ ! -L "$SOCKET_PATH" ] || {
    echo "CONTROL_SOCKET_RETIREMENT_COLLISION $SOCKET_PATH" >&2
    return 1
  }
  same_socket_identity "$RETIRED_SOCKET_PATH" "$SOCKET_ID" || {
    echo "CONTROL_SOCKET_CHANGED_DURING_RETIREMENT $RETIRED_SOCKET_PATH" >&2
    return 1
  }
  remove_bound_socket "$RETIRED_SOCKET_PATH" "$SOCKET_ID" || {
    echo "CONTROL_SOCKET_RETIREMENT_FAILED $RETIRED_SOCKET_PATH" >&2
    return 1
  }
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

wait_until_executable_gone() {
  WAIT_EXECUTABLE="$1"
  WAIT_LIMIT="$2"
  WAIT_INDEX=0
  while [ "$WAIT_INDEX" -lt "$WAIT_LIMIT" ]; do
    OBSERVED_EXE_PIDS=""
    if ! OBSERVED_EXE_PIDS="$(exact_path_pids "$WAIT_EXECUTABLE")"; then
      echo "PROCESS_OBSERVATION_FAILED executable=$WAIT_EXECUTABLE" >&2
      return 2
    fi
    if [ -z "$OBSERVED_EXE_PIDS" ]; then return 0; fi
    WAIT_INDEX=$((WAIT_INDEX + 1))
    "$SLEEP" 1
  done
  return 1
}

resume_incumbent_before_activation() {
  if [ "$ACTIVATION_STARTED" = "1" ] ||
    [ "$OLD_JOB_WAS_LOADED" != "1" ] ||
    [ "$INCUMBENT_STOP_REQUESTED" != "1" ]; then
    return 0
  fi
  wait_until_executable_gone "$IN_EXE" ${executableGoneLimit} || {
    echo "CANDIDATE_PREFLIGHT_PROCESS_STILL_PRESENT $IN_EXE" >&2
    return 1
  }
  wait_until_job_and_executable_gone ${generationGoneLimit} || {
    echo "INCUMBENT_NOT_QUIESCENT_BEFORE_RESUME $EXE" >&2
    return 1
  }
  same_directory_identity "$APP" "$APP_ID" &&
    same_directory_identity "$APP/Contents" "$APP_CONTENTS_ID" &&
    same_file_identity "$PLIST" "$PLIST_ID" || {
      echo "INCUMBENT_CHANGED_BEFORE_RESUME app=$APP plist=$PLIST" >&2
      return 1
    }
  "$LAUNCHCTL" enable "$JOB" 2>/dev/null || true
  if ! "$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST" 2>/dev/null; then
    "$LAUNCHCTL" load -w "$PLIST" || {
      echo "INCUMBENT_RELOAD_FAILED $PLIST" >&2
      return 1
    }
  fi
  RESUMED_PID="$("$LAUNCHCTL" kickstart -p "$JOB")" || {
    echo "INCUMBENT_RESTART_PID_NOT_PROVEN" >&2
    return 1
  }
  valid_pid "$RESUMED_PID" || {
    echo "INCUMBENT_RESTART_PID_INVALID $RESUMED_PID" >&2
    return 1
  }
  RESUMED_IDENTITY_OK=0
  WAIT_INDEX=0
  while [ "$WAIT_INDEX" -lt ${generationProofLimit} ]; do
    if job_exists && exact_exe_has_pid "$RESUMED_PID"; then
      RESUMED_IDENTITY_OK=1
      break
    fi
    WAIT_INDEX=$((WAIT_INDEX + 1))
    "$SLEEP" 1
  done
  [ "$RESUMED_IDENTITY_OK" = "1" ] &&
    same_directory_identity "$APP" "$APP_ID" &&
    same_directory_identity "$APP/Contents" "$APP_CONTENTS_ID" &&
    same_file_identity "$PLIST" "$PLIST_ID" || {
      echo "INCUMBENT_RESTART_NOT_PROVEN pid=$RESUMED_PID" >&2
      return 1
    }
  INCUMBENT_STOP_REQUESTED=0
  echo "INCUMBENT_RESUMED pid=$RESUMED_PID"
}

reclaim_abandoned_deploy_lock() {
  [ -d "$DEPLOY_LOCK" ] || return 1
  for RETIRED_PATH in \
    "$RETIRED_APP" \
    "$RETIRED_PLIST" \
    "$RETIRED_TERM_SOCKET" \
    "$RETIRED_BROWSER_SOCKET"
  do
    if [ -e "$RETIRED_PATH" ] || [ -L "$RETIRED_PATH" ]; then
      return 1
    fi
  done
  HOLDER_PID="$(/bin/cat "$DEPLOY_LOCK_HOLDER" 2>/dev/null || true)"
  if [ -n "$HOLDER_PID" ]; then
    case "$HOLDER_PID" in
      ''|*[!0-9]*) return 1 ;;
    esac
    if /bin/ps -p "$HOLDER_PID" -o pid= >/dev/null 2>&1; then
      return 1
    fi
  fi
  /bin/rm -f -- "$DEPLOY_LOCK_OWNER" "$DEPLOY_LOCK_HOLDER" || return 1
  /bin/rmdir "$DEPLOY_LOCK" || return 1
  [ ! -e "$DEPLOY_LOCK" ] && [ ! -L "$DEPLOY_LOCK" ]
}

release_deploy_lock() {
  if [ "$LOCK_HELD" != "1" ]; then return 0; fi
  same_directory_identity "$DEPLOY_LOCK" "$LOCK_ID" || return 1
  CURRENT_LOCK_TOKEN="$(/bin/cat "$DEPLOY_LOCK_OWNER" 2>/dev/null || true)"
  [ -n "$CURRENT_LOCK_TOKEN" ] &&
    [ "$CURRENT_LOCK_TOKEN" = "$LOCK_TOKEN" ] || return 1
  same_file_identity "$DEPLOY_LOCK_OWNER" "$LOCK_OWNER_ID" || return 1
  [ ! -e "$RETIRED_APP" ] && [ ! -L "$RETIRED_APP" ] &&
    [ ! -e "$RETIRED_PLIST" ] && [ ! -L "$RETIRED_PLIST" ] &&
    [ ! -e "$RETIRED_TERM_SOCKET" ] && [ ! -L "$RETIRED_TERM_SOCKET" ] &&
    [ ! -e "$RETIRED_BROWSER_SOCKET" ] && [ ! -L "$RETIRED_BROWSER_SOCKET" ] || return 1
  /bin/rm -f -- "$DEPLOY_LOCK_HOLDER" || return 1
  remove_bound_file "$DEPLOY_LOCK_OWNER" "$LOCK_OWNER_ID" || return 1
  same_directory_identity "$DEPLOY_LOCK" "$LOCK_ID" || return 1
  /bin/rmdir "$DEPLOY_LOCK" || return 1
  [ ! -e "$DEPLOY_LOCK" ] && [ ! -L "$DEPLOY_LOCK" ] || return 1
  LOCK_HELD=0
  return 0
}

cleanup_staging() {
  if [ "$PLIST_IN_CREATED" = "1" ]; then
    if [ -e "$PLIST_IN" ] || [ -L "$PLIST_IN" ]; then
      remove_bound_file "$PLIST_IN" "$PLIST_IN_ID" || return 1
    fi
    PLIST_IN_CREATED=0
    PLIST_IN_ID=""
  fi
  if [ "$IN_CREATED" = "1" ]; then
    if [ -e "$IN" ] || [ -L "$IN" ]; then
      remove_bound_directory "$IN" "$IN_ID" || return 1
    fi
    IN_CREATED=0
    IN_ID=""
  fi
  return 0
}

begin_candidate_activation() {
  # Retiring an admitted old resource is the irreversible boundary. No code
  # after this point can restore or launch the old generation.
  ACTIVATION_STARTED=1
}

on_deploy_exit() {
  EXIT_CODE=$?
  trap - EXIT
  trap '' HUP INT TERM
  set +e
  if [ "$EXIT_CODE" -ne 0 ]; then
    if [ "$ACTIVATION_STARTED" = "1" ]; then
      echo "DEPLOY_FORWARD_REPAIR_REQUIRED app=$APP incoming=$IN plist=$PLIST" >&2
      EXIT_CODE=${String(DARWIN_DEPLOY_INDETERMINATE_EXIT)}
    elif ! resume_incumbent_before_activation; then
      echo "DEPLOY_INCUMBENT_RESUME_FAILED app=$APP plist=$PLIST" >&2
      EXIT_CODE=${String(DARWIN_DEPLOY_INDETERMINATE_EXIT)}
    elif ! cleanup_staging; then
      echo "DEPLOY_STAGING_CLEANUP_REFUSED incoming=$IN plist_incoming=$PLIST_IN" >&2
      EXIT_CODE=${String(DARWIN_DEPLOY_INDETERMINATE_EXIT)}
    else
      echo "DEPLOY_NOT_STARTED" >&2
      EXIT_CODE=${String(DARWIN_DEPLOY_NOT_STARTED_EXIT)}
    fi
  elif ! cleanup_staging; then
    echo "DEPLOY_STAGING_CLEANUP_REFUSED incoming=$IN plist_incoming=$PLIST_IN" >&2
    EXIT_CODE=${String(DARWIN_DEPLOY_INDETERMINATE_EXIT)}
  fi
  if ! release_deploy_lock; then
    echo "DEPLOY_LOCK_RELEASE_FAILED $DEPLOY_LOCK" >&2
    if [ "$EXIT_CODE" -eq 0 ]; then EXIT_CODE=${String(DARWIN_DEPLOY_READY_WITH_LOCK_WARNING_EXIT)}; fi
  fi
  exit "$EXIT_CODE"
}

[ -x "$LSOF" ] || { echo "PROCESS_OBSERVER_UNAVAILABLE" >&2; exit 3; }
LOCK_TOKEN="$("$UUIDGEN")"
test -n "$LOCK_TOKEN"
if ! /bin/mkdir "$DEPLOY_LOCK" 2>/dev/null; then
  if reclaim_abandoned_deploy_lock && /bin/mkdir "$DEPLOY_LOCK" 2>/dev/null; then
    echo "DEPLOY_STALE_LOCK_RECLAIMED $DEPLOY_LOCK" >&2
  else
    echo "DEPLOY_ALREADY_IN_PROGRESS $DEPLOY_LOCK" >&2
    exit 8
  fi
fi
/bin/chmod 700 "$DEPLOY_LOCK"
LOCK_ID="$(owned_directory_identity "$DEPLOY_LOCK" 2>/dev/null || true)"
[ -n "$LOCK_ID" ] || {
  echo "DEPLOY_LOCK_IDENTITY_INVALID $DEPLOY_LOCK" >&2
  exit 8
}
LOCK_HELD=1
trap on_deploy_exit EXIT
trap 'exit 130' HUP INT TERM
set -C
if { exec 9> "$DEPLOY_LOCK_OWNER"; }; then
  set +C
else
  set +C
  echo "DEPLOY_LOCK_OWNER_CREATE_REFUSED $DEPLOY_LOCK_OWNER" >&2
  exit 8
fi
LOCK_OWNER_ID="$(owned_file_identity "$DEPLOY_LOCK_OWNER" 2>/dev/null || true)"
[ -n "$LOCK_OWNER_ID" ] || {
  exec 9>&-
  echo "DEPLOY_LOCK_OWNER_IDENTITY_INVALID $DEPLOY_LOCK_OWNER" >&2
  exit 8
}
/usr/bin/printf '%s\n' "$LOCK_TOKEN" >&9
exec 9>&-
/bin/chmod 600 "$DEPLOY_LOCK_OWNER"
/usr/bin/printf '%s\n' "$$" > "$DEPLOY_LOCK_HOLDER" || {
  echo "DEPLOY_LOCK_HOLDER_CREATE_REFUSED $DEPLOY_LOCK_HOLDER" >&2
  exit 8
}
same_file_identity "$DEPLOY_LOCK_OWNER" "$LOCK_OWNER_ID" || {
  echo "DEPLOY_LOCK_OWNER_CHANGED_DURING_CREATION $DEPLOY_LOCK_OWNER" >&2
  exit 8
}

# Bind package-state observation to the serialized transaction. If another deploy
# published an app after an exact absence observation, retry through the update
# path so terminal-session maintenance is acquired before replacement.
if [ "$EXPECTED_PACKAGE_STATE" = "absent" ] &&
  { [ -e "$APP" ] || [ -L "$APP" ]; }; then
  echo "PACKAGE_STATE_CHANGED_BEFORE_DEPLOY $APP" >&2
  exit ${String(DARWIN_DEPLOY_NOT_STARTED_EXIT)}
fi

for UNBOUND_PATH in \
  "$IN" \
  "$PLIST_IN" \
  "$FORBIDDEN_APP_PREVIOUS" \
  "$FORBIDDEN_PLIST_PREVIOUS" \
  "$FORBIDDEN_APP_REJECTED" \
  "$FORBIDDEN_PLIST_REJECTED"
do
  if [ -e "$UNBOUND_PATH" ] || [ -L "$UNBOUND_PATH" ]; then
    echo "UNBOUND_DEPLOY_PATH_PRESENT $UNBOUND_PATH" >&2
    exit 8
  fi
done

# Extract and verify the incoming signed artifact while the old generation is
# still running. Archive or signature failures therefore leave it untouched.
# ARTIFACT_KIND=app-tar streams tar of .app contents; release-zip streams the
# notarized ZIP, verifies digest, and expands with ditto (native macOS).
/bin/mkdir -p "$APP_PARENT"
/bin/mkdir "$IN"
IN_ID="$(owned_directory_identity "$IN" 2>/dev/null || true)"
[ -n "$IN_ID" ] || { echo "INCOMING_IDENTITY_INVALID $IN" >&2; exit 8; }
IN_CREATED=1
if [ "$ARTIFACT_KIND" = "release-zip" ]; then
  /bin/cat > "$ARCHIVE"
  ARCHIVE_SHA="$("$SHASUM" -a 256 "$ARCHIVE" | /usr/bin/awk '{print $1}')"
  [ "$ARCHIVE_SHA" = "$EXPECTED_ARCHIVE_SHA256" ] || {
    echo "INCOMING_ARCHIVE_DIGEST_MISMATCH" >&2
    exit 3
  }
  "$DITTO" -x -k "$ARCHIVE" "$IN" || {
    echo "INCOMING_ARCHIVE_EXPAND_FAILED" >&2
    exit 3
  }
  /bin/rm -f "$ARCHIVE" || true
  [ -d "$IN/$BUNDLE" ] || {
    echo "INCOMING_ARCHIVE_MISSING_BUNDLE $IN/$BUNDLE" >&2
    exit 3
  }
else
  /bin/mkdir "$IN/$BUNDLE"
  "$TAR" -C "$IN/$BUNDLE" -xf -
fi
test -x "$IN_EXE"
test -f "$IN_CLI_EXE" && test ! -L "$IN_CLI_EXE" && test -x "$IN_CLI_EXE" || {
  echo "INCOMING_CLI_INVALID $IN_CLI_EXE" >&2
  exit 3
}
INCOMING_VERIFY="$("$CODESIGN" --verify --deep --strict --verbose=2 -R "$DEVELOPER_ID_REQUIREMENT" "$IN/$BUNDLE" 2>&1)" || {
  echo "INCOMING_SIGNATURE_VERIFY_FAILED" >&2
  echo "$INCOMING_VERIFY" >&2
  exit 3
}
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
bundle_has_only_contents "$IN/$BUNDLE" || {
  echo "INCOMING_BUNDLE_ROOT_SHAPE_INVALID $IN/$BUNDLE" >&2
  exit 3
}
CANDIDATE_APP_ID="$(owned_directory_identity "$IN/$BUNDLE" 2>/dev/null || true)"
[ -n "$CANDIDATE_APP_ID" ] || {
  echo "INCOMING_BUNDLE_IDENTITY_INVALID $IN/$BUNDLE" >&2
  exit 3
}
CANDIDATE_CONTENTS_ID="$(owned_directory_identity "$IN/$BUNDLE/Contents" 2>/dev/null || true)"
[ -n "$CANDIDATE_CONTENTS_ID" ] || {
  echo "INCOMING_CONTENTS_IDENTITY_INVALID $IN/$BUNDLE/Contents" >&2
  exit 3
}
CANDIDATE_EXE_ID="$(owned_file_identity "$IN_EXE" 2>/dev/null || true)"
[ -n "$CANDIDATE_EXE_ID" ] || {
  echo "INCOMING_EXECUTABLE_IDENTITY_INVALID $IN_EXE" >&2
  exit 3
}
same_directory_identity "$IN/$BUNDLE" "$CANDIDATE_APP_ID" || {
  echo "INCOMING_BUNDLE_CHANGED_DURING_ADMISSION $IN/$BUNDLE" >&2
  exit 3
}

# Materialize and admit the next launchd document before quiescing the current
# generation. The fixed incoming path was proven absent above and exclusive
# creation prevents a silent overwrite.
/bin/mkdir -p "$(/usr/bin/dirname "$PLIST")" "$LOGDIR"
set -C
if { exec 8> "$PLIST_IN"; }; then
  set +C
else
  set +C
  echo "PLIST_INCOMING_CREATE_REFUSED $PLIST_IN" >&2
  exit 3
fi
PLIST_IN_CREATED=1
PLIST_IN_ID="$(owned_file_identity "$PLIST_IN" 2>/dev/null || true)"
[ -n "$PLIST_IN_ID" ] || {
  exec 8>&-
  echo "PLIST_INCOMING_IDENTITY_INVALID $PLIST_IN" >&2
  exit 3
}
if ! /usr/bin/printf '%s' ${shellLiteral(plistB64)} |
  /usr/bin/base64 -d >&8; then
  exec 8>&-
  echo "PLIST_INCOMING_WRITE_FAILED $PLIST_IN" >&2
  exit 3
fi
exec 8>&-
/bin/chmod 644 "$PLIST_IN"
same_file_identity "$PLIST_IN" "$PLIST_IN_ID" || {
  echo "PLIST_INCOMING_CHANGED_DURING_CREATION $PLIST_IN" >&2
  exit 3
}
admit_plist_program_arguments "$PLIST_IN" || {
  echo "PLIST_INCOMING_PRODUCT_IDENTITY_MISMATCH $PLIST_IN" >&2
  exit 3
}
# Incoming enrollment LaunchAgent must carry the headless flag.
NEXT_PLIST_ARG1="$("$PLUTIL" -extract ProgramArguments.1 raw -o - "$PLIST_IN" 2>/dev/null || true)"
[ "$NEXT_PLIST_ARG1" = "$ENROLLMENT_FLAG" ] || {
  echo "PLIST_INCOMING_ENROLLMENT_FLAG_MISSING $PLIST_IN" >&2
  exit 3
}
same_file_identity "$PLIST_IN" "$PLIST_IN_ID" || {
  echo "PLIST_INCOMING_CHANGED_DURING_ADMISSION $PLIST_IN" >&2
  exit 3
}

if [ -e "$APP" ] || [ -L "$APP" ]; then
  admit_existing_app || exit 4
fi
if [ -e "$PLIST" ] || [ -L "$PLIST" ]; then
  admit_existing_plist || exit 4
fi

# print output is intentionally never parsed. kickstart -p is the documented
# PID-producing launchctl operation and starts a loaded-but-idle old job so its
# generation can be captured before bootout.
if job_exists; then
  [ -n "$APP_ID" ] && [ -n "$PLIST_ID" ] || {
    echo "LAUNCHD_JOB_WITHOUT_ADMITTED_INCUMBENT $JOB" >&2
    exit 4
  }
  OLD_JOB_WAS_LOADED=1
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
else
  # An exact installed process outside the admitted LaunchAgent has no
  # supervisor generation the transaction can faithfully resume. Refuse
  # before asking either the app or launchd to stop anything.
  UNSUPERVISED_EXE_PIDS=""
  if ! UNSUPERVISED_EXE_PIDS="$(exact_exe_pids)"; then
    echo "PROCESS_OBSERVATION_FAILED" >&2
    exit 4
  fi
  if [ -n "$UNSUPERVISED_EXE_PIDS" ]; then
    UNSUPERVISED_PID_LIST="$(/usr/bin/printf '%s\n' "$UNSUPERVISED_EXE_PIDS" | /usr/bin/tr '\n' ',')"
    echo "UNSUPERVISED_INCUMBENT_REQUIRES_LAUNCHAGENT exe_pids=$UNSUPERVISED_PID_LIST" >&2
    exit 4
  fi
  if job_exists; then
    echo "INCUMBENT_SUPERVISION_CHANGED_DURING_ADMISSION $JOB" >&2
    exit 4
  fi
fi

# Ask both the app and launchd to retire an admitted old generation. A first
# install has no incumbent and does not issue speculative quit/bootout calls.
# Neither command is treated as proof; the bounded observation below is the
# destructive gate.
if [ "$OLD_JOB_WAS_LOADED" = "1" ]; then
  INCUMBENT_STOP_REQUESTED=1
  "$OSASCRIPT" -e ${shellLiteral(`with timeout of 5 seconds
  tell application "${PRODUCT_NAME}" to quit
end timeout`)} >/dev/null 2>&1 || true
  "$LAUNCHCTL" bootout "$JOB" >/dev/null 2>&1 || true
fi

if ! wait_until_job_and_executable_gone ${generationGoneLimit}; then
  CURRENT_EXE_PIDS="$(exact_exe_pids | /usr/bin/tr '\n' ',' || true)"
  echo "OLD_GENERATION_STILL_PRESENT exe_pids=$CURRENT_EXE_PIDS" >&2
  exit 4
fi

# Stale sockets are removed only after the old job and exact executable are
# both absent. Their later existence therefore witnesses a new listener.
retire_stale_socket "$TERM_SOCK" "$RETIRED_TERM_SOCKET" || exit 5
retire_stale_socket "$BROWSER_SOCK" "$RETIRED_BROWSER_SOCKET" || exit 5

begin_candidate_activation

# Permanently retire only resources admitted above. Moving into the freshly
# minted 0700 lock directory lets us re-check dev:inode before deletion; no
# rollback generation or fixed previous tree exists.
if [ -n "$APP_ID" ]; then
  [ ! -e "$RETIRED_APP" ] && [ ! -L "$RETIRED_APP" ] || {
    echo "APP_RETIREMENT_TARGET_COLLISION $RETIRED_APP" >&2
    exit 5
  }
  /bin/mkdir "$RETIRED_APP"
  RETIRED_APP_ID="$(owned_directory_identity "$RETIRED_APP" 2>/dev/null || true)"
  [ -n "$RETIRED_APP_ID" ] || {
    echo "APP_RETIREMENT_ROOT_IDENTITY_INVALID $RETIRED_APP" >&2
    exit 5
  }
  same_directory_identity "$APP" "$APP_ID" || {
    echo "EXISTING_APP_CHANGED_BEFORE_RETIREMENT $APP" >&2
    exit 5
  }
  bundle_has_only_contents "$APP" || {
    echo "EXISTING_APP_ROOT_SHAPE_CHANGED_BEFORE_RETIREMENT $APP" >&2
    exit 5
  }
  same_directory_identity "$APP/Contents" "$APP_CONTENTS_ID" || {
    echo "EXISTING_APP_CONTENTS_CHANGED_BEFORE_RETIREMENT $APP/Contents" >&2
    exit 5
  }
  /bin/mv -n "$APP/Contents" "$RETIRED_APP/Contents"
  [ ! -e "$APP/Contents" ] && [ ! -L "$APP/Contents" ] &&
    [ -e "$RETIRED_APP/Contents" ] || {
      echo "EXISTING_APP_RETIREMENT_COLLISION $APP" >&2
      exit 5
    }
  same_directory_identity "$RETIRED_APP/Contents" "$APP_CONTENTS_ID" || {
    echo "EXISTING_APP_CONTENTS_CHANGED_DURING_RETIREMENT $RETIRED_APP/Contents" >&2
    exit 5
  }
  bundle_has_only_contents "$RETIRED_APP" || {
    echo "APP_RETIREMENT_ROOT_SHAPE_INVALID $RETIRED_APP" >&2
    exit 5
  }
  same_directory_identity "$APP" "$APP_ID" || {
    echo "EXISTING_APP_ROOT_CHANGED_DURING_RETIREMENT $APP" >&2
    exit 5
  }
  /bin/rmdir "$APP" || {
    echo "EXISTING_APP_ROOT_NOT_EMPTY_AFTER_RETIREMENT $APP" >&2
    exit 5
  }
  [ ! -e "$APP" ] && [ ! -L "$APP" ] || {
    echo "EXISTING_APP_ROOT_REAPPEARED_AFTER_RETIREMENT $APP" >&2
    exit 5
  }
  same_directory_identity "$RETIRED_APP/Contents" "$APP_CONTENTS_ID" &&
    bundle_has_only_contents "$RETIRED_APP" || {
      echo "APP_RETIREMENT_CONTENT_CHANGED_BEFORE_DELETION $RETIRED_APP" >&2
      exit 5
    }
  remove_bound_app_bundle "$RETIRED_APP" "$RETIRED_APP_ID" "$APP_CONTENTS_ID" || {
    echo "EXISTING_APP_RETIREMENT_FAILED $RETIRED_APP" >&2
    exit 5
  }
fi
if [ -n "$PLIST_ID" ]; then
  same_file_identity "$PLIST" "$PLIST_ID" || {
    echo "EXISTING_PLIST_CHANGED_BEFORE_RETIREMENT $PLIST" >&2
    exit 5
  }
  [ ! -e "$RETIRED_PLIST" ] && [ ! -L "$RETIRED_PLIST" ] || {
    echo "PLIST_RETIREMENT_TARGET_COLLISION $RETIRED_PLIST" >&2
    exit 5
  }
  /bin/mv -n "$PLIST" "$RETIRED_PLIST"
  [ ! -e "$PLIST" ] && [ ! -L "$PLIST" ] || {
    echo "EXISTING_PLIST_RETIREMENT_COLLISION $PLIST" >&2
    exit 5
  }
  same_file_identity "$RETIRED_PLIST" "$PLIST_ID" || {
    echo "EXISTING_PLIST_CHANGED_DURING_RETIREMENT $RETIRED_PLIST" >&2
    exit 5
  }
  remove_bound_file "$RETIRED_PLIST" "$PLIST_ID" || {
    echo "EXISTING_PLIST_RETIREMENT_FAILED $RETIRED_PLIST" >&2
    exit 5
  }
fi

same_directory_identity "$IN/$BUNDLE" "$CANDIDATE_APP_ID" || {
  echo "INCOMING_BUNDLE_CHANGED_BEFORE_PUBLICATION $IN/$BUNDLE" >&2
  exit 5
}
same_directory_identity "$IN/$BUNDLE/Contents" "$CANDIDATE_CONTENTS_ID" &&
  same_file_identity "$IN_EXE" "$CANDIDATE_EXE_ID" || {
    echo "INCOMING_EXECUTABLE_CHANGED_BEFORE_PUBLICATION $IN_EXE" >&2
    exit 5
  }
if [ -e "$APP" ] || [ -L "$APP" ]; then
  echo "UNADMITTED_APP_APPEARED_BEFORE_PUBLICATION $APP" >&2
  exit 5
fi
/bin/mkdir "$APP"
PUBLISHED_APP_ID="$(owned_directory_identity "$APP" 2>/dev/null || true)"
[ -n "$PUBLISHED_APP_ID" ] || {
  echo "PUBLISHED_APP_ROOT_IDENTITY_INVALID $APP" >&2
  exit 5
}
same_directory_identity "$IN/$BUNDLE" "$CANDIDATE_APP_ID" || {
  echo "INCOMING_BUNDLE_CHANGED_AT_PUBLICATION $IN/$BUNDLE" >&2
  exit 5
}
/bin/mv -n "$IN/$BUNDLE/Contents" "$APP/Contents"
[ ! -e "$IN/$BUNDLE/Contents" ] && [ ! -L "$IN/$BUNDLE/Contents" ] &&
  [ -e "$APP/Contents" ] || {
    echo "INCOMING_BUNDLE_PUBLICATION_COLLISION $APP" >&2
    exit 5
  }
same_directory_identity "$APP" "$PUBLISHED_APP_ID" || {
  echo "PUBLISHED_APP_ROOT_CHANGED_DURING_PUBLICATION $APP" >&2
  exit 5
}
same_directory_identity "$IN/$BUNDLE" "$CANDIDATE_APP_ID" || {
  echo "INCOMING_BUNDLE_ROOT_CHANGED_DURING_PUBLICATION $IN/$BUNDLE" >&2
  exit 5
}
/bin/rmdir "$IN/$BUNDLE" || {
  echo "INCOMING_BUNDLE_ROOT_NOT_EMPTY_AFTER_PUBLICATION $IN/$BUNDLE" >&2
  exit 5
}
same_directory_identity "$IN" "$IN_ID" || {
  echo "INCOMING_ROOT_CHANGED_BEFORE_RETIREMENT $IN" >&2
  exit 5
}
/bin/rmdir "$IN" || {
  echo "INCOMING_ROOT_NOT_EMPTY_AFTER_PUBLICATION $IN" >&2
  exit 5
}
IN_CREATED=0
IN_ID=""
"$CODESIGN" --verify --deep --strict --verbose=2 -R "$DEVELOPER_ID_REQUIREMENT" "$APP" || {
  echo "PUBLISHED_APP_SIGNATURE_INVALID $APP" >&2
  exit 5
}
PUBLISHED_CODESIGN_METADATA="$("$CODESIGN" -d --verbose=4 "$APP" 2>&1)" || {
  echo "PUBLISHED_SIGNATURE_METADATA_UNAVAILABLE" >&2
  exit 5
}
PUBLISHED_SIGNED_EXE="$(single_metadata_value "$PUBLISHED_CODESIGN_METADATA" "Executable")" || exit 5
PUBLISHED_SIGNED_ID="$(single_metadata_value "$PUBLISHED_CODESIGN_METADATA" "Identifier")" || exit 5
PUBLISHED_SIGNED_TEAM="$(single_metadata_value "$PUBLISHED_CODESIGN_METADATA" "TeamIdentifier")" || exit 5
PUBLISHED_SIGNED_CDHASH="$(single_metadata_value "$PUBLISHED_CODESIGN_METADATA" "CDHash")" || exit 5
PUBLISHED_SIGNED_AUTHORITY="$(first_signing_authority "$PUBLISHED_CODESIGN_METADATA")" || exit 5
[ "$PUBLISHED_SIGNED_EXE" = "$EXE" ] &&
  [ "$PUBLISHED_SIGNED_ID" = "${LABEL}" ] &&
  [ "$PUBLISHED_SIGNED_TEAM" = "${TEAM_IDENTIFIER}" ] &&
  [ "$PUBLISHED_SIGNED_AUTHORITY" = "${SIGNING_AUTHORITY}" ] &&
  [ "$(/usr/bin/printf '%s' "$PUBLISHED_SIGNED_CDHASH" | /usr/bin/tr '[:upper:]' '[:lower:]')" = "$EXPECTED_CDHASH" ] || {
    echo "PUBLISHED_SIGNATURE_IDENTITY_MISMATCH $APP" >&2
    exit 5
  }
PUBLISHED_BUNDLE_ID="$("$PLUTIL" -extract CFBundleIdentifier raw -o - "$APP/Contents/Info.plist")"
PUBLISHED_BUNDLE_EXE="$("$PLUTIL" -extract CFBundleExecutable raw -o - "$APP/Contents/Info.plist")"
[ "$PUBLISHED_BUNDLE_ID" = "${LABEL}" ] &&
  [ "$PUBLISHED_BUNDLE_EXE" = "${PRODUCT_NAME}" ] || {
    echo "PUBLISHED_APP_PRODUCT_IDENTITY_MISMATCH $APP" >&2
    exit 5
  }
same_directory_identity "$APP" "$PUBLISHED_APP_ID" || {
  echo "PUBLISHED_APP_CHANGED_AFTER_ADMISSION $APP" >&2
  exit 5
}
test -x "$EXE" || { echo "PUBLISHED_EXECUTABLE_INVALID $EXE" >&2; exit 5; }
test -f "$CLI_EXE" && test ! -L "$CLI_EXE" && test -x "$CLI_EXE" || {
  echo "PUBLISHED_CLI_INVALID $CLI_EXE" >&2
  exit 5
}

same_file_identity "$PLIST_IN" "$PLIST_IN_ID" || {
  echo "PLIST_INCOMING_CHANGED_BEFORE_PUBLICATION $PLIST_IN" >&2
  exit 5
}
if [ -e "$PLIST" ] || [ -L "$PLIST" ]; then
  echo "UNADMITTED_PLIST_APPEARED_BEFORE_PUBLICATION $PLIST" >&2
  exit 5
fi
set -C
if { exec 3> "$PLIST"; }; then
  set +C
else
  set +C
  echo "PLIST_PUBLICATION_CREATE_REFUSED $PLIST" >&2
  exit 5
fi
PUBLISHED_PLIST_ID="$(owned_file_identity "$PLIST" 2>/dev/null || true)"
[ -n "$PUBLISHED_PLIST_ID" ] || {
  exec 3>&-
  echo "PUBLISHED_PLIST_IDENTITY_INVALID $PLIST" >&2
  exit 5
}
/bin/cat "$PLIST_IN" >&3 || {
  exec 3>&-
  echo "PUBLISHED_PLIST_WRITE_FAILED $PLIST" >&2
  exit 5
}
exec 3>&-
/bin/chmod 644 "$PLIST"
same_file_identity "$PLIST" "$PUBLISHED_PLIST_ID" || {
  echo "PUBLISHED_PLIST_CHANGED_DURING_PUBLICATION $PLIST" >&2
  exit 5
}
admit_plist_program_arguments "$PLIST" || {
  echo "PUBLISHED_PLIST_PRODUCT_IDENTITY_MISMATCH $PLIST" >&2
  exit 5
}
PUBLISHED_PLIST_ARG1="$("$PLUTIL" -extract ProgramArguments.1 raw -o - "$PLIST" 2>/dev/null || true)"
[ "$PUBLISHED_PLIST_ARG1" = "$ENROLLMENT_FLAG" ] || {
  echo "PUBLISHED_PLIST_ENROLLMENT_FLAG_MISSING $PLIST" >&2
  exit 5
}
same_file_identity "$PLIST_IN" "$PLIST_IN_ID" || {
  echo "PLIST_INCOMING_CHANGED_AFTER_PUBLICATION $PLIST_IN" >&2
  exit 5
}
remove_bound_file "$PLIST_IN" "$PLIST_IN_ID" || {
  echo "PLIST_INCOMING_RETIREMENT_FAILED $PLIST_IN" >&2
  exit 5
}
PLIST_IN_CREATED=0
PLIST_IN_ID=""
"$LAUNCHCTL" enable "$JOB" 2>/dev/null || true
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
while [ "$WAIT_INDEX" -lt ${generationProofLimit} ]; do
  if exact_exe_has_pid "$NEW_PID"; then NEW_IDENTITY_OK=1; break; fi
  WAIT_INDEX=$((WAIT_INDEX + 1))
  "$SLEEP" 1
done
[ "$NEW_IDENTITY_OK" = "1" ] || {
  echo "NEW_LAUNCHD_GENERATION_NOT_PROVEN old_pid=$OLD_PID" >&2
  exit 6
}

${
  firstInstall
    ? `STATION_OK=0
WAIT_INDEX=0
while [ "$WAIT_INDEX" -lt ${socketReadyLimit} ]; do
  if ! job_exists || ! exact_exe_has_pid "$NEW_PID"; then
    echo "NEW_LAUNCHD_GENERATION_LOST expected_pid=$NEW_PID" >&2
    exit 7
  fi
  STATION_OK=0
  if socket_owned_by_pid "$STATION_SOCK" "$NEW_PID"; then STATION_OK=1; fi
  if [ "$STATION_OK" = "1" ]; then
    if job_exists && exact_exe_has_pid "$NEW_PID" && socket_owned_by_pid "$STATION_SOCK" "$NEW_PID"; then
      echo "ENROLLMENT_READY pid=$NEW_PID station=1"
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
STATION_OK=0
if socket_owned_by_pid "$STATION_SOCK" "$NEW_PID"; then STATION_OK=1; fi
echo "ENROLLMENT_PARTIAL pid=$NEW_PID station=$STATION_OK" >&2
echo "ENROLLMENT_SOCKET_TIMEOUT pid=$NEW_PID station=$STATION_OK" >&2
exit 2`
    : `TERM_OK=0
BROWSER_OK=0
WAIT_INDEX=0
while [ "$WAIT_INDEX" -lt ${socketReadyLimit} ]; do
  if ! job_exists || ! exact_exe_has_pid "$NEW_PID"; then
    echo "NEW_LAUNCHD_GENERATION_LOST expected_pid=$NEW_PID" >&2
    exit 7
  fi
  TERM_OK=0
  BROWSER_OK=0
  if socket_owned_by_pid "$TERM_SOCK" "$NEW_PID"; then TERM_OK=1; fi
  if socket_owned_by_pid "$BROWSER_SOCK" "$NEW_PID"; then BROWSER_OK=1; fi
  if [ "$TERM_OK" = "1" ] && [ "$BROWSER_OK" = "1" ]; then
    if job_exists && exact_exe_has_pid "$NEW_PID" &&
      socket_owned_by_pid "$TERM_SOCK" "$NEW_PID" &&
      socket_owned_by_pid "$BROWSER_SOCK" "$NEW_PID"; then
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
echo "RUNTIME_SOCKET_TIMEOUT pid=$NEW_PID term=$TERM_OK browser=$BROWSER_OK" >&2
exit 2`
}
`.trim();
};

export const buildRemoteDeployScript = (
  remoteHome: string,
  expectedCdHash: string,
  transfer: DarwinRemoteArtifactTransfer,
): string =>
  buildRemoteDeployScriptWithRuntime(
    remoteHome,
    expectedCdHash,
    PRODUCTION_DEPLOY_SCRIPT_RUNTIME,
    transfer,
  );

export const buildRemoteDeployScriptForTest = (
  remoteHome: string,
  expectedCdHash: string,
  runtime: RemoteDeployScriptTestRuntime,
  transfer: DarwinRemoteArtifactTransfer,
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
  return buildRemoteDeployScriptWithRuntime(
    remoteHome,
    expectedCdHash,
    runtime,
    transfer,
  );
};

/**
 * After Station pair/configure, drop enrollment headless and prove full
 * supervised Remote readiness (term + browser sockets).
 */
export const buildRemoteRuntimeActivateScript = (
  remoteHome: string,
): string => {
  if (!isSafeRemoteHomePath(remoteHome)) {
    throw new Error("remote home must be a canonical absolute path");
  }
  const remoteAppPath = REMOTE_APP_PATH;
  const remoteExecutablePath = `${remoteAppPath}/Contents/MacOS/${PRODUCT_NAME}`;
  const plistPath = `${remoteHome}/Library/LaunchAgents/${LABEL}.plist`;
  const logDir = `${remoteHome}/Library/Logs/${PRODUCT_NAME}`;
  const termSock = `${remoteHome}/${TERM_REMOTE_SOCK_REL}`;
  const browserSock = browserControlSocketPath(remoteHome);
  const runtime = PRODUCTION_DEPLOY_SCRIPT_RUNTIME;
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
<key>StandardOutPath</key><string>${xmlText(logDir)}/vellum-command.out.log</string>
<key>StandardErrorPath</key><string>${xmlText(logDir)}/vellum-command.err.log</string>
</dict></plist>
`;
  const plistB64 = Buffer.from(plistBody, "utf8").toString("base64");
  return `
set -euo pipefail
umask 022
UNAME=${shellLiteral(runtime.commands.uname)}
LAUNCHCTL=${shellLiteral(runtime.commands.launchctl)}
LSOF=${shellLiteral(runtime.commands.lsof)}
PLUTIL=${shellLiteral(runtime.commands.plutil)}
SLEEP=${shellLiteral(runtime.commands.sleep)}
ID=${shellLiteral(runtime.commands.id)}
test "$("$UNAME" -s)" = "Darwin" || { echo "REMOTE_NOT_DARWIN $("$UNAME" -s)" >&2; exit 3; }
EXE=${shellLiteral(remoteExecutablePath)}
TERM_SOCK=${shellLiteral(termSock)}
BROWSER_SOCK=${shellLiteral(browserSock)}
PLIST=${shellLiteral(plistPath)}
DOMAIN="gui/$("$ID" -u)"
JOB="$DOMAIN/${LABEL}"
test -x "$EXE" || { echo "RUNTIME_EXE_MISSING $EXE" >&2; exit 4; }
/bin/mkdir -p ${shellLiteral(logDir)} "$(/usr/bin/dirname "$PLIST")"
/usr/bin/printf '%s' ${shellLiteral(plistB64)} | /usr/bin/base64 -d > "$PLIST"
/bin/chmod 644 "$PLIST"
PUBLISHED_LABEL="$("$PLUTIL" -extract Label raw -o - "$PLIST")"
PUBLISHED_EXE="$("$PLUTIL" -extract ProgramArguments.0 raw -o - "$PLIST")"
[ "$PUBLISHED_LABEL" = "${LABEL}" ] && [ "$PUBLISHED_EXE" = "$EXE" ] || {
  echo "RUNTIME_PLIST_IDENTITY_MISMATCH $PLIST" >&2
  exit 5
}
if "$PLUTIL" -extract ProgramArguments.1 raw -o - "$PLIST" >/dev/null 2>&1; then
  echo "RUNTIME_PLIST_STILL_ENROLLMENT $PLIST" >&2
  exit 5
fi
if "$LAUNCHCTL" print "$JOB" >/dev/null 2>&1; then
  "$LAUNCHCTL" bootout "$JOB" 2>/dev/null || true
  WAIT_INDEX=0
  while [ "$WAIT_INDEX" -lt 30 ]; do
    "$LAUNCHCTL" print "$JOB" >/dev/null 2>&1 || break
    WAIT_INDEX=$((WAIT_INDEX + 1))
    "$SLEEP" 1
  done
fi
"$LAUNCHCTL" enable "$JOB" 2>/dev/null || true
if ! "$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST" 2>/dev/null; then
  "$LAUNCHCTL" load -w "$PLIST"
fi
NEW_PID="$("$LAUNCHCTL" kickstart -p "$JOB")" || {
  echo "RUNTIME_LAUNCHD_PID_NOT_PROVEN" >&2
  exit 6
}
case "$NEW_PID" in
  ''|*[!0-9]*|0) echo "RUNTIME_LAUNCHD_PID_INVALID $NEW_PID" >&2; exit 6 ;;
esac
socket_owned_by_pid() {
  local sock="$1" pid="$2" out
  out="$("$LSOF" -n -P -F p -U -- "$sock" 2>/dev/null || true)"
  printf '%s\\n' "$out" | /usr/bin/grep -qx "p$pid"
}
TERM_OK=0
BROWSER_OK=0
WAIT_INDEX=0
while [ "$WAIT_INDEX" -lt 60 ]; do
  TERM_OK=0
  BROWSER_OK=0
  if socket_owned_by_pid "$TERM_SOCK" "$NEW_PID"; then TERM_OK=1; fi
  if socket_owned_by_pid "$BROWSER_SOCK" "$NEW_PID"; then BROWSER_OK=1; fi
  if [ "$TERM_OK" = "1" ] && [ "$BROWSER_OK" = "1" ]; then
    echo "STATION_READY pid=$NEW_PID term=1 browser=1"
    exit 0
  fi
  WAIT_INDEX=$((WAIT_INDEX + 1))
  "$SLEEP" 1
done
echo "RUNTIME_SOCKET_TIMEOUT pid=$NEW_PID term=$TERM_OK browser=$BROWSER_OK" >&2
exit 2
`.trim();
};

/** Run post-configure supervised relaunch on a Darwin Remote. */
export const activateDarwinRemoteRuntime = (
  ssh: Ssh,
  endpoint: SshTarget,
  remoteHome: string,
): Effect.Effect<
  { readonly ok: boolean; readonly detail: string },
  Error | import("../ssh/domain").SshError
> =>
  Effect.gen(function* () {
    const script = buildRemoteRuntimeActivateScript(remoteHome);
    const command = yield* compileDarwinRemoteActivationScript(script);
    // Empty transfer body: long DEPLOY_TIMEOUT_MS covers kickstart + socket poll.
    // Own TCP: Station peer retries share the mux and would drop this poll.
    const output = yield* ssh.transfer(
      deploymentStream(endpoint, command),
      Stream.empty,
      DEPLOY_TIMEOUT_MS,
    );
    return parseRuntimeActivateResult({
      stdout: output.stdout,
      stderr: output.stderr,
    });
  });

/** Activate a prepared Darwin target after Station pair/configure succeeds. */
export const activateDarwinRemoteRuntimeForTarget = (
  ssh: Ssh,
  target: RemoteDeploymentTarget,
): Effect.Effect<DeployRemoteResult, never> =>
  Effect.gen(function* () {
    const stages = [...target.progress];
    const homeResult = yield* ssh
      .run(homeDirectoryLookup(target.sshTarget))
      .pipe(Effect.result);
    if (homeResult._tag === "Failure") {
      const detail = `${target.host.label}: Remote runtime home lookup failed after Station configuration`;
      return {
        ok: false,
        detail,
        code: "io" as const,
        message: detail,
        stages,
        disposition: "indeterminate" as const,
      } satisfies DeployRemoteResult;
    }
    const remoteHome = decodeRemoteHomeDirectoryOutput(
      homeResult.success.stdout,
    );
    if (remoteHome === null) {
      const detail = `${target.host.label}: Remote runtime home is not a canonical absolute path`;
      return {
        ok: false,
        detail,
        code: "io" as const,
        message: detail,
        stages,
        disposition: "indeterminate" as const,
      } satisfies DeployRemoteResult;
    }
    stages.push(`Remote runtime relaunch admitted for ${remoteHome}`);
    const activated = yield* activateDarwinRemoteRuntime(
      ssh,
      target.sshTarget,
      remoteHome,
    ).pipe(Effect.result);
    if (activated._tag === "Failure") {
      const detail = `${target.host.label}: supervised Remote relaunch failed — ${describeDeployTransferFailure(activated.failure)}`;
      return {
        ok: false,
        detail,
        code: "io" as const,
        message: detail,
        stages,
        disposition: "indeterminate" as const,
      } satisfies DeployRemoteResult;
    }
    if (!activated.success.ok) {
      const detail = `${target.host.label}: ${activated.success.detail}`;
      return {
        ok: false,
        detail,
        code: "io" as const,
        message: detail,
        stages,
        disposition: "indeterminate" as const,
      } satisfies DeployRemoteResult;
    }
    stages.push(activated.success.detail);
    return {
      ok: true,
      detail: activated.success.detail,
      stages,
      disposition: "ready" as const,
    } satisfies DeployRemoteResult;
  });

const streamArtifactToRemote = (
  ssh: Ssh,
  endpoint: SshTarget,
  input: {
    readonly admission: DarwinDeployArtifactAdmission;
    readonly remoteHome: string;
    readonly expectedPackageState: "absent" | "present";
  },
): Effect.Effect<
  DeployTransferParse,
  Error | import("../ssh/domain").SshError
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const transfer: DarwinRemoteArtifactTransfer =
        input.admission.kind === "release-zip" && input.admission.archive
          ? {
              kind: "release-zip",
              expectedArchiveSha256: input.admission.archive.sha256,
              expectedPackageState: input.expectedPackageState,
            }
          : {
              kind: "app-tar",
              expectedPackageState: input.expectedPackageState,
            };
      const remoteScript = buildRemoteDeployScript(
        input.remoteHome,
        input.admission.localApp.cdHash,
        transfer,
      );

      const source = yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            if (
              transfer.kind === "release-zip" &&
              input.admission.archive
            ) {
              const lease = appProcessPlane.spawnChild({
                source: "hosts.deploy-remote.zip",
                purpose: "stream release ZIP to remote host",
                command: "/bin/cat",
                args: [input.admission.archive.zipPath],
              });
              return {
                lease,
                exit: watchTarExit(lease.io),
                stderr: captureTarStderr(lease.io.stderr),
                label: "zip" as const,
              };
            }
            const lease = appProcessPlane.spawnChild({
              source: "hosts.deploy-remote.tar",
              purpose: "stream app bundle to remote host",
              command: "/usr/bin/tar",
              args: [
                "-C",
                input.admission.localApp.appPath,
                "-cf",
                "-",
                ".",
              ],
            });
            return {
              lease,
              exit: watchTarExit(lease.io),
              stderr: captureTarStderr(lease.io.stderr),
              label: "tar" as const,
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
                  "deploy artifact stream scope finalized",
                ),
              ).pipe(
                Effect.andThen(
                  Effect.promise(() => awaitTarCloseBounded(exit, 2_000)),
                ),
              ),
      );
      const command = yield* compileDarwinRemoteDeployScript(remoteScript);
      // Dedicated TCP: Station peer retries own the shared mux.
      const output = yield* ssh
        .transfer(
          deploymentStream(endpoint, command),
          Stream.fromAsyncIterable(
            source.lease.io.stdout,
            (error) =>
              new Error(
                `local ${source.label} stream failed: ${error instanceof Error ? error.message : String(error)}`,
              ),
          ).pipe(Stream.map((chunk) => Uint8Array.from(chunk))),
          DEPLOY_TIMEOUT_MS,
        )
        .pipe(
          Effect.catchIf(
            (error): error is SshTransferExitError =>
              error instanceof SshTransferExitError &&
              error.code === DARWIN_DEPLOY_READY_WITH_LOCK_WARNING_EXIT,
            (error) =>
              Effect.succeed({
                stdout: error.stdout,
                stderr: error.stderr,
              }),
          ),
        );
      const sourceResult = yield* Effect.promise(() => source.exit.settlement);
      if (!sourceResult.ok) {
        return yield* Effect.fail(
          new Error(
            `local ${source.label} failed: ${sourceResult.error.message}${source.stderr() ? `: ${source.stderr()}` : ""}`,
          ),
        );
      }
      return parseDeployTransferResult(output);
    }),
  );

type DarwinStreamArtifactResult =
  | DeployTransferParse
  // Test seams may return the pre-enrollment boolean marker shape. Treating
  // that shape as runtime-ready keeps the seam backwards-compatible without
  // weakening the production parser.
  | { readonly ok: boolean; readonly detail: string };

export const makeDarwinRemoteDeploymentProvider = (deps: {
  readonly artifactAuthority: DarwinRemoteArtifactAuthority;
  readonly liveWorkAuthority: DarwinRemoteLiveWorkAuthority;
  readonly streamArtifact: (
    ssh: Ssh,
    endpoint: SshTarget,
    input: {
      readonly admission: DarwinDeployArtifactAdmission;
      readonly remoteHome: string;
      readonly expectedPackageState: "absent" | "present";
    },
  ) => Effect.Effect<
    DarwinStreamArtifactResult,
    Error | import("../ssh/domain").SshError
  >;
  readonly localPlatform: NodeJS.Platform;
}): RemoteDeploymentProvider => ({
  platform: "darwin",
  supportsBrowser: true,
  deploy: (providerInput) =>
    Effect.scoped(
      Effect.gen(function* () {
        const stages: string[] = [];
        const { ssh, target } = providerInput;
        const { host } = target;
        // Beta Cut 3: refuse before any freeform bash -lc script compilation.
        // Production loader also gates on RELEASE_CAPABILITIES.darwinRemoteDeploy
        // before importing this module; this is defense-in-depth for direct import.
        if (!RELEASE_CAPABILITIES.darwinRemoteDeploy) {
          return {
            ok: false,
            detail: DARWIN_REMOTE_DEPLOY_DISABLED_DETAIL,
            code: "validation" as const,
            message: DARWIN_REMOTE_DEPLOY_DISABLED_DETAIL,
            stages,
            disposition: "not-started" as const,
          };
        }
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
        if (deps.localPlatform !== "darwin") {
          return {
            ok: false,
            detail:
              "Deploy Remote must run from a macOS Command Center (local .app or release ZIP source)",
            code: "validation" as const,
            stages,
            disposition: "not-started" as const,
          };
        }

        const resolvedArtifact = yield* Effect.tryPromise({
          try: () => deps.artifactAuthority.resolve(),
          catch: (error) =>
            error instanceof Error ? error : new Error(String(error)),
        }).pipe(Effect.result);
        if (resolvedArtifact._tag === "Failure") {
          return {
            ok: false,
            detail: `${host.label}: deploy artifact unavailable — ${resolvedArtifact.failure.message}`,
            code: "not_found" as const,
            message: resolvedArtifact.failure.message,
            stages,
            disposition: "not-started" as const,
          };
        }
        const admission = resolvedArtifact.success;
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => admission.dispose()).pipe(
            Effect.catch(() => Effect.void),
          ),
        );
        push(
          stages,
          admission.kind === "release-zip"
            ? `release ZIP admitted version=${admission.localApp.version} sha256=${admission.archive?.sha256.slice(0, 12)}…`
            : `local bundle candidate ${admission.localApp.appPath}`,
        );
        push(
          stages,
          `local bundle admitted id=${admission.localApp.bundleIdentifier} team=${admission.localApp.teamIdentifier}`,
        );
        for (const stage of target.progress) push(stages, stage);

        const homeResult = yield* ssh
          .run(homeDirectoryLookup(target.sshTarget))
          .pipe(Effect.result);
        if (homeResult._tag === "Failure") {
          return {
            ok: false,
            detail: `${host.label}: remote home lookup failed`,
            code: "io" as const,
            stages,
            disposition: "not-started" as const,
            version: admission.localApp.version,
          };
        }
        const home = decodeRemoteHomeDirectoryOutput(homeResult.success.stdout);
        if (home === null) {
          return {
            ok: false,
            detail: `${host.label}: remote home is not a canonical absolute path`,
            code: "io" as const,
            stages,
            disposition: "not-started" as const,
            version: admission.localApp.version,
          };
        }
        push(stages, `remote home ${home}`);

        // Only an exact not-found exit selects first install. Transport,
        // timeout, authentication, and command-construction failures are not
        // evidence that an installed Remote is absent.
        const installedProbeCmd = yield* remoteDarwinPackageExists().pipe(
          Effect.result,
        );
        if (installedProbeCmd._tag === "Failure") {
          return {
            ok: false,
            detail: `${host.label}: could not construct the fixed installed-package probe — ${installedProbeCmd.failure.message}`,
            code: "io" as const,
            message: installedProbeCmd.failure.message,
            stages,
            disposition: "not-started" as const,
            version: admission.localApp.version,
          };
        }
        const installedProbe = yield* ssh
          .run(
            oneShot(target.sshTarget, installedProbeCmd.success, {
              budget: "short",
            }),
          )
          .pipe(Effect.result);
        const installedPresent = installedProbe._tag === "Success";
        const firstInstall =
          installedProbe._tag === "Failure" &&
          installedProbe.failure instanceof SshExitError &&
          installedProbe.failure.code === 1;
        if (!installedPresent && !firstInstall) {
          const message =
            installedProbe._tag === "Failure"
              ? installedProbe.failure.message
              : "installed-package probe returned an unknown result";
          return {
            ok: false,
            detail: `${host.label}: could not determine whether Vellum Command is installed — ${message}`,
            code: "io" as const,
            message,
            stages,
            disposition: "not-started" as const,
            version: admission.localApp.version,
          };
        }
        if (installedPresent) {
          // A published .app is not a live terminal plane. Quiesce only when
          // the Remote term control socket exists.
          const termSock = join(home, TERM_REMOTE_SOCK_REL);
          const termProbeCmd = yield* remoteTestSocketExists(termSock).pipe(
            Effect.result,
          );
          if (termProbeCmd._tag === "Failure") {
            return {
              ok: false,
              detail: `${host.label}: could not construct the Remote terminal-plane probe — ${termProbeCmd.failure.message}`,
              code: "io" as const,
              message: termProbeCmd.failure.message,
              stages,
              disposition: "not-started" as const,
              version: admission.localApp.version,
            };
          }
          const termProbe = yield* ssh
            .run(
              oneShot(target.sshTarget, termProbeCmd.success, {
                budget: "short",
              }),
            )
            .pipe(Effect.result);
          const termPlanePresent = termProbe._tag === "Success";
          const termPlaneAbsent =
            termProbe._tag === "Failure" &&
            termProbe.failure instanceof SshExitError &&
            termProbe.failure.code === 1;
          if (!termPlanePresent && !termPlaneAbsent) {
            const message =
              termProbe._tag === "Failure"
                ? describeLiveWorkAcquireFailure(termProbe.failure)
                : "terminal-plane probe returned an unknown result";
            return {
              ok: false,
              detail: `${host.label}: could not determine whether the Remote terminal plane is live — ${message}`,
              code: "io" as const,
              message,
              stages,
              disposition: "not-started" as const,
              version: admission.localApp.version,
            };
          }
          if (!termPlanePresent) {
            push(
              stages,
              "Vellum Command is not answering on this Mac — no live terminal to pause",
            );
          } else {
          // Updates only: never force-close active Remote sessions.
          const maintenance = yield* Effect.acquireRelease(
            deps.liveWorkAuthority.acquire(providerInput),
            (lease) => (lease.acquired ? lease.release : Effect.void),
          ).pipe(Effect.result);
          if (maintenance._tag === "Failure") {
            return {
              ok: false,
              detail: `${host.label}: could not acquire Remote terminal maintenance — ${describeLiveWorkAcquireFailure(maintenance.failure)}`,
              code: "conflict" as const,
              message: maintenance.failure.message,
              stages,
              disposition: "not-started" as const,
              version: admission.localApp.version,
            };
          }
          const liveWork = maintenance.success;
          if (!liveWork.acquired) {
            return darwinLiveWorkRefusalResult({
              hostLabel: host.label,
              stages,
              version: admission.localApp.version,
              refusal: liveWork,
            });
          }
          push(
            stages,
            `terminal route cut held observation=${liveWork.evidence.observationId}`,
          );
          }
        } else {
          push(stages, "Vellum Command is not installed on this Mac yet");
        }

        const streamed = yield* deps.streamArtifact(
          ssh,
          target.sshTarget,
          {
            admission,
            remoteHome: home,
            expectedPackageState: compileExpectedPackageState(
              installedPresent ? "present" : "absent",
              providerInput.stationConfiguration.state === "applied"
                ? "present"
                : undefined,
            ),
          },
        ).pipe(Effect.result);

        if (streamed._tag === "Failure") {
          const disposition = classifyDeployTransferDisposition(streamed.failure);
          return {
            ok: false,
            detail: `${host.label}: ${describeDeployTransferFailure(streamed.failure)}`,
            code: "io" as const,
            message: describeDeployTransferFailure(streamed.failure),
            stages,
            disposition,
            version: admission.localApp.version,
          };
        }
        push(stages, streamed.success.detail);
        if (!streamed.success.ok) {
          return {
            ok: false,
            detail: `${host.label}: ${streamed.success.detail}`,
            code: "io" as const,
            message: streamed.success.detail,
            stages,
            disposition: "indeterminate" as const,
            version: admission.localApp.version,
          };
        }

        // Enrollment control plane is enough for Station pair/configure.
        // Full term+browser readiness is a separate activate step.
        const disposition =
          ("phase" in streamed.success && streamed.success.phase === "enrollment")
            ? ("configuration-required" as const)
            : ("ready" as const);

        return {
          ok: true,
          detail: `${host.label} (${host.sshEndpoint}): ${streamed.success.detail}`,
          stages,
          disposition,
          version: admission.localApp.version,
        } satisfies DeployRemoteResult;
      }),
    ),
});

export const darwinRemoteDeploymentProvider: RemoteDeploymentProvider =
  makeDarwinRemoteDeploymentProvider({
    artifactAuthority: makeProductionDarwinArtifactAuthority(),
    liveWorkAuthority: makeProductionDarwinLiveWorkAuthority(),
    streamArtifact: streamArtifactToRemote,
    localPlatform: process.platform,
  });
