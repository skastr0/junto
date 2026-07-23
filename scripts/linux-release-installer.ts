import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  constants as fsConstants,
  type Stats,
} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  readdir,
  statfs,
  realpath,
  rename,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { hostname as kernelHostname } from "node:os";
import type { Socket } from "node:net";
import path from "node:path";
import process from "node:process";
import {
  LINUX_RELEASE_INSTALLER_JOURNAL,
  LINUX_RELEASE_INSTALLER_JOURNAL_PHASES,
  LINUX_RELEASE_INSTALLER_MAX_HEADER_BYTES,
  LINUX_RELEASE_INSTALLER_PROTOCOL,
  LINUX_RELEASE_INSTALLER_RECEIPT,
  decodeLinuxReleaseInstallerJournal,
  decodeLinuxReleaseInstallerRequest,
  encodeLinuxReleaseInstallerJournal,
  encodeLinuxReleaseInstallerReceipt,
  type LinuxReleaseInstallerCandidate,
  type LinuxReleaseInstallerFile,
  type LinuxReleaseInstallerJournal,
  type LinuxReleaseInstallerJournalPredecessor,
  type LinuxReleaseInstallerJournalPhase,
  type LinuxReleaseInstallerProcessIdentity,
  type LinuxReleaseInstallerReadinessEvidence,
  type LinuxReleaseInstallerReceipt,
  type LinuxReleaseInstallerRepairAction,
  type LinuxReleaseInstallerRequest,
  type LinuxReleaseInstallerTarget,
} from "../src/shared/linux-release-installer";
import {
  LINUX_RELEASE_BRIDGE_AUTH_METADATA,
  LINUX_RELEASE_BRIDGE_STAGE_METADATA,
  LINUX_RELEASE_BRIDGE_STAGE_ROOT,
  decodeLinuxReleaseBridgeAuthArmed,
  decodeLinuxReleaseBridgeStageRequest,
  encodeLinuxReleaseBridgeAuthArmed,
  encodeLinuxReleaseBridgeInventory,
  encodeLinuxReleaseBridgeStageRequest,
  linuxReleaseBridgeStagePath,
  type LinuxReleaseBridgeAuthArmed,
  type LinuxReleaseBridgeStageRequest,
} from "../src/shared/linux-release-bridge";
import {
  LINUX_RELEASE_FENCE_PROTOCOL,
  type LinuxReleaseFence,
} from "../src/shared/linux-release-fence";
import {
  LinuxReleaseFenceController,
  type LinuxReleaseFenceAuthority,
  type LinuxReleaseMaintenanceLease,
  type LinuxReleaseTermPeerObservation,
} from "./linux-release-fence-control";

/*
 * This file is build input, never the sudo target. Release packaging must
 * compile it into the root-owned standalone executable at FIXED_INSTALLER.
 * An env-resolved interpreter boundary would consume attacker-controlled
 * startup configuration before this program could reject it.
 */

const FIXED_INSTALLER = "/usr/libexec/vellum-release-installer";
const FIXED_STATE_ROOT = "/var/lib/vellum-release-installer";
const FIXED_SPOOL_ROOT = "/var/lib/vellum-release-installer/spool";
const FIXED_CACHE_ROOT = "/var/cache/vellum-release-installer";
const JOURNAL_FILE = "transaction.json";
const LOCK_FILE = "transaction.lock";
const MAX_JOURNAL_BYTES = 64 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const SAFE_USER = /^[a-z_][a-z0-9_-]{0,31}$/u;
const DECIMAL_ID = /^(0|[1-9][0-9]{0,9})$/u;
const DANGEROUS_ENVIRONMENT = [
  "BUN_OPTIONS",
  "BUN_INSTALL",
  "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
  "BUN_CONFIG_VERBOSE_FETCH",
  "BUN_CONFIG_LINK_NATIVE_BINS",
  "BUN_BE_BUN",
  "BUN_DEBUG_QUIET_LOGS",
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
] as const;
const SYSTEMD_UNSET_ENVIRONMENT = [
  "BASH_ENV",
  "BASHOPTS",
  "BUN_BE_BUN",
  "BUN_CONFIG_LINK_NATIVE_BINS",
  "BUN_CONFIG_VERBOSE_FETCH",
  "BUN_DEBUG_QUIET_LOGS",
  "BUN_INSTALL",
  "BUN_OPTIONS",
  "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
  "CHROME_WRAPPER",
  "ELECTRON_RUN_AS_NODE",
  "ENV",
  "GCONV_PATH",
  "GI_TYPELIB_PATH",
  "GIO_EXTRA_MODULES",
  "GLIBC_TUNABLES",
  "GTK_MODULES",
  "HOSTALIASES",
  "IFS",
  "LD_ASSUME_KERNEL",
  "LD_AUDIT",
  "LD_DEBUG",
  "LD_DEBUG_OUTPUT",
  "LD_LIBRARY_PATH",
  "LD_ORIGIN_PATH",
  "LD_PRELOAD",
  "LD_PROFILE",
  "LD_SHOW_AUXV",
  "LOCPATH",
  "MALLOC_TRACE",
  "NLSPATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REPL_EXTERNAL_MODULE",
  "PYTHONHOME",
  "PYTHONPATH",
  "QT_PLUGIN_PATH",
  "RESOLV_HOST_CONF",
  "SHELLOPTS",
  "TZDIR",
  "VELLUM_BROWSER_CAPABILITY",
  "VELLUM_BROWSER_HOME",
  "VELLUM_CANVASES_DIR",
  "VELLUM_E2E",
  "VELLUM_E2E_RENDERER_SURFACE_TIMEOUT_MS",
  "VELLUM_NODE_REF",
] as const;
const FORBIDDEN_SERVICE_ENVIRONMENT = new Set<string>(
  SYSTEMD_UNSET_ENVIRONMENT,
);

const forbiddenServiceEnvironmentName = (name: string): boolean =>
  FORBIDDEN_SERVICE_ENVIRONMENT.has(name) ||
  name.startsWith("BUN_") ||
  name.startsWith("DYLD_") ||
  name.startsWith("VELLUM_");

const exactProcessEnvironment = (
  actual: Readonly<Record<string, string>>,
  required: Readonly<Record<string, string>>,
): boolean => {
  const actualNames = Object.keys(actual).sort();
  const requiredNames = Object.keys(required).sort();
  return actualNames.length === requiredNames.length &&
    actualNames.every((name, index) => name === requiredNames[index]) &&
    Object.entries(required).every(([name, value]) => actual[name] === value);
};

const commandEnvironment = Object.freeze({
  PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
  LANG: "C",
  LC_ALL: "C",
  HOME: "/root",
  DEBIAN_FRONTEND: "noninteractive",
});

export interface LinuxReleaseInstallerInvocation {
  readonly effectiveUid: number;
  readonly arguments: ReadonlyArray<string>;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly hostname: string;
  readonly sudoUid: number;
  readonly sudoGid: number;
  readonly sudoUser: string;
  readonly sudoCommand: string;
  readonly process: LinuxReleaseInstallerProcessIdentity;
}

export interface LinuxReleaseInstallerDeadlines {
  readonly idleMs: number;
  readonly overallMs: number;
}

const defaultDeadlines: LinuxReleaseInstallerDeadlines = Object.freeze({
  idleMs: 30_000,
  overallMs: 15 * 60_000,
});

export interface VerifiedProtectedLinuxBundle {
  readonly version: string;
  readonly sourceRevision: string;
  readonly manifestSha256: string;
  readonly debFile: string;
  readonly debBytes: number;
  readonly debSha256: string;
}

export interface LinuxDebInspection {
  readonly packageName: string;
  readonly version: string;
  readonly architecture: string;
  readonly essential: "" | "no";
  readonly preDepends: "";
  readonly depends: string;
}

export interface LinuxOperationalState {
  readonly service:
    | "enabled-active"
    | "enabled-inactive"
    | "disabled-active"
    | "disabled-inactive"
    | "absent-inactive";
  readonly linger: boolean;
}

interface ProtectedStage {
  readonly transactionId: string;
  readonly files: ReadonlySet<string>;
}

interface ProtectedArtifact {
  readonly version: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface ImportedBridgeStage {
  readonly stage: ProtectedStage;
  readonly request: LinuxReleaseBridgeStageRequest;
  readonly auth: LinuxReleaseBridgeAuthArmed;
}

export interface LinuxReleaseFenceControl {
  readonly acquire: () => Promise<LinuxReleaseMaintenanceLease>;
  readonly prepare: (
    record: LinuxReleaseFence,
  ) => Promise<LinuxReleaseFenceAuthority>;
  readonly publish: (
    authority: LinuxReleaseFenceAuthority,
  ) => Promise<void>;
  readonly observePrepared: (
    record: LinuxReleaseFence,
    device: string | null,
    inode: string | null,
  ) => Promise<{
    readonly state: "pending" | "published" | "both" | "absent";
    readonly authority?: LinuxReleaseFenceAuthority;
  }>;
  readonly normalizePrepared: (
    authority: LinuxReleaseFenceAuthority,
  ) => Promise<"pending" | "published">;
  readonly adoptPublished: (
    record: LinuxReleaseFence,
    device: string,
    inode: string,
  ) => Promise<LinuxReleaseFenceAuthority>;
  readonly assertExact: (
    authority: LinuxReleaseFenceAuthority,
  ) => Promise<void>;
  readonly proveAbsent: (record: LinuxReleaseFence) => Promise<void>;
  readonly discardPrepared: (
    authority: LinuxReleaseFenceAuthority,
  ) => Promise<void>;
  readonly clear: (
    authority: LinuxReleaseFenceAuthority,
  ) => Promise<void>;
}

interface InstallerLock {
  readonly assertHeld: () => Promise<void>;
  readonly release: () => Promise<void>;
}

export interface LinuxReleaseInstallerHost {
  readonly ensureLayout: () => Promise<void>;
  readonly acquireLock: (
    owner: LinuxReleaseInstallerProcessIdentity,
  ) => Promise<InstallerLock>;
  readonly reconcileOrphans: (
    preserveTransactionId?: string,
  ) => Promise<void>;
  readonly readJournal: () => Promise<LinuxReleaseInstallerJournal | null>;
  readonly writeJournal: (
    journal: LinuxReleaseInstallerJournal,
  ) => Promise<void>;
  readonly clearJournal: () => Promise<void>;
  readonly isProcessLive: (
    identity: LinuxReleaseInstallerProcessIdentity,
  ) => Promise<boolean>;
  readonly beginStage: (transactionId: string) => Promise<ProtectedStage>;
  readonly reserveBundle: (bytes: number) => Promise<void>;
  readonly writeStageFile: (
    stage: ProtectedStage,
    descriptor: LinuxReleaseInstallerFile,
    chunks: AsyncIterable<Uint8Array>,
  ) => Promise<void>;
  readonly finishStage: (stage: ProtectedStage) => Promise<void>;
  readonly importBridgeStage: (
    request: Extract<
      LinuxReleaseInstallerRequest,
      { readonly kind: "prepare" }
    >,
  ) => Promise<ImportedBridgeStage>;
  readonly discardStage: (stage: ProtectedStage) => Promise<void>;
  readonly verifyProtectedBundle: (
    stage: ProtectedStage,
  ) => Promise<VerifiedProtectedLinuxBundle>;
  readonly inspectProtectedDeb: (
    stage: ProtectedStage,
    file: string,
  ) => Promise<LinuxDebInspection>;
  readonly currentVersion: () => Promise<string | null>;
  readonly observeCurrentVersion: () => Promise<string | null>;
  readonly currentOperationalState: (
    invocation: LinuxReleaseInstallerInvocation,
  ) => Promise<LinuxOperationalState>;
  readonly findCachedArtifact: (
    version: string,
  ) => Promise<ProtectedArtifact | null>;
  readonly cacheMatches: (
    candidate: LinuxReleaseInstallerCandidate,
  ) => Promise<boolean>;
  readonly cacheCandidate: (
    stage: ProtectedStage,
    verified: VerifiedProtectedLinuxBundle,
  ) => Promise<ProtectedArtifact>;
  readonly adoptInstalledCandidate: (
    stage: ProtectedStage,
    verified: VerifiedProtectedLinuxBundle,
    invocation: LinuxReleaseInstallerInvocation,
  ) => Promise<void>;
  readonly installCandidate: (
    stage: ProtectedStage,
    verified: VerifiedProtectedLinuxBundle,
  ) => Promise<void>;
  readonly activateAndVerify: (
    invocation: LinuxReleaseInstallerInvocation,
    version: string,
  ) => Promise<LinuxReleaseInstallerReadinessEvidence>;
  readonly verifyCurrentReadiness: (
    invocation: LinuxReleaseInstallerInvocation,
    version: string,
    generation: string,
  ) => Promise<LinuxReleaseInstallerReadinessEvidence>;
  readonly openFenceControl: (
    invocation: LinuxReleaseInstallerInvocation,
    target: LinuxReleaseInstallerTarget,
  ) => Promise<LinuxReleaseFenceControl>;
  readonly machineIdSha256: () => Promise<string>;
  readonly rollback: (
    invocation: LinuxReleaseInstallerInvocation,
    journal: LinuxReleaseInstallerJournal,
  ) => Promise<void>;
  readonly deleteCachedArtifact: (artifact: ProtectedArtifact) => Promise<void>;
}

export type VerifyProtectedLinuxBundle = (
  rootOnlyDirectory: string,
) => Promise<VerifiedProtectedLinuxBundle>;

export interface LinuxReleaseInstallerPaths {
  readonly stateRoot: string;
  readonly spoolRoot: string;
  readonly cacheRoot: string;
  readonly runtimeRoot?: string;
  readonly dpkgInfoRoot?: string;
  readonly installedRoot?: string;
}

export interface FixedCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type RunFixedCommand = (
  executable: string,
  arguments_: ReadonlyArray<string>,
  timeoutMs: number,
) => Promise<FixedCommandResult>;

export interface NodeLinuxReleaseInstallerHostOptions {
  readonly paths: LinuxReleaseInstallerPaths;
  readonly ownerUid: number;
  readonly ownerGid: number;
  readonly verifyProtectedBundle: VerifyProtectedLinuxBundle;
  readonly runCommand?: RunFixedCommand;
  readonly isProcessLive?: (
    identity: LinuxReleaseInstallerProcessIdentity,
  ) => Promise<boolean>;
  readonly acquireKernelLock?: (
    lockFile: string,
  ) => Promise<InstallerLock>;
  readonly bridgeStageRoot?: string;
  readonly fenceDirectory?: string;
  readonly fencePath?: string;
  readonly fenceControlFactory?: (
    invocation: LinuxReleaseInstallerInvocation,
    target: LinuxReleaseInstallerTarget,
  ) => Promise<LinuxReleaseFenceControl>;
  readonly readMachineIdSha256?: () => Promise<string>;
}

export class InstallerError extends Error {
  public constructor(
    readonly category:
      | "identity"
      | "protocol"
      | "busy"
      | "unsafe-state"
      | "verification"
      | "policy"
      | "install-failed"
      | "rollback-failed"
      | "internal",
    message: string,
  ) {
    super(message);
  }
}

const repairAction = (
  code: InstallerError["category"],
): LinuxReleaseInstallerRepairAction =>
  code === "identity"
    ? "invoke-with-fixed-sudo-command"
    : code === "protocol"
    ? "send-a-new-bounded-frame"
    : code === "busy"
    ? "retry-after-current-installer"
    : code === "verification"
    ? "obtain-a-valid-signed-release"
    : code === "install-failed"
    ? "retry-install"
    : code === "policy"
    ? "obtain-a-valid-signed-release"
    : "repair-root-installer-state-manually";

const refusal = (
  code: InstallerError["category"],
  transactionId: string | null,
): LinuxReleaseInstallerReceipt => {
  return {
    schema: LINUX_RELEASE_INSTALLER_RECEIPT,
    ok: false,
    state: "refused",
    code,
    transactionId,
    action: repairAction(code),
  };
};

const rolledBackReceipt = (
  code: InstallerError["category"],
  request: Extract<
    LinuxReleaseInstallerRequest,
    { readonly kind: "prepare" }
  >,
  helperChallenge: string,
  fenceId: string,
): LinuxReleaseInstallerReceipt => ({
  schema: LINUX_RELEASE_INSTALLER_RECEIPT,
  ok: false,
  state: "rolled-back",
  code,
  transactionId: request.transactionId,
  action: repairAction(code),
  providerNonce: request.providerNonce,
  bridgeNonce: request.bridgeNonce,
  helperChallenge,
  fenceId,
  inventorySha256: request.candidate.inventorySha256,
  cleanup: {
    fence: "cleared",
    journal: "cleared",
  },
});

const parsePositiveId = (value: string | undefined, label: string): number => {
  if (value === undefined || !DECIMAL_ID.test(value)) {
    throw new InstallerError("identity", `${label} is unavailable`);
  }
  const decoded = Number(value);
  if (!Number.isSafeInteger(decoded) || decoded < 1 || decoded > 0x7fff_ffff) {
    throw new InstallerError("identity", `${label} is invalid`);
  }
  return decoded;
};

export const deriveLinuxReleaseInstallerInvocation = async (): Promise<
  LinuxReleaseInstallerInvocation
> => {
  const environment = process.env;
  const stat = await readFile("/proc/self/stat", "utf8");
  const close = stat.lastIndexOf(")");
  const fields = close < 0 ? [] : stat.slice(close + 2).trim().split(/\s+/u);
  const startTicks = fields[19];
  const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8"))
    .trim();
  if (
    startTicks === undefined ||
    !/^(0|[1-9][0-9]{0,19})$/u.test(startTicks)
  ) {
    throw new InstallerError("identity", "kernel process identity is invalid");
  }
  return {
    effectiveUid: process.getuid?.() ?? -1,
    // The installed standalone has argv[0] only. Unlike a script interpreter,
    // its first caller argument is argv[1].
    arguments: process.argv.slice(1),
    environment,
    hostname: kernelHostname().toLowerCase(),
    sudoUid: parsePositiveId(environment.SUDO_UID, "sudo uid"),
    sudoGid: parsePositiveId(environment.SUDO_GID, "sudo gid"),
    sudoUser: environment.SUDO_USER ?? "",
    sudoCommand: environment.SUDO_COMMAND ?? "",
    process: {
      pid: process.pid,
      startTicks,
      bootId,
    },
  };
};

interface TrustedSudoTarget {
  readonly uid: number;
  readonly gid: number;
  readonly host: string;
}

const validateInvocation = (
  invocation: LinuxReleaseInstallerInvocation,
): TrustedSudoTarget => {
  if (
    invocation.effectiveUid !== 0 ||
    invocation.arguments.length !== 0 ||
    invocation.sudoCommand !== FIXED_INSTALLER ||
    !SAFE_USER.test(invocation.sudoUser) ||
    DANGEROUS_ENVIRONMENT.some((name) =>
      invocation.environment[name] !== undefined
    )
  ) {
    throw new InstallerError(
      "identity",
      "installer invocation is not the fixed sudo boundary",
    );
  }
  return {
    uid: invocation.sudoUid,
    gid: invocation.sudoGid,
    host: invocation.hostname,
  };
};

const targetsEqual = (
  left: TrustedSudoTarget,
  right: TrustedSudoTarget,
): boolean =>
  left.uid === right.uid && left.gid === right.gid && left.host === right.host;

class ExactFrameReader {
  readonly #iterator: AsyncIterator<Uint8Array>;
  #buffer = Buffer.alloc(0);
  #done = false;
  readonly #startedAt = Date.now();
  readonly #deadlines: LinuxReleaseInstallerDeadlines;

  public constructor(
    input: AsyncIterable<Uint8Array>,
    deadlines: LinuxReleaseInstallerDeadlines,
  ) {
    this.#iterator = input[Symbol.asyncIterator]();
    this.#deadlines = deadlines;
  }

  async #fill(): Promise<boolean> {
    while (this.#buffer.length === 0 && !this.#done) {
      const overallRemaining =
        this.#startedAt + this.#deadlines.overallMs - Date.now();
      if (overallRemaining <= 0) {
        throw new InstallerError("protocol", "installer frame timed out");
      }
      const waitMs = Math.min(this.#deadlines.idleMs, overallRemaining);
      const next = await new Promise<IteratorResult<Uint8Array>>(
        (resolve, reject) => {
          const timer = setTimeout(
            () => {
              void this.#iterator.return?.();
              reject(
                new InstallerError(
                  "protocol",
                  "installer frame input stalled",
                ),
              );
            },
            waitMs,
          );
          this.#iterator.next().then(
            (value) => {
              clearTimeout(timer);
              resolve(value);
            },
            (error) => {
              clearTimeout(timer);
              reject(error);
            },
          );
        },
      );
      if (next.done === true) {
        this.#done = true;
        return false;
      }
      const chunk = Buffer.from(next.value);
      if (chunk.length > 0) this.#buffer = chunk;
    }
    return this.#buffer.length > 0;
  }

  public async readHeader(): Promise<LinuxReleaseInstallerRequest> {
    const pieces: Buffer[] = [];
    let bytes = 0;
    while (await this.#fill()) {
      const newline = this.#buffer.indexOf(0x0a);
      const take = newline < 0 ? this.#buffer.length : newline;
      bytes += take;
      if (bytes > LINUX_RELEASE_INSTALLER_MAX_HEADER_BYTES) {
        throw new InstallerError("protocol", "installer header is oversized");
      }
      pieces.push(this.#buffer.subarray(0, take));
      this.#buffer = this.#buffer.subarray(
        newline < 0 ? take : take + 1,
      );
      if (newline >= 0) {
        const raw = Buffer.concat(pieces);
        if (raw.length === 0 || raw.includes(0x0d) || raw.includes(0x00)) {
          throw new InstallerError("protocol", "installer header is malformed");
        }
        try {
          return decodeLinuxReleaseInstallerRequest(
            JSON.parse(raw.toString("utf8")),
          );
        } catch (error) {
          throw new InstallerError(
            "protocol",
            error instanceof Error ? error.message : "invalid installer header",
          );
        }
      }
    }
    throw new InstallerError("protocol", "installer header is truncated");
  }

  public streamExact(bytes: number): AsyncIterable<Uint8Array> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        let remaining = bytes;
        while (remaining > 0) {
          if (!(await self.#fill())) {
            throw new InstallerError(
              "protocol",
              "installer file body is truncated",
            );
          }
          const take = Math.min(remaining, self.#buffer.length);
          const chunk = self.#buffer.subarray(0, take);
          self.#buffer = self.#buffer.subarray(take);
          remaining -= take;
          yield chunk;
        }
      },
    };
  }

  public async expectEof(): Promise<void> {
    if (this.#buffer.length > 0 || await this.#fill()) {
      throw new InstallerError(
        "protocol",
        "installer frame contains trailing bytes",
      );
    }
  }
}

const compareVersions = (left: string, right: string): number => {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

const phaseJournal = (
  journal: LinuxReleaseInstallerJournal,
  phase: LinuxReleaseInstallerJournalPhase,
  owner = journal.owner,
): LinuxReleaseInstallerJournal => ({
  ...journal,
  owner,
  phase,
});

const verifiedFileDescriptor = (
  request: Extract<LinuxReleaseInstallerRequest, { readonly kind: "prepare" }>,
  verified: VerifiedProtectedLinuxBundle,
): LinuxReleaseInstallerFile => {
  const descriptor = request.files.find((file) =>
    file.name === verified.debFile
  );
  if (
    descriptor === undefined ||
    descriptor.bytes !== verified.debBytes ||
    descriptor.sha256 !== verified.debSha256
  ) {
    throw new InstallerError(
      "verification",
      "verified package is not the exact protected frame entry",
    );
  }
  return descriptor;
};

const requestsBind = (
  prepare: Extract<LinuxReleaseInstallerRequest, { readonly kind: "prepare" }>,
  commit: Extract<LinuxReleaseInstallerRequest, { readonly kind: "commit" }>,
  helperChallenge: string,
  fenceId: string,
): boolean =>
  prepare.helperChallenge === helperChallenge &&
  commit.transactionId === prepare.transactionId &&
  commit.providerNonce === prepare.providerNonce &&
  commit.bridgeNonce === prepare.bridgeNonce &&
  commit.helperChallenge === helperChallenge &&
  commit.fenceId === fenceId &&
  commit.inventorySha256 === prepare.candidate.inventorySha256;

const bridgeMetadataBindsPrepare = (
  prepare: Extract<LinuxReleaseInstallerRequest, { readonly kind: "prepare" }>,
  stage: LinuxReleaseBridgeStageRequest,
  auth: LinuxReleaseBridgeAuthArmed,
): boolean => {
  return (
    stage.transactionId === prepare.transactionId &&
    stage.providerNonce === prepare.providerNonce &&
    auth.transactionId === prepare.transactionId &&
    auth.providerNonce === prepare.providerNonce &&
    auth.bridgeNonce === prepare.bridgeNonce &&
    targetsEqual(stage.target, prepare.target) &&
    stage.target.stationId === prepare.target.stationId &&
    targetsEqual(auth.target, prepare.target) &&
    auth.target.stationId === prepare.target.stationId &&
    stage.candidate.version === prepare.candidate.version &&
    stage.candidate.manifestSha256 === prepare.candidate.manifestSha256 &&
    stage.candidate.debSha256 === prepare.candidate.debSha256 &&
    stage.candidate.inventorySha256 === prepare.candidate.inventorySha256 &&
    auth.candidate.version === prepare.candidate.version &&
    auth.candidate.manifestSha256 === prepare.candidate.manifestSha256 &&
    auth.candidate.debSha256 === prepare.candidate.debSha256 &&
    auth.candidate.inventorySha256 === prepare.candidate.inventorySha256 &&
    JSON.stringify(stage.files) === JSON.stringify(prepare.files) &&
    stage.totalBytes === auth.totalBytes &&
    stage.totalBytes === prepare.totalBytes &&
    createHash("sha256")
      .update(encodeLinuxReleaseBridgeInventory(stage), "utf8")
      .digest("hex") === prepare.candidate.inventorySha256
  );
};

const stageBindsPrepare = (
  prepare: Extract<LinuxReleaseInstallerRequest, { readonly kind: "prepare" }>,
  imported: ImportedBridgeStage,
): boolean =>
  bridgeMetadataBindsPrepare(prepare, imported.request, imported.auth);

interface InterruptedTransaction {
  readonly journal: LinuxReleaseInstallerJournal;
  readonly predecessor: LinuxReleaseInstallerJournalPredecessor;
  readonly projectedVersion: string | null;
}

const PRE_MUTATION_PHASES = new Set<LinuxReleaseInstallerJournalPhase>([
  "fence-intent",
  "fence-prepared",
  "fence-published",
  "fence-acknowledged",
  "prepared",
]);

const ROLLBACK_REQUIRED_PHASES = new Set<LinuxReleaseInstallerJournalPhase>([
  "dpkg-started",
  "dpkg-installed",
  "activation-started",
  "rollback-started",
]);

const ROLLBACK_RESOLUTION_PHASES =
  new Set<LinuxReleaseInstallerJournalPhase>([
    "rolled-back",
    "rollback-acknowledged",
    "rollback-fence-clear-started",
    "rollback-fence-cleared",
  ]);

const ABORTED_RESOLUTION_PHASES =
  new Set<LinuxReleaseInstallerJournalPhase>([
    "aborted-acknowledged",
    "aborted-fence-clear-started",
    "aborted-fence-cleared",
  ]);

const CLEARED_FENCE_PHASES = new Set<LinuxReleaseInstallerJournalPhase>([
  "fence-cleared",
  "rollback-fence-cleared",
  "aborted-fence-cleared",
]);

const CLEAR_STARTED_PHASES = new Set<LinuxReleaseInstallerJournalPhase>([
  "fence-clear-started",
  "rollback-fence-clear-started",
  "aborted-fence-clear-started",
]);

const projectedVersionAfterRecovery = (
  journal: LinuxReleaseInstallerJournal,
): string | null =>
  PRE_MUTATION_PHASES.has(journal.phase) ||
    ROLLBACK_REQUIRED_PHASES.has(journal.phase) ||
    ROLLBACK_RESOLUTION_PHASES.has(journal.phase) ||
    ABORTED_RESOLUTION_PHASES.has(journal.phase)
    ? journal.fromVersion
    : journal.toVersion;

const inspectInterruptedTransaction = async (
  host: LinuxReleaseInstallerHost,
  target: LinuxReleaseInstallerTarget,
): Promise<InterruptedTransaction | null> => {
  const journal = await host.readJournal();
  if (journal === null) return null;
  const predecessor: LinuxReleaseInstallerJournalPredecessor = {
    transactionId: journal.transactionId,
    operation: journal.operation,
    phase: journal.phase,
  };
  if (!targetsEqual(journal.target, target)) {
    throw new InstallerError(
      "unsafe-state",
      "installer journal belongs to another trusted target",
    );
  }
  if (await host.isProcessLive(journal.owner)) {
    throw new InstallerError(
      "busy",
      "installer journal is owned by a live process",
    );
  }
  return {
    journal,
    predecessor,
    projectedVersion: projectedVersionAfterRecovery(journal),
  };
};

const recoveryExpectedVersion = (
  journal: LinuxReleaseInstallerJournal,
): string | null =>
  ROLLBACK_RESOLUTION_PHASES.has(journal.phase)
    ? journal.fromVersion
    : journal.toVersion;

const recoverInterruptedTransaction = async (
  host: LinuxReleaseInstallerHost,
  invocation: LinuxReleaseInstallerInvocation,
  fenceControl: LinuxReleaseFenceControl,
  interrupted: InterruptedTransaction,
  observedAuthority: LinuxReleaseFenceAuthority | undefined,
  observedPreparedState:
    | "pending"
    | "published"
    | "both"
    | "absent"
    | undefined,
  observedLease: LinuxReleaseMaintenanceLease,
): Promise<void> => {
  const journal = interrupted.journal;
  let lease: LinuxReleaseMaintenanceLease | undefined = observedLease;
  if (CLEARED_FENCE_PHASES.has(journal.phase)) {
    try {
      await fenceControl.proveAbsent(journal.fence.record);
      await host.clearJournal();
      return;
    } finally {
      await lease.release().catch(() => undefined);
    }
  }
  if (
    journal.phase === "fence-intent" ||
    journal.phase === "fence-prepared"
  ) {
    if (observedPreparedState === "absent") {
      try {
        await fenceControl.proveAbsent(journal.fence.record);
        await host.clearJournal();
        return;
      } finally {
        await lease.release().catch(() => undefined);
      }
    }
    if (
      observedAuthority === undefined ||
      observedPreparedState === undefined
    ) {
      throw new InstallerError(
        "unsafe-state",
        "prepared recovery fence authority is unavailable",
      );
    }
    const topology = await fenceControl.normalizePrepared(observedAuthority);
    if (topology === "pending") {
      try {
        await fenceControl.discardPrepared(observedAuthority);
        await host.clearJournal();
        return;
      } finally {
        await lease.release().catch(() => undefined);
      }
    } else {
      await lease.acknowledge(observedAuthority);
    }
  }
  let recovering = journal;
  const authority = observedAuthority;
  let resolution: "committed" | "rollback" | "aborted" =
    PRE_MUTATION_PHASES.has(journal.phase) ||
      ABORTED_RESOLUTION_PHASES.has(journal.phase)
      ? "aborted"
      : ROLLBACK_REQUIRED_PHASES.has(journal.phase) ||
          ROLLBACK_RESOLUTION_PHASES.has(journal.phase)
      ? "rollback"
      : "committed";
  if (authority === undefined) {
    if (!CLEAR_STARTED_PHASES.has(journal.phase)) {
      throw new InstallerError(
        "unsafe-state",
        "published recovery fence authority is unavailable",
      );
    }
    try {
      if (
        recovering.fence.postGeneration === null ||
        recovering.fence.postGeneration !== lease.peer.generation
      ) {
        throw new InstallerError(
          "unsafe-state",
          "cleared recovery fence generation is not exact",
        );
      }
      if (resolution !== "aborted") {
        const expectedVersion = recoveryExpectedVersion(recovering);
        if (expectedVersion === null) {
          throw new InstallerError(
            "unsafe-state",
            "cleared recovery fence has no authoritative package generation",
          );
        }
        await host.verifyCurrentReadiness(
          invocation,
          expectedVersion,
          lease.peer.generation,
        );
      }
      await fenceControl.proveAbsent(recovering.fence.record);
      recovering = phaseJournal(
        recovering,
        resolution === "rollback"
          ? "rollback-fence-cleared"
          : resolution === "aborted"
          ? "aborted-fence-cleared"
          : "fence-cleared",
      );
      await host.writeJournal(recovering);
      await host.clearJournal();
      return;
    } finally {
      await lease.release().catch(() => undefined);
    }
  }
  try {
    if (ROLLBACK_REQUIRED_PHASES.has(journal.phase)) {
      await lease.release();
      lease = undefined;
      resolution = "rollback";
      try {
        recovering = phaseJournal(
          journal,
          "rollback-started",
          invocation.process,
        );
        await host.writeJournal(recovering);
        await host.rollback(invocation, recovering);
        recovering = phaseJournal(recovering, "rolled-back");
        await host.writeJournal(recovering);
      } catch (error) {
        throw new InstallerError(
          "rollback-failed",
          error instanceof Error
            ? `interrupted transaction recovery failed: ${error.message}`
            : "interrupted transaction recovery failed",
        );
      }
      lease = await fenceControl.acquire();
      await lease.acknowledge(authority);
    }
    if (
      recovering.fence.postGeneration !== null &&
      recovering.fence.postGeneration !== lease.peer.generation
    ) {
      throw new InstallerError(
        "unsafe-state",
        "recovered fence generation changed after acknowledgment",
      );
    }
    if (resolution !== "aborted") {
      const expectedVersion = resolution === "rollback"
        ? recovering.fromVersion
        : recovering.toVersion;
      if (
        expectedVersion === null ||
        (resolution === "rollback" &&
          recovering.oldServiceState.endsWith("-inactive"))
      ) {
        throw new InstallerError(
          "unsafe-state",
          "recovered fence requires an authoritative active generation",
        );
      }
      await host.verifyCurrentReadiness(
        invocation,
        expectedVersion,
        lease.peer.generation,
      );
    }
    const acknowledgedPhase: LinuxReleaseInstallerJournalPhase =
      resolution === "rollback"
        ? "rollback-acknowledged"
        : resolution === "aborted"
        ? "aborted-acknowledged"
        : "postrestart-acknowledged";
    const clearStartedPhase: LinuxReleaseInstallerJournalPhase =
      resolution === "rollback"
        ? "rollback-fence-clear-started"
        : resolution === "aborted"
        ? "aborted-fence-clear-started"
        : "fence-clear-started";
    const clearedPhase: LinuxReleaseInstallerJournalPhase =
      resolution === "rollback"
        ? "rollback-fence-cleared"
        : resolution === "aborted"
        ? "aborted-fence-cleared"
        : "fence-cleared";
    if (!CLEAR_STARTED_PHASES.has(recovering.phase)) {
      recovering = {
        ...recovering,
        owner: invocation.process,
        fence: {
          ...recovering.fence,
          postGeneration: lease.peer.generation,
        },
        phase: acknowledgedPhase,
      };
      await host.writeJournal(recovering);
      recovering = phaseJournal(recovering, clearStartedPhase);
      await host.writeJournal(recovering);
    }
    await fenceControl.clear(authority);
    recovering = phaseJournal(recovering, clearedPhase);
    await host.writeJournal(recovering);
    await host.clearJournal();
  } finally {
    await lease?.release().catch(() => undefined);
  }
};

export type EmitLinuxReleaseInstallerReceipt = (
  receipt: LinuxReleaseInstallerReceipt,
) => Promise<void>;

const runPreparedInstall = async (
  request: Extract<LinuxReleaseInstallerRequest, { readonly kind: "prepare" }>,
  reader: ExactFrameReader,
  invocation: LinuxReleaseInstallerInvocation,
  target: LinuxReleaseInstallerTarget,
  host: LinuxReleaseInstallerHost,
  emit: EmitLinuxReleaseInstallerReceipt,
  helperChallenge: string,
  machineIdSha256: string,
): Promise<LinuxReleaseInstallerReceipt> => {
  await host.ensureLayout();
  let lock: InstallerLock;
  try {
    lock = await host.acquireLock(invocation.process);
  } catch (error) {
    if (error instanceof InstallerError) throw error;
    throw new InstallerError("busy", "another installer owns the fixed lock");
  }
  let stage: ProtectedStage | undefined;
  let activeJournal: LinuxReleaseInstallerJournal | undefined;
  let fenceControl: LinuxReleaseFenceControl | undefined;
  let fenceAuthority: LinuxReleaseFenceAuthority | undefined;
  let firstLease: LinuxReleaseMaintenanceLease | undefined;
  let finalLease: LinuxReleaseMaintenanceLease | undefined;
  let fencePublished = false;
  let mutationStarted = false;
  try {
    await lock.assertHeld();
    await host.reserveBundle(
      request.totalBytes,
    );
    const imported = await host.importBridgeStage(request);
    stage = imported.stage;
    if (!stageBindsPrepare(request, imported)) {
      throw new InstallerError(
        "identity",
        "bridge stage does not bind the privileged prepare frame",
      );
    }
    await lock.assertHeld();

    let verified: VerifiedProtectedLinuxBundle;
    try {
      verified = await host.verifyProtectedBundle(stage);
    } catch (error) {
      throw new InstallerError(
        "verification",
        error instanceof Error ? error.message : "signed bundle is invalid",
      );
    }
    verifiedFileDescriptor(request, verified);
    if (
      verified.version !== request.candidate.version ||
      verified.manifestSha256 !== request.candidate.manifestSha256 ||
      verified.debSha256 !== request.candidate.debSha256 ||
      !VERSION.test(verified.version) ||
      !/^[0-9a-f]{40}$/u.test(verified.sourceRevision) ||
      !SHA256.test(verified.manifestSha256) ||
      !SHA256.test(verified.debSha256) ||
      !Number.isSafeInteger(verified.debBytes) ||
      verified.debBytes < 1
    ) {
      throw new InstallerError(
        "verification",
        "protected verifier returned malformed authority",
      );
    }
    const inspection = await host.inspectProtectedDeb(
      stage,
      verified.debFile,
    );
    if (
      inspection.packageName !== "vellum" ||
      inspection.version !== verified.version ||
      inspection.architecture !== "amd64" ||
      (inspection.essential !== "" && inspection.essential !== "no") ||
      inspection.preDepends !== ""
    ) {
      throw new InstallerError(
        "policy",
        "protected deb violates the fixed package control policy",
      );
    }

    fenceControl = await host.openFenceControl(invocation, target);
    const interrupted = await inspectInterruptedTransaction(
      host,
      target,
    );
    const observedVersion = interrupted === null
      ? await host.currentVersion()
      : await host.observeCurrentVersion();
    const plannedFromVersion = interrupted?.projectedVersion ??
      observedVersion;
    if (
      plannedFromVersion !== null &&
      (!VERSION.test(plannedFromVersion) ||
        compareVersions(verified.version, plannedFromVersion) < 0)
    ) {
      throw new InstallerError(
        "policy",
        "automatic installer refuses downgrade or malformed package state",
      );
    }
    const plannedPrior = plannedFromVersion === null
      ? null
      : await host.findCachedArtifact(plannedFromVersion);
    const candidateIdentity: LinuxReleaseInstallerCandidate = {
      version: verified.version,
      debSha256: verified.debSha256,
      manifestSha256: verified.manifestSha256,
      inventorySha256: request.candidate.inventorySha256,
    };
    const plannedSameVersion = plannedFromVersion !== null &&
      verified.version === plannedFromVersion;
    const plannedExactCache = plannedSameVersion &&
      await host.cacheMatches(candidateIdentity);
    const plannedOperation: "install" | "adopt" | "noop" = plannedSameVersion
      ? plannedExactCache
        ? "noop"
        : "adopt"
      : "install";
    if (
      plannedOperation === "install" &&
      plannedFromVersion !== null &&
      plannedPrior === null
    ) {
      throw new InstallerError(
        "unsafe-state",
        "baseline signed rollback artifact must be adopted before upgrade",
      );
    }
    const fence: LinuxReleaseFence = {
      schema: LINUX_RELEASE_FENCE_PROTOCOL,
      fenceId: randomBytes(16).toString("hex"),
      transactionId: request.transactionId,
      operation: plannedOperation === "install" ? "install" : "adopt",
      targetUid: target.uid,
      targetGid: target.gid,
      stationId: target.stationId,
      machineIdSha256,
      bootId: invocation.process.bootId,
      candidateDigest: request.candidate.inventorySha256,
    };
    let interruptedAuthority: LinuxReleaseFenceAuthority | undefined;
    let interruptedPreparedState:
      | "pending"
      | "published"
      | "both"
      | "absent"
      | undefined;
    let interruptedFencePublished = false;
    if (interrupted !== null) {
      const priorFence = interrupted.journal.fence;
      if (
        interrupted.journal.phase === "fence-intent" ||
        interrupted.journal.phase === "fence-prepared"
      ) {
        const observation = await fenceControl.observePrepared(
          priorFence.record,
          priorFence.device,
          priorFence.inode,
        );
        interruptedAuthority = observation.authority;
        interruptedPreparedState = observation.state;
      } else if (CLEARED_FENCE_PHASES.has(interrupted.journal.phase)) {
        await fenceControl.proveAbsent(priorFence.record);
      } else {
        if (priorFence.device === null || priorFence.inode === null) {
          throw new InstallerError(
            "unsafe-state",
            "published recovery fence has no durable inode binding",
          );
        }
        try {
          interruptedAuthority = await fenceControl.adoptPublished(
            priorFence.record,
            priorFence.device,
            priorFence.inode,
          );
          interruptedFencePublished = true;
        } catch (error) {
          if (!CLEAR_STARTED_PHASES.has(interrupted.journal.phase)) {
            throw error;
          }
          await fenceControl.proveAbsent(priorFence.record);
        }
      }
    }
    firstLease = await fenceControl.acquire();
    if (
      interruptedAuthority !== undefined &&
      interruptedFencePublished
    ) {
      await firstLease.acknowledge(interruptedAuthority);
    }

    const rootReady: LinuxReleaseInstallerReceipt = {
      schema: LINUX_RELEASE_INSTALLER_RECEIPT,
      ok: true,
      state: "root-ready",
      transactionId: request.transactionId,
      providerNonce: request.providerNonce,
      bridgeNonce: request.bridgeNonce,
      helperChallenge,
      target,
      candidate: request.candidate,
      fence,
      machineIdSha256,
      bootId: invocation.process.bootId,
      operation: plannedOperation,
      fromVersion: plannedFromVersion,
      currentVersion: observedVersion,
      journalPredecessor: interrupted?.predecessor ?? null,
      maintenance: firstLease.evidence,
      totalBytes: request.totalBytes,
    };
    await emit(rootReady);
    const commit = await reader.readHeader();
    await reader.expectEof();
    if (commit.kind !== "commit" ||
      !requestsBind(request, commit, helperChallenge, fence.fenceId)) {
      throw new InstallerError(
        "protocol",
        "installer commit does not bind ROOT_READY",
      );
    }
    await host.reconcileOrphans(request.transactionId);
    if (interrupted !== null) {
      const recoveryLease = firstLease;
      firstLease = undefined;
      await recoverInterruptedTransaction(
        host,
        invocation,
        fenceControl,
        interrupted,
        interruptedAuthority,
        interruptedPreparedState,
        recoveryLease,
      );
      firstLease = await fenceControl.acquire();
    }
    const fromVersion = await host.currentVersion();
    if (fromVersion !== plannedFromVersion) {
      throw new InstallerError(
        "unsafe-state",
        "recovered package baseline differs from ROOT_READY",
      );
    }
    const prior = fromVersion === null
      ? null
      : await host.findCachedArtifact(fromVersion);
    const sameVersion = fromVersion !== null && verified.version === fromVersion;
    const exactCache = sameVersion &&
      await host.cacheMatches(candidateIdentity);
    const operation: "install" | "adopt" | "noop" = sameVersion
      ? exactCache
        ? "noop"
        : "adopt"
      : "install";
    if (
      operation !== plannedOperation ||
      prior?.sha256 !== plannedPrior?.sha256
    ) {
      throw new InstallerError(
        "unsafe-state",
        "post-recovery install plan differs from ROOT_READY",
      );
    }
    if (sameVersion) {
      await host.adoptInstalledCandidate(stage, verified, invocation);
    }
    const oldState = await host.currentOperationalState(invocation);
    if (
      (fromVersion === null) !== (oldState.service === "absent-inactive")
    ) {
      throw new InstallerError(
        "unsafe-state",
        "package and service presence do not agree",
      );
    }
    if (oldState.service === "absent-inactive" && operation !== "install") {
      throw new InstallerError(
        "unsafe-state",
        "installed package has no activatable Remote unit",
      );
    }
    activeJournal = {
      schema: LINUX_RELEASE_INSTALLER_JOURNAL,
      transactionId: request.transactionId,
      operation: operation === "install" ? "install" : "adopt",
      owner: invocation.process,
      target,
      fence: {
        record: fence,
        device: null,
        inode: null,
        preGeneration: firstLease.peer.generation,
        postGeneration: null,
      },
      manifestSha256: verified.manifestSha256,
      debSha256: verified.debSha256,
      sourceRevision: verified.sourceRevision,
      fromVersion,
      toVersion: verified.version,
      priorArtifactSha256: operation === "install"
        ? prior?.sha256 ?? null
        : null,
      oldServiceState: oldState.service,
      oldLinger: oldState.linger,
      phase: "fence-intent",
    };
    await host.writeJournal(activeJournal);
    fenceAuthority = await fenceControl.prepare(fence);
    activeJournal = {
      ...activeJournal,
      fence: {
        ...activeJournal.fence,
        device: fenceAuthority.device,
        inode: fenceAuthority.inode,
      },
      phase: "fence-prepared",
    };
    await host.writeJournal(activeJournal);
    await fenceControl.publish(fenceAuthority);
    fencePublished = true;
    activeJournal = phaseJournal(activeJournal, "fence-published");
    await host.writeJournal(activeJournal);
    await firstLease.acknowledge(fenceAuthority);
    activeJournal = phaseJournal(activeJournal, "fence-acknowledged");
    await host.writeJournal(activeJournal);
    activeJournal = phaseJournal(activeJournal, "prepared");
    await host.writeJournal(activeJournal);
    await lock.assertHeld();
    const preTokenDevice = firstLease.tokenDevice;
    const preTokenInode = firstLease.tokenInode;
    await firstLease.release();
    firstLease = undefined;

    let readiness: LinuxReleaseInstallerReadinessEvidence;
    let candidate: ProtectedArtifact | null = null;
    if (operation === "noop") {
      finalLease = await fenceControl.acquire();
      await finalLease.acknowledge(fenceAuthority);
      readiness = await host.verifyCurrentReadiness(
        invocation,
        verified.version,
        finalLease.peer.generation,
      );
    } else {
      mutationStarted = true;
      if (operation === "install") {
        candidate = await host.cacheCandidate(stage, verified);
        activeJournal = phaseJournal(activeJournal, "dpkg-started");
        await host.writeJournal(activeJournal);
        try {
          await host.installCandidate(stage, verified);
        } catch (error) {
          throw new InstallerError(
            "install-failed",
            error instanceof Error ? error.message : "dpkg installation failed",
          );
        }
        activeJournal = phaseJournal(activeJournal, "dpkg-installed");
        await host.writeJournal(activeJournal);
      }
      activeJournal = phaseJournal(activeJournal, "activation-started");
      await host.writeJournal(activeJournal);
      try {
        readiness = await host.activateAndVerify(
          invocation,
          verified.version,
        );
      } catch (error) {
        throw new InstallerError(
          "install-failed",
          error instanceof Error ? error.message : "release activation failed",
        );
      }
      if (operation === "adopt") {
        candidate = await host.cacheCandidate(stage, verified);
      }
      activeJournal = phaseJournal(activeJournal, "verified");
      await host.writeJournal(activeJournal);
      finalLease = await fenceControl.acquire();
      if (
        finalLease.peer.generation ===
          activeJournal.fence.preGeneration ||
        (finalLease.tokenDevice === preTokenDevice &&
          finalLease.tokenInode === preTokenInode) ||
        finalLease.peer.generation !== readiness.generation
      ) {
        throw new InstallerError(
          "unsafe-state",
          "Remote service did not establish a fresh exact generation",
        );
      }
      await finalLease.acknowledge(fenceAuthority);
      readiness = await host.verifyCurrentReadiness(
        invocation,
        verified.version,
        finalLease.peer.generation,
      );
    }
    activeJournal = {
      ...activeJournal,
      fence: {
        ...activeJournal.fence,
        postGeneration: finalLease.peer.generation,
      },
      phase: "postrestart-acknowledged",
    };
    await host.writeJournal(activeJournal);
    await lock.assertHeld();
    activeJournal = phaseJournal(activeJournal, "fence-clear-started");
    await host.writeJournal(activeJournal);
    await fenceControl.clear(fenceAuthority);
    activeJournal = phaseJournal(activeJournal, "fence-cleared");
    await host.writeJournal(activeJournal);
    await host.clearJournal();
    activeJournal = undefined;
    if (
      prior !== null &&
      candidate !== null &&
      prior.version !== candidate.version
    ) {
      await host.deleteCachedArtifact(prior).catch(() => undefined);
    }
    await host.discardStage(stage).catch(() => undefined);
    stage = undefined;
    return {
      schema: LINUX_RELEASE_INSTALLER_RECEIPT,
      ok: true,
      state: "ready",
      transactionId: request.transactionId,
      providerNonce: request.providerNonce,
      bridgeNonce: request.bridgeNonce,
      helperChallenge,
      fenceId: fence.fenceId,
      inventorySha256: request.candidate.inventorySha256,
      operation,
      changed: operation !== "noop",
      fromVersion,
      toVersion: verified.version,
      manifestSha256: verified.manifestSha256,
      debSha256: verified.debSha256,
      sourceRevision: verified.sourceRevision,
      recoveredTransactionId: interrupted?.predecessor.transactionId ?? null,
      readiness,
    };
  } catch (error) {
    const failure = error instanceof InstallerError
      ? error
      : new InstallerError(
        "internal",
        error instanceof Error ? error.message : "installer failed",
      );
    if (
      activeJournal !== undefined &&
      fenceControl !== undefined &&
      fenceAuthority !== undefined &&
      !mutationStarted
    ) {
      try {
        await lock.assertHeld();
        if (fencePublished) {
          const clearingLease = firstLease ?? finalLease;
          if (clearingLease === undefined) {
            throw new Error("pre-mutation fence lease is unavailable");
          }
          await clearingLease.acknowledge(fenceAuthority);
          activeJournal = {
            ...activeJournal,
            fence: {
              ...activeJournal.fence,
              postGeneration: clearingLease.peer.generation,
            },
            phase: "aborted-acknowledged",
          };
          await host.writeJournal(activeJournal);
          activeJournal = phaseJournal(
            activeJournal,
            "aborted-fence-clear-started",
          );
          await host.writeJournal(activeJournal);
          await fenceControl.clear(fenceAuthority);
          activeJournal = phaseJournal(
            activeJournal,
            "aborted-fence-cleared",
          );
          await host.writeJournal(activeJournal);
        } else {
          await fenceControl.discardPrepared(fenceAuthority);
        }
        await host.clearJournal();
        activeJournal = undefined;
      } catch {
        return refusal("unsafe-state", request.transactionId);
      }
    } else if (
      activeJournal !== undefined &&
      mutationStarted &&
      fenceControl !== undefined &&
      fenceAuthority !== undefined
    ) {
      const rollbackControl = fenceControl;
      const rollbackAuthority = fenceAuthority;
      try {
        await lock.assertHeld();
        await firstLease?.release();
        firstLease = undefined;
        await finalLease?.release();
        finalLease = undefined;
        activeJournal = phaseJournal(activeJournal, "rollback-started");
        await host.writeJournal(activeJournal);
        await host.rollback(invocation, activeJournal);
        activeJournal = phaseJournal(activeJournal, "rolled-back");
        await host.writeJournal(activeJournal);
        if (
          activeJournal.fromVersion === null ||
          activeJournal.oldServiceState.endsWith("-inactive")
        ) {
          throw new Error(
            "rolled-back service has no authoritative active generation",
          );
        }
        finalLease = await rollbackControl.acquire();
        await finalLease.acknowledge(rollbackAuthority);
        await host.verifyCurrentReadiness(
          invocation,
          activeJournal.fromVersion,
          finalLease.peer.generation,
        );
        activeJournal = {
          ...activeJournal,
          fence: {
            ...activeJournal.fence,
            postGeneration: finalLease.peer.generation,
          },
          phase: "rollback-acknowledged",
        };
        await host.writeJournal(activeJournal);
        activeJournal = phaseJournal(
          activeJournal,
          "rollback-fence-clear-started",
        );
        await host.writeJournal(activeJournal);
        await rollbackControl.clear(rollbackAuthority);
        activeJournal = phaseJournal(
          activeJournal,
          "rollback-fence-cleared",
        );
        await host.writeJournal(activeJournal);
        await host.clearJournal();
        activeJournal = undefined;
        return rolledBackReceipt(
          failure.category,
          request,
          helperChallenge,
          rollbackAuthority.record.fenceId,
        );
      } catch {
        return refusal("rollback-failed", request.transactionId);
      }
    }
    return refusal(failure.category, request.transactionId);
  } finally {
    await firstLease?.release().catch(() => undefined);
    await finalLease?.release().catch(() => undefined);
    if (stage !== undefined) {
      await host.discardStage(stage).catch(() => undefined);
    }
    await lock.release().catch(() => undefined);
  }
};

/**
 * Executes one whole privileged transaction. The caller receives a bounded
 * exact receipt for every expected failure; no continuation/subcommand can
 * commit or delete rollback authority.
 */
export const runLinuxReleaseInstaller = async (
  input: AsyncIterable<Uint8Array>,
  invocation: LinuxReleaseInstallerInvocation,
  host: LinuxReleaseInstallerHost,
  deadlines: LinuxReleaseInstallerDeadlines = defaultDeadlines,
  emit: EmitLinuxReleaseInstallerReceipt = async () => undefined,
): Promise<LinuxReleaseInstallerReceipt> => {
  let trustedTarget: TrustedSudoTarget;
  try {
    trustedTarget = validateInvocation(invocation);
  } catch (error) {
    return refusal(
      error instanceof InstallerError ? error.category : "identity",
      null,
    );
  }
  if (
    !Number.isSafeInteger(deadlines.idleMs) ||
    deadlines.idleMs < 1 ||
    !Number.isSafeInteger(deadlines.overallMs) ||
    deadlines.overallMs < deadlines.idleMs
  ) {
    return refusal("internal", null);
  }
  const reader = new ExactFrameReader(input, deadlines);
  let request: LinuxReleaseInstallerRequest | undefined;
  try {
    const helperChallenge = randomBytes(16).toString("hex");
    const machineIdSha256 = await host.machineIdSha256();
    await emit({
      schema: LINUX_RELEASE_INSTALLER_RECEIPT,
      ok: true,
      state: "root-armed",
      helperChallenge,
      target: trustedTarget,
      machineIdSha256,
      bootId: invocation.process.bootId,
    });
    request = await reader.readHeader();
    if (
      request.kind !== "prepare" ||
      request.helperChallenge !== helperChallenge
    ) {
      throw new InstallerError(
        "protocol",
        "installer PREPARE does not bind ROOT_ARMED",
      );
    }
    if (!targetsEqual(request.target, trustedTarget)) {
      throw new InstallerError(
        "identity",
        "installer frame target does not match sudo and kernel identity",
      );
    }
    return await runPreparedInstall(
      request,
      reader,
      invocation,
      request.target,
      host,
      emit,
      helperChallenge,
      machineIdSha256,
    );
  } catch (error) {
    const failure = error instanceof InstallerError
      ? error
      : new InstallerError(
        "internal",
        error instanceof Error ? error.message : "installer failed",
      );
    return refusal(
      failure.category,
      request?.kind === "prepare"
        ? request.transactionId
        : null,
    );
  }
};

const stageDirectories = new WeakMap<ProtectedStage, string>();
const artifactPaths = new WeakMap<ProtectedArtifact, string>();

const isMissing = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { readonly code?: unknown }).code === "ENOENT";

const modeOf = (metadata: Stats): number => metadata.mode & 0o777;

const sameInode = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const socketFileDescriptor = (socket: Socket): number | undefined => {
  const handle = (socket as unknown as { _handle?: { fd?: number } })._handle;
  const descriptor = handle?.fd;
  return typeof descriptor === "number" &&
      Number.isInteger(descriptor) &&
      descriptor >= 0
    ? descriptor
    : undefined;
};

const readBoundedProtectedFile = async (
  file: string,
  ownerUid: number,
  maximum: number,
  expectedMode = 0o600,
): Promise<Buffer> => {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      file,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.uid !== ownerUid ||
      modeOf(metadata) !== expectedMode ||
      metadata.size < 1 ||
      metadata.size > maximum
    ) {
      throw new InstallerError(
        "unsafe-state",
        "root-protected file metadata is invalid",
      );
    }
    return await handle.readFile();
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

const syncDirectory = async (directory: string): Promise<void> => {
  const handle = await open(
    directory,
    fsConstants.O_RDONLY |
      fsConstants.O_DIRECTORY |
      fsConstants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const assertProtectedDirectory = async (
  directory: string,
  ownerUid: number,
  ownerGid: number,
): Promise<void> => {
  const metadata = await lstat(directory);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== ownerUid ||
    metadata.gid !== ownerGid ||
    modeOf(metadata) !== 0o700 ||
    await realpath(directory) !== path.resolve(directory)
  ) {
    throw new InstallerError(
      "unsafe-state",
      "installer fixed directory is not root-owned mode 0700",
    );
  }
};

const ensureProtectedDirectory = async (
  directory: string,
  ownerUid: number,
  ownerGid: number,
): Promise<void> => {
  try {
    await mkdir(directory, { mode: 0o700 });
    await syncDirectory(path.dirname(directory));
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      (error as { readonly code?: unknown }).code !== "EEXIST"
    ) {
      throw error;
    }
  }
  await assertProtectedDirectory(directory, ownerUid, ownerGid);
};

const hashHandle = async (
  handle: FileHandle,
  bytes?: number,
): Promise<string> => {
  const hash = createHash("sha256");
  const metadata = await handle.stat();
  const length = bytes ?? metadata.size;
  if (metadata.size !== length || length < 1) {
    throw new InstallerError("unsafe-state", "protected file size changed");
  }
  for await (
    const chunk of handle.createReadStream({
      autoClose: false,
      start: 0,
      end: length - 1,
    })
  ) {
    hash.update(chunk);
  }
  return hash.digest("hex");
};

const openVerifiedProtectedFile = async (
  file: string,
  ownerUid: number,
  expectedBytes: number,
  expectedSha256: string,
): Promise<FileHandle> => {
  const handle = await open(
    file,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.uid !== ownerUid ||
      modeOf(metadata) !== 0o600 ||
      metadata.size !== expectedBytes ||
      await hashHandle(handle, expectedBytes) !== expectedSha256
    ) {
      throw new InstallerError(
        "unsafe-state",
        "protected artifact does not match root metadata",
      );
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
};

export const runFixedCommand: RunFixedCommand = (
  executable,
  arguments_,
  timeoutMs,
) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, [...arguments_], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: commandEnvironment,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let finished = false;
    let terminalError: Error | undefined;
    const timer = setTimeout(() => {
      if (finished) return;
      terminalError = new Error(`fixed command timed out: ${executable}`);
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("error", (error) => {
      terminalError = error;
    });
    child.stdout.on("data", (value: Buffer) => {
      stdoutBytes += value.length;
      if (stdoutBytes > MAX_COMMAND_OUTPUT_BYTES) {
        terminalError = new Error(
          `fixed command stdout is oversized: ${executable}`,
        );
        child.kill("SIGKILL");
      } else {
        stdout.push(Buffer.from(value));
      }
    });
    child.stderr.on("data", (value: Buffer) => {
      stderrBytes += value.length;
      if (stderrBytes > MAX_COMMAND_OUTPUT_BYTES) {
        terminalError = new Error(
          `fixed command stderr is oversized: ${executable}`,
        );
        child.kill("SIGKILL");
      } else {
        stderr.push(Buffer.from(value));
      }
    });
    child.once("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (terminalError !== undefined) {
        reject(terminalError);
        return;
      }
      resolve({
        code: code ?? 255,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });

const acquireFlock = async (lockFile: string): Promise<InstallerLock> => {
  const child = spawn(
    "/usr/bin/flock",
    ["--exclusive", "--nonblock", "--", lockFile, "/usr/bin/cat"],
    {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: commandEnvironment,
    },
  );
  let stderrBytes = 0;
  child.stderr.on("data", (value: Buffer) => {
    stderrBytes += value.length;
    if (stderrBytes > MAX_COMMAND_OUTPUT_BYTES) child.kill("SIGKILL");
  });
  let closed = false;
  let closeCode: number | null = null;
  const closedPromise = new Promise<void>((resolve) => {
    child.once("close", (code) => {
      closed = true;
      closeCode = code;
      resolve();
    });
  });
  const acquired = await new Promise<boolean>((resolve, reject) => {
    const marker = Buffer.from("L");
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("kernel lock acquisition timed out"));
    }, 5_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    void closedPromise.then(() => {
      clearTimeout(timer);
      resolve(false);
    });
    child.stdout.once("data", (value: Buffer) => {
      clearTimeout(timer);
      resolve(value.equals(marker));
    });
    child.stdin.write(marker);
  });
  if (!acquired) {
    child.stdin.destroy();
    throw new InstallerError("busy", "installer kernel lock is held");
  }
  let released = false;
  return {
    assertHeld: async () => {
      if (closed) {
        throw new InstallerError(
          "unsafe-state",
          `installer kernel lock lease ended unexpectedly (${closeCode ?? "signal"})`,
        );
      }
    },
    release: async () => {
      if (released) return;
      released = true;
      if (closed) return;
      child.stdin.end();
      await closedPromise;
    },
  };
};

const requireCommand = async (
  runner: RunFixedCommand,
  executable: string,
  arguments_: ReadonlyArray<string>,
  timeoutMs: number,
): Promise<string> => {
  const result = await runner(executable, arguments_, timeoutMs);
  if (result.code !== 0 || result.stderr.length > MAX_COMMAND_OUTPUT_BYTES) {
    throw new Error(`fixed command failed: ${executable}`);
  }
  return result.stdout;
};

interface CacheMetadata {
  readonly schema: "vellum/linux-release-installer-cache/v1";
  readonly version: string;
  readonly bytes: number;
  readonly debSha256: string;
  readonly manifestSha256: string;
}

const decodeCacheMetadata = (value: unknown): CacheMetadata => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InstallerError("unsafe-state", "cache metadata is malformed");
  }
  const input = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(input).sort()) !==
      JSON.stringify(
        ["schema", "version", "bytes", "debSha256", "manifestSha256"].sort(),
      ) ||
    input.schema !== "vellum/linux-release-installer-cache/v1" ||
    typeof input.version !== "string" ||
    !VERSION.test(input.version) ||
    typeof input.bytes !== "number" ||
    !Number.isSafeInteger(input.bytes) ||
    input.bytes < 1 ||
    typeof input.debSha256 !== "string" ||
    !SHA256.test(input.debSha256) ||
    typeof input.manifestSha256 !== "string" ||
    !SHA256.test(input.manifestSha256)
  ) {
    throw new InstallerError("unsafe-state", "cache metadata is malformed");
  }
  return {
    schema: "vellum/linux-release-installer-cache/v1",
    version: input.version,
    bytes: input.bytes,
    debSha256: input.debSha256,
    manifestSha256: input.manifestSha256,
  };
};

const cacheMetadataText = (metadata: CacheMetadata): string =>
  `${JSON.stringify(metadata)}\n`;

const canonicalJson = (value: unknown): string => `${JSON.stringify(value)}\n`;

const validateReadinessReceipt = (
  raw: string,
  generation: string,
): boolean => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return false;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    canonicalJson(value) !== raw
  ) {
    return false;
  }
  const receipt = value as Record<string, unknown>;
  const components = receipt.components;
  const expected = [
    "version",
    "role",
    "host",
    "package",
    "supervisor",
    "canvasPull",
    "work",
    "terminal",
    "browserTransport",
    "browserComposition",
    "display",
    "sandbox",
    "browserCapability",
  ];
  if (
    receipt.version !== 1 ||
    receipt.generation !== generation ||
    receipt.state !== "ready" ||
    typeof components !== "object" ||
    components === null ||
    Array.isArray(components)
  ) {
    return false;
  }
  const decoded = components as Record<string, unknown>;
  return JSON.stringify(Object.keys(decoded).sort()) ===
      JSON.stringify([...expected].sort()) &&
    expected.every((name) => decoded[name] === "ready");
};

export class NodeLinuxReleaseInstallerHost
  implements LinuxReleaseInstallerHost
{
  readonly #paths: LinuxReleaseInstallerPaths;
  readonly #ownerUid: number;
  readonly #ownerGid: number;
  readonly #verifier: VerifyProtectedLinuxBundle;
  readonly #runtimeRoot: string;
  readonly #dpkgInfoRoot: string;
  readonly #installedRoot: string;
  readonly #bridgeStageRoot: string;
  readonly #fenceDirectory: string | undefined;
  readonly #fencePath: string | undefined;
  readonly #fenceControlFactory:
    | NodeLinuxReleaseInstallerHostOptions["fenceControlFactory"]
    | undefined;
  readonly #readMachineIdSha256:
    | NodeLinuxReleaseInstallerHostOptions["readMachineIdSha256"]
    | undefined;
  readonly #run: RunFixedCommand;
  readonly #processLive: (
    identity: LinuxReleaseInstallerProcessIdentity,
  ) => Promise<boolean>;
  readonly #kernelLock: (lockFile: string) => Promise<InstallerLock>;

  public constructor(options: NodeLinuxReleaseInstallerHostOptions) {
    this.#paths = Object.freeze({
      stateRoot: path.resolve(options.paths.stateRoot),
      spoolRoot: path.resolve(options.paths.spoolRoot),
      cacheRoot: path.resolve(options.paths.cacheRoot),
    });
    this.#ownerUid = options.ownerUid;
    this.#ownerGid = options.ownerGid;
    this.#verifier = options.verifyProtectedBundle;
    this.#runtimeRoot = path.resolve(options.paths.runtimeRoot ?? "/run/user");
    this.#dpkgInfoRoot = path.resolve(
      options.paths.dpkgInfoRoot ?? "/var/lib/dpkg/info",
    );
    this.#installedRoot = path.resolve(options.paths.installedRoot ?? "/");
    this.#bridgeStageRoot = path.resolve(
      options.bridgeStageRoot ?? LINUX_RELEASE_BRIDGE_STAGE_ROOT,
    );
    this.#fenceDirectory = options.fenceDirectory === undefined
      ? undefined
      : path.resolve(options.fenceDirectory);
    this.#fencePath = options.fencePath === undefined
      ? undefined
      : path.resolve(options.fencePath);
    this.#fenceControlFactory = options.fenceControlFactory;
    this.#readMachineIdSha256 = options.readMachineIdSha256;
    this.#run = options.runCommand ?? runFixedCommand;
    this.#processLive = options.isProcessLive ??
      ((identity) => this.#defaultProcessLive(identity));
    this.#kernelLock = options.acquireKernelLock ?? acquireFlock;
  }

  public async ensureLayout(): Promise<void> {
    await ensureProtectedDirectory(
      this.#paths.stateRoot,
      this.#ownerUid,
      this.#ownerGid,
    );
    const lockPath = path.join(this.#paths.stateRoot, LOCK_FILE);
    try {
      const handle = await open(
        lockPath,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_NOFOLLOW,
        0o600,
      );
      await handle.sync();
      await handle.close();
      await syncDirectory(this.#paths.stateRoot);
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        (error as { readonly code?: unknown }).code !== "EEXIST"
      ) {
        throw error;
      }
      const metadata = await lstat(lockPath);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.uid !== this.#ownerUid ||
        metadata.gid !== this.#ownerGid ||
        modeOf(metadata) !== 0o600
      ) {
        throw new InstallerError(
          "unsafe-state",
          "installer kernel lock file is unsafe",
        );
      }
    }
    await ensureProtectedDirectory(
      this.#paths.spoolRoot,
      this.#ownerUid,
      this.#ownerGid,
    );
    await ensureProtectedDirectory(
      this.#paths.cacheRoot,
      this.#ownerUid,
      this.#ownerGid,
    );
  }

  async #defaultProcessLive(
    identity: LinuxReleaseInstallerProcessIdentity,
  ): Promise<boolean> {
    try {
      const bootId = (
        await readFile("/proc/sys/kernel/random/boot_id", "utf8")
      ).trim();
      if (bootId !== identity.bootId) return false;
      const stat = await readFile(`/proc/${identity.pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const fields = close < 0 ? [] : stat.slice(close + 2).trim().split(/\s+/u);
      return fields[19] === identity.startTicks;
    } catch (error) {
      if (isMissing(error)) return false;
      throw new InstallerError(
        "unsafe-state",
        "kernel process liveness is indeterminate",
      );
    }
  }

  public isProcessLive(
    identity: LinuxReleaseInstallerProcessIdentity,
  ): Promise<boolean> {
    return this.#processLive(identity);
  }

  public async acquireLock(
    _owner: LinuxReleaseInstallerProcessIdentity,
  ): Promise<InstallerLock> {
    const lockPath = path.join(this.#paths.stateRoot, LOCK_FILE);
    return await this.#kernelLock(lockPath);
  }

  async #journalStateWithoutLock(): Promise<
    "clear" | "recoverable" | "manual-repair" | "busy"
  > {
    try {
      const journal = await this.readJournal();
      if (journal === null) return "clear";
      return await this.#processLive(journal.owner) ? "busy" : "recoverable";
    } catch {
      return "manual-repair";
    }
  }

  async #validateLockFile(): Promise<boolean> {
    const lockPath = path.join(this.#paths.stateRoot, LOCK_FILE);
    try {
      const metadata = await lstat(lockPath);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.uid !== this.#ownerUid ||
        metadata.gid !== this.#ownerGid ||
        modeOf(metadata) !== 0o600
      ) {
        throw new InstallerError(
          "unsafe-state",
          "installer kernel lock file is unsafe",
        );
      }
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  public async probe(candidate: LinuxReleaseInstallerCandidate): Promise<{
    readonly currentVersion: string | null;
    readonly artifactMatches: boolean;
    readonly journalState:
      | "clear"
      | "recoverable"
      | "manual-repair"
      | "busy";
  }> {
    const lockExists = await this.#validateLockFile();
    if (!lockExists) {
      // Before the first install there is no persistent lock inode. Recheck
      // after the fail-closed reads: an installer creates this inode before it
      // can stage, journal, cache, or invoke dpkg.
      const currentVersion = await this.currentVersion();
      const artifactMatches = await this.cacheMatches(candidate);
      const journalState = await this.#journalStateWithoutLock();
      if (await this.#validateLockFile()) {
        return {
          currentVersion: null,
          artifactMatches: false,
          journalState: "busy",
        };
      }
      return { currentVersion, artifactMatches, journalState };
    }
    let lease: InstallerLock;
    try {
      lease = await this.#kernelLock(
        path.join(this.#paths.stateRoot, LOCK_FILE),
      );
    } catch (error) {
      if (error instanceof InstallerError && error.category === "busy") {
        return {
          currentVersion: null,
          artifactMatches: false,
          journalState: "busy",
        };
      }
      throw error;
    }
    try {
      const currentVersion = await this.currentVersion();
      const artifactMatches = await this.cacheMatches(candidate);
      const journalState = await this.#journalStateWithoutLock();
      return { currentVersion, artifactMatches, journalState };
    } finally {
      await lease.release();
    }
  }

  async #removeStrictDirectory(
    directory: string,
    allowed: (name: string) => boolean,
  ): Promise<void> {
    await assertProtectedDirectory(
      directory,
      this.#ownerUid,
      this.#ownerGid,
    );
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length > 65) {
      throw new InstallerError(
        "unsafe-state",
        "orphan directory is unexpectedly large",
      );
    }
    for (const entry of entries) {
      if (
        !allowed(entry.name) ||
        !entry.isFile() ||
        entry.isSymbolicLink()
      ) {
        throw new InstallerError(
          "unsafe-state",
          "orphan directory contains unsafe entries",
        );
      }
      const file = path.join(directory, entry.name);
      const metadata = await lstat(file);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.uid !== this.#ownerUid ||
        metadata.gid !== this.#ownerGid ||
        modeOf(metadata) !== 0o600
      ) {
        throw new InstallerError(
          "unsafe-state",
          "orphan file is not root protected",
        );
      }
    }
    for (const entry of entries) {
      await unlink(path.join(directory, entry.name));
    }
    await syncDirectory(directory);
    await rmdir(directory);
  }

  public async reconcileOrphans(
    preserveTransactionId?: string,
  ): Promise<void> {
    const spoolEntries = await readdir(this.#paths.spoolRoot, {
      withFileTypes: true,
    });
    for (const entry of spoolEntries) {
      if (entry.name === preserveTransactionId) continue;
      if (
        !/^[0-9a-f]{32}$/u.test(entry.name) ||
        !entry.isDirectory() ||
        entry.isSymbolicLink()
      ) {
        throw new InstallerError(
          "unsafe-state",
          "spool contains an unrecognized root entry",
        );
      }
      const stageDirectory = path.join(this.#paths.spoolRoot, entry.name);
      const controlDirectory = path.join(
        stageDirectory,
        ".candidate-control",
      );
      try {
        await assertProtectedDirectory(
          controlDirectory,
          this.#ownerUid,
          this.#ownerGid,
        );
        const controlEntries = await readdir(controlDirectory, {
          withFileTypes: true,
        });
        const allowedControl = new Set([
          "control",
          "md5sums",
          "preinst",
          "postinst",
          "prerm",
          "postrm",
          "conffiles",
          "triggers",
        ]);
        if (
          controlEntries.length > allowedControl.size ||
          controlEntries.some((controlEntry) =>
            !allowedControl.has(controlEntry.name) ||
            !controlEntry.isFile() ||
            controlEntry.isSymbolicLink()
          )
        ) {
          throw new InstallerError(
            "unsafe-state",
            "orphan candidate control directory is malformed",
          );
        }
        for (const controlEntry of controlEntries) {
          const controlFile = path.join(
            controlDirectory,
            controlEntry.name,
          );
          const metadata = await lstat(controlFile);
          if (
            metadata.uid !== this.#ownerUid ||
            metadata.gid !== this.#ownerGid ||
            (metadata.mode & 0o022) !== 0
          ) {
            throw new InstallerError(
              "unsafe-state",
              "orphan candidate control file is unsafe",
            );
          }
        }
        for (const controlEntry of controlEntries) {
          await unlink(path.join(controlDirectory, controlEntry.name));
        }
        await syncDirectory(controlDirectory);
        await rmdir(controlDirectory);
        await syncDirectory(stageDirectory);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      const payloadDirectory = path.join(
        stageDirectory,
        ".candidate-payload",
      );
      try {
        await assertProtectedDirectory(
          payloadDirectory,
          this.#ownerUid,
          this.#ownerGid,
        );
        await this.#removeExtractedTree(payloadDirectory);
        await syncDirectory(stageDirectory);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      await this.#removeStrictDirectory(
        stageDirectory,
        (name) =>
          name.length >= 2 &&
          name.length <= 128 &&
          path.basename(name) === name &&
          !name.includes("/") &&
          !name.includes("\\") &&
          !name.startsWith("."),
      );
    }
    if (
      spoolEntries.some((entry) => entry.name !== preserveTransactionId)
    ) {
      await syncDirectory(this.#paths.spoolRoot);
    }
    const cacheEntries = await readdir(this.#paths.cacheRoot, {
      withFileTypes: true,
    });
    for (const entry of cacheEntries) {
      if (!entry.name.startsWith(".candidate-")) continue;
      if (
        !/^\.candidate-[0-9a-f]{32}-(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u
          .test(entry.name) ||
        !entry.isDirectory() ||
        entry.isSymbolicLink()
      ) {
        throw new InstallerError(
          "unsafe-state",
          "cache contains a malformed candidate temporary",
        );
      }
      await this.#removeStrictDirectory(
        path.join(this.#paths.cacheRoot, entry.name),
        (name) => name === "package.deb" || name === "artifact.json",
      );
    }
    if (cacheEntries.some((entry) => entry.name.startsWith(".candidate-"))) {
      await syncDirectory(this.#paths.cacheRoot);
    }
    const stateEntries = await readdir(this.#paths.stateRoot, {
      withFileTypes: true,
    });
    const journalPhases = new Set<string>(
      LINUX_RELEASE_INSTALLER_JOURNAL_PHASES,
    );
    for (const entry of stateEntries) {
      if (!entry.name.startsWith(".journal.")) continue;
      const temporary =
        /^\.journal\.([0-9a-f]{32})\.([a-z-]+)\.([1-9][0-9]{0,9})\.(0|[1-9][0-9]{0,19})$/u
          .exec(entry.name);
      if (
        temporary === null ||
        !journalPhases.has(temporary[2] ?? "") ||
        !entry.isFile() ||
        entry.isSymbolicLink()
      ) {
        throw new InstallerError(
          "unsafe-state",
          "state contains a malformed journal temporary",
        );
      }
      const metadata = await lstat(
        path.join(this.#paths.stateRoot, entry.name),
      );
      if (
        metadata.uid !== this.#ownerUid ||
        metadata.gid !== this.#ownerGid ||
        modeOf(metadata) !== 0o600
      ) {
        throw new InstallerError(
          "unsafe-state",
          "journal temporary is not root protected",
        );
      }
      await unlink(path.join(this.#paths.stateRoot, entry.name));
    }
    if (stateEntries.some((entry) => entry.name.startsWith(".journal."))) {
      await syncDirectory(this.#paths.stateRoot);
    }
  }

  public async readJournal(): Promise<LinuxReleaseInstallerJournal | null> {
    const journalPath = path.join(this.#paths.stateRoot, JOURNAL_FILE);
    let raw: Buffer;
    try {
      raw = await readBoundedProtectedFile(
        journalPath,
        this.#ownerUid,
        MAX_JOURNAL_BYTES,
      );
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    try {
      const text = raw.toString("utf8");
      const journal = decodeLinuxReleaseInstallerJournal(JSON.parse(text));
      if (encodeLinuxReleaseInstallerJournal(journal) !== text) {
        throw new Error("journal is not canonical");
      }
      return journal;
    } catch (error) {
      throw new InstallerError(
        "unsafe-state",
        error instanceof Error ? error.message : "journal is malformed",
      );
    }
  }

  public async writeJournal(
    journal: LinuxReleaseInstallerJournal,
  ): Promise<void> {
    const text = encodeLinuxReleaseInstallerJournal(journal);
    const temporary = path.join(
      this.#paths.stateRoot,
      `.journal.${journal.transactionId}.${journal.phase}.${journal.owner.pid}.${journal.owner.startTicks}`,
    );
    const destination = path.join(this.#paths.stateRoot, JOURNAL_FILE);
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        temporary,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(text, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, destination);
      await syncDirectory(this.#paths.stateRoot);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  public async clearJournal(): Promise<void> {
    const journalPath = path.join(this.#paths.stateRoot, JOURNAL_FILE);
    try {
      await unlink(journalPath);
      await syncDirectory(this.#paths.stateRoot);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  public async beginStage(transactionId: string): Promise<ProtectedStage> {
    const directory = path.join(this.#paths.spoolRoot, transactionId);
    await mkdir(directory, { mode: 0o700 });
    await assertProtectedDirectory(
      directory,
      this.#ownerUid,
      this.#ownerGid,
    );
    await syncDirectory(this.#paths.spoolRoot);
    const stage: ProtectedStage = {
      transactionId,
      files: new Set<string>(),
    };
    stageDirectories.set(stage, directory);
    return stage;
  }

  async #assertFreeSpace(directory: string, requestedBytes: number): Promise<void> {
    const filesystem = await statfs(directory, { bigint: true });
    const available = filesystem.bavail * filesystem.bsize;
    const reserve = 1024n * 1024n * 1024n;
    if (available < BigInt(requestedBytes) + reserve) {
      throw new InstallerError(
        "policy",
        "root installer safety reserve would be exhausted",
      );
    }
  }

  public async reserveBundle(bytes: number): Promise<void> {
    if (!Number.isSafeInteger(bytes) || bytes < 1) {
      throw new InstallerError("protocol", "bundle reservation is invalid");
    }
    const [spoolMetadata, cacheMetadata] = await Promise.all([
      lstat(this.#paths.spoolRoot),
      lstat(this.#paths.cacheRoot),
    ]);
    if (spoolMetadata.dev === cacheMetadata.dev) {
      await this.#assertFreeSpace(this.#paths.spoolRoot, bytes * 2);
    } else {
      await this.#assertFreeSpace(this.#paths.spoolRoot, bytes);
      await this.#assertFreeSpace(this.#paths.cacheRoot, bytes);
    }
  }

  public async writeStageFile(
    stage: ProtectedStage,
    descriptor: LinuxReleaseInstallerFile,
    chunks: AsyncIterable<Uint8Array>,
  ): Promise<void> {
    const directory = stageDirectories.get(stage);
    if (directory === undefined || stage.files.has(descriptor.name)) {
      throw new InstallerError("unsafe-state", "stage authority is invalid");
    }
    const destination = path.join(directory, descriptor.name);
    let handle: FileHandle | undefined;
    let bytes = 0;
    let nextCapacityCheck = 64 * 1024 * 1024;
    const hash = createHash("sha256");
    try {
      handle = await open(
        destination,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_NOFOLLOW,
        0o600,
      );
      for await (const value of chunks) {
        const chunk = Buffer.from(value);
        bytes += chunk.length;
        if (bytes > descriptor.bytes) {
          throw new InstallerError("protocol", "installer file is oversized");
        }
        hash.update(chunk);
        if (bytes >= nextCapacityCheck) {
          await this.#assertFreeSpace(
            this.#paths.spoolRoot,
            descriptor.bytes - bytes,
          );
          nextCapacityCheck += 64 * 1024 * 1024;
        }
        let offset = 0;
        while (offset < chunk.length) {
          const written = await handle.write(
            chunk,
            offset,
            chunk.length - offset,
          );
          if (written.bytesWritten < 1) {
            throw new Error("short write to protected spool");
          }
          offset += written.bytesWritten;
        }
      }
      if (
        bytes !== descriptor.bytes ||
        hash.digest("hex") !== descriptor.sha256
      ) {
        throw new InstallerError(
          "verification",
          "installer file does not match its framed hash",
        );
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      (stage.files as Set<string>).add(descriptor.name);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(destination).catch(() => undefined);
      throw error;
    }
  }

  public async finishStage(stage: ProtectedStage): Promise<void> {
    const directory = stageDirectories.get(stage);
    if (directory === undefined) {
      throw new InstallerError("unsafe-state", "stage authority is invalid");
    }
    await syncDirectory(directory);
    await syncDirectory(this.#paths.spoolRoot);
  }

  async #readBridgeMetadata(
    file: string,
    uid: number,
    gid: number,
    maximum: number,
  ): Promise<{ readonly text: string; readonly metadata: Stats }> {
    const handle = await open(
      file,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    try {
      const before = await handle.stat();
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.uid !== uid ||
        before.gid !== gid ||
        modeOf(before) !== 0o600 ||
        before.nlink !== 1 ||
        before.size < 1 ||
        before.size > maximum
      ) {
        throw new InstallerError(
          "identity",
          "bridge metadata is not exact for the sudo caller",
        );
      }
      const text = await handle.readFile({ encoding: "utf8" });
      const after = await handle.stat();
      const pathname = await lstat(file);
      if (
        !sameInode(before, after) ||
        !sameInode(before, pathname) ||
        after.size !== Buffer.byteLength(text, "utf8")
      ) {
        throw new InstallerError(
          "identity",
          "bridge metadata changed during import",
        );
      }
      return { text, metadata: after };
    } finally {
      await handle.close();
    }
  }

  public async importBridgeStage(
    prepare: Extract<
      LinuxReleaseInstallerRequest,
      { readonly kind: "prepare" }
    >,
  ): Promise<ImportedBridgeStage> {
    const root = await lstat(this.#bridgeStageRoot);
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      root.uid !== this.#ownerUid ||
      root.gid !== this.#ownerGid ||
      (root.mode & 0o7777) !== 0o1733 ||
      await realpath(this.#bridgeStageRoot) !== this.#bridgeStageRoot
    ) {
      throw new InstallerError(
        "unsafe-state",
        "fixed bridge stage root is not root-owned mode 01733",
      );
    }
    const sourceDirectory = linuxReleaseBridgeStagePath(
      prepare.target.uid,
      prepare.transactionId,
      this.#bridgeStageRoot,
    );
    const directory = await lstat(sourceDirectory);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      directory.uid !== prepare.target.uid ||
      directory.gid !== prepare.target.gid ||
      modeOf(directory) !== 0o700 ||
      (process.platform === "linux"
        ? directory.nlink !== 2
        : directory.nlink < 1) ||
      await realpath(sourceDirectory) !== sourceDirectory
    ) {
      throw new InstallerError(
        "identity",
        "selected bridge stage directory is not exact",
      );
    }
    const stageMetadataPath = path.join(
      sourceDirectory,
      LINUX_RELEASE_BRIDGE_STAGE_METADATA,
    );
    const authMetadataPath = path.join(
      sourceDirectory,
      LINUX_RELEASE_BRIDGE_AUTH_METADATA,
    );
    const stageMetadata = await this.#readBridgeMetadata(
      stageMetadataPath,
      prepare.target.uid,
      prepare.target.gid,
      LINUX_RELEASE_INSTALLER_MAX_HEADER_BYTES,
    );
    const authMetadata = await this.#readBridgeMetadata(
      authMetadataPath,
      prepare.target.uid,
      prepare.target.gid,
      4 * 1024,
    );
    let request: LinuxReleaseBridgeStageRequest;
    let auth: LinuxReleaseBridgeAuthArmed;
    try {
      request = decodeLinuxReleaseBridgeStageRequest(
        JSON.parse(stageMetadata.text),
      );
      auth = decodeLinuxReleaseBridgeAuthArmed(
        JSON.parse(authMetadata.text),
      );
      if (
        encodeLinuxReleaseBridgeStageRequest(request) !== stageMetadata.text ||
        encodeLinuxReleaseBridgeAuthArmed(auth) !== authMetadata.text
      ) {
        throw new Error("bridge metadata is not canonical");
      }
    } catch (error) {
      throw new InstallerError(
        "protocol",
        error instanceof Error ? error.message : "bridge metadata is malformed",
      );
    }
    if (!bridgeMetadataBindsPrepare(prepare, request, auth)) {
      throw new InstallerError(
        "identity",
        "bridge metadata does not bind the privileged prepare frame",
      );
    }
    const stage = await this.beginStage(prepare.transactionId);
    const sourceHandles: Array<{
      readonly descriptor: LinuxReleaseInstallerFile;
      readonly handle: FileHandle;
      readonly metadata: Stats;
      readonly source: string;
    }> = [];
    try {
      for (const descriptor of request.files) {
        const source = path.join(sourceDirectory, descriptor.name);
        const handle = await open(
          source,
          fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
        );
        const metadata = await handle.stat();
        if (
          !metadata.isFile() ||
          metadata.isSymbolicLink() ||
          metadata.uid !== prepare.target.uid ||
          metadata.gid !== prepare.target.gid ||
          modeOf(metadata) !== 0o600 ||
          metadata.nlink !== 1 ||
          metadata.size !== descriptor.bytes
        ) {
          await handle.close();
          throw new InstallerError(
            "identity",
            "bridge payload inode is not exact",
          );
        }
        sourceHandles.push({ descriptor, handle, metadata, source });
        await this.writeStageFile(
          stage,
          descriptor,
          handle.createReadStream({
            autoClose: false,
            start: 0,
            end: descriptor.bytes - 1,
          }),
        );
      }
      await this.finishStage(stage);
      for (const source of sourceHandles) {
        const current = await source.handle.stat();
        const pathname = await lstat(source.source);
        if (
          !sameInode(source.metadata, current) ||
          !sameInode(source.metadata, pathname) ||
          current.size !== source.descriptor.bytes
        ) {
          throw new InstallerError(
            "identity",
            "bridge payload changed during secure import",
          );
        }
      }
      const currentDirectory = await lstat(sourceDirectory);
      if (!sameInode(directory, currentDirectory)) {
        throw new InstallerError(
          "identity",
          "bridge stage path changed during secure import",
        );
      }
      for (const source of sourceHandles) {
        await source.handle.close();
      }
      // The privileged importer never deletes from the same-UID bridge
      // directory. The unprivileged bridge retains the directory descriptor
      // and performs exact cleanup after the sudo child exits.
      return { stage, request, auth };
    } catch (error) {
      for (const source of sourceHandles) {
        await source.handle.close().catch(() => undefined);
      }
      await this.discardStage(stage).catch(() => undefined);
      throw error;
    }
  }

  public async discardStage(stage: ProtectedStage): Promise<void> {
    const directory = stageDirectories.get(stage);
    if (directory === undefined) return;
    for (const name of stage.files) {
      await unlink(path.join(directory, name)).catch((error) => {
        if (!isMissing(error)) throw error;
      });
    }
    await syncDirectory(directory).catch(() => undefined);
    await rmdir(directory).catch((error) => {
      if (!isMissing(error)) throw error;
    });
    await syncDirectory(this.#paths.spoolRoot).catch(() => undefined);
    stageDirectories.delete(stage);
  }

  public async verifyProtectedBundle(
    stage: ProtectedStage,
  ): Promise<VerifiedProtectedLinuxBundle> {
    const directory = stageDirectories.get(stage);
    if (directory === undefined) {
      throw new InstallerError("unsafe-state", "stage authority is invalid");
    }
    await assertProtectedDirectory(
      directory,
      this.#ownerUid,
      this.#ownerGid,
    );
    return await this.#verifier(directory);
  }

  #stageFile(stage: ProtectedStage, file: string): string {
    const directory = stageDirectories.get(stage);
    if (
      directory === undefined ||
      !stage.files.has(file) ||
      path.basename(file) !== file
    ) {
      throw new InstallerError("unsafe-state", "protected file is not staged");
    }
    return path.join(directory, file);
  }

  public async inspectProtectedDeb(
    stage: ProtectedStage,
    file: string,
  ): Promise<LinuxDebInspection> {
    const deb = this.#stageFile(stage, file);
    const field = async (name: string): Promise<string> => {
      const output = await requireCommand(
        this.#run,
        "/usr/bin/dpkg-deb",
        ["--field", deb, name],
        30_000,
      );
      if (output.includes("\0") || output.includes("\r")) {
        throw new Error("dpkg-deb field output is malformed");
      }
      const normalized = output.endsWith("\n")
        ? output.slice(0, -1)
        : output;
      if (normalized.includes("\n")) {
        throw new Error("dpkg-deb field output is multiline");
      }
      return normalized;
    };
    await requireCommand(
      this.#run,
      "/usr/bin/dpkg-deb",
      ["--info", deb],
      30_000,
    );
    return {
      packageName: await field("Package"),
      version: await field("Version"),
      architecture: await field("Architecture"),
      essential: await field("Essential") as "" | "no",
      preDepends: await field("Pre-Depends") as "",
      depends: await field("Depends"),
    };
  }

  public async currentVersion(): Promise<string | null> {
    const result = await this.#run(
      "/usr/bin/dpkg-query",
      ["--show", "--showformat=${Status}\\t${Version}\\n", "vellum"],
      30_000,
    );
    if (
      result.code === 1 &&
      result.stdout === "" &&
      result.stderr === "dpkg-query: no packages found matching vellum\n"
    ) {
      return null;
    }
    if (result.code !== 0 || result.stderr !== "") {
      throw new InstallerError(
        "unsafe-state",
        "installed package state is indeterminate",
      );
    }
    const match = /^install ok installed\t([^\n]+)\n$/u.exec(result.stdout);
    if (
      result.code === 0 &&
      /^deinstall ok config-files\t[^\n]+\n$/u.test(result.stdout) &&
      result.stderr === ""
    ) {
      return null;
    }
    if (match === null || !VERSION.test(match[1] ?? "")) {
      throw new InstallerError(
        "unsafe-state",
        "installed package state is malformed",
      );
    }
    return match[1] ?? null;
  }

  public async observeCurrentVersion(): Promise<string | null> {
    const result = await this.#run(
      "/usr/bin/dpkg-query",
      ["--show", "--showformat=${Status}\\t${Version}\\n", "vellum"],
      30_000,
    );
    if (
      result.code === 1 &&
      result.stdout === "" &&
      result.stderr === "dpkg-query: no packages found matching vellum\n"
    ) {
      return null;
    }
    const match =
      /^(?:unknown|install|hold|deinstall|purge) (?:ok|reinstreq) (?:not-installed|config-files|half-installed|unpacked|half-configured|triggers-awaited|triggers-pending|installed)\t([^\n]+)\n$/u
        .exec(result.stdout);
    if (
      result.code !== 0 ||
      result.stderr !== "" ||
      match === null ||
      !VERSION.test(match[1] ?? "")
    ) {
      throw new InstallerError(
        "unsafe-state",
        "observed package version is indeterminate",
      );
    }
    return match[1] ?? null;
  }

  async #readCacheMetadata(version: string): Promise<{
    readonly directory: string;
    readonly packagePath: string;
    readonly metadata: CacheMetadata;
  } | null> {
    if (!VERSION.test(version)) {
      throw new InstallerError("unsafe-state", "cache version is malformed");
    }
    const directory = path.join(this.#paths.cacheRoot, `v-${version}`);
    try {
      await assertProtectedDirectory(
        directory,
        this.#ownerUid,
        this.#ownerGid,
      );
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    const metadataPath = path.join(directory, "artifact.json");
    const raw = await readBoundedProtectedFile(
      metadataPath,
      this.#ownerUid,
      MAX_JOURNAL_BYTES,
    );
    let metadata: CacheMetadata;
    try {
      const text = raw.toString("utf8");
      metadata = decodeCacheMetadata(JSON.parse(text));
      if (
        cacheMetadataText(metadata) !== text ||
        metadata.version !== version
      ) {
        throw new Error("cache metadata is not canonical");
      }
    } catch (error) {
      throw new InstallerError(
        "unsafe-state",
        error instanceof Error ? error.message : "cache metadata is malformed",
      );
    }
    return {
      directory,
      packagePath: path.join(directory, "package.deb"),
      metadata,
    };
  }

  public async findCachedArtifact(
    version: string,
  ): Promise<ProtectedArtifact | null> {
    const cached = await this.#readCacheMetadata(version);
    if (cached === null) return null;
    const handle = await openVerifiedProtectedFile(
      cached.packagePath,
      this.#ownerUid,
      cached.metadata.bytes,
      cached.metadata.debSha256,
    );
    await handle.close();
    const artifact: ProtectedArtifact = Object.freeze({
      version,
      sha256: cached.metadata.debSha256,
      bytes: cached.metadata.bytes,
    });
    artifactPaths.set(artifact, cached.packagePath);
    return artifact;
  }

  public async cacheMatches(
    candidate: LinuxReleaseInstallerCandidate,
  ): Promise<boolean> {
    const cached = await this.#readCacheMetadata(candidate.version);
    if (cached === null) return false;
    if (
      cached.metadata.debSha256 !== candidate.debSha256 ||
      cached.metadata.manifestSha256 !== candidate.manifestSha256
    ) {
      return false;
    }
    const handle = await openVerifiedProtectedFile(
      cached.packagePath,
      this.#ownerUid,
      cached.metadata.bytes,
      cached.metadata.debSha256,
    );
    await handle.close();
    return true;
  }

  public async cacheCandidate(
    stage: ProtectedStage,
    verified: VerifiedProtectedLinuxBundle,
  ): Promise<ProtectedArtifact> {
    const existing = await this.#readCacheMetadata(verified.version);
    if (existing !== null) {
      if (
        existing.metadata.debSha256 !== verified.debSha256 ||
        existing.metadata.manifestSha256 !== verified.manifestSha256 ||
        existing.metadata.bytes !== verified.debBytes
      ) {
        throw new InstallerError(
          "policy",
          "a signed release version is immutable and already cached",
        );
      }
      const handle = await openVerifiedProtectedFile(
        existing.packagePath,
        this.#ownerUid,
        verified.debBytes,
        verified.debSha256,
      );
      await handle.close();
      const artifact: ProtectedArtifact = Object.freeze({
        version: verified.version,
        sha256: verified.debSha256,
        bytes: verified.debBytes,
      });
      artifactPaths.set(artifact, existing.packagePath);
      return artifact;
    }
    const finalDirectory = path.join(
      this.#paths.cacheRoot,
      `v-${verified.version}`,
    );
    const directory = path.join(
      this.#paths.cacheRoot,
      `.candidate-${stage.transactionId}-${verified.version}`,
    );
    await mkdir(directory, { mode: 0o700 });
    await assertProtectedDirectory(
      directory,
      this.#ownerUid,
      this.#ownerGid,
    );
    const source = this.#stageFile(stage, verified.debFile);
    const destination = path.join(directory, "package.deb");
    const metadataPath = path.join(directory, "artifact.json");
    let sourceHandle: FileHandle | undefined;
    let destinationHandle: FileHandle | undefined;
    let metadataHandle: FileHandle | undefined;
    try {
      sourceHandle = await openVerifiedProtectedFile(
        source,
        this.#ownerUid,
        verified.debBytes,
        verified.debSha256,
      );
      destinationHandle = await open(
        destination,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_NOFOLLOW,
        0o600,
      );
      const hash = createHash("sha256");
      let bytes = 0;
      for await (
        const value of sourceHandle.createReadStream({
          autoClose: false,
          start: 0,
          end: verified.debBytes - 1,
        })
      ) {
        const chunk = Buffer.from(value);
        bytes += chunk.length;
        if (bytes % (64 * 1024 * 1024) < chunk.length) {
          await this.#assertFreeSpace(
            this.#paths.cacheRoot,
            verified.debBytes - bytes,
          );
        }
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const written = await destinationHandle.write(
            chunk,
            offset,
            chunk.length - offset,
          );
          if (written.bytesWritten < 1) throw new Error("short cache write");
          offset += written.bytesWritten;
        }
      }
      if (
        bytes !== verified.debBytes ||
        hash.digest("hex") !== verified.debSha256
      ) {
        throw new InstallerError(
          "unsafe-state",
          "protected candidate changed during cache copy",
        );
      }
      await destinationHandle.sync();
      await destinationHandle.close();
      destinationHandle = undefined;
      const metadata: CacheMetadata = {
        schema: "vellum/linux-release-installer-cache/v1",
        version: verified.version,
        bytes: verified.debBytes,
        debSha256: verified.debSha256,
        manifestSha256: verified.manifestSha256,
      };
      metadataHandle = await open(
        metadataPath,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_NOFOLLOW,
        0o600,
      );
      await metadataHandle.writeFile(cacheMetadataText(metadata), "utf8");
      await metadataHandle.sync();
      await metadataHandle.close();
      metadataHandle = undefined;
      await syncDirectory(directory);
      await rename(directory, finalDirectory);
      await syncDirectory(this.#paths.cacheRoot);
      const artifact: ProtectedArtifact = Object.freeze({
        version: verified.version,
        sha256: verified.debSha256,
        bytes: verified.debBytes,
      });
      artifactPaths.set(artifact, path.join(finalDirectory, "package.deb"));
      return artifact;
    } catch (error) {
      await destinationHandle?.close().catch(() => undefined);
      await metadataHandle?.close().catch(() => undefined);
      await unlink(metadataPath).catch(() => undefined);
      await unlink(destination).catch(() => undefined);
      await rmdir(directory).catch(() => undefined);
      await syncDirectory(this.#paths.cacheRoot).catch(() => undefined);
      throw error;
    } finally {
      await sourceHandle?.close().catch(() => undefined);
    }
  }

  async #readRootMetadataFile(
    file: string,
    maximum = 8 * 1024 * 1024,
  ): Promise<Buffer> {
    const handle = await open(
      file,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    try {
      const metadata = await handle.stat();
      if (
        !metadata.isFile() ||
        metadata.uid !== this.#ownerUid ||
        (metadata.mode & 0o022) !== 0 ||
        metadata.size < 1 ||
        metadata.size > maximum
      ) {
        throw new InstallerError(
          "unsafe-state",
          "dpkg package metadata is not root protected",
        );
      }
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  async #candidatePayloadEntries(payloadRoot: string): Promise<
    ReadonlyArray<{
      readonly relative: string;
      readonly type: "directory" | "file" | "symlink";
      readonly mode: number;
      readonly uid: number;
      readonly gid: number;
      readonly bytes?: number;
      readonly sha256?: string;
      readonly link?: string;
    }>
  > {
    const collected: Array<{
      readonly relative: string;
      readonly type: "directory" | "file" | "symlink";
      readonly mode: number;
      readonly uid: number;
      readonly gid: number;
      readonly bytes?: number;
      readonly sha256?: string;
      readonly link?: string;
    }> = [];
    let totalBytes = 0;
    const visit = async (directory: string, prefix: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries.sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0
      )) {
        if (
          entry.name === "." ||
          entry.name === ".." ||
          entry.name.includes("/") ||
          entry.name.includes("\\") ||
          entry.name.includes("\0")
        ) {
          throw new InstallerError(
            "unsafe-state",
            "candidate payload contains an unsafe path",
          );
        }
        const relative = prefix === ""
          ? entry.name
          : `${prefix}/${entry.name}`;
        const candidatePath = path.join(payloadRoot, relative);
        const metadata = await lstat(candidatePath);
        const common = {
          relative,
          mode: metadata.mode & 0o7777,
          uid: metadata.uid,
          gid: metadata.gid,
        };
        if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
          collected.push({ ...common, type: "directory" });
          await visit(candidatePath, relative);
        } else if (metadata.isFile() && !metadata.isSymbolicLink()) {
          totalBytes += metadata.size;
          if (
            !Number.isSafeInteger(totalBytes) ||
            totalBytes > 3 * 1024 * 1024 * 1024
          ) {
            throw new InstallerError(
              "unsafe-state",
              "candidate payload is oversized",
            );
          }
          const handle = await open(
            candidatePath,
            fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
          );
          try {
            collected.push({
              ...common,
              type: "file",
              bytes: metadata.size,
              sha256: await hashHandle(handle, metadata.size),
            });
          } finally {
            await handle.close();
          }
        } else if (metadata.isSymbolicLink()) {
          collected.push({
            ...common,
            type: "symlink",
            link: await readlink(candidatePath),
          });
        } else {
          throw new InstallerError(
            "unsafe-state",
            "candidate payload contains a special file",
          );
        }
        if (collected.length > 100_000) {
          throw new InstallerError(
            "unsafe-state",
            "candidate payload contains too many paths",
          );
        }
      }
    };
    await visit(payloadRoot, "");
    return collected;
  }

  async #proveInstalledPayload(
    payloadRoot: string,
  ): Promise<void> {
    const entries = await this.#candidatePayloadEntries(payloadRoot);
    const expectedPaths = new Set(entries.map((entry) => `/${entry.relative}`));
    const installedList = (
      await this.#readRootMetadataFile(
        path.join(this.#dpkgInfoRoot, "vellum.list"),
        16 * 1024 * 1024,
      )
    ).toString("utf8");
    const listedPaths = new Set(
      installedList.split("\n").filter((value) => value !== "").map((value) => {
        if (!value.startsWith("/") || value.includes("\0")) {
          throw new InstallerError(
            "unsafe-state",
            "installed dpkg path list is malformed",
          );
        }
        const normalized = path.posix.normalize(value.replace(/\/\.$/u, "/"));
        if (!normalized.startsWith("/") || normalized.includes("..")) {
          throw new InstallerError(
            "unsafe-state",
            "installed dpkg path list escapes root",
          );
        }
        return normalized.length > 1 && normalized.endsWith("/")
          ? normalized.slice(0, -1)
          : normalized;
      }).filter((value) => value !== "/"),
    );
    if (
      expectedPaths.size !== listedPaths.size ||
      [...expectedPaths].some((value) => !listedPaths.has(value))
    ) {
      throw new InstallerError(
        "unsafe-state",
        "installed dpkg path list differs from signed candidate",
      );
    }
    for (const entry of entries) {
      const installedPath = path.join(this.#installedRoot, entry.relative);
      const installedParent = entry.type === "symlink"
        ? path.dirname(installedPath)
        : installedPath;
      if (await realpath(installedParent) !== path.resolve(installedParent)) {
        throw new InstallerError(
          "unsafe-state",
          "installed package path traverses a symbolic link",
        );
      }
      const metadata = await lstat(installedPath);
      if (
        (metadata.mode & 0o7777) !== entry.mode ||
        metadata.uid !== entry.uid ||
        metadata.gid !== entry.gid
      ) {
        throw new InstallerError(
          "unsafe-state",
          "installed payload metadata differs from signed candidate",
        );
      }
      if (entry.type === "directory") {
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
          throw new InstallerError(
            "unsafe-state",
            "installed payload type differs from signed candidate",
          );
        }
      } else if (entry.type === "symlink") {
        if (
          !metadata.isSymbolicLink() ||
          await readlink(installedPath) !== entry.link
        ) {
          throw new InstallerError(
            "unsafe-state",
            "installed symlink differs from signed candidate",
          );
        }
      } else {
        if (
          !metadata.isFile() ||
          metadata.isSymbolicLink() ||
          metadata.size !== entry.bytes
        ) {
          throw new InstallerError(
            "unsafe-state",
            "installed payload type differs from signed candidate",
          );
        }
        const handle = await open(
          installedPath,
          fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
        );
        try {
          if (await hashHandle(handle, metadata.size) !== entry.sha256) {
            throw new InstallerError(
              "unsafe-state",
              "installed payload content differs from signed candidate",
            );
          }
        } finally {
          await handle.close();
        }
      }
    }
  }

  async #removeExtractedTree(root: string): Promise<void> {
    const entries = await this.#candidatePayloadEntries(root);
    for (const entry of [...entries].sort((left, right) =>
      right.relative.split("/").length - left.relative.split("/").length
    )) {
      const target = path.join(root, entry.relative);
      if (entry.type === "directory") await rmdir(target);
      else await unlink(target);
    }
    await syncDirectory(root);
    await rmdir(root);
  }

  public async adoptInstalledCandidate(
    stage: ProtectedStage,
    verified: VerifiedProtectedLinuxBundle,
    invocation: LinuxReleaseInstallerInvocation,
  ): Promise<void> {
    if (await this.currentVersion() !== verified.version) {
      throw new InstallerError(
        "unsafe-state",
        "installed package version changed before adoption",
      );
    }
    const deb = this.#stageFile(stage, verified.debFile);
    const directory = stageDirectories.get(stage);
    if (directory === undefined) {
      throw new InstallerError("unsafe-state", "stage authority is invalid");
    }
    const controlDirectory = path.join(directory, ".candidate-control");
    const payloadDirectory = path.join(directory, ".candidate-payload");
    await mkdir(controlDirectory, { mode: 0o700 });
    await mkdir(payloadDirectory, { mode: 0o700 });
    try {
      const extraction = await this.#run(
        "/usr/bin/dpkg-deb",
        ["--control", deb, controlDirectory],
        30_000,
      );
      if (extraction.code !== 0) {
        throw new InstallerError(
          "verification",
          "candidate control archive could not be inspected",
        );
      }
      const payloadExtraction = await this.#run(
        "/usr/bin/dpkg-deb",
        ["--extract", deb, payloadDirectory],
        60_000,
      );
      if (payloadExtraction.code !== 0) {
        throw new InstallerError(
          "verification",
          "candidate payload could not be inspected",
        );
      }
      await assertProtectedDirectory(
        controlDirectory,
        this.#ownerUid,
        this.#ownerGid,
      );
      const entries = await readdir(controlDirectory, { withFileTypes: true });
      const allowed = new Set([
        "control",
        "md5sums",
        "preinst",
        "postinst",
        "prerm",
        "postrm",
        "conffiles",
        "triggers",
      ]);
      const names = new Set(entries.map((entry) => entry.name));
      if (
        !names.has("control") ||
        !names.has("md5sums") ||
        entries.length > allowed.size ||
        entries.some((entry) =>
          !allowed.has(entry.name) ||
          !entry.isFile() ||
          entry.isSymbolicLink()
        )
      ) {
        throw new InstallerError(
          "unsafe-state",
          "candidate control archive violates adoption policy",
        );
      }
      for (const name of [...allowed].filter((value) => value !== "control")) {
        const candidatePath = path.join(controlDirectory, name);
        const installedPath = path.join(this.#dpkgInfoRoot, `vellum.${name}`);
        const candidatePresent = names.has(name);
        let installedPresent: boolean;
        try {
          installedPresent = (await lstat(installedPath)).isFile();
        } catch (error) {
          if (!isMissing(error)) throw error;
          installedPresent = false;
        }
        if (candidatePresent !== installedPresent) {
          throw new InstallerError(
            "unsafe-state",
            "installed dpkg metadata differs from signed candidate",
          );
        }
        if (
          candidatePresent &&
          !(await this.#readRootMetadataFile(candidatePath)).equals(
            await this.#readRootMetadataFile(installedPath),
          )
        ) {
          throw new InstallerError(
            "unsafe-state",
            "installed dpkg metadata differs from signed candidate",
          );
        }
      }
      const candidateControl = await this.inspectProtectedDeb(
        stage,
        verified.debFile,
      );
      const installedControl = await this.#run(
        "/usr/bin/dpkg-query",
        [
          "--show",
          "--showformat=${Package}\\t${Version}\\t${Architecture}\\t${Essential}\\t${Pre-Depends}\\t${Depends}\\n",
          "vellum",
        ],
        30_000,
      );
      const installedFields =
        installedControl.stdout.endsWith("\n") &&
          !installedControl.stdout.slice(0, -1).includes("\n")
          ? installedControl.stdout.slice(0, -1).split("\t")
          : [];
      if (
        installedControl.code !== 0 ||
        installedControl.stderr !== "" ||
        installedFields.length !== 6 ||
        installedFields[0] !== "vellum" ||
        installedFields[1] !== verified.version ||
        installedFields[2] !== "amd64" ||
        (installedFields[3] !== "" && installedFields[3] !== "no") ||
        installedFields[4] !== "" ||
        installedFields[5] !== candidateControl.depends
      ) {
        throw new InstallerError(
          "unsafe-state",
          "installed package control identity differs from signed candidate",
        );
      }
      await this.#proveInstalledPayload(payloadDirectory);
      await this.#assertPackagedUnitPolicy(invocation);
    } finally {
      const entries = await readdir(controlDirectory, {
        withFileTypes: true,
      });
      for (const entry of entries) {
        if (entry.isFile() && !entry.isSymbolicLink()) {
          await unlink(path.join(controlDirectory, entry.name));
        }
      }
      await syncDirectory(controlDirectory);
      await rmdir(controlDirectory);
      await this.#removeExtractedTree(payloadDirectory);
      await syncDirectory(directory);
    }
  }

  async #runUserSystemctl(
    invocation: LinuxReleaseInstallerInvocation,
    arguments_: ReadonlyArray<string>,
  ): Promise<FixedCommandResult> {
    /*
     * The single-owner user manager is an operational actuator and
     * work-preservation witness, not the root authorization boundary. Its
     * answers may stop a transaction, but never select candidate bytes,
     * privileged paths, package commands, or rollback authority; those are
     * fixed and signed before this surface is consulted.
     */
    const runtimeDirectory = path.join(
      this.#runtimeRoot,
      String(invocation.sudoUid),
    );
    const runtimeMetadata = await lstat(runtimeDirectory);
    const busMetadata = await lstat(path.join(runtimeDirectory, "bus"));
    if (
      !runtimeMetadata.isDirectory() ||
      runtimeMetadata.isSymbolicLink() ||
      runtimeMetadata.uid !== invocation.sudoUid ||
      modeOf(runtimeMetadata) !== 0o700 ||
      !busMetadata.isSocket() ||
      busMetadata.isSymbolicLink() ||
      busMetadata.uid !== invocation.sudoUid
    ) {
      throw new InstallerError(
        "unsafe-state",
        "target user systemd bus topology is unavailable",
      );
    }
    const home = await this.#resolveTargetHome(invocation);
    return await this.#run(
      "/usr/sbin/runuser",
      [
        "--user",
        invocation.sudoUser,
        "--",
        "/usr/bin/env",
        "--ignore-environment",
        "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
        "LANG=C",
        "LC_ALL=C",
        `HOME=${home}`,
        `XDG_RUNTIME_DIR=${runtimeDirectory}`,
        `DBUS_SESSION_BUS_ADDRESS=unix:path=${runtimeDirectory}/bus`,
        "/usr/bin/systemctl",
        "--user",
        ...arguments_,
      ],
      30_000,
    );
  }

  async #resolveTargetHome(
    invocation: LinuxReleaseInstallerInvocation,
  ): Promise<string> {
    const passwd = await this.#run(
      "/usr/bin/getent",
      ["passwd", String(invocation.sudoUid)],
      30_000,
    );
    const fields = passwd.stdout.endsWith("\n")
      ? passwd.stdout.slice(0, -1).split(":")
      : [];
    const home = fields[5];
    if (
      passwd.code !== 0 ||
      passwd.stderr !== "" ||
      fields.length !== 7 ||
      fields[0] !== invocation.sudoUser ||
      fields[2] !== String(invocation.sudoUid) ||
      fields[3] !== String(invocation.sudoGid) ||
      home === undefined ||
      !path.isAbsolute(home) ||
      home.includes("\0")
    ) {
      throw new InstallerError(
        "identity",
        "sudo identity does not match the fixed passwd database",
      );
    }
    const homeMetadata = await lstat(home);
    if (
      !homeMetadata.isDirectory() ||
      homeMetadata.isSymbolicLink() ||
      homeMetadata.uid !== invocation.sudoUid
    ) {
      throw new InstallerError(
        "unsafe-state",
        "target user home is not trustworthy",
      );
    }
    return home;
  }

  async #assertPackagedUnitPolicy(
    invocation: LinuxReleaseInstallerInvocation,
  ): Promise<void> {
    const packageVerification = await this.#run(
      "/usr/bin/dpkg",
      ["--verify", "vellum"],
      30_000,
    );
    if (
      packageVerification.code !== 0 ||
      packageVerification.stdout !== "" ||
      packageVerification.stderr !== ""
    ) {
      throw new Error("package-owned user unit failed integrity verification");
    }
    const expected = new Map([
      ["FragmentPath", "/usr/lib/systemd/user/vellum-remote.service\n"],
      ["DropInPaths", "\n"],
      ["LoadState", "loaded\n"],
      ["Type", "notify\n"],
      ["NotifyAccess", "all\n"],
      [
        "UnsetEnvironment",
        `${SYSTEMD_UNSET_ENVIRONMENT.join(" ")}\n`,
      ],
    ]);
    for (const [property, output] of expected) {
      const result = await this.#runUserSystemctl(invocation, [
        "show",
        "vellum-remote.service",
        `--property=${property}`,
        "--value",
      ]);
      if (result.code !== 0 || result.stdout !== output || result.stderr !== "") {
        throw new InstallerError(
          "unsafe-state",
          "user unit is masked, overridden, or not package-owned",
        );
      }
    }
  }

  async #unitProperty(
    invocation: LinuxReleaseInstallerInvocation,
    property: string,
  ): Promise<string> {
    const result = await this.#runUserSystemctl(invocation, [
      "show",
      "vellum-remote.service",
      `--property=${property}`,
      "--value",
    ]);
    if (
      result.code !== 0 ||
      result.stderr !== "" ||
      !result.stdout.endsWith("\n") ||
      result.stdout.slice(0, -1).includes("\n")
    ) {
      throw new InstallerError(
        "unsafe-state",
        `Remote unit ${property} is indeterminate`,
      );
    }
    return result.stdout.slice(0, -1);
  }

  async #processFacts(pid: number): Promise<{
    readonly startTicks: string;
    readonly parentPid: number;
    readonly uid: number;
    readonly gid: number;
    readonly cgroup: string;
    readonly invocationId: string;
    readonly executable: string;
    readonly arguments: ReadonlyArray<string>;
    readonly environmentSha256: string;
    readonly environment: Readonly<Record<string, string>>;
  }> {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = close < 0 ? [] : stat.slice(close + 2).trim().split(/\s+/u);
    const parentPid = Number(fields[1]);
    const startTicks = fields[19];
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const uidFields = /^Uid:\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)$/mu
      .exec(status);
    const gidFields = /^Gid:\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)$/mu
      .exec(status);
    const cgroupRaw = await readFile(`/proc/${pid}/cgroup`, "utf8");
    const cgroup = /^0::([^\n]+)\n$/u.exec(cgroupRaw)?.[1];
    const environment = (await readFile(`/proc/${pid}/environ`))
      .toString("utf8")
      .split("\0")
      .filter((entry) => entry !== "");
    const invocationEntries = environment.filter((entry) =>
      entry.startsWith("INVOCATION_ID=")
    );
    const environmentNames = environment.map((entry) =>
      entry.slice(0, entry.indexOf("="))
    );
    const environmentRecord = Object.freeze(
      Object.fromEntries(
        environment.map((entry) => {
          const separator = entry.indexOf("=");
          return [entry.slice(0, separator), entry.slice(separator + 1)];
        }),
      ),
    );
    const executable = await realpath(`/proc/${pid}/exe`);
    const argvRaw = await readFile(`/proc/${pid}/cmdline`);
    const arguments_ = argvRaw.toString("utf8").split("\0").filter(
      (entry) => entry !== "",
    );
    if (
      startTicks === undefined ||
      !/^(0|[1-9][0-9]{0,19})$/u.test(startTicks) ||
      !Number.isSafeInteger(parentPid) ||
      parentPid < 1 ||
      uidFields === null ||
      gidFields === null ||
      new Set(uidFields.slice(1)).size !== 1 ||
      new Set(gidFields.slice(1)).size !== 1 ||
      cgroup === undefined ||
      invocationEntries.length !== 1 ||
      !/^INVOCATION_ID=[0-9a-f]{32}$/u.test(invocationEntries[0] ?? "") ||
      environment.some((entry) =>
        !/^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(entry)
      ) ||
      new Set(environmentNames).size !== environmentNames.length ||
      environmentNames.some(forbiddenServiceEnvironmentName) ||
      arguments_.length === 0
    ) {
      throw new InstallerError(
        "unsafe-state",
        "Remote process identity is malformed",
      );
    }
    return {
      startTicks,
      parentPid,
      uid: Number(uidFields[1]),
      gid: Number(gidFields[1]),
      cgroup,
      invocationId: invocationEntries[0]!.slice("INVOCATION_ID=".length),
      executable,
      arguments: Object.freeze(arguments_),
      environmentSha256: createHash("sha256")
        .update([...environment].sort().join("\0"), "utf8")
        .digest("hex"),
      environment: environmentRecord,
    };
  }

  async #validateTermPeer(
    socket: Socket,
    invocation: LinuxReleaseInstallerInvocation,
    target: LinuxReleaseInstallerTarget,
  ): Promise<LinuxReleaseTermPeerObservation> {
    const descriptor = socketFileDescriptor(socket);
    if (descriptor === undefined) {
      throw new InstallerError(
        "unsafe-state",
        "TermControl peer descriptor is unavailable",
      );
    }
    const helper =
      "/opt/Vellum Command/resources/bin/unix-peer-pid.py";
    const result = spawnSync("/usr/bin/python3", [helper], {
      stdio: [descriptor, "pipe", "pipe"],
      encoding: "utf8",
      timeout: 1_000,
      env: commandEnvironment,
    });
    const peerPid = /^[1-9][0-9]*$/u.test(result.stdout?.trim() ?? "")
      ? Number(result.stdout.trim())
      : NaN;
    if (
      result.status !== 0 ||
      result.stderr !== "" ||
      !Number.isSafeInteger(peerPid) ||
      peerPid < 1
    ) {
      throw new InstallerError(
        "unsafe-state",
        "SO_PEERCRED TermControl peer is unavailable",
      );
    }
    await this.#assertPackagedUnitPolicy(invocation);
    const [
      active,
      sub,
      fragment,
      dropIns,
      generation,
      mainPidRaw,
      controlGroup,
    ] = await Promise.all([
      this.#unitProperty(invocation, "ActiveState"),
      this.#unitProperty(invocation, "SubState"),
      this.#unitProperty(invocation, "FragmentPath"),
      this.#unitProperty(invocation, "DropInPaths"),
      this.#unitProperty(invocation, "InvocationID"),
      this.#unitProperty(invocation, "MainPID"),
      this.#unitProperty(invocation, "ControlGroup"),
    ]);
    const mainPid = /^[1-9][0-9]*$/u.test(mainPidRaw)
      ? Number(mainPidRaw)
      : NaN;
    if (
      active !== "active" ||
      sub !== "running" ||
      fragment !== "/usr/lib/systemd/user/vellum-remote.service" ||
      dropIns !== "" ||
      !/^[0-9a-f]{32}$/u.test(generation) ||
      !Number.isSafeInteger(mainPid) ||
      mainPid < 1 ||
      peerPid === mainPid ||
      !controlGroup.endsWith("/vellum-remote.service")
    ) {
      throw new InstallerError(
        "unsafe-state",
        "TermControl unit generation is not package-owned and active",
      );
    }
    const [mainBefore, peerBefore] = await Promise.all([
      this.#processFacts(mainPid),
      this.#processFacts(peerPid),
    ]);
    const wrapper =
      "/opt/Vellum Command/resources/systemd/vellum-remote-launch-v1";
    const app = "/opt/Vellum Command/vellum";
    const targetHome = await this.#resolveTargetHome(invocation);
    const runtimeDirectory = path.join(
      this.#runtimeRoot,
      String(target.uid),
    );
    const baseEnvironment = {
      PATH: "/usr/bin:/bin",
      HOME: targetHome,
      XDG_STATE_HOME: path.join(targetHome, ".local", "state"),
      XDG_RUNTIME_DIR: runtimeDirectory,
      INVOCATION_ID: generation,
      ELECTRON_OZONE_PLATFORM_HINT: "x11",
      OZONE_PLATFORM: "x11",
      XDG_SESSION_TYPE: "x11",
      PWD: targetHome,
    };
    const display = peerBefore.environment.DISPLAY;
    const authority = peerBefore.environment.XAUTHORITY;
    const displayMatch = /^:(89|9[0-6])$/u.exec(display ?? "");
    const peerEnvironment = displayMatch === null
      ? null
      : {
        ...baseEnvironment,
        DISPLAY: display!,
        XAUTHORITY: path.join(
          runtimeDirectory,
          "vellum-remote",
          `x11-${generation}`,
          "authority",
        ),
      };
    if (
      mainBefore.uid !== target.uid ||
      mainBefore.gid !== target.gid ||
      mainBefore.invocationId !== generation ||
      mainBefore.cgroup !== controlGroup ||
      mainBefore.arguments.length !== 3 ||
      mainBefore.arguments[1] !== wrapper ||
      mainBefore.arguments[2] !== "--clean" ||
      !new Set(["/bin/sh", "/bin/dash", "/usr/bin/dash"]).has(
        mainBefore.arguments[0]!,
      ) ||
      !new Set(["/bin/dash", "/usr/bin/dash"]).has(mainBefore.executable) ||
      !exactProcessEnvironment(mainBefore.environment, baseEnvironment) ||
      peerBefore.parentPid !== mainPid ||
      peerBefore.uid !== target.uid ||
      peerBefore.gid !== target.gid ||
      peerBefore.invocationId !== generation ||
      peerBefore.cgroup !== controlGroup ||
      peerBefore.executable !== app ||
      peerBefore.arguments.length !== 3 ||
      peerBefore.arguments[0] !== app ||
      peerBefore.arguments[1] !== "--vellum-headless" ||
      peerBefore.arguments[2] !== "--ozone-platform=x11" ||
      peerEnvironment === null ||
      authority !== peerEnvironment.XAUTHORITY ||
      !exactProcessEnvironment(peerBefore.environment, peerEnvironment)
    ) {
      throw new InstallerError(
        "unsafe-state",
        "TermControl peer is not the exact Remote Electron child",
      );
    }
    const [mainAfter, peerAfter, generationAfter, mainPidAfter] =
      await Promise.all([
        this.#processFacts(mainPid),
        this.#processFacts(peerPid),
        this.#unitProperty(invocation, "InvocationID"),
        this.#unitProperty(invocation, "MainPID"),
      ]);
    const packageVerification = await this.#run(
      "/usr/bin/dpkg",
      ["--verify", "vellum"],
      30_000,
    );
    if (
      mainAfter.startTicks !== mainBefore.startTicks ||
      peerAfter.startTicks !== peerBefore.startTicks ||
      mainAfter.invocationId !== mainBefore.invocationId ||
      peerAfter.invocationId !== peerBefore.invocationId ||
      mainAfter.environmentSha256 !== mainBefore.environmentSha256 ||
      peerAfter.environmentSha256 !== peerBefore.environmentSha256 ||
      generationAfter !== generation ||
      mainPidAfter !== mainPidRaw ||
      packageVerification.code !== 0 ||
      packageVerification.stdout !== "" ||
      packageVerification.stderr !== ""
    ) {
      throw new InstallerError(
        "unsafe-state",
        "TermControl generation changed during peer validation",
      );
    }
    return {
      pid: peerPid,
      uid: peerBefore.uid,
      gid: peerBefore.gid,
      startTicks: peerBefore.startTicks,
      generation,
      invocationId: peerBefore.invocationId,
    };
  }

  public async openFenceControl(
    invocation: LinuxReleaseInstallerInvocation,
    target: LinuxReleaseInstallerTarget,
  ): Promise<LinuxReleaseFenceControl> {
    if (this.#fenceControlFactory !== undefined) {
      return await this.#fenceControlFactory(invocation, target);
    }
    const targetHome = await this.#resolveTargetHome(invocation);
    return new LinuxReleaseFenceController({
      paths: {
        targetHome,
        ...(this.#fenceDirectory === undefined
          ? {}
          : { fenceDirectory: this.#fenceDirectory }),
        ...(this.#fencePath === undefined
          ? {}
          : { fencePath: this.#fencePath }),
      },
      target,
      rootUid: this.#ownerUid,
      rootGid: this.#ownerGid,
      validatePeer: (socket) =>
        this.#validateTermPeer(socket, invocation, target),
    });
  }

  public async machineIdSha256(): Promise<string> {
    if (this.#readMachineIdSha256 !== undefined) {
      return await this.#readMachineIdSha256();
    }
    const raw = await readFile("/etc/machine-id", "utf8");
    if (!/^[0-9a-f]{32}\n?$/u.test(raw)) {
      throw new InstallerError(
        "unsafe-state",
        "machine identity is malformed",
      );
    }
    return createHash("sha256").update(raw.trim(), "utf8").digest("hex");
  }

  public async currentOperationalState(
    invocation: LinuxReleaseInstallerInvocation,
  ): Promise<LinuxOperationalState> {
    const [enabled, active, linger] = await Promise.all([
      this.#runUserSystemctl(invocation, [
        "is-enabled",
        "vellum-remote.service",
      ]),
      this.#runUserSystemctl(invocation, [
        "is-active",
        "vellum-remote.service",
      ]),
      this.#run(
        "/usr/bin/loginctl",
        [
          "show-user",
          String(invocation.sudoUid),
          "--property=Linger",
          "--value",
        ],
        30_000,
      ),
    ]);
    const enabledState = enabled.stdout === "enabled\n" && enabled.code === 0
      ? "enabled"
      : enabled.stdout === "disabled\n" && enabled.code !== 0
      ? "disabled"
      : enabled.stdout === "not-found\n" && enabled.code !== 0
      ? "absent"
      : null;
    const activeState = active.stdout === "active\n" && active.code === 0
      ? "active"
      : active.stdout === "inactive\n" && active.code !== 0
      ? "inactive"
      : null;
    if (
      enabledState === null ||
      activeState === null ||
      linger.code !== 0 ||
      (linger.stdout !== "yes\n" && linger.stdout !== "no\n")
    ) {
      throw new InstallerError(
        "unsafe-state",
        "service or linger state is indeterminate",
      );
    }
    return {
      service: `${enabledState}-${activeState}` as LinuxOperationalState[
        "service"
      ],
      linger: linger.stdout === "yes\n",
    };
  }

  async #mutationUnitState(transactionId: string): Promise<string> {
    const result = await this.#run(
      "/usr/bin/systemctl",
      [
        "is-active",
        `vellum-release-install-${transactionId}.service`,
      ],
      30_000,
    );
    if (result.stdout === "inactive\n" || result.stdout === "failed\n") {
      return result.stdout.trim();
    }
    if (result.stdout === "active\n" || result.stdout === "activating\n") {
      return result.stdout.trim();
    }
    if (result.code === 4 && result.stdout === "unknown\n") return "unknown";
    // Collected transient units commonly report no stdout and status 4.
    if (result.code === 4 && result.stdout === "") return "unknown";
    throw new InstallerError(
      "unsafe-state",
      "dpkg transaction scope state is indeterminate",
    );
  }

  async #assertMutationQuiescent(transactionId: string): Promise<void> {
    const state = await this.#mutationUnitState(transactionId);
    if (state === "active" || state === "activating") {
      throw new InstallerError(
        "rollback-failed",
        "prior dpkg transaction scope is still active",
      );
    }
  }

  async #runDpkgTransaction(
    unit: string,
    dpkgArguments: ReadonlyArray<string>,
  ): Promise<void> {
    const output = await this.#run(
      "/usr/bin/systemd-run",
      [
        "--system",
        "--quiet",
        "--wait",
        "--collect",
        "--pipe",
        "--service-type=exec",
        `--unit=${unit}`,
        "--property=KillMode=control-group",
        "--property=TimeoutStopSec=30s",
        "--property=RuntimeMaxSec=180s",
        "--",
        "/usr/bin/dpkg",
        ...dpkgArguments,
      ],
      240_000,
    );
    if (output.code !== 0) {
      throw new Error("scoped dpkg transaction failed");
    }
  }

  public async installCandidate(
    stage: ProtectedStage,
    verified: VerifiedProtectedLinuxBundle,
  ): Promise<void> {
    const source = this.#stageFile(stage, verified.debFile);
    const handle = await openVerifiedProtectedFile(
      source,
      this.#ownerUid,
      verified.debBytes,
      verified.debSha256,
    );
    await handle.close();
    await this.#runDpkgTransaction(
      `vellum-release-install-${stage.transactionId}.service`,
      ["--install", source],
    );
    const version = await this.currentVersion();
    if (version !== verified.version) {
      throw new Error("dpkg did not install the signed release version");
    }
  }

  public async activateAndVerify(
    invocation: LinuxReleaseInstallerInvocation,
    version: string,
  ): Promise<LinuxReleaseInstallerReadinessEvidence> {
    const linger = await this.#run(
      "/usr/bin/loginctl",
      ["enable-linger", invocation.sudoUser],
      30_000,
    );
    if (linger.code !== 0) throw new Error("failed to enable Remote linger");
    for (const arguments_ of [
      ["daemon-reload"],
    ] as const) {
      const result = await this.#runUserSystemctl(invocation, arguments_);
      if (result.code !== 0) {
        throw new Error("failed to activate Remote service");
      }
    }
    await this.#assertPackagedUnitPolicy(invocation);
    for (const arguments_ of [
      ["enable", "vellum-remote.service"],
      ["restart", "vellum-remote.service"],
    ] as const) {
      const result = await this.#runUserSystemctl(invocation, arguments_);
      if (result.code !== 0) {
        throw new Error("failed to activate Remote service");
      }
    }
    const generationResult = await this.#runUserSystemctl(invocation, [
      "show",
      "vellum-remote.service",
      "--property=InvocationID",
      "--value",
    ]);
    const generation = generationResult.stdout.endsWith("\n")
      ? generationResult.stdout.slice(0, -1)
      : generationResult.stdout;
    if (
      generationResult.code !== 0 ||
      !/^[0-9a-f]{32}$/u.test(generation)
    ) {
      throw new Error("Remote service generation is unavailable");
    }
    return await this.verifyCurrentReadiness(
      invocation,
      version,
      generation,
    );
  }

  public async verifyCurrentReadiness(
    invocation: LinuxReleaseInstallerInvocation,
    version: string,
    generation: string,
  ): Promise<LinuxReleaseInstallerReadinessEvidence> {
    if (!VERSION.test(version) || !/^[0-9a-f]{32}$/u.test(generation)) {
      throw new InstallerError(
        "unsafe-state",
        "readiness binding is malformed",
      );
    }
    const readinessPath = path.join(
      this.#runtimeRoot,
      String(invocation.sudoUid),
      "vellum",
      "station-ready.json",
    );
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      try {
        const handle = await open(
          readinessPath,
          fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
        );
        try {
          const metadata = await handle.stat();
          if (
            metadata.isFile() &&
            metadata.uid === invocation.sudoUid &&
            modeOf(metadata) === 0o600 &&
            metadata.size > 0 &&
            metadata.size <= MAX_JOURNAL_BYTES
          ) {
            const raw = await handle.readFile({ encoding: "utf8" });
            if (validateReadinessReceipt(raw, generation)) {
              if (await this.currentVersion() !== version) {
                throw new Error("installed version changed during activation");
              }
              const verification = await this.#run(
                "/usr/bin/dpkg",
                ["--verify", "vellum"],
                30_000,
              );
              if (
                verification.code !== 0 ||
                verification.stdout !== "" ||
                verification.stderr !== ""
              ) {
                throw new Error("installed package integrity is not exact");
              }
              return {
                state: "ready",
                generation,
                packageVersion: version,
                receiptSha256: createHash("sha256")
                  .update(raw, "utf8")
                  .digest("hex"),
              };
            }
          }
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("fresh Remote station readiness receipt did not arrive");
  }

  async #restoreOperationalState(
    invocation: LinuxReleaseInstallerInvocation,
    journal: LinuxReleaseInstallerJournal,
  ): Promise<void> {
    const [enabled, active] = journal.oldServiceState.split("-") as [
      "enabled" | "disabled" | "absent",
      "active" | "inactive",
    ];
    const enableResult = enabled === "absent"
      ? { code: 0, stdout: "", stderr: "" }
      : await this.#runUserSystemctl(invocation, [
        enabled === "enabled" ? "enable" : "disable",
        "vellum-remote.service",
      ]);
    const activeResult = enabled === "absent"
      ? { code: 0, stdout: "", stderr: "" }
      : await this.#runUserSystemctl(invocation, [
        active === "active" ? "start" : "stop",
        "vellum-remote.service",
      ]);
    const lingerResult = await this.#run(
      "/usr/bin/loginctl",
      [
        journal.oldLinger ? "enable-linger" : "disable-linger",
        invocation.sudoUser,
      ],
      30_000,
    );
    if (
      enableResult.code !== 0 ||
      activeResult.code !== 0 ||
      lingerResult.code !== 0
    ) {
      throw new Error("failed to restore Remote operational state");
    }
  }

  async #recoveryPackageState(): Promise<
    | { readonly kind: "absent" }
    | {
      readonly kind: "installed" | "intermediate";
      readonly version: string;
      readonly status: string;
    }
  > {
    const result = await this.#run(
      "/usr/bin/dpkg-query",
      ["--show", "--showformat=${Status}\\t${Version}\\n", "vellum"],
      30_000,
    );
    if (
      result.code === 1 &&
      result.stdout === "" &&
      result.stderr === "dpkg-query: no packages found matching vellum\n"
    ) {
      return { kind: "absent" };
    }
    if (result.code !== 0 || result.stderr !== "") {
      throw new InstallerError(
        "rollback-failed",
        "rollback package state is indeterminate",
      );
    }
    if (/^deinstall ok config-files\t[^\n]+\n$/u.test(result.stdout)) {
      return { kind: "absent" };
    }
    const match =
      /^(install (?:ok|reinstreq) (?:installed|half-installed|unpacked|half-configured|triggers-awaited|triggers-pending))\t([^\n]+)\n$/u
        .exec(result.stdout);
    const status = match?.[1];
    const version = match?.[2];
    if (
      status === undefined ||
      version === undefined ||
      !VERSION.test(version)
    ) {
      throw new InstallerError(
        "rollback-failed",
        "rollback package state is malformed",
      );
    }
    return {
      kind: status === "install ok installed"
        ? "installed"
        : "intermediate",
      version,
      status,
    };
  }

  public async rollback(
    invocation: LinuxReleaseInstallerInvocation,
    journal: LinuxReleaseInstallerJournal,
  ): Promise<void> {
    await this.#assertMutationQuiescent(journal.transactionId);
    const packageState = await this.#recoveryPackageState();
    if (journal.operation === "adopt") {
      if (
        packageState.kind !== "installed" ||
        packageState.version !== journal.fromVersion
      ) {
        throw new Error("adoption rollback package version changed");
      }
    } else if (journal.fromVersion === null) {
      if (packageState.kind !== "absent") {
        if (packageState.version !== journal.toVersion) {
          throw new InstallerError(
            "rollback-failed",
            "rollback refuses to overwrite an unrelated package version",
          );
        }
        await this.#runDpkgTransaction(
          `vellum-release-rollback-${journal.transactionId}.service`,
          ["--purge", "vellum"],
        );
      }
      if (await this.currentVersion() !== null) {
        throw new Error("first-install rollback did not purge package");
      }
    } else {
      if (packageState.kind === "absent") {
        throw new InstallerError(
          "rollback-failed",
          "rollback package disappeared outside the recorded transaction",
        );
      }
      if (
        packageState.version !== journal.fromVersion &&
        packageState.version !== journal.toVersion
      ) {
        throw new InstallerError(
          "rollback-failed",
          "rollback refuses to overwrite an unrelated package version",
        );
      }
      if (
        packageState.kind !== "installed" ||
        packageState.version !== journal.fromVersion
      ) {
        const prior = await this.findCachedArtifact(journal.fromVersion);
        const priorPath = prior === null ? undefined : artifactPaths.get(prior);
        if (
          prior === null ||
          priorPath === undefined ||
          prior.sha256 !== journal.priorArtifactSha256
        ) {
          throw new InstallerError(
            "rollback-failed",
            "root rollback artifact is missing or changed",
          );
        }
        const handle = await openVerifiedProtectedFile(
          priorPath,
          this.#ownerUid,
          prior.bytes,
          prior.sha256,
        );
        await handle.close();
        await this.#runDpkgTransaction(
          `vellum-release-rollback-${journal.transactionId}.service`,
          ["--install", priorPath],
        );
      }
      if (await this.currentVersion() !== journal.fromVersion) {
        throw new Error("rollback did not restore prior package version");
      }
    }
    await this.#restoreOperationalState(invocation, journal);
    if (journal.fromVersion !== null) {
      const verification = await this.#run(
        "/usr/bin/dpkg",
        ["--verify", "vellum"],
        30_000,
      );
      if (
        verification.code !== 0 ||
        verification.stdout !== "" ||
        verification.stderr !== ""
      ) {
        throw new Error("rollback package integrity is not exact");
      }
    }
    const restored = await this.currentOperationalState(invocation);
    if (
      restored.service !== journal.oldServiceState ||
      restored.linger !== journal.oldLinger
    ) {
      throw new Error("rollback operational state did not match journal");
    }
  }

  public async deleteCachedArtifact(
    artifact: ProtectedArtifact,
  ): Promise<void> {
    const packagePath = artifactPaths.get(artifact);
    if (packagePath === undefined) {
      throw new InstallerError(
        "unsafe-state",
        "cache deletion authority was not minted here",
      );
    }
    const directory = path.dirname(packagePath);
    if (
      directory !==
        path.join(this.#paths.cacheRoot, `v-${artifact.version}`)
    ) {
      throw new InstallerError(
        "unsafe-state",
        "cache deletion escaped the fixed root",
      );
    }
    // Revalidate exact root-owned authority immediately before deletion.
    const handle = await openVerifiedProtectedFile(
      packagePath,
      this.#ownerUid,
      artifact.bytes,
      artifact.sha256,
    );
    await handle.close();
    await unlink(path.join(directory, "artifact.json"));
    await unlink(packagePath);
    await syncDirectory(directory);
    await rmdir(directory);
    await syncDirectory(this.#paths.cacheRoot);
    artifactPaths.delete(artifact);
  }
}

const productionVerifier: VerifyProtectedLinuxBundle = async (directory) => {
  const [
    { verifyProductionLinuxDeployBundle },
    { LINUX_RELEASE_MANIFEST },
  ] = await Promise.all([
    import("../src/main/vellum/hosts/linux-release-admission"),
    import("./linux-release-bundle"),
  ]);
  const candidate = await verifyProductionLinuxDeployBundle({
    bundleDirectory: directory,
  });
  const manifestPath = path.join(directory, LINUX_RELEASE_MANIFEST);
  const handle = await open(
    manifestPath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  let manifestSha256: string;
  try {
    manifestSha256 = await hashHandle(handle);
  } finally {
    await handle.close();
  }
  return {
    version: candidate.receipt.version,
    sourceRevision: candidate.receipt.sourceRevision,
    manifestSha256,
    debFile: candidate.receipt.packageFile,
    debBytes: candidate.receipt.packageBytes,
    debSha256: candidate.receipt.packageSha256,
  };
};

export const makeProductionLinuxReleaseInstallerHost = ():
  NodeLinuxReleaseInstallerHost =>
    new NodeLinuxReleaseInstallerHost({
      paths: {
        stateRoot: FIXED_STATE_ROOT,
        spoolRoot: FIXED_SPOOL_ROOT,
        cacheRoot: FIXED_CACHE_ROOT,
      },
      ownerUid: 0,
      ownerGid: 0,
      verifyProtectedBundle: productionVerifier,
    });

const verifyInstalledExecutable = async (): Promise<void> => {
  const executable = await realpath(process.execPath);
  if (executable !== FIXED_INSTALLER) {
    throw new InstallerError(
      "identity",
      "installer source/interpreter execution is forbidden",
    );
  }
  const metadata = await lstat(executable);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== 0 ||
    metadata.gid !== 0 ||
    (modeOf(metadata) !== 0o755 && modeOf(metadata) !== 0o700)
  ) {
    throw new InstallerError(
      "identity",
      "installed helper inode is not root-owned and immutable to the caller",
    );
  }
};

const writeReceiptFrame = (
  receipt: LinuxReleaseInstallerReceipt,
): Promise<void> =>
  new Promise((resolve, reject) => {
    process.stdout.write(
      encodeLinuxReleaseInstallerReceipt(receipt),
      (error) => {
        if (error === null || error === undefined) resolve();
        else reject(error);
      },
    );
  });

/**
 * A flushed canonical receipt is application status, including refusal and
 * rollback. SSH transports reserve a non-zero exit for the absence of a
 * complete receipt so they do not discard a valid failure frame.
 */
export const linuxReleaseInstallerReceiptExitCode = (
  _receipt: LinuxReleaseInstallerReceipt,
): 0 => 0;

if (import.meta.main) {
  try {
    await verifyInstalledExecutable();
    const invocation = await deriveLinuxReleaseInstallerInvocation();
    const receipt = await runLinuxReleaseInstaller(
      process.stdin,
      invocation,
      makeProductionLinuxReleaseInstallerHost(),
      defaultDeadlines,
      writeReceiptFrame,
    );
    await writeReceiptFrame(receipt);
    // The canonical receipt is application status. A zero exit tells the SSH
    // transport that the complete transcript arrived, including refusal and
    // rolled-back outcomes.
    process.exitCode = linuxReleaseInstallerReceiptExitCode(receipt);
  } catch (error) {
    if (error instanceof InstallerError) {
      try {
        const receipt = refusal(error.category, null);
        await writeReceiptFrame(receipt);
        process.exitCode = linuxReleaseInstallerReceiptExitCode(receipt);
      } catch {
        process.exitCode = 1;
      }
    } else {
      // An unexpected crash without a flushed canonical receipt is a
      // transport failure and must not be mistaken for application status.
      process.exitCode = 1;
    }
  }
}
