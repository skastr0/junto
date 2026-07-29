/**
 * Ubuntu Remote deployment.
 *
 * The Command Center admits a complete signed release bundle locally, proves
 * the fixed Remote platform, holds a host-scoped terminal route cut, and then
 * streams the bundle to one preinstalled root-owned helper. No candidate path,
 * package-manager command, repair path, or sudo argv is caller-controlled.
 */

import { createHash, randomBytes } from "node:crypto";
import { lstat } from "node:fs/promises";
import { Effect, Fiber, Queue, Stream } from "effect";
import { LINUX_RELEASE_MANIFEST } from "../../../../scripts/linux-release-bundle";
import {
  ensureLinuxReleaseCache,
  linuxRemoteArtifactBundleRoot,
} from "./linux-release-feed";
import {
  LINUX_RELEASE_BRIDGE_STAGE_PROTOCOL,
  decodeLinuxReleaseBridgeAuthArmed,
  decodeLinuxReleaseBridgeStageCleared,
  encodeLinuxReleaseBridgeAuthArmed,
  encodeLinuxReleaseBridgeInventory,
  encodeLinuxReleaseBridgeStageCleared,
  encodeLinuxReleaseBridgeStageRequest,
  type LinuxReleaseBridgeAuthArmed,
  type LinuxReleaseBridgeCandidate,
  type LinuxReleaseBridgeStageCleared,
  type LinuxReleaseBridgeStageRequest,
  type LinuxReleaseBridgeTarget,
} from "@shared/linux-release-bridge";
import {
  LINUX_RELEASE_INSTALLER_MAX_BUNDLE_BYTES,
  LINUX_RELEASE_INSTALLER_MAX_FILES,
  LINUX_RELEASE_INSTALLER_PROTOCOL,
  decodeLinuxReleaseInstallerReceipt,
  decodeLinuxReleaseInstallerRequest,
  encodeLinuxReleaseInstallerReceipt,
  encodeLinuxReleaseInstallerRequest,
  type LinuxReleaseInstallerFile,
  type LinuxReleaseInstallerReceipt,
  type LinuxReleaseInstallerRequest,
} from "@shared/linux-release-installer";
import {
  makeRemoteStdin,
} from "../ssh/domain";
import {
  deploymentStream,
  oneShotWithStdin,
} from "../ssh/program";
import {
  compileLinuxReleaseBridge,
  compileLinuxRemotePreflight,
  compileLinuxRemotePreflightSource,
} from "../ssh/remote-plan";
import type { SshLease } from "../ssh/service";
import {
  authorizeProductionLinuxDeployBundle,
  openVerifiedProductionLinuxDeployBundle,
  verifyProductionLinuxDeployBundle,
  type ProductionLinuxDeployBundleAdmission,
} from "./linux-release-admission";
import {
  linuxAdministratorCredentialMatches,
  takeLinuxAdministratorPasswordLine,
  type LinuxAdministratorCredentialBinding,
} from "./linux-administrator-credential";
import {
  type DeployRemoteResult,
  type RemoteDeploymentProvider,
  type RemoteDeploymentProviderInput,
} from "./remote-deployment";

const HELPER = "/usr/libexec/vellum-release-installer";
const BRIDGE = "/usr/libexec/vellum-release-bridge";
const SHA256 = /^[0-9a-f]{64}$/u;
const SEMVER =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const HOST =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;
const OBSERVATION = /^[0-9A-Za-z][0-9A-Za-z._:-]{0,127}$/u;
const MAX_ACTIVE_TERMINAL_SESSIONS = 4_096;
const MIN_FREE_BYTES = 512 * 1024 * 1024;
const MAX_STAGES = 24;
const MAX_STAGE_BYTES = 192;
const MAX_PROTOCOL_OUTPUT_BYTES = 64 * 1024;
const MAX_PROTOCOL_LINE_BYTES = 16 * 1024;
const MAX_SSH_WRITE_BYTES = 1024 * 1024;

const LINUX_PREFLIGHT =
  /^LINUX_REMOTE_PREFLIGHT_V3 disk=([1-9][0-9]{0,19}) current=(none|[0-9]+\.[0-9]+\.[0-9]+) enabled=([01]) active=([01]) linger=([01]) helper=([01]) bridge=([01]) ready=([01]) generation=(none|[0-9a-f]{32}) uid=([1-9][0-9]{0,9}) gid=([1-9][0-9]{0,9}) host=([a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?) libc=([0-9]+\.[0-9]+) unit=(not-found|present)$/u;
const LINUX_PREFLIGHT_REFUSED =
  /^LINUX_REMOTE_PREFLIGHT_REFUSED_V3 reason=(os|release|architecture|libc|commands|systemd-user|disk|package|version|linger|identity)$/u;

export type LinuxRemotePreflightEvidence =
  | {
      readonly ok: true;
      readonly availableBytes: number;
      readonly installedVersion?: string;
      readonly serviceEnabled: boolean;
      readonly serviceActive: boolean;
      readonly lingerEnabled: boolean;
      readonly helperInstalled: boolean;
      readonly bridgeInstalled: boolean;
      readonly currentReady: boolean;
      readonly generation?: string;
      readonly uid: number;
      readonly gid: number;
      readonly host: string;
      readonly libcVersion: string;
      readonly unitState: "not-found" | "present";
    }
  | {
      readonly ok: false;
      readonly reason:
        | "os"
        | "release"
        | "architecture"
        | "libc"
        | "commands"
        | "systemd-user"
        | "disk"
        | "package"
        | "version"
        | "linger"
        | "identity"
        | "malformed";
    };

export const decodeLinuxRemotePreflight = (
  stdout: string,
): LinuxRemotePreflightEvidence => {
  if (!stdout.endsWith("\n") || stdout.indexOf("\n") !== stdout.length - 1) {
    return { ok: false, reason: "malformed" };
  }
  const line = stdout.slice(0, -1);
  const refused = LINUX_PREFLIGHT_REFUSED.exec(line);
  if (refused !== null) {
    return {
      ok: false,
      reason: refused[1] as Exclude<
        LinuxRemotePreflightEvidence,
        { readonly ok: true }
      >["reason"],
    };
  }
  const match = LINUX_PREFLIGHT.exec(line);
  if (match === null) return { ok: false, reason: "malformed" };
  const availableBytes = Number(match[1]);
  const uid = Number(match[10]);
  const gid = Number(match[11]);
  const currentReady = match[8] === "1";
  const installedVersion =
    match[2] === "none" ? undefined : match[2];
  const unitState = match[14] as "not-found" | "present";
  if (
    !Number.isSafeInteger(availableBytes) ||
    availableBytes <= 0 ||
    !Number.isSafeInteger(uid) ||
    uid <= 0 ||
    !Number.isSafeInteger(gid) ||
    gid <= 0 ||
    !HOST.test(match[12] ?? "") ||
    (installedVersion === undefined && unitState !== "not-found") ||
    (installedVersion !== undefined && unitState !== "present") ||
    (installedVersion === undefined &&
      (match[3] !== "0" ||
        match[4] !== "0" ||
        currentReady)) ||
    (currentReady &&
      (match[3] !== "1" ||
        match[4] !== "1" ||
        match[9] === "none")) ||
    (!currentReady && match[9] !== "none")
  ) {
    return { ok: false, reason: "malformed" };
  }
  return Object.freeze({
    ok: true as const,
    availableBytes,
    ...(installedVersion === undefined ? {} : { installedVersion }),
    serviceEnabled: match[3] === "1",
    serviceActive: match[4] === "1",
    lingerEnabled: match[5] === "1",
    helperInstalled: match[6] === "1",
    bridgeInstalled: match[7] === "1",
    currentReady,
    ...(match[9] === "none" ? {} : { generation: match[9] }),
    uid,
    gid,
    host: match[12]!,
    libcVersion: match[13]!,
    unitState,
  });
};

/**
 * Read-only platform and generation proof. Privileged recovery and package
 * state are deliberately absent: those belong exclusively to the helper.
 * Source of truth: `compileLinuxRemotePreflightSource` in remote-plan.
 */
export const buildLinuxRemotePreflightScript = (): string =>
  compileLinuxRemotePreflightSource();

/** The mutation command is a fixed executable with no caller-controlled argv. */
export const buildLinuxRemoteDeployCommand = (): Readonly<{
  executable: typeof BRIDGE;
  args: readonly [];
}> => Object.freeze({ executable: BRIDGE, args: [] as const });

export interface LinuxRemoteArtifactBundleEntry {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly stream: NodeJS.ReadableStream & AsyncIterable<Buffer>;
}

export interface LinuxRemoteArtifactAdmission {
  readonly version: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly sourceRevision: string;
  readonly manifestSha256: string;
  readonly bundleBytes: number;
  readonly files: ReadonlyArray<LinuxReleaseInstallerFile>;
  readonly openBundle: () => AsyncIterable<LinuxRemoteArtifactBundleEntry>;
}

export interface LinuxRemoteArtifactCandidate {
  readonly version: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly manifestSha256: string;
  readonly bundleBytes: number;
  readonly authorize: (
    preflight: Extract<LinuxRemotePreflightEvidence, { readonly ok: true }>,
  ) => LinuxRemoteArtifactAdmission;
}

export type LinuxRemoteArtifactAuthority = {
  readonly resolve: () => Promise<LinuxRemoteArtifactCandidate>;
};

const bytewiseCompare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const boundedBundleInventory = (
  admission: ProductionLinuxDeployBundleAdmission,
): {
  readonly manifestSha256: string;
  readonly bundleBytes: number;
  readonly files: ReadonlyArray<LinuxReleaseInstallerFile>;
} => {
  const files = admission.receipt.bundleFiles.map((entry) =>
    Object.freeze({
      name: entry.file,
      bytes: entry.bytes,
      sha256: entry.sha256,
    }),
  );
  if (
    files.length === 0 ||
    files.length > LINUX_RELEASE_INSTALLER_MAX_FILES ||
    files.some(
      (entry, index) =>
        entry.bytes <= 0 ||
        !Number.isSafeInteger(entry.bytes) ||
        !SHA256.test(entry.sha256) ||
        (index > 0 &&
          bytewiseCompare(files[index - 1]!.name, entry.name) >= 0),
    )
  ) {
    throw new Error("signed Linux bundle inventory exceeds installer policy");
  }
  const bundleBytes = files.reduce((total, entry) => total + entry.bytes, 0);
  if (
    !Number.isSafeInteger(bundleBytes) ||
    bundleBytes <= 0 ||
    bundleBytes > LINUX_RELEASE_INSTALLER_MAX_BUNDLE_BYTES
  ) {
    throw new Error("signed Linux bundle exceeds installer byte policy");
  }
  const manifest = files.find(
    (entry) => entry.name === LINUX_RELEASE_MANIFEST,
  );
  if (manifest === undefined) {
    throw new Error("signed Linux bundle omits its manifest receipt");
  }
  return Object.freeze({
    manifestSha256: manifest.sha256,
    bundleBytes,
    files: Object.freeze(files),
  });
};

export { linuxRemoteArtifactBundleRoot } from "./linux-release-feed";

/**
 * Production trust is compiled into the application by the release authority.
 * The mutable candidate cannot provide keys, pins, target facts, or a path.
 *
 * Cache source of truth: stable channel on the release Worker (R2). Local
 * ~/.vellum/releases/linux-x64-glibc/current is a seated cache after download.
 */
export const makeProductionLinuxArtifactAuthority = (
  home?: string,
): LinuxRemoteArtifactAuthority => {
  const resolvedHome = home;
  return Object.freeze({
    resolve: async () => {
      const cache = await ensureLinuxReleaseCache({
        ...(resolvedHome === undefined ? {} : { home: resolvedHome }),
      });
      const bundleRoot = cache.bundleRoot;
      const metadata = await lstat(bundleRoot);
      const expectedUid = process.getuid?.();
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        (metadata.mode & 0o022) !== 0 ||
        (expectedUid !== undefined && metadata.uid !== expectedUid)
      ) {
        throw new Error("Linux Remote release bundle is not owner-controlled");
      }
      const candidate =
        await verifyProductionLinuxDeployBundle({
          bundleDirectory: bundleRoot,
        });
      const manifest = candidate.receipt.bundleFiles.find(
        (entry) => entry.file === LINUX_RELEASE_MANIFEST,
      );
      const bundleBytes = candidate.receipt.bundleFiles.reduce(
        (total, entry) => total + entry.bytes,
        0,
      );
      if (
        manifest === undefined ||
        !Number.isSafeInteger(bundleBytes) ||
        bundleBytes <= 0 ||
        bundleBytes > LINUX_RELEASE_INSTALLER_MAX_BUNDLE_BYTES
      ) {
        throw new Error("signed Linux bundle inventory is invalid");
      }
      return Object.freeze({
        version: candidate.version,
        bytes: candidate.bytes,
        sha256: candidate.sha256,
        manifestSha256: manifest.sha256,
        bundleBytes,
        authorize: (
          preflight: Extract<
            LinuxRemotePreflightEvidence,
            { readonly ok: true }
          >,
        ): LinuxRemoteArtifactAdmission => {
          const admission = authorizeProductionLinuxDeployBundle(candidate, {
            ...(preflight.installedVersion === undefined
              ? {}
              : { installedVersion: preflight.installedVersion }),
            remoteTarget: {
              distribution: "ubuntu",
              distributionVersion: "24.04",
              architecture: "x86_64",
              libcFamily: "glibc",
              libcVersion: preflight.libcVersion,
            },
          });
          const inventory = boundedBundleInventory(admission);
          return Object.freeze({
            version: admission.version,
            bytes: admission.bytes,
            sha256: admission.sha256,
            sourceRevision: admission.receipt.sourceRevision,
            manifestSha256: inventory.manifestSha256,
            bundleBytes: inventory.bundleBytes,
            files: inventory.files,
            openBundle: () =>
              openVerifiedProductionLinuxDeployBundle(
                admission,
              ) as AsyncIterable<LinuxRemoteArtifactBundleEntry>,
          });
        },
      });
    },
  });
};

export type LinuxRemoteLiveWorkEvidence = {
  readonly activeTerminalSessions: number;
  readonly observationId: string;
};

export type LinuxRemoteLiveWorkAdmission =
  | {
      readonly acquired: true;
      readonly evidence: LinuxRemoteLiveWorkEvidence & {
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
      readonly evidence: LinuxRemoteLiveWorkEvidence;
    };

export type LinuxRemoteLiveWorkAuthority = {
  readonly acquire: (
    input: RemoteDeploymentProviderInput,
    installedVersion: string | undefined,
    proveBootstrapAbsence: () => Promise<boolean>,
  ) => Effect.Effect<LinuxRemoteLiveWorkAdmission, Error>;
};

/**
 * The router cut lives in Command Center memory, so restarting the Remote
 * cannot reopen terminal admission. Bootstrap installs the same cut first and
 * then reruns the fixed absence proof without dialing a nonexistent service.
 */
export const makeProductionLinuxLiveWorkAuthority =
  (): LinuxRemoteLiveWorkAuthority =>
    Object.freeze({
      acquire: (providerInput, installedVersion, proveBootstrapAbsence) =>
        Effect.tryPromise({
          try: async () => {
            const { termPlane } = await import("../term/plane");
            if (installedVersion === undefined) {
              const lease =
                await termPlane.router.acquireRemoteHostBootstrapMaintenance(
                  providerInput.target.host.id,
                  {
                    prove: async (target) => {
                      if (
                        target.endpoint !==
                        String(providerInput.target.endpoint)
                      ) {
                        throw new Error(
                          "terminal bootstrap target changed",
                        );
                      }
                      if (!(await proveBootstrapAbsence())) {
                        throw new Error(
                          "remote bootstrap absence proof was denied",
                        );
                      }
                      return {
                        hostId: target.hostId,
                        endpoint: target.endpoint,
                        packageState: "absent" as const,
                        unitState: "not-found" as const,
                      };
                    },
                  },
                );
              return {
                acquired: true as const,
                evidence: {
                  activeTerminalSessions: 0 as const,
                  observationId: `bootstrap-${providerInput.target.host.id}`,
                },
                release: Effect.sync(() => {
                  lease.release();
                }),
              };
            }
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
          catch: (error) =>
            error instanceof Error ? error : new Error(String(error)),
        }),
    });

const appendStage = (stages: string[], value: string): void => {
  if (stages.length >= MAX_STAGES) return;
  const encoded = Buffer.from(value, "utf8");
  const prefix = encoded
    .subarray(0, MAX_STAGE_BYTES - 3)
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
  stages.push(
    encoded.byteLength <= MAX_STAGE_BYTES ? value : `${prefix}...`,
  );
};

const boundedStages = (values: readonly string[]): string[] => {
  const stages: string[] = [];
  for (const value of values) appendStage(stages, value);
  return stages;
};

const deployFailure = (
  input: RemoteDeploymentProviderInput,
  stages: readonly string[],
  detail: string,
  options: {
    readonly code: NonNullable<DeployRemoteResult["code"]>;
    readonly disposition: DeployRemoteResult["disposition"];
    readonly version?: string;
    readonly recoveryAction?: DeployRemoteResult["recoveryAction"];
  },
): DeployRemoteResult => ({
  ok: false,
  detail: `${input.target.host.label}: ${detail}`,
  code: options.code,
  message: detail,
  stages: Object.freeze([...stages]),
  disposition: options.disposition,
  ...(options.version === undefined ? {} : { version: options.version }),
  ...(options.recoveryAction === undefined
    ? {}
    : { recoveryAction: options.recoveryAction }),
});

const preflightDetail = (
  reason: Exclude<LinuxRemotePreflightEvidence, { readonly ok: true }>["reason"],
): string => {
  switch (reason) {
    case "os":
    case "release":
      return "Linux Remote requires Ubuntu 24.04";
    case "architecture":
      return "Linux Remote requires x86_64";
    case "libc":
      return "Linux Remote requires glibc 2.39 or newer";
    case "commands":
      return "Linux Remote prerequisites are incomplete";
    case "systemd-user":
      return "the Remote systemd user manager or unit state is malformed";
    case "disk":
      return "the Remote has insufficient bounded staging, install, and forward-repair reserve";
    case "package":
      return "the installed Vellum Remote package state is malformed";
    case "version":
      return "the admitted package version is invalid";
    case "linger":
      return "the Remote linger state could not be proven";
    case "identity":
      return "the Remote POSIX identity is unsupported";
    case "malformed":
      return "the Remote preflight receipt is malformed";
  }
};

const preflightInput = (
  candidate: Pick<
    LinuxRemoteArtifactCandidate,
    "bundleBytes" | "version" | "sha256" | "manifestSha256"
  >,
): string =>
  `${candidate.bundleBytes}\n${candidate.version}\n${candidate.sha256}\n${candidate.manifestSha256}\n`;

const runPreflight = (
  input: RemoteDeploymentProviderInput,
  candidate: LinuxRemoteArtifactCandidate,
) =>
  Effect.gen(function* () {
    const command = yield* compileLinuxRemotePreflight();
    const stdin = yield* makeRemoteStdin(preflightInput(candidate));
    const result = yield* input.ssh.run(
      oneShotWithStdin(input.target.sshTarget, command, stdin, {
        budget: "standard",
      }),
    );
    if (result.stderr !== "") {
      return yield* Effect.fail(
        new Error("fixed Ubuntu preflight returned diagnostics"),
      );
    }
    return decodeLinuxRemotePreflight(result.stdout);
  });

class LinuxDeploymentProtocolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "LinuxDeploymentProtocolError";
  }
}

type ProtocolOutput =
  | { readonly _tag: "Line"; readonly line: string }
  | { readonly _tag: "End" }
  | { readonly _tag: "Failure"; readonly error: Error };

interface ProtocolOutputReader {
  readonly take: Effect.Effect<ProtocolOutput, Error>;
  readonly stderr: Fiber.RuntimeFiber<number, Error>;
}

class BoundedProtocolLineParser {
  #pending = Buffer.alloc(0);
  #totalBytes = 0;

  public push(chunk: Uint8Array): readonly string[] {
    this.#totalBytes += chunk.byteLength;
    if (this.#totalBytes > MAX_PROTOCOL_OUTPUT_BYTES) {
      throw new LinuxDeploymentProtocolError(
        "Linux release transcript exceeded its output boundary",
      );
    }
    this.#pending = Buffer.concat([
      this.#pending,
      Buffer.from(chunk),
    ]);
    const lines: string[] = [];
    for (;;) {
      const newline = this.#pending.indexOf(0x0a);
      if (newline < 0) break;
      const bytes = this.#pending.subarray(0, newline);
      this.#pending = this.#pending.subarray(newline + 1);
      if (
        bytes.byteLength === 0 ||
        bytes.byteLength > MAX_PROTOCOL_LINE_BYTES ||
        bytes.includes(0x00) ||
        bytes.includes(0x0d)
      ) {
        throw new LinuxDeploymentProtocolError(
          "Linux release transcript contains a malformed line",
        );
      }
      try {
        lines.push(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
      } catch {
        throw new LinuxDeploymentProtocolError(
          "Linux release transcript is not canonical UTF-8",
        );
      }
    }
    if (this.#pending.byteLength > MAX_PROTOCOL_LINE_BYTES) {
      throw new LinuxDeploymentProtocolError(
        "Linux release transcript line is oversized",
      );
    }
    return lines;
  }

  public end(): void {
    if (this.#pending.byteLength !== 0) {
      throw new LinuxDeploymentProtocolError(
        "Linux release transcript ended with a partial line",
      );
    }
  }
}

const protocolOutput = (
  lease: SshLease,
): Effect.Effect<
  ProtocolOutputReader,
  never,
  import("effect").Scope.Scope
> =>
  Effect.gen(function* () {
    const queue = yield* Queue.bounded<ProtocolOutput>(8);
    const parser = new BoundedProtocolLineParser();
    const stdout = Stream.runForEach(lease.stdout, (chunk) =>
      Effect.try({
        try: () => parser.push(chunk),
        catch: (error) =>
          error instanceof Error ? error : new Error(String(error)),
      }).pipe(
        Effect.flatMap((lines) =>
          Effect.forEach(
            lines,
            (line) => Queue.offer(queue, { _tag: "Line", line }),
            { discard: true },
          ),
        ),
      ),
    ).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Queue.offer(queue, {
            _tag: "Failure",
            error: error instanceof Error
              ? error
              : new Error(String(error)),
          }),
        onSuccess: () =>
          Effect.try({
            try: () => parser.end(),
            catch: (error) =>
              error instanceof Error ? error : new Error(String(error)),
          }).pipe(
            Effect.matchEffect({
              onFailure: (error) =>
                Queue.offer(queue, { _tag: "Failure", error }),
              onSuccess: () => Queue.offer(queue, { _tag: "End" }),
            }),
          ),
      }),
    );
    yield* Effect.forkScoped(stdout);

    let stderrBytes = 0;
    const stderr = yield* Effect.forkScoped(
      Stream.runForEach(lease.stderr, (chunk) =>
        Effect.try({
          try: () => {
            stderrBytes += chunk.byteLength;
            if (stderrBytes > MAX_PROTOCOL_OUTPUT_BYTES) {
              throw new LinuxDeploymentProtocolError(
                "Linux release diagnostics exceeded their boundary",
              );
            }
          },
          catch: (error) =>
            error instanceof Error ? error : new Error(String(error)),
        }),
      ).pipe(Effect.zipRight(Effect.sync(() => stderrBytes))),
    );
    return {
      take: Queue.take(queue),
      stderr,
    };
  });

const takeProtocolLine = (
  output: ProtocolOutputReader,
): Effect.Effect<string, Error> =>
  output.take.pipe(
    Effect.flatMap((message) => {
      switch (message._tag) {
        case "Line":
          return Effect.succeed(message.line);
        case "Failure":
          return Effect.fail(message.error);
        case "End":
          return Effect.fail(
            new LinuxDeploymentProtocolError(
              "Linux release transcript ended before its receipt",
            ),
          );
      }
    }),
  );

const expectProtocolEnd = (
  output: ProtocolOutputReader,
): Effect.Effect<void, Error> =>
  output.take.pipe(
    Effect.flatMap((message) => {
      switch (message._tag) {
        case "End":
          return Effect.void;
        case "Failure":
          return Effect.fail(message.error);
        case "Line":
          return Effect.fail(
            new LinuxDeploymentProtocolError(
              "Linux release transcript contains an extra record",
            ),
          );
      }
    }),
  );

const exactBridgeAuth = (line: string): LinuxReleaseBridgeAuthArmed => {
  try {
    const decoded = decodeLinuxReleaseBridgeAuthArmed(
      JSON.parse(line) as unknown,
    );
    if (encodeLinuxReleaseBridgeAuthArmed(decoded) !== `${line}\n`) {
      throw new Error("non-canonical bridge record");
    }
    return decoded;
  } catch {
    throw new LinuxDeploymentProtocolError(
      "Linux release bridge returned a malformed authorization record",
    );
  }
};

const exactBridgeCleanup = (line: string): LinuxReleaseBridgeStageCleared => {
  try {
    const decoded = decodeLinuxReleaseBridgeStageCleared(
      JSON.parse(line) as unknown,
    );
    if (encodeLinuxReleaseBridgeStageCleared(decoded) !== `${line}\n`) {
      throw new Error("non-canonical bridge cleanup record");
    }
    return decoded;
  } catch {
    throw new LinuxDeploymentProtocolError(
      "Linux release bridge returned malformed cleanup evidence",
    );
  }
};

const exactInstallerReceipt = (
  line: string,
): LinuxReleaseInstallerReceipt => {
  try {
    const decoded = decodeLinuxReleaseInstallerReceipt(
      JSON.parse(line) as unknown,
    );
    if (encodeLinuxReleaseInstallerReceipt(decoded) !== `${line}\n`) {
      throw new Error("non-canonical installer receipt");
    }
    return decoded;
  } catch {
    throw new LinuxDeploymentProtocolError(
      "Linux release installer returned a malformed receipt",
    );
  }
};

const writeBounded = (
  lease: SshLease,
  bytes: Uint8Array,
): Effect.Effect<void, Error> =>
  Effect.forEach(
    Array.from(
      { length: Math.ceil(bytes.byteLength / MAX_SSH_WRITE_BYTES) },
      (_, index) =>
        bytes.subarray(
          index * MAX_SSH_WRITE_BYTES,
          Math.min((index + 1) * MAX_SSH_WRITE_BYTES, bytes.byteLength),
        ),
    ),
    (chunk) => lease.write(chunk),
    { discard: true },
  ).pipe(Effect.mapError((error) => error as Error));

const bundleFrame = async function* (
  admission: LinuxRemoteArtifactAdmission,
): AsyncIterable<Uint8Array> {
  let index = 0;
  for await (const entry of admission.openBundle()) {
    const expected = admission.files[index];
    if (
      expected === undefined ||
      entry.name !== expected.name ||
      entry.bytes !== expected.bytes ||
      entry.sha256 !== expected.sha256
    ) {
      throw new Error(
        "signed Linux bundle stream diverged from its admitted inventory",
      );
    }
    let bytes = 0;
    for await (const chunk of entry.stream) {
      bytes += chunk.byteLength;
      if (bytes > entry.bytes) {
        throw new Error("signed Linux bundle entry exceeded its receipt");
      }
      yield Uint8Array.from(chunk);
    }
    if (bytes !== entry.bytes) {
      throw new Error("signed Linux bundle entry ended before its receipt");
    }
    index += 1;
  }
  if (index !== admission.files.length) {
    throw new Error("signed Linux bundle stream omitted admitted entries");
  }
};

interface LinuxReleaseAttempt {
  readonly stage: LinuxReleaseBridgeStageRequest;
  readonly binding: LinuxAdministratorCredentialBinding;
}

const releaseAttempt = (
  input: RemoteDeploymentProviderInput,
  preflight: Extract<LinuxRemotePreflightEvidence, { readonly ok: true }>,
  admission: LinuxRemoteArtifactAdmission,
): LinuxReleaseAttempt => {
  const target: LinuxReleaseBridgeTarget = {
    uid: preflight.uid,
    gid: preflight.gid,
    host: preflight.host,
    stationId: input.target.host.id,
  };
  const provisionalCandidate: LinuxReleaseBridgeCandidate = {
    version: admission.version,
    manifestSha256: admission.manifestSha256,
    debSha256: admission.sha256,
    inventorySha256: "0".repeat(64),
  };
  const inventorySha256 = createHash("sha256")
    .update(
      encodeLinuxReleaseBridgeInventory({
        candidate: provisionalCandidate,
        totalBytes: admission.bundleBytes,
        files: admission.files,
      }),
      "utf8",
    )
    .digest("hex");
  const candidate: LinuxReleaseBridgeCandidate = {
    ...provisionalCandidate,
    inventorySha256,
  };
  const stage: LinuxReleaseBridgeStageRequest = {
    schema: LINUX_RELEASE_BRIDGE_STAGE_PROTOCOL,
    kind: "stage",
    transactionId: randomBytes(16).toString("hex"),
    providerNonce: randomBytes(16).toString("hex"),
    target,
    candidate,
    totalBytes: admission.bundleBytes,
    files: admission.files,
  };
  // Force the complete stage shape through the canonical decoder before the
  // provider asks for a password or cuts the live-work route.
  encodeLinuxReleaseBridgeStageRequest(stage);
  return Object.freeze({
    stage,
    binding: {
      hostId: input.target.host.id,
      endpoint: input.target.endpoint,
      version: candidate.version,
      manifestSha256: candidate.manifestSha256,
      debSha256: candidate.debSha256,
      inventorySha256: candidate.inventorySha256,
    },
  });
};

const targetsEqual = (
  left: LinuxReleaseBridgeTarget,
  right: LinuxReleaseBridgeTarget,
): boolean =>
  left.uid === right.uid &&
  left.gid === right.gid &&
  left.host === right.host &&
  left.stationId === right.stationId;

const candidatesEqual = (
  left: LinuxReleaseBridgeCandidate,
  right: LinuxReleaseBridgeCandidate,
): boolean =>
  left.version === right.version &&
  left.manifestSha256 === right.manifestSha256 &&
  left.debSha256 === right.debSha256 &&
  left.inventorySha256 === right.inventorySha256;

const authMatchesStage = (
  auth: LinuxReleaseBridgeAuthArmed,
  stage: LinuxReleaseBridgeStageRequest,
): boolean =>
  auth.transactionId === stage.transactionId &&
  auth.providerNonce === stage.providerNonce &&
  targetsEqual(auth.target, stage.target) &&
  candidatesEqual(auth.candidate, stage.candidate) &&
  auth.totalBytes === stage.totalBytes;

const validateStageCleanup = (
  cleanup: LinuxReleaseBridgeStageCleared,
  attempt: LinuxReleaseAttempt,
  auth: LinuxReleaseBridgeAuthArmed,
  reason: LinuxReleaseBridgeStageCleared["reason"],
): void => {
  if (
    cleanup.transactionId !== attempt.stage.transactionId ||
    cleanup.providerNonce !== attempt.stage.providerNonce ||
    cleanup.bridgeNonce !== auth.bridgeNonce ||
    !targetsEqual(cleanup.target, attempt.stage.target) ||
    !candidatesEqual(cleanup.candidate, attempt.stage.candidate) ||
    cleanup.totalBytes !== attempt.stage.totalBytes ||
    cleanup.reason !== reason ||
    cleanup.cleanup.files !== "cleared" ||
    cleanup.cleanup.directory !== "removed"
  ) {
    throw new LinuxDeploymentProtocolError(
      "Linux release bridge cleanup changed the admitted stage authority",
    );
  }
};

const validateRootArmed = (
  receipt: Extract<
    LinuxReleaseInstallerReceipt,
    { readonly ok: true; readonly state: "root-armed" }
  >,
  attempt: LinuxReleaseAttempt,
): void => {
  if (
    receipt.target.uid !== attempt.stage.target.uid ||
    receipt.target.gid !== attempt.stage.target.gid ||
    receipt.target.host !== attempt.stage.target.host
  ) {
    throw new LinuxDeploymentProtocolError(
      "root-armed receipt changed the sudo-derived Linux target",
    );
  }
};

const validateRootReady = (
  receipt: Extract<
    LinuxReleaseInstallerReceipt,
    { readonly ok: true; readonly state: "root-ready" }
  >,
  rootArmed: Extract<
    LinuxReleaseInstallerReceipt,
    { readonly ok: true; readonly state: "root-armed" }
  >,
  attempt: LinuxReleaseAttempt,
  auth: LinuxReleaseBridgeAuthArmed,
  preflight: Extract<LinuxRemotePreflightEvidence, { readonly ok: true }>,
): void => {
  const expectedPrior = preflight.installedVersion ?? null;
  const recovering = receipt.journalPredecessor !== null;
  const plannedSameVersion =
    receipt.fromVersion === attempt.stage.candidate.version;
  const expectedFenceOperation =
    receipt.operation === "install" ? "install" : "adopt";
  if (
    receipt.transactionId !== attempt.stage.transactionId ||
    receipt.providerNonce !== attempt.stage.providerNonce ||
    receipt.bridgeNonce !== auth.bridgeNonce ||
    receipt.helperChallenge !== rootArmed.helperChallenge ||
    receipt.machineIdSha256 !== rootArmed.machineIdSha256 ||
    receipt.bootId !== rootArmed.bootId ||
    !targetsEqual(receipt.target, attempt.stage.target) ||
    !candidatesEqual(receipt.candidate, attempt.stage.candidate) ||
    receipt.totalBytes !== attempt.stage.totalBytes ||
    receipt.currentVersion !== expectedPrior ||
    (!recovering && receipt.fromVersion !== expectedPrior) ||
    (recovering &&
      receipt.journalPredecessor?.transactionId ===
        attempt.stage.transactionId) ||
    receipt.fence.transactionId !== attempt.stage.transactionId ||
    receipt.fence.fenceId.length !== 32 ||
    receipt.fence.operation !== expectedFenceOperation ||
    receipt.fence.targetUid !== attempt.stage.target.uid ||
    receipt.fence.targetGid !== attempt.stage.target.gid ||
    receipt.fence.stationId !== attempt.stage.target.stationId ||
    receipt.fence.machineIdSha256 !== receipt.machineIdSha256 ||
    receipt.fence.bootId !== receipt.bootId ||
    receipt.fence.candidateDigest !==
      attempt.stage.candidate.inventorySha256 ||
    receipt.maintenance.activeTerminalSessions !== 0 ||
    (receipt.operation === "install" && plannedSameVersion) ||
    (receipt.operation === "adopt" && !plannedSameVersion)
  ) {
    throw new LinuxDeploymentProtocolError(
      "root-ready receipt changed the admitted Linux release authority",
    );
  }
};

const validateFinalReady = (
  receipt: Extract<
    LinuxReleaseInstallerReceipt,
    { readonly ok: true; readonly state: "ready" }
  >,
  rootReady: Extract<
    LinuxReleaseInstallerReceipt,
    { readonly ok: true; readonly state: "root-ready" }
  >,
  attempt: LinuxReleaseAttempt,
  auth: LinuxReleaseBridgeAuthArmed,
  admission: LinuxRemoteArtifactAdmission,
): void => {
  const recoveredTransactionId =
    rootReady.journalPredecessor?.transactionId ?? null;
  if (
    receipt.transactionId !== attempt.stage.transactionId ||
    receipt.providerNonce !== attempt.stage.providerNonce ||
    receipt.bridgeNonce !== auth.bridgeNonce ||
    receipt.helperChallenge !== rootReady.helperChallenge ||
    receipt.fenceId !== rootReady.fence.fenceId ||
    receipt.inventorySha256 !==
      attempt.stage.candidate.inventorySha256 ||
    receipt.operation !== rootReady.operation ||
    receipt.fromVersion !== rootReady.fromVersion ||
    receipt.toVersion !== admission.version ||
    receipt.manifestSha256 !== admission.manifestSha256 ||
    receipt.debSha256 !== admission.sha256 ||
    receipt.sourceRevision !== admission.sourceRevision ||
    receipt.recoveredTransactionId !== recoveredTransactionId ||
    receipt.readiness.state !== "ready" ||
    receipt.readiness.packageVersion !== admission.version
  ) {
    throw new LinuxDeploymentProtocolError(
      "final Linux readiness receipt changed the committed release authority",
    );
  }
};

const protocolStep = <A>(
  run: () => A,
): Effect.Effect<A, Error> =>
  Effect.try({
    try: run,
    catch: (error) =>
      error instanceof Error ? error : new Error(String(error)),
  });

type LinuxReleaseInstallerRefusal = Extract<
  LinuxReleaseInstallerReceipt,
  { readonly ok: false; readonly state: "refused" }
>;

type LinuxReleaseInstallerReady = Extract<
  LinuxReleaseInstallerReceipt,
  { readonly ok: true; readonly state: "ready" }
>;

type LinuxReleaseSessionOutcome =
  | {
      readonly kind: "authorization-failed";
      readonly cleanup: LinuxReleaseBridgeStageCleared;
    }
  | {
      readonly kind: "refused";
      readonly receipt: LinuxReleaseInstallerRefusal;
      readonly cleanup: LinuxReleaseBridgeStageCleared;
    }
  | {
      readonly kind: "ready";
      readonly receipt: LinuxReleaseInstallerReady;
      readonly cleanup: LinuxReleaseBridgeStageCleared;
    };

const afterPasswordRecord = (
  line: string,
):
  | {
      readonly kind: "cleanup";
      readonly cleanup: LinuxReleaseBridgeStageCleared;
    }
  | {
      readonly kind: "installer";
      readonly receipt: LinuxReleaseInstallerReceipt;
    } => {
  try {
    return {
      kind: "cleanup",
      cleanup: exactBridgeCleanup(line),
    };
  } catch {
    return {
      kind: "installer",
      receipt: exactInstallerReceipt(line),
    };
  }
};

const runReleaseSession = (
  input: RemoteDeploymentProviderInput,
  attempt: LinuxReleaseAttempt,
  admission: LinuxRemoteArtifactAdmission,
  preflight: Extract<LinuxRemotePreflightEvidence, { readonly ok: true }>,
): Effect.Effect<LinuxReleaseSessionOutcome, Error> =>
  Effect.gen(function* () {
    const command = yield* compileLinuxReleaseBridge();
    return yield* input.ssh.transact(
      deploymentStream(input.target.sshTarget, command),
      (lease) =>
        Effect.scoped(Effect.gen(function* () {
          const output = yield* protocolOutput(lease);
          const stageFrame = yield* protocolStep(() =>
            Buffer.from(
              encodeLinuxReleaseBridgeStageRequest(attempt.stage),
              "utf8",
            )
          );
          yield* writeBounded(
            lease,
            stageFrame,
          );
          yield* Stream.runForEach(
            Stream.fromAsyncIterable(
              bundleFrame(admission),
              (error) =>
                error instanceof Error
                  ? error
                  : new Error(String(error)),
            ),
            (chunk) => writeBounded(lease, chunk),
          );

          const authLine = yield* takeProtocolLine(output);
          const auth = yield* protocolStep(() =>
            exactBridgeAuth(authLine)
          );
          if (!authMatchesStage(auth, attempt.stage)) {
            return yield* Effect.fail(
              new LinuxDeploymentProtocolError(
                "Linux release bridge authorization changed the admitted target",
              ),
            );
          }

          const credential =
            input.authorization?.kind === "linux-administrator-password"
              ? input.authorization.credential
              : undefined;
          if (
            credential === undefined ||
            !linuxAdministratorCredentialMatches(
              credential,
              attempt.binding,
            )
          ) {
            return yield* Effect.fail(
              new LinuxDeploymentProtocolError(
                "Linux administrator authorization is unavailable",
              ),
            );
          }
          const passwordLine = yield* protocolStep(() =>
            takeLinuxAdministratorPasswordLine(
              credential,
              attempt.binding,
            )
          );
          yield* lease.writeSensitive(passwordLine).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                passwordLine.fill(0);
              }),
            ),
          );

          const finishParsedCleanup = (
            cleanup: LinuxReleaseBridgeStageCleared,
            reason: LinuxReleaseBridgeStageCleared["reason"],
            closeInput: boolean,
          ): Effect.Effect<LinuxReleaseBridgeStageCleared, Error> =>
            Effect.gen(function* () {
              if (closeInput) yield* lease.closeInput;
              yield* protocolStep(() =>
                validateStageCleanup(
                  cleanup,
                  attempt,
                  auth,
                  reason,
                )
              );
              yield* expectProtocolEnd(output);
              if ((yield* Fiber.join(output.stderr)) !== 0) {
                return yield* Effect.fail(
                  new LinuxDeploymentProtocolError(
                    "Linux release transaction included diagnostics",
                  ),
                );
              }
              return cleanup;
            });

          const takeCleanup = (
            reason: LinuxReleaseBridgeStageCleared["reason"],
            closeInput: boolean,
          ): Effect.Effect<LinuxReleaseBridgeStageCleared, Error> =>
            Effect.gen(function* () {
              if (closeInput) yield* lease.closeInput;
              const cleanupLine = yield* takeProtocolLine(output);
              const cleanup = yield* protocolStep(() =>
                exactBridgeCleanup(cleanupLine)
              );
              return yield* finishParsedCleanup(
                cleanup,
                reason,
                false,
              );
            });

          const armedLine = yield* takeProtocolLine(output);
          const afterPassword = yield* protocolStep(() =>
            afterPasswordRecord(armedLine)
          );
          if (afterPassword.kind === "cleanup") {
            const cleanup = yield* finishParsedCleanup(
              afterPassword.cleanup,
              "authorization-failed",
              true,
            );
            return {
              kind: "authorization-failed" as const,
              cleanup,
            };
          }
          const armed = afterPassword.receipt;
          if (!armed.ok) {
            if (armed.state !== "refused") {
              return yield* Effect.fail(
                new LinuxDeploymentProtocolError(
                  "Linux installer returned an unexpected non-refusal state before COMMIT",
                ),
              );
            }
            const cleanup = yield* takeCleanup(
              "installer-refused",
              true,
            );
            return {
              kind: "refused" as const,
              receipt: armed,
              cleanup,
            };
          }
          if (armed.state !== "root-armed") {
            return yield* Effect.fail(
              new LinuxDeploymentProtocolError(
                "Linux installer omitted the root authorization barrier",
              ),
            );
          }
          yield* protocolStep(() => validateRootArmed(armed, attempt));

          const prepare: LinuxReleaseInstallerRequest = {
            schema: LINUX_RELEASE_INSTALLER_PROTOCOL,
            kind: "prepare",
            transactionId: attempt.stage.transactionId,
            providerNonce: attempt.stage.providerNonce,
            bridgeNonce: auth.bridgeNonce,
            helperChallenge: armed.helperChallenge,
            target: attempt.stage.target,
            candidate: attempt.stage.candidate,
            totalBytes: attempt.stage.totalBytes,
            files: attempt.stage.files,
          };
          const prepareFrame = yield* protocolStep(() =>
            Buffer.from(
              encodeLinuxReleaseInstallerRequest(prepare),
              "utf8",
            )
          );
          yield* writeBounded(
            lease,
            prepareFrame,
          );

          const preparedLine = yield* takeProtocolLine(output);
          const prepared = yield* protocolStep(() =>
            exactInstallerReceipt(preparedLine)
          );
          if (!prepared.ok) {
            if (
              prepared.state !== "refused" ||
              prepared.transactionId !== attempt.stage.transactionId
            ) {
              return yield* Effect.fail(
                new LinuxDeploymentProtocolError(
                  "Linux installer returned an unbound pre-commit refusal",
                ),
              );
            }
            const cleanup = yield* takeCleanup(
              "installer-terminal",
              true,
            );
            return {
              kind: "refused" as const,
              receipt: prepared,
              cleanup,
            };
          }
          if (prepared.state !== "root-ready") {
            return yield* Effect.fail(
              new LinuxDeploymentProtocolError(
                "Linux installer committed before the provider barrier",
              ),
            );
          }
          yield* protocolStep(() =>
            validateRootReady(
              prepared,
              armed,
              attempt,
              auth,
              preflight,
            )
          );

          const commit: LinuxReleaseInstallerRequest = {
            schema: LINUX_RELEASE_INSTALLER_PROTOCOL,
            kind: "commit",
            transactionId: attempt.stage.transactionId,
            providerNonce: attempt.stage.providerNonce,
            bridgeNonce: auth.bridgeNonce,
            helperChallenge: prepared.helperChallenge,
            fenceId: prepared.fence.fenceId,
            inventorySha256:
              attempt.stage.candidate.inventorySha256,
          };
          const commitFrame = yield* protocolStep(() =>
            Buffer.from(
              encodeLinuxReleaseInstallerRequest(commit),
              "utf8",
            )
          );
          yield* writeBounded(
            lease,
            commitFrame,
          );
          yield* lease.closeInput;

          const finalLine = yield* takeProtocolLine(output);
          const final = yield* protocolStep(() =>
            exactInstallerReceipt(finalLine)
          );
          if (!final.ok) {
            // Once COMMIT has crossed, an installer refusal is indeterminate:
            // retain the forward-repair posture after bounded bridge cleanup.
            yield* takeCleanup("installer-terminal", false);
            return yield* Effect.fail(
              new LinuxDeploymentProtocolError(
                "Linux installer crossed COMMIT without final readiness; forward repair requires a newer signed release",
              ),
            );
          }
          if (final.state !== "ready") {
            return yield* Effect.fail(
              new LinuxDeploymentProtocolError(
                "Linux release transaction omitted final readiness",
              ),
            );
          }
          yield* protocolStep(() =>
            validateFinalReady(
              final,
              prepared,
              attempt,
              auth,
              admission,
            )
          );
          const cleanup = yield* takeCleanup(
            "installer-terminal",
            false,
          );
          return {
            kind: "ready" as const,
            receipt: final,
            cleanup,
          };
        })),
    );
  }).pipe(
    Effect.mapError((error) =>
      error instanceof Error ? error : new Error(String(error)),
    ),
  );

const refusalFailure = (
  input: RemoteDeploymentProviderInput,
  stages: readonly string[],
  version: string,
  receipt: Extract<
    LinuxReleaseInstallerReceipt,
    { readonly ok: false; readonly state: "refused" }
  >,
): DeployRemoteResult => {
  switch (receipt.action) {
    case "invoke-with-fixed-sudo-command":
      return deployFailure(
        input,
        stages,
        "the fixed root-owned Linux release installer or its sudo authority must be bootstrapped by an operator",
        {
          code: "auth_required",
          disposition: "not-started",
          version,
          recoveryAction: {
            kind: "bootstrap-linux-release-installer",
          },
        },
      );
    case "repair-root-installer-state-manually":
    case "repair-installed-package-manually":
      return deployFailure(
        input,
        stages,
        "the root-owned Linux release transaction state requires bounded operator repair before retry",
        {
          code: "conflict",
          disposition: "not-started",
          version,
          recoveryAction: {
            kind: "repair-linux-release-transaction",
          },
        },
      );
    case "retry-after-current-installer":
      return deployFailure(
        input,
        stages,
        "another root-owned Linux release transaction is active",
        {
          code: "conflict",
          disposition: "not-started",
          version,
          recoveryAction: { kind: "retry-linux-release-install" },
        },
      );
    case "send-a-new-bounded-frame":
    case "obtain-a-valid-signed-release":
      return deployFailure(
        input,
        stages,
        "the privileged installer refused the framed signed release before mutation",
        {
          code: "validation",
          disposition: "not-started",
          version,
        },
      );
  }
};

const sessionFailure = (
  input: RemoteDeploymentProviderInput,
  stages: readonly string[],
  version: string,
): DeployRemoteResult =>
  deployFailure(
    input,
    stages,
    "the staged Linux release did not produce exact cleanup, readiness, or forward-repair evidence",
    {
      code: "conflict",
      disposition: "indeterminate",
      version,
      recoveryAction: {
        kind: "repair-linux-release-transaction" as const,
      },
    },
  );

export const makeLinuxRemoteDeploymentProvider = (input: {
  readonly artifactAuthority: LinuxRemoteArtifactAuthority;
  readonly liveWorkAuthority: LinuxRemoteLiveWorkAuthority;
}): RemoteDeploymentProvider => ({
  platform: "linux",
  supportsBrowser: true,
  deploy: (providerInput) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { target, stationConfiguration } = providerInput;
        const stages = boundedStages(target.progress);
        if (target.platform.platform !== "linux") {
          return deployFailure(
            providerInput,
            stages,
            `Linux deployment provider refused ${target.platform.kernelName}`,
            { code: "validation", disposition: "not-started" },
          );
        }
        if (
          stationConfiguration.state !== "applied" ||
          stationConfiguration.remoteHostId !== target.host.id
        ) {
          return deployFailure(
            providerInput,
            stages,
            "validated Remote station configuration is required before Linux package deployment",
            { code: "validation", disposition: "not-started" },
          );
        }

        const resolved = yield* Effect.tryPromise({
          try: () => input.artifactAuthority.resolve(),
          catch: (error) =>
            error instanceof Error ? error : new Error(String(error)),
        }).pipe(Effect.either);
        if (resolved._tag === "Left") {
          return deployFailure(
            providerInput,
            stages,
            `exact signed Linux release bundle unavailable — ${resolved.left.message}`,
            { code: "not_found", disposition: "not-started" },
          );
        }
        const candidate = resolved.right;
        if (
          !SEMVER.test(candidate.version) ||
          candidate.bytes <= 0 ||
          candidate.bundleBytes <= 0 ||
          !SHA256.test(candidate.sha256) ||
          !SHA256.test(candidate.manifestSha256)
        ) {
          return deployFailure(
            providerInput,
            stages,
            "signed Linux release candidate metadata is malformed",
            { code: "validation", disposition: "not-started" },
          );
        }
        appendStage(stages, `signed artifact admitted version=${candidate.version}`);

        const preflightResult = yield* runPreflight(
          providerInput,
          candidate,
        ).pipe(Effect.either);
        if (preflightResult._tag === "Left") {
          return deployFailure(
            providerInput,
            stages,
            "fixed Ubuntu package preflight failed before transfer",
            {
              code: "io",
              disposition: "not-started",
              version: candidate.version,
            },
          );
        }
        const preflight = preflightResult.right;
        if (!preflight.ok) {
          return deployFailure(
            providerInput,
            stages,
            preflightDetail(preflight.reason),
            {
              code:
                preflight.reason === "malformed" ? "io" : "validation",
              disposition: "not-started",
              version: candidate.version,
            },
          );
        }
        if (!preflight.helperInstalled || !preflight.bridgeInstalled) {
          return deployFailure(
            providerInput,
            stages,
            "the fixed root-owned Linux release installer and unprivileged bridge must be bootstrapped by an operator",
            {
              code: "auth_required",
              disposition: "not-started",
              version: candidate.version,
              recoveryAction: {
                kind: "bootstrap-linux-release-installer",
              },
            },
          );
        }
        let admission: LinuxRemoteArtifactAdmission;
        try {
          admission = candidate.authorize(preflight);
        } catch (error) {
          return deployFailure(
            providerInput,
            stages,
            error instanceof Error
              ? error.message
              : "signed Linux release authorization failed",
            {
              code: "validation",
              disposition: "not-started",
              version: candidate.version,
            },
          );
        }
        if (
          admission.version !== candidate.version ||
          admission.bytes !== candidate.bytes ||
          admission.sha256 !== candidate.sha256 ||
          admission.manifestSha256 !== candidate.manifestSha256 ||
          admission.bundleBytes !== candidate.bundleBytes
        ) {
          return deployFailure(
            providerInput,
            stages,
            "signed Linux release authorization changed candidate identity",
            {
              code: "validation",
              disposition: "not-started",
              version: candidate.version,
            },
          );
        }
        const requiredBytes =
          admission.bundleBytes * 3 + MIN_FREE_BYTES;
        if (preflight.availableBytes < requiredBytes) {
          return deployFailure(
            providerInput,
            stages,
            "the Remote has insufficient bounded staging, install, and forward-repair reserve",
            {
              code: "validation",
              disposition: "not-started",
              version: admission.version,
            },
          );
        }

        const attempted = yield* protocolStep(() =>
          releaseAttempt(
            providerInput,
            preflight,
            admission,
          )
        ).pipe(Effect.either);
        if (attempted._tag === "Left") {
          return deployFailure(
            providerInput,
            stages,
            "the admitted Linux release inventory could not be framed into one bounded transaction",
            {
              code: "validation",
              disposition: "not-started",
              version: admission.version,
            },
          );
        }
        const attempt = attempted.right;
        const credential =
          providerInput.authorization?.kind ===
            "linux-administrator-password"
            ? providerInput.authorization.credential
            : undefined;
        if (
          !linuxAdministratorCredentialMatches(
            credential,
            attempt.binding,
          )
        ) {
          const authorizationRequest = {
            kind: "linux-administrator-password" as const,
            ...attempt.binding,
            endpoint: String(attempt.binding.endpoint),
          };
          return {
            ...deployFailure(
              providerInput,
              stages,
              "fresh administrator authorization is required for this exact Linux target and signed release",
              {
                code: "auth_required",
                disposition: "not-started",
                version: admission.version,
              },
            ),
            authorizationRequest,
          };
        }
        appendStage(
          stages,
          `preflight ok current=${preflight.installedVersion ?? "none"} helper=exact bridge=exact`,
        );

        const proveBootstrapAbsence = async (): Promise<boolean> => {
          const rerun = await Effect.runPromise(
            runPreflight(providerInput, candidate),
          );
          return (
            rerun.ok &&
            rerun.installedVersion === undefined &&
            rerun.unitState === "not-found" &&
            rerun.helperInstalled &&
            rerun.bridgeInstalled
          );
        };
        const maintenance = yield* Effect.acquireRelease(
          input.liveWorkAuthority.acquire(
            providerInput,
            preflight.installedVersion,
            proveBootstrapAbsence,
          ),
          (lease) => (lease.acquired ? lease.release : Effect.void),
        ).pipe(Effect.either);
        if (maintenance._tag === "Left") {
          return deployFailure(
            providerInput,
            stages,
            "the Command Center could not hold the Remote terminal route closed for package activation",
            {
              code: "conflict",
              disposition: "not-started",
              version: admission.version,
              recoveryAction: {
                kind: "restore-terminal-live-work-observation",
              },
            },
          );
        }
        const liveWork = maintenance.right;
        if (
          !Number.isSafeInteger(liveWork.evidence.activeTerminalSessions) ||
          liveWork.evidence.activeTerminalSessions < 0 ||
          liveWork.evidence.activeTerminalSessions >
            MAX_ACTIVE_TERMINAL_SESSIONS ||
          !OBSERVATION.test(liveWork.evidence.observationId) ||
          (liveWork.acquired &&
            liveWork.evidence.activeTerminalSessions !== 0) ||
          (!liveWork.acquired &&
            liveWork.reason === "active-terminal-sessions" &&
            liveWork.evidence.activeTerminalSessions === 0)
        ) {
          return deployFailure(
            providerInput,
            stages,
            "the Remote terminal maintenance receipt was malformed",
            {
              code: "conflict",
              disposition: "not-started",
              version: admission.version,
              recoveryAction: {
                kind: "restore-terminal-live-work-observation",
              },
            },
          );
        }
        if (!liveWork.acquired) {
          const recoveryAction =
            liveWork.reason === "active-terminal-sessions"
              ? {
                  kind: "close-active-vellum-terminals" as const,
                  activeTerminalSessions:
                    liveWork.evidence.activeTerminalSessions,
                }
              : {
                  kind:
                    "restore-terminal-live-work-observation" as const,
                };
          return deployFailure(
            providerInput,
            stages,
            liveWork.reason === "active-terminal-sessions"
              ? `package activation refused because ${liveWork.evidence.activeTerminalSessions} Vellum terminal sessions are active`
              : liveWork.reason === "maintenance-held"
                ? "another package activation holds the Remote terminal route cut"
                : "the Remote terminal plane is shutting down",
            {
              code: "conflict",
              disposition: "not-started",
              version: admission.version,
              recoveryAction,
            },
          );
        }
        appendStage(
          stages,
          `terminal route cut held observation=${liveWork.evidence.observationId}`,
        );

        const installed = yield* runReleaseSession(
          providerInput,
          attempt,
          admission,
          preflight,
        ).pipe(Effect.either);
        if (installed._tag === "Left") {
          return sessionFailure(
            providerInput,
            stages,
            admission.version,
          );
        }
        const outcome = installed.right;
        if (outcome.kind === "authorization-failed") {
          return deployFailure(
            providerInput,
            stages,
            "the one-shot Linux administrator password was not accepted; the exact staged payload was removed",
            {
              code: "auth_required",
              disposition: "not-started",
              version: admission.version,
            },
          );
        }
        if (outcome.kind === "refused") {
          return refusalFailure(
            providerInput,
            stages,
            admission.version,
            outcome.receipt,
          );
        }
        const receipt = outcome.receipt;
        appendStage(
          stages,
          `root-owned transaction ${attempt.stage.transactionId} committed operation=${receipt.operation}`,
        );
        appendStage(
          stages,
          `systemd generation ${receipt.readiness.generation} work control ready`,
        );
        const result: DeployRemoteResult = {
          ok: true,
          detail: `${target.host.label}: Linux Remote ${admission.version} installed from the signed bundle and structurally ready`,
          stages: Object.freeze([...stages]),
          disposition: "ready",
          version: admission.version,
        };
        return result;
      }),
    ),
});

export const linuxRemoteDeploymentProvider: RemoteDeploymentProvider =
  makeLinuxRemoteDeploymentProvider({
    artifactAuthority: makeProductionLinuxArtifactAuthority(),
    liveWorkAuthority: makeProductionLinuxLiveWorkAuthority(),
  });
