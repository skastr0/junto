#!/usr/bin/env bun
/**
 * Thin, operator-owned two-installation Linux qualification driver.
 *
 * This script owns only disposable OrbStack VM lifecycle, exact artifact
 * custody, packaged operator CLI invocation, and bounded observations. It does
 * not implement Station verbs, open product state, or mint a passing release
 * qualification receipt.
 *
 * Roles:
 *   Command Center — Electron desktop (Xvfb allowed for headless lab).
 *   Remote — displayless generation-pinned Node user service only
 *            (`vellum-remote.service` → resources/bin/vellum-remote). Never
 *            Electron, Chromium, renderer, CDP, Xvfb, or DISPLAY.
 *
 * Fresh VMs (when not cloning a pinned golden): 
 *   orbctl create -a amd64 ubuntu:24.04
 * Do not repair or reuse a failed guest as a substitute for a stock host.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  createReadStream,
} from "node:fs";
import {
  access,
  appendFile,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Either } from "effect";
import {
  LINUX_QUALIFICATION_CANDIDATE_PURPOSE,
  LINUX_RELEASE_MANIFEST,
  type LinuxQualificationCandidateVerificationReceipt,
  type LinuxReleaseVerificationReceipt,
} from "./linux-release-bundle";
import { redactLinuxCiLog } from "./linux-ci-evidence";
import {
  verifyProductionLinuxDeployBundle,
  verifyQualificationLinuxDeployBundle,
} from "../src/main/vellum/hosts/linux-release-admission";
import {
  decodeStationQualification,
  STATION_QUALIFICATION_EVIDENCE_FILE,
  STATION_QUALIFICATION_RECEIPT_FILE,
  STATION_QUALIFICATION_SCHEMA,
} from "../src/shared/station-qualification";
import {
  STATION_API_PROTOCOL,
} from "../src/shared/station-api";
import {
  decodeStationSessionFrame,
  STATION_SESSION_PROTOCOL,
} from "../src/shared/station-session";
import { STATION_PROTOCOL_BASELINE } from "../src/shared/station-protocol";
import {
  assertNoTcpListeners,
  descendantRows,
  hasDebugAuthority,
  parseProcessRows,
} from "./packaged-runtime-smoke";
import { parseProcSandboxStatus } from "./linux-ci-packaged-smoke";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const OBSERVATION_SCHEMA =
  "vellum/linux-orbstack-observation/v2" as const;
const RUN_STATE_SCHEMA =
  "vellum/linux-orbstack-run-state/v3" as const;
const EVIDENCE_FILE = STATION_QUALIFICATION_EVIDENCE_FILE;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const MAX_EVIDENCE_LINE_BYTES = 32 * 1024;
const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;
const STATION_PROTOCOL = STATION_PROTOCOL_BASELINE;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEPLOY_COMMAND_TIMEOUT_MS = 10 * 60_000;
const RUN_ID = /^[a-z0-9][a-z0-9-]{2,31}$/u;
const MACHINE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{5,127}$/u;
const MACHINE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const USERNAME = /^[a-z_][a-z0-9_-]{0,31}$/u;
const SOURCE_COMMIT = /^[0-9a-f]{40}$/u;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const INSTALLATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_BASENAME = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,255}$/u;
const shellLiteral = (value: string): string =>
  `'${value.replaceAll("'", `'"'"'`)}'`;

export type QualificationMode = "prepare" | "run" | "observe" | "cleanup";
export type QualificationKind =
  | "qualification-candidate"
  | "final-release";

export interface CommandRequest {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly input?: string;
  readonly timeoutMs?: number;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandExecutor {
  readonly run: (request: CommandRequest) => Promise<CommandResult>;
}

interface OrbMachineInfo {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  readonly image: {
    readonly distro: string;
    readonly version: string;
    readonly arch: string;
  };
  readonly config: {
    readonly defaultUsername: string;
  };
  readonly ip?: string;
}

interface ArtifactIdentity {
  readonly version: string;
  readonly sourceCommit: string;
  readonly archiveFile: string;
  readonly archiveBytes: number;
  readonly archiveSha256: string;
  readonly manifestSha256: string;
  readonly stationProtocol: typeof STATION_PROTOCOL;
  readonly bundleFiles: ReadonlyArray<string>;
  readonly verification: {
    readonly schema:
      | LinuxReleaseVerificationReceipt["schema"]
      | LinuxQualificationCandidateVerificationReceipt["schema"];
    readonly keyId: string;
    readonly keyringRevision: number;
    readonly signedAt: string;
    readonly expiresAt: string;
    readonly filesVerified: number;
    readonly purpose?: typeof LINUX_QUALIFICATION_CANDIDATE_PURPOSE;
    readonly publishable?: false;
    readonly ciEvidenceSha256?: string;
  };
}

interface RunMachine {
  readonly id: string;
  readonly name: string;
  readonly username: string;
  readonly sshEndpoint?: string;
}

type QualificationVirtualization = "orbstack" | "box";

interface QualificationPhaseProof {
  readonly commandCenterInstallationId: string;
  readonly remoteInstallationId: string;
  readonly phases: {
    readonly managedDeploy: "passed";
    readonly initialSync: "passed";
    readonly workRoundTrip: "passed";
    readonly commandCenterOffline: "passed";
    readonly remoteRestart: "passed";
    readonly idempotentRedeploy: "passed";
  };
  readonly doctor: unknown;
  readonly stationVerbs: {
    readonly pair: "request-response-observed";
    readonly configure: "request-response-observed";
    readonly project: "request-response-observed";
    readonly report: "request-response-observed";
    readonly status: "request-response-observed";
  };
  readonly pty: {
    readonly echo: "live-packaged-runtime-observed";
    readonly utf8: "live-packaged-runtime-observed";
    readonly resize: "live-packaged-runtime-observed";
    readonly exit: "live-packaged-runtime-observed";
    readonly shutdown: "live-packaged-runtime-observed";
  };
  readonly deployment: {
    readonly activation: {
      readonly generation: string;
      readonly unitExecStart: string;
      readonly conditionExecutable: string;
    };
    readonly corruptCandidate: {
      readonly candidateSha256: string;
      readonly outcome: "rejected-before-activation";
      readonly before: GenerationState;
      readonly after: GenerationState;
    };
    readonly restart: {
      readonly before: GenerationState;
      readonly after: GenerationState;
    };
    readonly idempotentRedeploy: {
      readonly outcome: "already-active";
      readonly before: GenerationState;
      readonly after: GenerationState;
    };
    readonly hostMutation: {
      readonly sudoInvocations: 0;
      readonly privilegedInstallInvocations: 0;
      readonly systemPathMutations: 0;
    };
  };
}

interface GenerationState {
  readonly generation: string;
  readonly installationId: string;
  readonly invocationId: string;
}

export interface QualificationRunState {
  readonly schema: typeof RUN_STATE_SCHEMA;
  readonly runId: string;
  readonly kind: QualificationKind;
  readonly virtualization: QualificationVirtualization;
  readonly commandCenterMode:
    | "new-activation-checkpoint"
    | "retained-licensed";
  readonly golden?: RunMachine;
  readonly machines: {
    readonly commandCenter?: RunMachine;
    readonly remote?: RunMachine;
  };
  readonly artifact: ArtifactIdentity;
  readonly prepared: boolean;
  readonly managedRunAttempted: boolean;
  readonly managedDeployReady: boolean;
  readonly qualification?: QualificationPhaseProof;
  readonly failed: boolean;
  readonly cleaned: boolean;
}

export interface QualificationOptions {
  readonly mode: QualificationMode;
  readonly runId?: string;
  readonly confirmRunId?: string;
  readonly evidenceDirectory: string;
  readonly goldenName?: string;
  readonly goldenId?: string;
  readonly commandCenterName?: string;
  readonly commandCenterId?: string;
  readonly bundleDirectory?: string;
  readonly sourceCommit?: string;
  readonly kind?: QualificationKind;
  readonly virtualization?: QualificationVirtualization;
  readonly orbctlPath?: string;
}

interface EvidenceEvent {
  readonly schema: typeof OBSERVATION_SCHEMA;
  readonly at: string;
  readonly runId: string;
  readonly event: string;
  readonly status: "observation" | "passed" | "failed";
  readonly detail: unknown;
  readonly state?: QualificationRunState;
}

export interface QualificationDependencies {
  readonly executor?: CommandExecutor;
  readonly now?: () => Date;
}

const truncateUtf8 = (input: string, limit: number): string => {
  const bytes = Buffer.from(input, "utf8");
  if (bytes.byteLength <= limit) return input;
  return `${bytes.subarray(0, Math.max(0, limit - 32)).toString("utf8")}\n<truncated>`;
};

const defaultExecutor: CommandExecutor = {
  run: (request) =>
    new Promise((resolve, reject) => {
      const child = spawn(request.executable, [...request.args], {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PATH:
            process.env.PATH ??
              "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
        },
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) child.kill("SIGTERM");
      }, request.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
      timeout.unref();

      const collect = (current: string, chunk: Buffer | string): string => {
        const next = `${current}${String(chunk)}`;
        if (Buffer.byteLength(next, "utf8") > MAX_COMMAND_OUTPUT_BYTES) {
          child.kill("SIGTERM");
          reject(new Error("qualification command exceeded its output bound"));
          return truncateUtf8(next, MAX_COMMAND_OUTPUT_BYTES);
        }
        return next;
      };
      child.stdout.on("data", (chunk: Buffer) => {
        stdout = collect(stdout, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = collect(stderr, chunk);
      });
      child.on("error", (error) => {
        settled = true;
        clearTimeout(timeout);
        reject(error);
      });
      child.on("close", (code, signal) => {
        settled = true;
        clearTimeout(timeout);
        if (signal !== null) {
          reject(new Error(`qualification command terminated by ${signal}`));
          return;
        }
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
        });
      });
      if (request.input === undefined) child.stdin.end();
      else child.stdin.end(request.input);
    }),
};

const requiredString = (
  value: string | undefined,
  label: string,
  pattern?: RegExp,
): string => {
  if (
    value === undefined ||
    value.length === 0 ||
    value.includes("\0") ||
    (pattern !== undefined && !pattern.test(value))
  ) {
    throw new Error(`invalid or missing ${label}`);
  }
  return value;
};

export const requireRunId = (value: string | undefined): string =>
  requiredString(value, "qualification run id", RUN_ID);

export const qualificationMachineNames = (
  runIdInput: string,
): { readonly commandCenter: string; readonly remote: string } => {
  const runId = requireRunId(runIdInput);
  return {
    commandCenter: `vellum-q-${runId}-cc`,
    remote: `vellum-q-${runId}-remote`,
  };
};

const requireSafeMachineId = (value: string | undefined, label: string): string =>
  requiredString(value, label, MACHINE_ID);

const requireSourceCommit = (value: string | undefined): string =>
  requiredString(value, "source commit", SOURCE_COMMIT);

const commandFailure = (
  operation: string,
  result: CommandResult,
): Error => {
  const raw = result.stderr.trim() || result.stdout.trim();
  const redacted = redactLinuxCiLog(raw, {
    workspace: repoRoot,
    home: homedir(),
  }).output;
  return new Error(
    `${operation} exited ${String(result.exitCode)}${
      redacted.length === 0
        ? ""
        : `: ${truncateUtf8(redacted, 2 * 1024)}`
    }`,
  );
};

const runRequired = async (
  executor: CommandExecutor,
  operation: string,
  request: CommandRequest,
): Promise<CommandResult> => {
  const result = await executor.run(request);
  if (result.exitCode !== 0) throw commandFailure(operation, result);
  return result;
};

const sha256File = async (file: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });

const requireRegularPath = async (
  candidate: string,
  label: string,
): Promise<string> => {
  const requested = path.resolve(candidate);
  const requestedMetadata = await lstat(requested);
  if (!requestedMetadata.isFile() || requestedMetadata.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file`);
  }
  const canonical = await realpath(requested);
  const metadata = await lstat(canonical);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file`);
  }
  return canonical;
};

const requireBundleDirectory = async (
  candidate: string,
): Promise<string> => {
  const requested = path.resolve(candidate);
  const requestedMetadata = await lstat(requested);
  if (!requestedMetadata.isDirectory() || requestedMetadata.isSymbolicLink()) {
    throw new Error("release bundle is not a regular directory");
  }
  const canonical = await realpath(requested);
  const metadata = await lstat(canonical);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("release bundle is not a regular directory");
  }
  return canonical;
};

type VerifiedBundleReceipt =
  | LinuxReleaseVerificationReceipt
  | LinuxQualificationCandidateVerificationReceipt;

const inspectVerifiedBundle = async (input: {
  readonly canonicalBundleDirectory: string;
  readonly sourceCommit: string;
  readonly receipt: VerifiedBundleReceipt;
  readonly expectedKind: "qualification-candidate" | "final-release";
}): Promise<ArtifactIdentity & {
  readonly canonicalArchivePath: string;
  readonly canonicalBundleDirectory: string;
}> => {
  const { receipt } = input;
  if (receipt.sourceRevision !== input.sourceCommit) {
    throw new Error("release bundle source commit does not match the requested commit");
  }
  if (input.expectedKind === "qualification-candidate") {
    if (
      receipt.schema !==
        "vellum/linux-qualification-candidate-verification-receipt/v1" ||
      receipt.purpose !== LINUX_QUALIFICATION_CANDIDATE_PURPOSE ||
      receipt.publishable !== false ||
      !SHA256.test(receipt.ciEvidenceSha256)
    ) {
      throw new Error("qualification candidate verification receipt is invalid");
    }
  } else if (
    receipt.schema !== "vellum/linux-release-verification-receipt/v1"
  ) {
    throw new Error("final release verification receipt is invalid");
  }
  if (
    path.basename(receipt.packageFile) !== receipt.packageFile ||
    !SAFE_BASENAME.test(receipt.packageFile)
  ) {
    throw new Error("verified runtime archive name is unsafe");
  }
  const canonicalArchivePath = await requireRegularPath(
    path.join(input.canonicalBundleDirectory, receipt.packageFile),
    "verified runtime archive",
  );
  if (
    path.dirname(canonicalArchivePath) !== input.canonicalBundleDirectory
  ) {
    throw new Error("verified runtime archive escapes its signed bundle");
  }
  const archiveMetadata = await stat(canonicalArchivePath);
  const archiveSha256 = await sha256File(canonicalArchivePath);
  if (
    path.basename(canonicalArchivePath) !== receipt.packageFile ||
    archiveMetadata.size !== receipt.packageBytes ||
    archiveSha256 !== receipt.packageSha256
  ) {
    throw new Error(
      "runtime archive does not match the signed bundle manifest",
    );
  }
  const manifest = receipt.bundleFiles.find(
    (entry) => entry.file === LINUX_RELEASE_MANIFEST,
  );
  if (
    manifest === undefined ||
    !SHA256.test(manifest.sha256) ||
    receipt.bundleFiles.length < 4 ||
    receipt.bundleFiles.length > 64 ||
    receipt.filesVerified < 1 ||
    receipt.filesVerified > receipt.bundleFiles.length
  ) {
    throw new Error("verified release bundle inventory is incomplete");
  }
  const bundleFiles = receipt.bundleFiles.map(({ file }) => file);
  if (
    new Set(bundleFiles).size !== bundleFiles.length ||
    bundleFiles.some(
      (file) => path.basename(file) !== file || !SAFE_BASENAME.test(file),
    )
  ) {
    throw new Error("verified release bundle inventory is unsafe");
  }
  return {
    version: receipt.version,
    sourceCommit: input.sourceCommit,
    archiveFile: receipt.packageFile,
    archiveBytes: receipt.packageBytes,
    archiveSha256,
    manifestSha256: manifest.sha256,
    stationProtocol: STATION_PROTOCOL,
    bundleFiles,
    verification: {
      schema: receipt.schema,
      keyId: receipt.keyId,
      keyringRevision: receipt.keyringRevision,
      signedAt: receipt.signedAt,
      expiresAt: receipt.expiresAt,
      filesVerified: receipt.filesVerified,
      ...(receipt.schema ===
          "vellum/linux-qualification-candidate-verification-receipt/v1"
        ? {
            purpose: receipt.purpose,
            publishable: receipt.publishable,
            ciEvidenceSha256: receipt.ciEvidenceSha256,
          }
        : {}),
    },
    canonicalArchivePath,
    canonicalBundleDirectory: input.canonicalBundleDirectory,
  };
};

export const inspectManagedArtifact = async (input: {
  readonly bundleDirectory: string;
  readonly sourceCommit: string;
}): Promise<ArtifactIdentity & {
  readonly canonicalArchivePath: string;
  readonly canonicalBundleDirectory: string;
}> => {
  const canonicalBundleDirectory = await requireBundleDirectory(
    input.bundleDirectory,
  );
  const sourceCommit = requireSourceCommit(input.sourceCommit);
  const verified = await verifyProductionLinuxDeployBundle({
    bundleDirectory: canonicalBundleDirectory,
  });
  return inspectVerifiedBundle({
    canonicalBundleDirectory,
    sourceCommit,
    receipt: verified.receipt,
    expectedKind: "final-release",
  });
};

export const inspectQualificationCandidateArtifact = async (input: {
  readonly bundleDirectory: string;
  readonly sourceCommit: string;
}): Promise<ArtifactIdentity & {
  readonly canonicalArchivePath: string;
  readonly canonicalBundleDirectory: string;
}> => {
  const canonicalBundleDirectory = await requireBundleDirectory(
    input.bundleDirectory,
  );
  const sourceCommit = requireSourceCommit(input.sourceCommit);
  const verified = await verifyQualificationLinuxDeployBundle({
    bundleDirectory: canonicalBundleDirectory,
  });
  return inspectVerifiedBundle({
    canonicalBundleDirectory,
    sourceCommit,
    receipt: verified.receipt,
    expectedKind: "qualification-candidate",
  });
};

const parseOrbInfo = (
  stdout: string,
  expectedName: string,
): OrbMachineInfo => {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new Error(`OrbStack returned malformed info for ${expectedName}`);
  }
  const record =
    typeof raw === "object" &&
      raw !== null &&
      !Array.isArray(raw) &&
      typeof (raw as { record?: unknown }).record === "object" &&
      (raw as { record?: unknown }).record !== null
      ? (raw as { record: Record<string, unknown> }).record
      : undefined;
  const image =
    record !== undefined &&
      typeof record.image === "object" &&
      record.image !== null
      ? record.image as Record<string, unknown>
      : undefined;
  const config =
    record !== undefined &&
      typeof record.config === "object" &&
      record.config !== null
      ? record.config as Record<string, unknown>
      : undefined;
  if (
    record === undefined ||
    record.name !== expectedName ||
    typeof record.id !== "string" ||
    !MACHINE_ID.test(record.id) ||
    typeof record.state !== "string" ||
    image?.distro !== "ubuntu" ||
    image.version !== "noble" ||
    image.arch !== "amd64" ||
    typeof config?.default_username !== "string" ||
    !USERNAME.test(config.default_username)
  ) {
    throw new Error(
      `OrbStack machine ${expectedName} is not pinned Ubuntu 24.04 amd64`,
    );
  }
  return {
    id: record.id,
    name: expectedName,
    state: record.state,
    image: {
      distro: "ubuntu",
      version: "noble",
      arch: "amd64",
    },
    config: { defaultUsername: config.default_username },
  };
};

const isBoxCliPath = (executable: string): boolean =>
  path.basename(executable) === "box";

const parseBoxInfo = (
  stdout: string,
  expectedId: string,
  logicalName: string,
): OrbMachineInfo => {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new Error(`Box returned malformed info for ${expectedId}`);
  }
  const box =
    typeof raw === "object" &&
      raw !== null &&
      !Array.isArray(raw) &&
      typeof (raw as { box?: unknown }).box === "object" &&
      (raw as { box?: unknown }).box !== null
      ? (raw as { box: Record<string, unknown> }).box
      : undefined;
  if (
    box === undefined ||
    box.id !== expectedId ||
    typeof box.state !== "string" ||
    typeof box.ip !== "string" ||
    !/^[0-9a-f:.]+$/iu.test(box.ip)
  ) {
    throw new Error(`Box ${expectedId} has invalid identity or network facts`);
  }
  return {
    id: expectedId,
    name: logicalName,
    state: box.state === "stopped" ? "stopped" : "running",
    image: { distro: "ubuntu", version: "24.04", arch: "amd64" },
    config: { defaultUsername: "user" },
    ip: box.ip,
  };
};

const orbInfo = async (
  executor: CommandExecutor,
  orbctlPath: string,
  machineName: string,
): Promise<OrbMachineInfo> => {
  if (isBoxCliPath(orbctlPath)) {
    const result = await runRequired(executor, `box info ${machineName}`, {
      executable: orbctlPath,
      args: ["info", machineName, "--json"],
    });
    return parseBoxInfo(result.stdout, machineName, machineName);
  }
  const result = await runRequired(executor, `orbctl info ${machineName}`, {
    executable: orbctlPath,
    args: ["info", machineName, "--format", "json"],
  });
  return parseOrbInfo(result.stdout, machineName);
};

const boxInfo = async (
  executor: CommandExecutor,
  boxPath: string,
  id: string,
  logicalName: string,
): Promise<OrbMachineInfo> => {
  const result = await runRequired(executor, `box info ${id}`, {
    executable: boxPath,
    args: ["info", id, "--json"],
  });
  return parseBoxInfo(result.stdout, id, logicalName);
};

const createBoxMachine = async (
  executor: CommandExecutor,
  boxPath: string,
  logicalName: string,
): Promise<RunMachine> => {
  const created = await runRequired(executor, `create ${logicalName}`, {
    executable: boxPath,
    args: ["new", "--no-env", "--ttl", "21600", "--json"],
    timeoutMs: DEPLOY_COMMAND_TIMEOUT_MS,
  });
  let raw: unknown;
  try {
    raw = JSON.parse(created.stdout);
  } catch {
    throw new Error(`Box creation returned malformed JSON for ${logicalName}`);
  }
  const id =
    typeof raw === "object" &&
      raw !== null &&
      !Array.isArray(raw) &&
      typeof (raw as { box?: { id?: unknown } }).box?.id === "string"
      ? (raw as { box: { id: string } }).box.id
      : undefined;
  if (id === undefined || !MACHINE_ID.test(id)) {
    throw new Error(`Box creation returned no safe identity for ${logicalName}`);
  }
  const deadline = Date.now() + DEPLOY_COMMAND_TIMEOUT_MS;
  let last: OrbMachineInfo | undefined;
  while (Date.now() < deadline) {
    last = await boxInfo(executor, boxPath, id, logicalName);
    if (last.state === "running") {
      return {
        id,
        name: logicalName,
        username: last.config.defaultUsername,
        sshEndpoint: `${last.config.defaultUsername}@${last.ip!}`,
      };
    }
    await delay(1_000);
  }
  throw new Error(`Box ${id} did not become ready`);
};

const prepareBoxSshRoute = async (
  executor: CommandExecutor,
  boxPath: string,
  commandCenter: RunMachine,
  remote: RunMachine,
): Promise<void> => {
  const endpoint = remote.sshEndpoint;
  if (endpoint === undefined) throw new Error("Box Remote has no SSH endpoint");
  const host = endpoint.slice(endpoint.indexOf("@") + 1);
  const publicKey = await runGuest(
    executor,
    boxPath,
    commandCenter,
    "mint qualification-only SSH identity",
    "/bin/sh",
    [
      "-c",
      'set -eu; umask 077; mkdir -p "$HOME/.ssh"; test ! -e "$HOME/.ssh/id_ed25519"; /usr/bin/ssh-keygen -q -t ed25519 -N "" -f "$HOME/.ssh/id_ed25519"; /usr/bin/cat "$HOME/.ssh/id_ed25519.pub"',
    ],
  );
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: .*)?\n?$/u.test(publicKey.stdout)) {
    throw new Error("Box qualification SSH public key is malformed");
  }
  await runGuest(
    executor,
    boxPath,
    remote,
    "authorize qualification-only Command Center key",
    "/bin/sh",
    [
      "-c",
      'set -eu; umask 077; mkdir -p "$HOME/.ssh"; /usr/bin/cat > "$HOME/.ssh/authorized_keys"; /usr/bin/chmod 700 "$HOME/.ssh"; /usr/bin/chmod 600 "$HOME/.ssh/authorized_keys"',
    ],
    { input: publicKey.stdout },
  );
  await runGuest(
    executor,
    boxPath,
    commandCenter,
    "pin Box Remote SSH host key",
    "/bin/sh",
    [
      "-c",
      `set -eu; umask 077; /usr/bin/ssh-keyscan -H ${host} > "$HOME/.ssh/known_hosts"; /usr/bin/chmod 600 "$HOME/.ssh/known_hosts"; /usr/bin/ssh -o BatchMode=yes -o StrictHostKeyChecking=yes ${endpoint} /usr/bin/true`,
    ],
  );
};

const runOrb = (
  executor: CommandExecutor,
  orbctlPath: string,
  operation: string,
  args: ReadonlyArray<string>,
  options: { readonly input?: string; readonly timeoutMs?: number } = {},
): Promise<CommandResult> =>
  runRequired(executor, operation, {
    executable: orbctlPath,
    args,
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
  });

const guestHome = (machine: RunMachine): string =>
  `/home/${machine.username}`;

const runtimeGenerationName = (artifact: ArtifactIdentity): string =>
  `${artifact.version}-${artifact.archiveSha256}`;

const runtimeReleaseDirectory = (
  machine: RunMachine,
  artifact: ArtifactIdentity,
): string =>
  path.posix.join(
    guestHome(machine),
    ".vellum/runtime/releases",
    runtimeGenerationName(artifact),
  );

const runtimeExecutable = (
  machine: RunMachine,
  artifact: ArtifactIdentity,
): string => path.posix.join(runtimeReleaseDirectory(machine, artifact), "vellum");

const runtimeCli = (
  machine: RunMachine,
  artifact: ArtifactIdentity,
): string =>
  path.posix.join(
    runtimeReleaseDirectory(machine, artifact),
    "resources/bin/vellum",
  );

const runtimeStationCli = (
  machine: RunMachine,
  artifact: ArtifactIdentity,
): string =>
  path.posix.join(
    runtimeReleaseDirectory(machine, artifact),
    "resources/bin/vellum-station",
  );

const runGuest = (
  executor: CommandExecutor,
  orbctlPath: string,
  machine: RunMachine,
  operation: string,
  executable: string,
  args: ReadonlyArray<string>,
  options: { readonly input?: string; readonly timeoutMs?: number } = {},
): Promise<CommandResult> =>
  runRequired(executor, operation, {
    executable: orbctlPath,
    args: isBoxCliPath(orbctlPath)
      ? ["ssh", machine.id, executable, ...args]
      : ["run", "--machine", machine.name, executable, ...args],
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
  });

const runGuestUnchecked = (
  executor: CommandExecutor,
  orbctlPath: string,
  machine: RunMachine,
  executable: string,
  args: ReadonlyArray<string>,
  options: { readonly input?: string; readonly timeoutMs?: number } = {},
): Promise<CommandResult> =>
  executor.run({
    executable: orbctlPath,
    args: isBoxCliPath(orbctlPath)
      ? ["ssh", machine.id, executable, ...args]
      : ["run", "--machine", machine.name, executable, ...args],
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
  });

const parseJsonObject = (input: string, label: string): Record<string, unknown> => {
  const lines = input
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length !== 1) throw new Error(`${label} did not emit one JSON line`);
  let value: unknown;
  try {
    value = JSON.parse(lines[0]);
  } catch {
    throw new Error(`${label} emitted malformed JSON`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} emitted a non-object JSON value`);
  }
  return value as Record<string, unknown>;
};

const parseOperatorEnvelope = (
  result: CommandResult,
  command: string,
): Record<string, unknown> => {
  const envelope = parseJsonObject(result.stdout, command);
  if (
    envelope.ok !== true ||
    envelope.command !== command ||
    typeof envelope.data !== "object" ||
    envelope.data === null ||
    Array.isArray(envelope.data)
  ) {
    throw new Error(`${command} returned the wrong operator envelope`);
  }
  return envelope.data as Record<string, unknown>;
};

const operatorCommand = async (
  executor: CommandExecutor,
  orbctlPath: string,
  machine: RunMachine,
  artifact: ArtifactIdentity,
  command: string,
  args: ReadonlyArray<string>,
  timeoutMs?: number,
): Promise<Record<string, unknown>> => {
  const renderedCommand = command.replaceAll(".", " ");
  const result = await runGuest(
    executor,
    orbctlPath,
    machine,
    renderedCommand,
    runtimeCli(machine, artifact),
    args,
    { timeoutMs },
  );
  return parseOperatorEnvelope(result, renderedCommand);
};

const operatorCommandAllowFailure = async (
  executor: CommandExecutor,
  orbctlPath: string,
  machine: RunMachine,
  artifact: ArtifactIdentity,
  command: string,
  args: ReadonlyArray<string>,
  timeoutMs?: number,
): Promise<{
  readonly result: CommandResult;
  readonly data: Record<string, unknown>;
}> => {
  const renderedCommand = command.replaceAll(".", " ");
  const result = await runGuestUnchecked(
    executor,
    orbctlPath,
    machine,
    runtimeCli(machine, artifact),
    args,
    { timeoutMs },
  );
  return {
    result,
    data: parseOperatorEnvelope(result, renderedCommand),
  };
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const retryOperatorCommand = async (
  executor: CommandExecutor,
  orbctlPath: string,
  machine: RunMachine,
  artifact: ArtifactIdentity,
  command: string,
  args: ReadonlyArray<string>,
  accept: (data: Record<string, unknown>) => boolean = () => true,
): Promise<Record<string, unknown>> => {
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const data = await operatorCommand(
        executor,
        orbctlPath,
        machine,
        artifact,
        command,
        args,
      );
      if (accept(data)) return data;
      lastError = new Error(`${command.replaceAll(".", " ")} is not ready`);
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`${command.replaceAll(".", " ")} timed out`);
};

const requireQualificationDoctor = (
  fleetTest: Record<string, unknown>,
): unknown => {
  const observation =
    typeof fleetTest.linuxCapabilities === "object" &&
      fleetTest.linuxCapabilities !== null &&
      !Array.isArray(fleetTest.linuxCapabilities)
      ? fleetTest.linuxCapabilities as Record<string, unknown>
      : undefined;
  const terminal =
    typeof observation?.terminal === "object" &&
      observation.terminal !== null &&
      !Array.isArray(observation.terminal)
      ? observation.terminal as Record<string, unknown>
      : undefined;
  const browser =
    typeof observation?.browser === "object" &&
      observation.browser !== null &&
      !Array.isArray(observation.browser)
      ? observation.browser as Record<string, unknown>
      : undefined;
  if (
    observation?.status !== "ready" ||
    terminal?.status !== "ready" ||
    browser?.status !== "unavailable"
  ) {
    throw new Error(
      "Remote Doctor must report core and terminal ready with browser intentionally unavailable",
    );
  }
  return observation;
};

const observeGenerationState = async (
  executor: CommandExecutor,
  orbctlPath: string,
  machine: RunMachine,
  artifact: ArtifactIdentity,
  installationId: string,
  label: string,
): Promise<GenerationState> => {
  const shown = await runGuest(
    executor,
    orbctlPath,
    machine,
    label,
    "/usr/bin/systemctl",
    [
      "--user",
      "show",
      REMOTE_USERLAND_UNIT,
      "--property=InvocationID",
      "--value",
    ],
  );
  const invocationId = shown.stdout.trim();
  if (!/^[0-9a-f]{32}$/u.test(invocationId)) {
    throw new Error(`${label} returned an invalid service invocation`);
  }
  return {
    generation: runtimeGenerationName(artifact),
    installationId,
    invocationId,
  };
};

const proveRemotePty = async (
  executor: CommandExecutor,
  orbctlPath: string,
  machine: RunMachine,
  artifact: ArtifactIdentity,
  runId: string,
): Promise<QualificationPhaseProof["pty"]> => {
  const bindingId = `qualification-${runId}-pty`;
  const shutdownBindingId = `qualification-${runId}-shutdown`;
  const created = await operatorCommand(
    executor,
    orbctlPath,
    machine,
    artifact,
    "terminal.create",
    ["terminal", "create", "--binding-id", bindingId, "--cols", "80", "--rows", "24"],
  );
  if (created.status !== "running") {
    throw new Error("packaged Remote PTY did not start");
  }
  const resized = await operatorCommand(
    executor,
    orbctlPath,
    machine,
    artifact,
    "terminal.resize",
    ["terminal", "resize", bindingId, "--cols", "101", "--rows", "37"],
  );
  if (resized.resized !== true || resized.cols !== 101 || resized.rows !== 37) {
    throw new Error("packaged Remote PTY resize was not observed");
  }
  const marker = `VELLUM_PTY_${runId}`;
  const utf8 = "Olá-✓";
  const written = await operatorCommand(
    executor,
    orbctlPath,
    machine,
    artifact,
    "terminal.write",
    [
      "terminal",
      "write",
      bindingId,
      `printf '${marker}\\n${utf8}\\n'; exit 7\n`,
    ],
  );
  if (written.written !== true) {
    throw new Error("packaged Remote PTY write was not accepted");
  }
  await delay(500);
  const attached = await runGuest(
    executor,
    orbctlPath,
    machine,
    "observe packaged Remote PTY stream",
    runtimeCli(machine, artifact),
    ["terminal", "attach", bindingId],
    { timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS },
  );
  const frames = attached.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => parseJsonObject(line, "terminal attach frame"))
    .map((envelope) => {
      if (
        envelope.ok !== true ||
        envelope.command !== "terminal attach" ||
        typeof envelope.data !== "object" ||
        envelope.data === null ||
        Array.isArray(envelope.data)
      ) {
        throw new Error("terminal attach emitted an invalid stream envelope");
      }
      return envelope.data as Record<string, unknown>;
    });
  const output = frames
    .filter((frame) => frame.type === "output" && typeof frame.data === "string")
    .map((frame) => frame.data as string)
    .join("");
  if (
    !output.includes(marker) ||
    !output.includes(utf8) ||
    !frames.some(
      (frame) =>
        frame.type === "resize" && frame.cols === 101 && frame.rows === 37,
    ) ||
    !frames.some((frame) => frame.type === "exit" && frame.code === 7)
  ) {
    throw new Error("packaged Remote PTY stream did not prove echo/UTF-8/resize/exit");
  }

  await operatorCommand(
    executor,
    orbctlPath,
    machine,
    artifact,
    "terminal.create",
    ["terminal", "create", "--binding-id", shutdownBindingId],
  );
  const killed = await operatorCommand(
    executor,
    orbctlPath,
    machine,
    artifact,
    "terminal.kill",
    ["terminal", "kill", shutdownBindingId],
  );
  if (killed.killed !== true) {
    throw new Error("packaged Remote PTY shutdown was not observed");
  }
  return {
    echo: "live-packaged-runtime-observed",
    utf8: "live-packaged-runtime-observed",
    resize: "live-packaged-runtime-observed",
    exit: "live-packaged-runtime-observed",
    shutdown: "live-packaged-runtime-observed",
  };
};

const proveCorruptCandidateRejected = async (
  executor: CommandExecutor,
  orbctlPath: string,
  commandCenter: RunMachine,
  remote: RunMachine,
  artifact: ArtifactIdentity,
  profile: "qualification-candidate" | "final-release",
  remoteHostId: string,
  remoteInstallationId: string,
  runId: string,
): Promise<QualificationPhaseProof["deployment"]["corruptCandidate"]> => {
  const before = await observeGenerationState(
    executor,
    orbctlPath,
    remote,
    artifact,
    remoteInstallationId,
    "observe Remote before corrupt-candidate rejection",
  );
  const candidate = path.posix.join(
    guestHome(commandCenter),
    managedBundleRelativeDestination(profile),
    artifact.archiveFile,
  );
  const backup = `${candidate}.qualified-backup-${requireRunId(runId)}`;
  let backupCreated = false;
  let candidateSha256 = "";
  try {
    await runGuest(
      executor,
      orbctlPath,
      commandCenter,
      "stage reversible corrupt-candidate probe",
      "/bin/sh",
      [
        "-c",
        `set -eu; test ! -e ${shellLiteral(backup)}; /usr/bin/cp --reflink=auto --preserve=mode,timestamps -- ${shellLiteral(candidate)} ${shellLiteral(backup)}; printf X >> ${shellLiteral(candidate)}`,
      ],
    );
    backupCreated = true;
    const digest = await runGuest(
      executor,
      orbctlPath,
      commandCenter,
      "hash corrupt qualification candidate",
      "/usr/bin/sha256sum",
      [candidate],
    );
    candidateSha256 = digest.stdout.trim().split(/\s+/u)[0] ?? "";
    if (!SHA256.test(candidateSha256) || candidateSha256 === artifact.archiveSha256) {
      throw new Error("corrupt-candidate probe did not change the archive digest");
    }
    const attempted = profile === "qualification-candidate"
      ? await operatorCommandAllowFailure(
          executor,
          orbctlPath,
          commandCenter,
          artifact,
          "fleet.qualify",
          ["fleet", "qualify", remoteHostId],
          DEPLOY_COMMAND_TIMEOUT_MS,
        )
      : await operatorCommandAllowFailure(
          executor,
          orbctlPath,
          commandCenter,
          artifact,
          "fleet.deploy",
          ["fleet", "deploy", remoteHostId, "--source", "cached"],
          DEPLOY_COMMAND_TIMEOUT_MS,
        );
    if (
      attempted.result.exitCode === 0 ||
      attempted.data.ok !== false ||
      attempted.data.status !== "failed"
    ) {
      throw new Error("corrupt candidate was not rejected by the product deploy path");
    }
  } finally {
    if (backupCreated) {
      await runGuest(
        executor,
        orbctlPath,
        commandCenter,
        "restore qualified candidate after corruption probe",
        "/usr/bin/mv",
        ["-T", "--", backup, candidate],
      );
    }
  }
  const after = await observeGenerationState(
    executor,
    orbctlPath,
    remote,
    artifact,
    remoteInstallationId,
    "observe Remote after corrupt-candidate rejection",
  );
  if (before.invocationId !== after.invocationId) {
    throw new Error("corrupt candidate altered the active Remote generation");
  }
  return {
    candidateSha256,
    outcome: "rejected-before-activation",
    before,
    after,
  };
};

const evidencePath = (directory: string): string =>
  path.join(directory, EVIDENCE_FILE);

const assertEvidencePath = async (
  directory: string,
  allowCreate: boolean,
): Promise<string> => {
  const absolute = path.resolve(directory);
  if (allowCreate) {
    await mkdir(absolute, { recursive: true, mode: 0o700 });
    await chmod(absolute, 0o700);
  }
  const metadata = await lstat(absolute);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("qualification evidence directory is not a regular directory");
  }
  const file = evidencePath(absolute);
  try {
    const evidenceMetadata = await lstat(file);
    if (!evidenceMetadata.isFile() || evidenceMetadata.isSymbolicLink()) {
      throw new Error("qualification evidence file is not a regular file");
    }
  } catch (error) {
    if (
      !allowCreate ||
      !(error instanceof Error) ||
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw error;
    }
  }
  return absolute;
};

const sanitizeEvidenceDetail = (value: unknown): unknown => {
  const raw = JSON.stringify(value);
  const redacted = redactLinuxCiLog(raw, {
    workspace: repoRoot,
    home: homedir(),
  });
  return JSON.parse(redacted.output) as unknown;
};

const appendEvidence = async (
  directory: string,
  event: EvidenceEvent,
): Promise<void> => {
  const file = evidencePath(directory);
  let currentBytes = 0;
  try {
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("qualification evidence file is not a regular file");
    }
    currentBytes = metadata.size;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw error;
    }
  }
  const line = `${JSON.stringify({
    ...event,
    detail: sanitizeEvidenceDetail(event.detail),
  })}\n`;
  const bytes = Buffer.byteLength(line, "utf8");
  if (
    bytes > MAX_EVIDENCE_LINE_BYTES ||
    currentBytes + bytes > MAX_EVIDENCE_BYTES
  ) {
    throw new Error("qualification evidence exceeded its bounded JSONL contract");
  }
  await appendFile(file, line, { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600);
};

const readEvidenceEvents = async (
  directory: string,
): Promise<ReadonlyArray<EvidenceEvent>> => {
  const body = await readFile(evidencePath(directory), "utf8");
  if (Buffer.byteLength(body, "utf8") > MAX_EVIDENCE_BYTES) {
    throw new Error("qualification evidence exceeded its bounded JSONL contract");
  }
  const lines = body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) throw new Error("qualification evidence is empty");
  return lines.map((line) => {
    if (Buffer.byteLength(line, "utf8") > MAX_EVIDENCE_LINE_BYTES) {
      throw new Error("qualification evidence line exceeded its bound");
    }
    const value = JSON.parse(line) as EvidenceEvent;
    if (
      value.schema !== OBSERVATION_SCHEMA ||
      !RUN_ID.test(value.runId) ||
      typeof value.event !== "string"
    ) {
      throw new Error("qualification evidence contains an invalid event");
    }
    return value;
  });
};

const latestState = (
  events: ReadonlyArray<EvidenceEvent>,
): QualificationRunState => {
  const state = [...events].reverse().find((event) => event.state !== undefined)
    ?.state;
  if (state === undefined || state.schema !== RUN_STATE_SCHEMA) {
    throw new Error("qualification evidence has no valid run state");
  }
  if (
    !RUN_ID.test(state.runId) ||
    (
      state.kind !== "qualification-candidate" &&
      state.kind !== "final-release"
    ) ||
    (state.virtualization !== "orbstack" && state.virtualization !== "box") ||
    !SEMVER.test(state.artifact.version) ||
    !SOURCE_COMMIT.test(state.artifact.sourceCommit) ||
    !SAFE_BASENAME.test(state.artifact.archiveFile) ||
    !Number.isSafeInteger(state.artifact.archiveBytes) ||
    state.artifact.archiveBytes <= 0 ||
    !SHA256.test(state.artifact.archiveSha256) ||
    state.artifact.stationProtocol !== STATION_PROTOCOL ||
    !SHA256.test(state.artifact.manifestSha256) ||
    state.artifact.bundleFiles.length < 4 ||
    (
      state.managedDeployReady &&
      (
        state.qualification === undefined ||
        !INSTALLATION_ID.test(
          state.qualification.commandCenterInstallationId,
        ) ||
        !INSTALLATION_ID.test(state.qualification.remoteInstallationId) ||
        state.qualification.commandCenterInstallationId ===
          state.qualification.remoteInstallationId ||
        Object.values(state.qualification.phases).some(
          (phase) => phase !== "passed",
        )
      )
    ) ||
    (
      state.kind === "qualification-candidate"
        ? state.artifact.verification.schema !==
            "vellum/linux-qualification-candidate-verification-receipt/v1" ||
          state.artifact.verification.purpose !==
            LINUX_QUALIFICATION_CANDIDATE_PURPOSE ||
          state.artifact.verification.publishable !== false ||
          !SHA256.test(
            state.artifact.verification.ciEvidenceSha256 ?? "",
          )
        : state.artifact.verification.schema !==
            "vellum/linux-release-verification-receipt/v1"
    )
  ) {
    throw new Error("qualification evidence has malformed run state");
  }
  const names = qualificationMachineNames(state.runId);
  const commandCenter = state.machines.commandCenter;
  const remote = state.machines.remote;
  if (
    commandCenter !== undefined &&
    (
      commandCenter.name !== names.commandCenter ||
      commandCenter.name === names.remote ||
      !MACHINE_ID.test(commandCenter.id) ||
      !USERNAME.test(commandCenter.username)
    )
  ) {
    throw new Error("qualification evidence has malformed Command Center identity");
  }
  if (
    remote !== undefined &&
    (
      remote.name !== names.remote ||
      !MACHINE_ID.test(remote.id) ||
      !USERNAME.test(remote.username)
    )
  ) {
    throw new Error("qualification evidence has malformed Remote identity");
  }
  if (
    state.machines.commandCenter !== undefined &&
    state.machines.remote !== undefined &&
    state.machines.commandCenter.id === state.machines.remote.id
  ) {
    throw new Error("qualification evidence reuses one VM identity");
  }
  return state;
};

const withState = (
  state: QualificationRunState,
  changes: Partial<QualificationRunState>,
): QualificationRunState => Object.freeze({ ...state, ...changes });

const recordFailure = async (
  directory: string,
  now: () => Date,
  state: QualificationRunState,
  operation: string,
  error: unknown,
): Promise<never> => {
  const failed = withState(state, { failed: true });
  await appendEvidence(directory, {
    schema: OBSERVATION_SCHEMA,
    at: now().toISOString(),
    runId: state.runId,
    event: operation,
    status: "failed",
    detail: {
      message: error instanceof Error ? error.message : String(error),
      preservedMachines: Object.values(state.machines)
        .filter((machine): machine is RunMachine => machine !== undefined)
        .map(({ id, name }) => ({ id, name })),
    },
    state: failed,
  });
  throw error;
};

const validateGuestFacts = async (
  executor: CommandExecutor,
  orbctlPath: string,
  machine: RunMachine,
): Promise<{
  readonly distribution: "ubuntu";
  readonly version: "24.04";
  readonly architecture: "x86_64";
}> => {
  const [distribution, version, architecture] = await Promise.all([
    runGuest(
      executor,
      orbctlPath,
      machine,
      "observe Ubuntu distribution",
      "/usr/bin/lsb_release",
      ["-is"],
    ),
    runGuest(
      executor,
      orbctlPath,
      machine,
      "observe Ubuntu version",
      "/usr/bin/lsb_release",
      ["-rs"],
    ),
    runGuest(
      executor,
      orbctlPath,
      machine,
      "observe machine architecture",
      "/usr/bin/uname",
      ["-m"],
    ),
  ]);
  if (
    distribution.stdout.trim().toLowerCase() !== "ubuntu" ||
    version.stdout.trim() !== "24.04" ||
    architecture.stdout.trim() !== "x86_64"
  ) {
    throw new Error(`${machine.name} is not native Ubuntu 24.04 x86_64`);
  }
  return {
    distribution: "ubuntu",
    version: "24.04",
    architecture: "x86_64",
  };
};

const runtimeReleaseId = (artifact: ArtifactIdentity): string =>
  `${artifact.version}-${artifact.archiveSha256}`;

const verifyPackageAbsent = async (
  executor: CommandExecutor,
  orbctlPath: string,
  machine: RunMachine,
): Promise<void> => {
  const result = await runGuest(
    executor,
    orbctlPath,
    machine,
    `prove no userland runtime on ${machine.name}`,
    "/bin/sh",
    [
      "-c",
      'if [ -d "$HOME/.vellum/runtime/releases" ] && [ "$(/usr/bin/find "$HOME/.vellum/runtime/releases" -mindepth 1 -maxdepth 1 2>/dev/null | /usr/bin/wc -l)" != 0 ]; then exit 1; fi; if [ -x "$HOME/.local/bin/vellum-station" ]; then exit 1; fi; exit 0',
    ],
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `${machine.name} is not pristine: a Vellum userland runtime is already present`,
    );
  }
};

const observeInstalledPackage = async (
  executor: CommandExecutor,
  orbctlPath: string,
  machine: RunMachine,
  artifact: ArtifactIdentity,
): Promise<Record<string, unknown>> => {
  const release = runtimeReleaseId(artifact);
  const result = await runGuest(
    executor,
    orbctlPath,
    machine,
    `observe exact userland runtime on ${machine.name}`,
    "/bin/sh",
    [
      "-c",
      `set -eu; RELEASE="$HOME/.vellum/runtime/releases/${release}"; test -x "$RELEASE/vellum"; test -x "$HOME/.local/bin/vellum-station"; printf 'vellum\t%s\tuserland\n' "${artifact.version}"`,
    ],
  );
  const [packageName, version, architecture] =
    result.stdout.trim().split("\t");
  if (
    packageName !== "vellum" ||
    version !== artifact.version ||
    architecture !== "userland"
  ) {
    throw new Error(
      `retained Command Center does not run exact userland runtime ${artifact.version}; update it through the product update lane before reuse`,
    );
  }
  return { packageName, version, architecture, release };
};

const installPackage = async (
  executor: CommandExecutor,
  orbctlPath: string,
  machine: RunMachine,
  guestArchivePath: string,
  artifact: ArtifactIdentity,
): Promise<Record<string, unknown>> => {
  const release = runtimeReleaseId(artifact);
  const packageHash = await runGuest(
    executor,
    orbctlPath,
    machine,
    `observe staged runtime archive hash on ${machine.name}`,
    "/usr/bin/sha256sum",
    [guestArchivePath],
  );
  const sha256 = packageHash.stdout.trim().split(/\s+/u)[0];
  if (sha256 !== artifact.archiveSha256) {
    throw new Error(`staged archive hash mismatch on ${machine.name}`);
  }
  const shellQuote = (value: string): string =>
    `'${value.replace(/'/g, `'\\''`)}'`;
  // Extract the signed archive, then seal the generation-pinned unit through
  // the product binary (`--install-user-service`). Remote runtime is never
  // started via a runner-authored systemd-run/Electron/Xvfb path.
  const installScript = [
    "set -eu",
    "umask 077",
    'ROOT="$HOME/.vellum/runtime"',
    `RELEASE_ID="${release}"`,
    'STAGE="$ROOT/staging/$RELEASE_ID-$$"',
    'DEST="$ROOT/releases/$RELEASE_ID"',
    `ARCHIVE=${shellQuote(guestArchivePath)}`,
    'mkdir -p "$ROOT/releases" "$ROOT/staging" "$HOME/.local/bin" "$HOME/.config/systemd/user"',
    'mkdir "$STAGE"',
    '/usr/bin/tar -xzf "$ARCHIVE" -C "$STAGE" --no-same-owner --no-same-permissions',
    `TREE="$STAGE/vellum-runtime-${artifact.version}-linux-x64"`,
    'test -x "$TREE/vellum"',
    'test -x "$TREE/resources/bin/vellum-remote"',
    'test -x "$TREE/resources/systemd/vellum-remote-launch"',
    'mv "$TREE" "$DEST"',
    'rmdir -- "$STAGE"',
    'ln -sfn "$DEST/resources/bin/vellum-station" "$HOME/.local/bin/vellum-station"',
    'ln -sfn "$DEST/resources/bin/vellum-browser" "$HOME/.local/bin/vellum-browser"',
    '"$DEST/resources/bin/vellum-remote" --install-user-service',
    "/usr/bin/systemctl --user daemon-reload",
    "/usr/bin/systemctl --user enable --now vellum-remote.service || true",
    `printf 'vellum\\t%s\\tuserland\\n' "${artifact.version}"`,
  ].join("\n");
  await runGuest(
    executor,
    orbctlPath,
    machine,
    `install exact userland runtime on ${machine.name}`,
    "/bin/sh",
    ["-c", installScript],
    { timeoutMs: DEPLOY_COMMAND_TIMEOUT_MS },
  );
  return {
    packageName: "vellum",
    version: artifact.version,
    architecture: "userland",
    sha256,
    release,
  };
};

const startPackagedRuntime = async (
  executor: CommandExecutor,
  orbctlPath: string,
  machine: RunMachine,
): Promise<void> => {
  await runGuest(
    executor,
    orbctlPath,
    machine,
    `reload Vellum user unit on ${machine.name}`,
    "/usr/bin/systemctl",
    ["--user", "daemon-reload"],
  );
  await runGuest(
    executor,
    orbctlPath,
    machine,
    `start packaged Vellum runtime on ${machine.name}`,
    "/usr/bin/systemctl",
    ["--user", "--no-block", "start", "vellum-remote.service"],
  );
};

const activationUnitName = (runId: string): string =>
  `vellum-qualification-activation-${requireRunId(runId)}.service`;

/** Sole product Remote supervisor unit (generation-pinned Node, not Electron). */
const REMOTE_USERLAND_UNIT = "vellum-remote.service" as const;

const stopUserUnitAndProveInactive = async (
  executor: CommandExecutor,
  orbctlPath: string,
  machine: RunMachine,
  unit: string,
): Promise<Record<string, string>> => {
  await runGuest(
    executor,
    orbctlPath,
    machine,
    `stop ${unit}`,
    "/usr/bin/systemctl",
    ["--user", "stop", unit],
  );
  const shown = await runGuest(
    executor,
    orbctlPath,
    machine,
    `prove ${unit} inactive`,
    "/usr/bin/systemctl",
    [
      "--user",
      "show",
      unit,
      "--property=ActiveState",
      "--property=SubState",
      "--property=MainPID",
    ],
  );
  const fields = Object.fromEntries(
    shown.stdout
      .trim()
      .split(/\r?\n/u)
      .map((line) => {
        const separator = line.indexOf("=");
        return separator > 0
          ? [line.slice(0, separator), line.slice(separator + 1)]
          : ["", ""];
      }),
  );
  if (
    fields.ActiveState !== "inactive" ||
    fields.SubState !== "dead" ||
    fields.MainPID !== "0"
  ) {
    throw new Error(`${unit} did not stop cleanly on ${machine.name}`);
  }
  return fields;
};

const startExistingQualificationUnit = (
  executor: CommandExecutor,
  orbctlPath: string,
  machine: RunMachine,
  unit: string,
): Promise<CommandResult> =>
  runGuest(
    executor,
    orbctlPath,
    machine,
    `start ${unit}`,
    "/usr/bin/systemctl",
    ["--user", "--no-block", "start", unit],
  );

const launchCommandCenterActivation = async (
  executor: CommandExecutor,
  orbctlPath: string,
  machine: RunMachine,
  runId: string,
): Promise<string> => {
  const unit = activationUnitName(runId);
  const displayArguments = isBoxCliPath(orbctlPath)
    ? [
        "--setenv=DISPLAY=:0",
        `--setenv=XAUTHORITY=${guestHome(machine)}/.Xauthority`,
        "--setenv=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus",
      ]
    : [];
  const launch = isBoxCliPath(orbctlPath)
    ? 'set -eu; APP=$(/usr/bin/find "$HOME/.vellum/runtime/releases" -mindepth 2 -maxdepth 2 -type f -name vellum -perm -111 | /usr/bin/head -n 1); test -n "$APP"; exec "$APP" --ozone-platform=x11 --vellum-operator-control'
    : 'set -eu; APP=$(/usr/bin/find "$HOME/.vellum/runtime/releases" -mindepth 2 -maxdepth 2 -type f -name vellum -perm -111 | /usr/bin/head -n 1); test -n "$APP"; exec /usr/bin/xvfb-run -a -s "-screen 0 1280x1024x24 -nolisten tcp" "$APP" --ozone-platform=x11 --vellum-operator-control';
  await runGuest(
    executor,
    orbctlPath,
    machine,
    "stop headless Command Center before trusted-renderer activation",
    "/usr/bin/systemctl",
    ["--user", "stop", "vellum-remote.service"],
  );
  await runGuest(
    executor,
    orbctlPath,
    machine,
    "launch trusted-renderer Command Center activation checkpoint",
    "/usr/bin/systemd-run",
    [
      "--user",
      `--unit=${unit.slice(0, -".service".length)}`,
      "--property=Type=simple",
      "--property=KillMode=control-group",
      "--property=TimeoutStopSec=10s",
      ...displayArguments,
      "/bin/sh",
      "-c",
      launch,
    ],
  );
  return unit;
};

/**
 * Prove the generation-pinned product Remote unit and start it.
 * Never launches Electron, Xvfb, ozone, or a runner-authored temp unit.
 */
const ensureRemoteUserlandService = async (
  executor: CommandExecutor,
  orbctlPath: string,
  machine: RunMachine,
  artifact: ArtifactIdentity,
): Promise<typeof REMOTE_USERLAND_UNIT> => {
  const release = runtimeReleaseId(artifact);
  await runGuest(
    executor,
    orbctlPath,
    machine,
    "prove generation-pinned displayless Remote unit",
    "/bin/sh",
    [
      "-c",
      [
        "set -eu",
        `RELEASE="$HOME/.vellum/runtime/releases/${release}"`,
        'UNIT="$HOME/.config/systemd/user/vellum-remote.service"',
        'test -x "$RELEASE/resources/bin/vellum-remote"',
        'test ! -L "$RELEASE/resources/bin/vellum-remote"',
        'test -x "$RELEASE/resources/systemd/vellum-remote-launch"',
        'test ! -L "$RELEASE/resources/systemd/vellum-remote-launch"',
        'test -f "$UNIT"',
        'test ! -L "$UNIT"',
        `/usr/bin/grep -F "ExecStart=" "$UNIT" | /usr/bin/grep -F "releases/${release}/resources/systemd/vellum-remote-launch" >/dev/null`,
        `/usr/bin/grep -F "ConditionFileIsExecutable=" "$UNIT" | /usr/bin/grep -F "releases/${release}/resources/bin/vellum-remote" >/dev/null`,
        '! /usr/bin/grep -E "xvfb|ozone-platform|--vellum-headless|ELECTRON_|chromium" "$UNIT" >/dev/null',
      ].join("; "),
    ],
  );
  await runGuest(
    executor,
    orbctlPath,
    machine,
    "start product Remote userland service",
    "/usr/bin/systemctl",
    ["--user", "start", REMOTE_USERLAND_UNIT],
  );
  const shown = await runGuest(
    executor,
    orbctlPath,
    machine,
    "prove product Remote userland service active",
    "/usr/bin/systemctl",
    [
      "--user",
      "show",
      REMOTE_USERLAND_UNIT,
      "--property=ActiveState",
      "--property=SubState",
      "--property=MainPID",
      "--property=ControlGroup",
      "--property=InvocationID",
    ],
  );
  parseServiceFields(shown.stdout, machine.name);
  return REMOTE_USERLAND_UNIT;
};

export const managedBundleRelativeDestination = (
  profile: "qualification-candidate" | "final-release",
): string =>
  `${managedBundleCacheRoot(profile)}/current/`;

const managedBundleCacheRoot = (
  profile: "qualification-candidate" | "final-release",
): string =>
  profile === "qualification-candidate"
    ? ".vellum/releases/linux-x64-glibc/qualification"
    : ".vellum/releases/linux-x64-glibc";

const guestPathExists = async (
  executor: CommandExecutor,
  orbctlPath: string,
  machine: RunMachine,
  candidate: string,
): Promise<boolean> => {
  const result = await runGuestUnchecked(
    executor,
    orbctlPath,
    machine,
    "/usr/bin/test",
    ["-e", candidate],
  );
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new Error(
    `could not inspect fixed release cache on ${machine.name}: ${truncateUtf8(result.stderr, 512)}`,
  );
};

const requireOwnedDirectory = async (
  executor: CommandExecutor,
  orbctlPath: string,
  machine: RunMachine,
  candidate: string,
  label: string,
): Promise<void> => {
  for (const args of [
    ["!", "-L", candidate],
    ["-d", candidate],
    ["-O", candidate],
  ]) {
    await runGuest(
      executor,
      orbctlPath,
      machine,
      `verify ${label}`,
      "/usr/bin/test",
      args,
    );
  }
};

const exactDirectoryEntries = async (
  executor: CommandExecutor,
  orbctlPath: string,
  machine: RunMachine,
  directory: string,
): Promise<ReadonlyArray<string>> => {
  const result = await runGuest(
    executor,
    orbctlPath,
    machine,
    "inventory fixed release cache",
    "/usr/bin/find",
    [
      directory,
      "-mindepth",
      "1",
      "-maxdepth",
      "1",
      "-printf",
      "%f\n",
    ],
  );
  const entries = result.stdout
    .split(/\r?\n/u)
    .filter((entry) => entry.length > 0)
    .sort();
  if (
    entries.some((entry) =>
      path.posix.basename(entry) !== entry || !SAFE_BASENAME.test(entry)
    )
  ) {
    throw new Error("fixed release cache contains an unsafe entry");
  }
  return entries;
};

interface ManagedBundleStagingArtifact {
  readonly canonicalBundleDirectory: string;
  readonly bundleFiles: ReadonlyArray<string>;
  readonly archiveFile: string;
  readonly archiveSha256: string;
  readonly manifestSha256: string;
}

const verifyGuestBundleDirectory = async (
  executor: CommandExecutor,
  orbctlPath: string,
  machine: RunMachine,
  directory: string,
  artifact: ManagedBundleStagingArtifact,
): Promise<void> => {
  await requireOwnedDirectory(
    executor,
    orbctlPath,
    machine,
    directory,
    "owned non-symlink release cache directory",
  );
  const entries = await exactDirectoryEntries(
    executor,
    orbctlPath,
    machine,
    directory,
  );
  if (
    entries.length !== artifact.bundleFiles.length ||
    entries.some(
      (entry, index) =>
        entry !== [...artifact.bundleFiles].sort()[index],
    )
  ) {
    throw new Error("fixed release cache inventory does not match the verified bundle");
  }
  const fileMetadata = await runGuest(
    executor,
    orbctlPath,
    machine,
    "verify fixed release cache file custody",
    "/usr/bin/stat",
    [
      "--format=%n\t%U\t%F",
      ...artifact.bundleFiles.map((name) =>
        path.posix.join(directory, name)
      ),
    ],
  );
  const metadata = fileMetadata.stdout
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => line.split("\t"));
  if (
    metadata.length !== artifact.bundleFiles.length ||
    metadata.some(
      (fields) =>
        fields.length !== 3 ||
        fields[1] !== machine.username ||
        fields[2] !== "regular file",
    )
  ) {
    throw new Error("fixed release cache files are not owned regular files");
  }
  const [manifestHash, packageHash] = await Promise.all([
    runGuest(
      executor,
      orbctlPath,
      machine,
      "verify fixed-cache manifest hash",
      "/usr/bin/sha256sum",
      [path.posix.join(directory, LINUX_RELEASE_MANIFEST)],
    ),
    runGuest(
      executor,
      orbctlPath,
      machine,
      "verify fixed-cache package hash",
      "/usr/bin/sha256sum",
      [path.posix.join(directory, artifact.archiveFile)],
    ),
  ]);
  if (
    manifestHash.stdout.trim().split(/\s+/u)[0] !==
      artifact.manifestSha256 ||
    packageHash.stdout.trim().split(/\s+/u)[0] !== artifact.archiveSha256
  ) {
    throw new Error("fixed release cache hashes do not match the verified bundle");
  }
};

export const stageManagedBundle = async (
  executor: CommandExecutor,
  orbctlPath: string,
  machine: RunMachine,
  artifact: ManagedBundleStagingArtifact,
  profile: "qualification-candidate" | "final-release",
): Promise<string> => {
  const relativeRoot = managedBundleCacheRoot(profile);
  const relativeDestination = managedBundleRelativeDestination(profile);
  const absoluteRoot = path.posix.join(guestHome(machine), relativeRoot);
  const absoluteDestination = path.posix.join(
    guestHome(machine),
    relativeDestination,
  );
  const stagingParent = path.posix.join(absoluteRoot, "staging");
  const archiveParent = path.posix.join(absoluteRoot, "archive");
  const stagingDirectory = path.posix.join(
    stagingParent,
    artifact.manifestSha256,
  );
  const relativeStagingDirectory =
    `${relativeRoot}/staging/${artifact.manifestSha256}/`;
  await runGuest(
    executor,
    orbctlPath,
    machine,
    "create fixed release-cache custody directories",
    "/usr/bin/install",
    [
      "-d",
      "-m",
      "0700",
      absoluteRoot,
      stagingParent,
      archiveParent,
    ],
  );
  for (const [directory, label] of [
    [absoluteRoot, "release-cache root"],
    [stagingParent, "release-cache staging directory"],
    [archiveParent, "release-cache archive directory"],
  ] as const) {
    await requireOwnedDirectory(
      executor,
      orbctlPath,
      machine,
      directory,
      label,
    );
  }

  if (await guestPathExists(
    executor,
    orbctlPath,
    machine,
    absoluteDestination,
  )) {
    await requireOwnedDirectory(
      executor,
      orbctlPath,
      machine,
      absoluteDestination,
      "current release cache",
    );
    const currentManifest = await runGuest(
      executor,
      orbctlPath,
      machine,
      "hash current release-cache manifest",
      "/usr/bin/sha256sum",
      [path.posix.join(absoluteDestination, LINUX_RELEASE_MANIFEST)],
    );
    if (
      currentManifest.stdout.trim().split(/\s+/u)[0] ===
        artifact.manifestSha256
    ) {
      await verifyGuestBundleDirectory(
        executor,
        orbctlPath,
        machine,
        absoluteDestination,
        artifact,
      );
      return path.posix.join(absoluteDestination, artifact.archiveFile);
    }
  }

  if (!(await guestPathExists(
    executor,
    orbctlPath,
    machine,
    stagingDirectory,
  ))) {
    await runGuest(
      executor,
      orbctlPath,
      machine,
      "create fixed verified Linux staging directory",
      "/usr/bin/install",
      ["-d", "-m", "0700", stagingDirectory],
    );
    if (isBoxCliPath(orbctlPath)) {
      for (const name of artifact.bundleFiles) {
        await runRequired(executor, `stage ${name} on ${machine.name}`, {
          executable: orbctlPath,
          args: [
            "scp",
            path.join(artifact.canonicalBundleDirectory, name),
            `${machine.id}:${path.posix.join(stagingDirectory, name)}`,
          ],
          timeoutMs: DEPLOY_COMMAND_TIMEOUT_MS,
        });
      }
    } else {
      // orbctl push currently resolves into OrbStack's read-only container view
      // (/containers/ro/...) and fails. Stage via the host-mounted guest home.
      const hostStagingDirectory = path.join(
        homedir(),
        "OrbStack",
        machine.name,
        "home",
        machine.username,
        ...relativeStagingDirectory.split("/").filter(Boolean),
      );
      await mkdir(hostStagingDirectory, { recursive: true, mode: 0o700 });
      for (const name of artifact.bundleFiles) {
        await copyFile(
          path.join(artifact.canonicalBundleDirectory, name),
          path.join(hostStagingDirectory, name),
        );
      }
    }
  }
  await verifyGuestBundleDirectory(
    executor,
    orbctlPath,
    machine,
    stagingDirectory,
    artifact,
  );

  let archivedCurrent: string | undefined;
  if (await guestPathExists(
    executor,
    orbctlPath,
    machine,
    absoluteDestination,
  )) {
    const oldManifest = await runGuest(
      executor,
      orbctlPath,
      machine,
      "hash superseded release-cache manifest",
      "/usr/bin/sha256sum",
      [path.posix.join(absoluteDestination, LINUX_RELEASE_MANIFEST)],
    );
    const oldManifestSha256 =
      oldManifest.stdout.trim().split(/\s+/u)[0] ?? "";
    if (!SHA256.test(oldManifestSha256)) {
      throw new Error("superseded release cache has no valid manifest hash");
    }
    archivedCurrent = path.posix.join(archiveParent, oldManifestSha256);
    if (await guestPathExists(
      executor,
      orbctlPath,
      machine,
      archivedCurrent,
    )) {
      throw new Error(
        "release-cache archive already contains the superseded manifest",
      );
    }
    await runGuest(
      executor,
      orbctlPath,
      machine,
      "archive superseded fixed release cache",
      "/usr/bin/mv",
      ["-T", "--", absoluteDestination, archivedCurrent],
    );
  }

  try {
    await runGuest(
      executor,
      orbctlPath,
      machine,
      "atomically install fixed release cache",
      "/usr/bin/mv",
      ["-T", "--", stagingDirectory, absoluteDestination],
    );
  } catch (error) {
    if (
      archivedCurrent !== undefined &&
      !(await guestPathExists(
        executor,
        orbctlPath,
        machine,
        absoluteDestination,
      ))
    ) {
      try {
        await runGuest(
          executor,
          orbctlPath,
          machine,
          "restore superseded fixed release cache",
          "/usr/bin/mv",
          ["-T", "--", archivedCurrent, absoluteDestination],
        );
      } catch (restoreError) {
        throw new Error(
          "fixed release-cache promotion and recovery both failed",
          { cause: restoreError },
        );
      }
    }
    throw error;
  }
  return path.posix.join(absoluteDestination, artifact.archiveFile);
};

const prepare = async (
  options: QualificationOptions,
  dependencies: Required<QualificationDependencies>,
): Promise<QualificationRunState> => {
  const runId = requireRunId(options.runId);
  const directory = await assertEvidencePath(options.evidenceDirectory, true);
  try {
    await access(evidencePath(directory), fsConstants.F_OK);
    throw new Error("qualification evidence already exists for this run");
  } catch (error) {
    if (
      !(error instanceof Error) ||
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw error;
    }
  }
  const kind = options.kind ?? "qualification-candidate";
  const retainedNameSupplied = options.commandCenterName !== undefined;
  const retainedIdSupplied = options.commandCenterId !== undefined;
  if (retainedNameSupplied !== retainedIdSupplied) {
    throw new Error(
      "retained Command Center requires both --command-center-vm and --command-center-id",
    );
  }
  const commandCenterMode = retainedNameSupplied
    ? "retained-licensed" as const
    : "new-activation-checkpoint" as const;
  const sourceCommit = requireSourceCommit(options.sourceCommit);
  const artifactWithPaths =
    kind === "qualification-candidate"
      ? await inspectQualificationCandidateArtifact({
          bundleDirectory: requiredString(
            options.bundleDirectory,
            "bundle directory",
          ),
          sourceCommit,
        })
      : await inspectManagedArtifact({
          bundleDirectory: requiredString(
            options.bundleDirectory,
            "bundle directory",
          ),
          sourceCommit,
        });
  const {
    canonicalArchivePath: _canonicalArchivePath,
    ...artifactWithoutArchivePath
  } = artifactWithPaths;
  const artifact: ArtifactIdentity = "canonicalBundleDirectory" in
      artifactWithoutArchivePath
    ? (() => {
        const {
          canonicalBundleDirectory: _canonicalBundleDirectory,
          ...identity
        } = artifactWithoutArchivePath;
        return identity;
      })()
    : artifactWithoutArchivePath;
  const virtualization = options.virtualization ?? "orbstack";
  const orbctlPath = options.orbctlPath ??
    (virtualization === "box" ? "box" : "orbctl");
  const names = qualificationMachineNames(runId);

  if (virtualization === "box") {
    if (retainedNameSupplied || retainedIdSupplied) {
      throw new Error("Box qualification requires two fresh --no-env Boxes");
    }
    let boxState: QualificationRunState = {
      schema: RUN_STATE_SCHEMA,
      runId,
      kind,
      virtualization,
      commandCenterMode: "new-activation-checkpoint",
      machines: {},
      artifact,
      prepared: false,
      managedRunAttempted: false,
      managedDeployReady: false,
      failed: false,
      cleaned: false,
    };
    await appendEvidence(directory, {
      schema: OBSERVATION_SCHEMA,
      at: dependencies.now().toISOString(),
      runId,
      event: "signed-candidate-validated",
      status: "passed",
      detail: { artifact, virtualization },
      state: boxState,
    });
    try {
      const commandCenter = await createBoxMachine(
        dependencies.executor,
        orbctlPath,
        names.commandCenter,
      );
      boxState = withState(boxState, { machines: { commandCenter } });
      await appendEvidence(directory, {
        schema: OBSERVATION_SCHEMA,
        at: dependencies.now().toISOString(),
        runId,
        event: "command-center-created",
        status: "passed",
        detail: { machine: commandCenter, lifecycle: "fresh-no-env-box" },
        state: boxState,
      });
      const remote = await createBoxMachine(
        dependencies.executor,
        orbctlPath,
        names.remote,
      );
      boxState = withState(boxState, {
        machines: { commandCenter, remote },
      });
      const [commandCenterFacts, remoteFacts] = await Promise.all([
        validateGuestFacts(
          dependencies.executor,
          orbctlPath,
          commandCenter,
        ),
        validateGuestFacts(dependencies.executor, orbctlPath, remote),
      ]);
      await Promise.all([
        verifyPackageAbsent(
          dependencies.executor,
          orbctlPath,
          commandCenter,
        ),
        verifyPackageAbsent(dependencies.executor, orbctlPath, remote),
      ]);
      await prepareBoxSshRoute(
        dependencies.executor,
        orbctlPath,
        commandCenter,
        remote,
      );
      const managedArtifact = artifactWithPaths as ArtifactIdentity & {
        readonly canonicalArchivePath: string;
        readonly canonicalBundleDirectory: string;
      };
      const commandCenterArchive = await stageManagedBundle(
        dependencies.executor,
        orbctlPath,
        commandCenter,
        managedArtifact,
        kind,
      );
      const packageIdentity = await installPackage(
        dependencies.executor,
        orbctlPath,
        commandCenter,
        commandCenterArchive,
        artifact,
      );
      const activationUnit = await launchCommandCenterActivation(
        dependencies.executor,
        orbctlPath,
        commandCenter,
        runId,
      );
      boxState = withState(boxState, { prepared: true });
      await appendEvidence(directory, {
        schema: OBSERVATION_SCHEMA,
        at: dependencies.now().toISOString(),
        runId,
        event: "prepared",
        status: "passed",
        detail: {
          commandCenter: { id: commandCenter.id, name: commandCenter.name },
          remote: { id: remote.id, name: remote.name },
          commandCenterFacts,
          remoteFacts,
          package: packageIdentity,
          activationCheckpoint: {
            status: "activation-required",
            unit: activationUnit,
            surface: "trusted-renderer-on-box-desktop",
            secretCustody: "never-cli-args-env-files-or-evidence",
          },
          next:
            "activate the normal-renderer Command Center privately, leave it running, then run",
        },
        state: boxState,
      });
      return boxState;
    } catch (error) {
      return recordFailure(
        directory,
        dependencies.now,
        boxState,
        "prepare-failed",
        error,
      );
    }
  }
  const goldenName = requiredString(
    options.goldenName,
    "golden VM name",
    MACHINE_NAME,
  );
  const goldenId = requireSafeMachineId(options.goldenId, "golden VM id");
  const goldenInfo = await orbInfo(
    dependencies.executor,
    orbctlPath,
    goldenName,
  );
  if (goldenInfo.id !== goldenId || goldenInfo.state !== "stopped") {
    throw new Error("golden VM identity/state does not match its explicit pin");
  }
  const golden: RunMachine = {
    id: goldenInfo.id,
    name: goldenInfo.name,
    username: goldenInfo.config.defaultUsername,
  };
  let state: QualificationRunState = {
    schema: RUN_STATE_SCHEMA,
    runId,
    kind,
    virtualization,
    commandCenterMode,
    golden,
    machines: {},
    artifact,
    prepared: false,
    managedRunAttempted: false,
    managedDeployReady: false,
    failed: false,
    cleaned: false,
  };
  await appendEvidence(directory, {
    schema: OBSERVATION_SCHEMA,
    at: dependencies.now().toISOString(),
    runId,
    event: "golden-validated",
    status: "passed",
    detail: {
      golden: { id: golden.id, name: golden.name },
      image: goldenInfo.image,
      artifact,
      qualificationKind: kind,
    },
    state,
  });

  try {
    let commandCenter: RunMachine;
    if (commandCenterMode === "retained-licensed") {
      const retainedName = requiredString(
        options.commandCenterName,
        "retained Command Center name",
        MACHINE_NAME,
      );
      const retainedId = requireSafeMachineId(
        options.commandCenterId,
        "retained Command Center id",
      );
      const commandCenterInfo = await orbInfo(
        dependencies.executor,
        orbctlPath,
        retainedName,
      );
      if (
        commandCenterInfo.id !== retainedId ||
        commandCenterInfo.state !== "stopped" ||
        commandCenterInfo.id === golden.id ||
        commandCenterInfo.name === names.remote
      ) {
        throw new Error(
          "retained Command Center identity/state does not match its exact pin",
        );
      }
      commandCenter = {
        id: commandCenterInfo.id,
        name: commandCenterInfo.name,
        username: commandCenterInfo.config.defaultUsername,
      };
    } else {
      await runOrb(
        dependencies.executor,
        orbctlPath,
        "clone Command Center VM",
        ["clone", goldenName, names.commandCenter],
        { timeoutMs: DEPLOY_COMMAND_TIMEOUT_MS },
      );
      const commandCenterInfo = await orbInfo(
        dependencies.executor,
        orbctlPath,
        names.commandCenter,
      );
      if (
        commandCenterInfo.state !== "stopped" ||
        commandCenterInfo.id === golden.id
      ) {
        throw new Error("Command Center clone identity/state is invalid");
      }
      commandCenter = {
        id: commandCenterInfo.id,
        name: commandCenterInfo.name,
        username: commandCenterInfo.config.defaultUsername,
      };
    }
    state = withState(state, {
      machines: { commandCenter },
    });
    await appendEvidence(directory, {
      schema: OBSERVATION_SCHEMA,
      at: dependencies.now().toISOString(),
      runId,
      event: commandCenterMode === "retained-licensed"
        ? "command-center-retained"
        : "command-center-cloned",
      status: "passed",
      detail: {
        machine: commandCenter,
        lifecycle: commandCenterMode,
      },
      state,
    });

    await runOrb(
      dependencies.executor,
      orbctlPath,
      "clone Remote VM",
      ["clone", goldenName, names.remote],
      { timeoutMs: DEPLOY_COMMAND_TIMEOUT_MS },
    );
    const remoteInfo = await orbInfo(
      dependencies.executor,
      orbctlPath,
      names.remote,
    );
    if (
      remoteInfo.state !== "stopped" ||
      remoteInfo.id === golden.id ||
      remoteInfo.id === commandCenter.id
    ) {
      throw new Error("Remote clone identity/state is invalid");
    }
    const remote: RunMachine = {
      id: remoteInfo.id,
      name: remoteInfo.name,
      username: remoteInfo.config.defaultUsername,
    };
    const goldenAfterClone = await orbInfo(
      dependencies.executor,
      orbctlPath,
      golden.name,
    );
    if (
      goldenAfterClone.id !== golden.id ||
      goldenAfterClone.state !== "stopped"
    ) {
      throw new Error("golden VM provenance changed while cloning");
    }
    state = withState(state, {
      machines: { commandCenter, remote },
    });
    await appendEvidence(directory, {
      schema: OBSERVATION_SCHEMA,
      at: dependencies.now().toISOString(),
      runId,
      event: "remote-cloned",
      status: "passed",
      detail: {
        machine: remote,
        goldenAfterClone: {
          id: goldenAfterClone.id,
          name: goldenAfterClone.name,
          state: goldenAfterClone.state,
        },
      },
      state,
    });

    await Promise.all([
      runOrb(
        dependencies.executor,
        orbctlPath,
        "start Command Center VM",
        ["start", commandCenter.name],
        { timeoutMs: DEPLOY_COMMAND_TIMEOUT_MS },
      ),
      runOrb(
        dependencies.executor,
        orbctlPath,
        "start Remote VM",
        ["start", remote.name],
        { timeoutMs: DEPLOY_COMMAND_TIMEOUT_MS },
      ),
    ]);
    const [commandCenterRunning, remoteRunning, commandCenterFacts, remoteFacts] =
      await Promise.all([
        orbInfo(dependencies.executor, orbctlPath, commandCenter.name),
        orbInfo(dependencies.executor, orbctlPath, remote.name),
        validateGuestFacts(
          dependencies.executor,
          orbctlPath,
          commandCenter,
        ),
        validateGuestFacts(dependencies.executor, orbctlPath, remote),
      ]);
    if (
      commandCenterRunning.id !== commandCenter.id ||
      remoteRunning.id !== remote.id ||
      commandCenterRunning.state !== "running" ||
      remoteRunning.state !== "running"
    ) {
      throw new Error("prepared OrbStack clones are not the recorded running VMs");
    }
    await verifyPackageAbsent(dependencies.executor, orbctlPath, remote);
    if (commandCenterMode === "new-activation-checkpoint") {
      await verifyPackageAbsent(
        dependencies.executor,
        orbctlPath,
        commandCenter,
      );
    }

    const managedArtifact = artifactWithPaths as ArtifactIdentity & {
      readonly canonicalArchivePath: string;
      readonly canonicalBundleDirectory: string;
    };
    const commandCenterArchive = await stageManagedBundle(
      dependencies.executor,
      orbctlPath,
      commandCenter,
      managedArtifact,
      kind,
    );
    const packageIdentity =
      commandCenterMode === "new-activation-checkpoint"
        ? await installPackage(
            dependencies.executor,
            orbctlPath,
            commandCenter,
            commandCenterArchive,
            artifact,
          )
        : await observeInstalledPackage(
            dependencies.executor,
            orbctlPath,
            commandCenter,
            artifact,
          );
    const activationUnit = await launchCommandCenterActivation(
      dependencies.executor,
      orbctlPath,
      commandCenter,
      runId,
    );
    await appendEvidence(directory, {
      schema: OBSERVATION_SCHEMA,
      at: dependencies.now().toISOString(),
      runId,
      event: "command-center-bootstrap-installed",
      status: "passed",
      detail: {
        package: packageIdentity,
        remotePackageState: "absent",
        bundleCustody: "fixed-verified-cache",
        activationCheckpoint:
          commandCenterMode === "retained-licensed"
            ? {
                status: "retained-licensed-installation",
                unit: activationUnit,
                proofRequired: "fleet-list",
              }
            : {
                status: "activation-required",
                unit: activationUnit,
                surface: "trusted-renderer",
                secretCustody: "never-cli-args-env-files-or-evidence",
              },
      },
    });

    state = withState(state, { prepared: true });
    await appendEvidence(directory, {
      schema: OBSERVATION_SCHEMA,
      at: dependencies.now().toISOString(),
      runId,
      event: "prepared",
      status: "passed",
      detail: {
        commandCenter: { id: commandCenter.id, name: commandCenter.name },
        remote: { id: remote.id, name: remote.name },
        commandCenterFacts,
        remoteFacts,
        next: commandCenterMode === "new-activation-checkpoint"
          ? "activate the normal-renderer Command Center privately, leave it running, then run"
          : "run",
      },
      state,
    });
    return state;
  } catch (error) {
    return recordFailure(
      directory,
      dependencies.now,
      state,
      "prepare-failed",
      error,
    );
  }
};

const requirePreparedMachines = (
  state: QualificationRunState,
): { readonly commandCenter: RunMachine; readonly remote: RunMachine } => {
  const commandCenter = state.machines.commandCenter;
  const remote = state.machines.remote;
  if (!state.prepared || commandCenter === undefined || remote === undefined) {
    throw new Error("qualification run is not fully prepared");
  }
  if (state.cleaned) throw new Error("qualification run was already cleaned");
  return { commandCenter, remote };
};

const requireSuccessfulFleetSync = (
  data: Record<string, unknown>,
  hostId: string,
): {
  readonly stationInstallationId: string;
  readonly remoteStatus: Record<string, unknown>;
} => {
  if (!Array.isArray(data.results) || data.results.length !== 1) {
    throw new Error("fleet sync did not return exactly one selected Remote");
  }
  const result = data.results[0];
  if (
    typeof result !== "object" ||
    result === null ||
    Array.isArray(result) ||
    (result as Record<string, unknown>).ok !== true ||
    (result as Record<string, unknown>).hostId !== hostId ||
    typeof (result as Record<string, unknown>).stationInstallationId !==
      "string"
  ) {
    throw new Error("fleet sync did not return a successful bound Remote");
  }
  const record = result as Record<string, unknown>;
  const receipt =
    typeof record.receipt === "object" &&
      record.receipt !== null &&
      !Array.isArray(record.receipt)
      ? record.receipt as Record<string, unknown>
      : undefined;
  const remoteStatus =
    receipt !== undefined &&
      typeof receipt.remoteStatus === "object" &&
      receipt.remoteStatus !== null &&
      !Array.isArray(receipt.remoteStatus)
      ? receipt.remoteStatus as Record<string, unknown>
      : undefined;
  if (
    remoteStatus === undefined ||
    remoteStatus.installationId !== record.stationInstallationId
  ) {
    throw new Error("fleet sync receipt is not bound to the selected Remote");
  }
  return {
    stationInstallationId: record.stationInstallationId as string,
    remoteStatus,
  };
};

const requireReadyFleetStatus = (
  data: Record<string, unknown>,
  hostId: string,
  stationInstallationId: string,
): void => {
  if (!Array.isArray(data.peers) || data.peers.length !== 1) {
    throw new Error("fleet status did not return exactly one selected Remote");
  }
  const peer = data.peers[0];
  if (
    typeof peer !== "object" ||
    peer === null ||
    Array.isArray(peer) ||
    (peer as Record<string, unknown>).hostId !== hostId ||
    (peer as Record<string, unknown>).stationInstallationId !==
      stationInstallationId ||
    (peer as Record<string, unknown>).phase !== "ready" ||
    (peer as Record<string, unknown>).sessionOpen !== true
  ) {
    throw new Error("fleet status did not report the bound Remote ready");
  }
};

interface QualificationWorkIdentity {
  readonly runId: string;
  readonly canvasName: string;
  readonly hostId: string;
  readonly stationInstallationId: string;
  readonly taskId: string;
  readonly actor: {
    readonly seatId: string;
    readonly canvasName: string;
    readonly nodeId: string;
  };
  readonly receivedThrough: string;
}

const requireQualificationWorkIdentity = (
  data: Record<string, unknown>,
  expected: {
    readonly runId: string;
    readonly hostId: string;
    readonly stationInstallationId: string;
    readonly prior?: QualificationWorkIdentity;
  },
): QualificationWorkIdentity => {
  const actor =
    typeof data.actor === "object" &&
      data.actor !== null &&
      !Array.isArray(data.actor)
      ? data.actor as Record<string, unknown>
      : undefined;
  if (
    data.runId !== expected.runId ||
    data.hostId !== expected.hostId ||
    data.stationInstallationId !== expected.stationInstallationId ||
    typeof data.canvasName !== "string" ||
    data.canvasName.length === 0 ||
    typeof data.taskId !== "string" ||
    data.taskId.length === 0 ||
    actor === undefined ||
    typeof actor.seatId !== "string" ||
    typeof actor.canvasName !== "string" ||
    typeof actor.nodeId !== "string" ||
    actor.canvasName !== data.canvasName ||
    typeof data.receivedThrough !== "string" ||
    !/^[1-9][0-9]{0,31}$/u.test(data.receivedThrough)
  ) {
    throw new Error("qualification work returned an invalid bound identity");
  }
  const identity: QualificationWorkIdentity = {
    runId: data.runId,
    canvasName: data.canvasName,
    hostId: data.hostId,
    stationInstallationId: data.stationInstallationId,
    taskId: data.taskId,
    actor: {
      seatId: actor.seatId,
      canvasName: actor.canvasName,
      nodeId: actor.nodeId,
    },
    receivedThrough: data.receivedThrough,
  };
  const prior = expected.prior;
  if (
    prior !== undefined &&
    (
      identity.canvasName !== prior.canvasName ||
      identity.taskId !== prior.taskId ||
      identity.actor.seatId !== prior.actor.seatId ||
      identity.actor.canvasName !== prior.actor.canvasName ||
      identity.actor.nodeId !== prior.actor.nodeId
    )
  ) {
    throw new Error("qualification work identity changed between installations");
  }
  return identity;
};

const managedRun = async (
  options: QualificationOptions,
  dependencies: Required<QualificationDependencies>,
): Promise<QualificationRunState> => {
  const directory = await assertEvidencePath(options.evidenceDirectory, false);
  const events = await readEvidenceEvents(directory);
  let state = latestState(events);
  const runId = requireRunId(options.runId ?? state.runId);
  if (state.runId !== runId) {
    throw new Error("qualification run id does not match its evidence");
  }
  if (state.managedRunAttempted) {
    throw new Error("managed qualification run was already attempted");
  }
  const { commandCenter, remote } = requirePreparedMachines(state);
  const orbctlPath = options.orbctlPath ??
    (state.virtualization === "box" ? "box" : "orbctl");
  try {
    await verifyPackageAbsent(
      dependencies.executor,
      orbctlPath,
      remote,
    );
    const remoteHostId = `q-${runId}-remote`;
    const sshEndpoint = remote.sshEndpoint ??
      `${remote.username}@${remote.name}@orb`;

    const localConfiguration = await retryOperatorCommand(
      dependencies.executor,
      orbctlPath,
      commandCenter,
      state.artifact,
      "station.configure-command-center",
      [
        "station",
        "configure-command-center",
      ],
    );
    const initialLocalStatus = await retryOperatorCommand(
      dependencies.executor,
      orbctlPath,
      commandCenter,
      state.artifact,
      "station.status",
      ["station", "status"],
      (data) => data.state === "ready",
    );
    const initialFleetReadiness = await operatorCommand(
      dependencies.executor,
      orbctlPath,
      commandCenter,
      state.artifact,
      "fleet.list",
      ["fleet", "list"],
    ).catch((error) => {
      throw new Error(
        "Command Center is not license-ready; activate the installed app through its trusted renderer, leave that process running, then rerun without recreating either VM",
        { cause: error },
      );
    });
    if (!Array.isArray(initialFleetReadiness.hosts)) {
      throw new Error("licensed Command Center returned malformed fleet state");
    }
    requireReadyStationStatus(
      initialLocalStatus,
      "command-center",
      commandCenter.name,
    );
    const commandCenterInstallationId = initialLocalStatus.installationId;
    if (
      typeof commandCenterInstallationId !== "string" ||
      !INSTALLATION_ID.test(commandCenterInstallationId)
    ) {
      throw new Error("Command Center returned an invalid installation identity");
    }
    state = withState(state, { managedRunAttempted: true });
    await appendEvidence(directory, {
      schema: OBSERVATION_SCHEMA,
      at: dependencies.now().toISOString(),
      runId,
      event: "managed-run-started",
      status: "observation",
      detail: {
        source:
          state.kind === "qualification-candidate"
            ? "signed-qualification-candidate"
            : "signed-final-release-cache",
        remotePackageState: "absent",
        licensedProductStartup: {
          activationRenderer: "fleet-list-succeeded",
          qualificationRuntime: "fleet-list-succeeded",
        },
      },
      state,
    });
    const add = await operatorCommand(
      dependencies.executor,
      orbctlPath,
      commandCenter,
      state.artifact,
      "fleet.add",
      [
        "fleet",
        "add",
        "--id",
        remoteHostId,
        "--label",
        `Qualification ${runId} Remote`,
        "--ssh-endpoint",
        sshEndpoint,
        "--capability",
        "terminal",
      ],
    );
    const managedInstalls = await operatorCommand(
      dependencies.executor,
      orbctlPath,
      commandCenter,
      state.artifact,
      "fleet.enable-managed-installs",
      ["fleet", "enable-managed-installs"],
    );
    if (managedInstalls.remoteManagedInstalls !== true) {
      throw new Error("managed-install kill switch did not become enabled");
    }
    const deployExactArtifact = (): Promise<Record<string, unknown>> =>
      state.kind === "qualification-candidate"
        ? operatorCommand(
            dependencies.executor,
            orbctlPath,
            commandCenter,
            state.artifact,
            "fleet.qualify",
            ["fleet", "qualify", remoteHostId],
            DEPLOY_COMMAND_TIMEOUT_MS,
          )
        : operatorCommand(
            dependencies.executor,
            orbctlPath,
            commandCenter,
            state.artifact,
            "fleet.deploy",
            ["fleet", "deploy", remoteHostId, "--source", "cached"],
            DEPLOY_COMMAND_TIMEOUT_MS,
          );
    const requireReadyDeployment = (
      deploymentResult: Record<string, unknown>,
      label: string,
    ): void => {
      if (deploymentResult.status === "authorization-required") {
        throw new Error(
          `${label} requested administrator authorization; userland deploy must not require elevation`,
        );
      }
      if (
        deploymentResult.status !== "ready" ||
        deploymentResult.ok !== true
      ) {
        throw new Error(
          `${label} did not become ready (${String(deploymentResult.status)})`,
        );
      }
    };
    const deployment = await deployExactArtifact();
    requireReadyDeployment(deployment, "managed deploy");
    const test = await operatorCommand(
      dependencies.executor,
      orbctlPath,
      commandCenter,
      state.artifact,
      "fleet.test",
      ["fleet", "test", remoteHostId],
    );
    if (test.ok !== true) {
      throw new Error("fleet.test did not prove the installed Remote reachable");
    }
    const doctor = requireQualificationDoctor(test);
    const sync = await operatorCommand(
      dependencies.executor,
      orbctlPath,
      commandCenter,
      state.artifact,
      "fleet.sync",
      ["fleet", "sync", "--id", remoteHostId],
      DEPLOY_COMMAND_TIMEOUT_MS,
    );
    const initialSync = requireSuccessfulFleetSync(sync, remoteHostId);
    requireReadyStationStatus(
      initialSync.remoteStatus,
      "remote",
      remote.name,
    );
    const status = await operatorCommand(
      dependencies.executor,
      orbctlPath,
      commandCenter,
      state.artifact,
      "fleet.status",
      ["fleet", "status", "--id", remoteHostId],
    );
    requireReadyFleetStatus(
      status,
      remoteHostId,
      initialSync.stationInstallationId,
    );
    const pty = await proveRemotePty(
      dependencies.executor,
      orbctlPath,
      remote,
      state.artifact,
      runId,
    );
    const corruptCandidate = await proveCorruptCandidateRejected(
      dependencies.executor,
      orbctlPath,
      commandCenter,
      remote,
      state.artifact,
      state.kind,
      remoteHostId,
      initialSync.stationInstallationId,
      runId,
    );
    const remotePackage = await runGuest(
      dependencies.executor,
      orbctlPath,
      remote,
      "observe managed Remote userland runtime",
      "/bin/sh",
      [
        "-c",
        `set -eu; RELEASE="$HOME/.vellum/runtime/releases/${state.artifact.version}-${state.artifact.archiveSha256}"; test -x "$RELEASE/resources/bin/vellum-remote"; test -x "$RELEASE/resources/systemd/vellum-remote-launch"; printf 'vellum\\t%s\\tuserland\\n' "${state.artifact.version}"`,
      ],
    );
    const [packageName, packageVersion, architecture] =
      remotePackage.stdout.trim().split("\t");
    if (
      packageName !== "vellum" ||
      packageVersion !== state.artifact.version ||
      architecture !== "userland"
    ) {
      throw new Error("managed Remote userland runtime does not match the candidate");
    }
    const invocationBefore = await runGuest(
      dependencies.executor,
      orbctlPath,
      remote,
      "observe Remote generation before restart",
      "/usr/bin/systemctl",
      [
        "--user",
        "show",
        "vellum-remote.service",
        "--property=InvocationID",
        "--value",
      ],
    );
    const beforeId = invocationBefore.stdout.trim();
    if (!/^[0-9a-f]{32}$/u.test(beforeId)) {
      throw new Error("Remote generation before restart is invalid");
    }
    const workPrepared = await operatorCommand(
      dependencies.executor,
      orbctlPath,
      commandCenter,
      state.artifact,
      "qualification.work.prepare",
      [
        "qualification",
        "work",
        "prepare",
        "--run-id",
        runId,
        "--host-id",
        remoteHostId,
      ],
      DEPLOY_COMMAND_TIMEOUT_MS,
    );
    const preparedIdentity = requireQualificationWorkIdentity(
      workPrepared,
      {
        runId,
        hostId: remoteHostId,
        stationInstallationId: initialSync.stationInstallationId,
      },
    );
    if (
      workPrepared.state !== "working" ||
      (
        workPrepared.disposition !== "prepared" &&
        workPrepared.disposition !== "idempotent"
      )
    ) {
      throw new Error("Command Center did not prepare the qualification task");
    }
    const commandCenterOffline = await stopUserUnitAndProveInactive(
      dependencies.executor,
      orbctlPath,
      commandCenter,
      activationUnitName(runId),
    );
    const remoteQualificationUnit = await ensureRemoteUserlandService(
      dependencies.executor,
      orbctlPath,
      remote,
      state.artifact,
    );
    const remoteOfflineStatus = await retryOperatorCommand(
      dependencies.executor,
      orbctlPath,
      remote,
      state.artifact,
      "station.status",
      ["station", "status"],
      (data: Record<string, unknown>) => {
        const configuration =
          typeof data.configuration === "object" &&
            data.configuration !== null &&
            !Array.isArray(data.configuration)
            ? data.configuration as Record<string, unknown>
            : undefined;
        const readiness =
          typeof data.readiness === "object" &&
            data.readiness !== null &&
            !Array.isArray(data.readiness)
            ? data.readiness as Record<string, unknown>
            : undefined;
        return (
          configuration?.role === "remote" &&
          data.installationId === initialSync.stationInstallationId &&
          readiness?.database === true &&
          readiness.workControl === true &&
          readiness.simulation === true &&
          readiness.session === false
        );
      },
    );
    const workProgressed = await operatorCommand(
      dependencies.executor,
      orbctlPath,
      remote,
      state.artifact,
      "qualification.work.progress-offline",
      [
        "qualification",
        "work",
        "progress-offline",
        "--run-id",
        runId,
      ],
      DEPLOY_COMMAND_TIMEOUT_MS,
    );
    const progressedIdentity = requireQualificationWorkIdentity(
      workProgressed,
      {
        runId,
        hostId: remoteHostId,
        stationInstallationId: initialSync.stationInstallationId,
        prior: preparedIdentity,
      },
    );
    if (
      workProgressed.before !== "working" ||
      workProgressed.after !== "completed" ||
      workProgressed.disposition !== "applied" ||
      BigInt(progressedIdentity.receivedThrough) <=
        BigInt(preparedIdentity.receivedThrough)
    ) {
      throw new Error("Remote did not complete the qualification task offline");
    }
    const remoteQualificationStopped =
      await stopUserUnitAndProveInactive(
        dependencies.executor,
        orbctlPath,
        remote,
        remoteQualificationUnit,
      );
    await startPackagedRuntime(
      dependencies.executor,
      orbctlPath,
      remote,
    );
    await startExistingQualificationUnit(
      dependencies.executor,
      orbctlPath,
      commandCenter,
      activationUnitName(runId),
    );
    const commandCenterRestarted = await retryOperatorCommand(
      dependencies.executor,
      orbctlPath,
      commandCenter,
      state.artifact,
      "station.status",
      ["station", "status"],
      (data) =>
        data.state === "ready" &&
        data.installationId === commandCenterInstallationId,
    );
    const workVerified = await operatorCommand(
      dependencies.executor,
      orbctlPath,
      commandCenter,
      state.artifact,
      "qualification.work.verify",
      [
        "qualification",
        "work",
        "verify",
        "--run-id",
        runId,
        "--host-id",
        remoteHostId,
      ],
      DEPLOY_COMMAND_TIMEOUT_MS,
    );
    const verifiedIdentity = requireQualificationWorkIdentity(
      workVerified,
      {
        runId,
        hostId: remoteHostId,
        stationInstallationId: initialSync.stationInstallationId,
        prior: progressedIdentity,
      },
    );
    if (
      workVerified.state !== "completed" ||
      verifiedIdentity.receivedThrough !==
        progressedIdentity.receivedThrough
    ) {
      throw new Error("Command Center did not verify the offline task result");
    }
    const recoveredRemote = await waitForFixedStationReady(
      dependencies.executor,
      orbctlPath,
      remote,
      state.artifact,
      "remote",
      `restart-${runId}`,
    );
    if (
      recoveredRemote.installationId !== initialSync.stationInstallationId
    ) {
      throw new Error("Remote restart changed its installation identity");
    }
    const invocationAfter = await runGuest(
      dependencies.executor,
      orbctlPath,
      remote,
      "observe Remote generation after restart",
      "/usr/bin/systemctl",
      [
        "--user",
        "show",
        "vellum-remote.service",
        "--property=InvocationID",
        "--value",
      ],
    );
    const afterId = invocationAfter.stdout.trim();
    if (!/^[0-9a-f]{32}$/u.test(afterId) || afterId === beforeId) {
      throw new Error("Remote restart did not produce a new service generation");
    }
    const restartSyncData = await operatorCommand(
      dependencies.executor,
      orbctlPath,
      commandCenter,
      state.artifact,
      "fleet.sync",
      ["fleet", "sync", "--id", remoteHostId],
      DEPLOY_COMMAND_TIMEOUT_MS,
    );
    const restartSync = requireSuccessfulFleetSync(
      restartSyncData,
      remoteHostId,
    );
    if (
      restartSync.stationInstallationId !==
        initialSync.stationInstallationId
    ) {
      throw new Error("fleet rebound a different Remote after restart");
    }
    const idempotentBefore = await observeGenerationState(
      dependencies.executor,
      orbctlPath,
      remote,
      state.artifact,
      initialSync.stationInstallationId,
      "observe Remote before idempotent redeploy",
    );
    const redeployment = await deployExactArtifact();
    requireReadyDeployment(redeployment, "idempotent redeploy");
    const idempotentAfter = await observeGenerationState(
      dependencies.executor,
      orbctlPath,
      remote,
      state.artifact,
      initialSync.stationInstallationId,
      "observe Remote after idempotent redeploy",
    );
    if (idempotentBefore.invocationId !== idempotentAfter.invocationId) {
      throw new Error("idempotent redeploy restarted the active Remote generation");
    }
    const redeploySyncData = await operatorCommand(
      dependencies.executor,
      orbctlPath,
      commandCenter,
      state.artifact,
      "fleet.sync",
      ["fleet", "sync", "--id", remoteHostId],
      DEPLOY_COMMAND_TIMEOUT_MS,
    );
    const redeploySync = requireSuccessfulFleetSync(
      redeploySyncData,
      remoteHostId,
    );
    if (
      redeploySync.stationInstallationId !==
        initialSync.stationInstallationId
    ) {
      throw new Error("idempotent redeploy changed Remote installation identity");
    }
    const finalStatus = await operatorCommand(
      dependencies.executor,
      orbctlPath,
      commandCenter,
      state.artifact,
      "fleet.status",
      ["fleet", "status", "--id", remoteHostId],
    );
    requireReadyFleetStatus(
      finalStatus,
      remoteHostId,
      initialSync.stationInstallationId,
    );
    const packageAfterRedeploy = await runGuest(
      dependencies.executor,
      orbctlPath,
      remote,
      "observe userland runtime after idempotent redeploy",
      "/bin/sh",
      [
        "-c",
        `set -eu; RELEASE="$HOME/.vellum/runtime/releases/${state.artifact.version}-${state.artifact.archiveSha256}"; test -x "$RELEASE/resources/bin/vellum-remote"; test -x "$RELEASE/resources/systemd/vellum-remote-launch"; printf 'vellum\\t%s\\tuserland\\n' "${state.artifact.version}"`,
      ],
    );
    if (
      packageAfterRedeploy.stdout.trim() !==
        `vellum\t${state.artifact.version}\tuserland`
    ) {
      throw new Error("idempotent redeploy changed the qualified userland runtime");
    }
    const generation = runtimeGenerationName(state.artifact);
    const remoteInstallationId = initialSync.stationInstallationId;
    const qualification: QualificationPhaseProof = {
      commandCenterInstallationId,
      remoteInstallationId,
      phases: {
        managedDeploy: "passed",
        initialSync: "passed",
        workRoundTrip: "passed",
        commandCenterOffline: "passed",
        remoteRestart: "passed",
        idempotentRedeploy: "passed",
      },
      doctor,
      stationVerbs: {
        pair: "request-response-observed",
        configure: "request-response-observed",
        project: "request-response-observed",
        report: "request-response-observed",
        status: "request-response-observed",
      },
      pty,
      deployment: {
        activation: {
          generation,
          unitExecStart: path.posix.join(
            runtimeReleaseDirectory(remote, state.artifact),
            "resources/systemd/vellum-remote-launch",
          ),
          conditionExecutable: path.posix.join(
            runtimeReleaseDirectory(remote, state.artifact),
            "resources/bin/vellum-remote",
          ),
        },
        corruptCandidate,
        restart: {
          before: {
            generation,
            installationId: remoteInstallationId,
            invocationId: beforeId,
          },
          after: {
            generation,
            installationId: remoteInstallationId,
            invocationId: afterId,
          },
        },
        idempotentRedeploy: {
          outcome: "already-active",
          before: idempotentBefore,
          after: idempotentAfter,
        },
        hostMutation: {
          sudoInvocations: 0,
          privilegedInstallInvocations: 0,
          systemPathMutations: 0,
        },
      },
    };
    state = withState(state, {
      managedDeployReady: true,
      qualification,
    });
    await appendEvidence(directory, {
      schema: OBSERVATION_SCHEMA,
      at: dependencies.now().toISOString(),
      runId,
      event: "managed-deploy-observed-ready",
      status: "passed",
      detail: {
        localConfiguration,
        localStatus: initialLocalStatus,
        fleetReadiness: initialFleetReadiness,
        add,
        test,
        managedInstalls,
        deploymentLane: state.kind,
        deployment,
        sync,
        status,
        workRoundTrip: {
          prepared: workPrepared,
          commandCenterOffline,
          remoteOfflineStatus,
          progressed: workProgressed,
          remoteQualificationStopped,
          commandCenterRestarted,
          verified: workVerified,
        },
        remoteRestart: {
          installationId: initialSync.stationInstallationId,
          invocationBefore: beforeId,
          invocationAfter: afterId,
          station: recoveredRemote,
          sync: restartSyncData,
        },
        idempotentRedeploy: {
          deployment: redeployment,
          sync: redeploySyncData,
          status: finalStatus,
          package: packageAfterRedeploy.stdout.trim(),
        },
        packagedCommandCenter: {
          activationUnit: activationUnitName(runId),
          station: commandCenterRestarted,
        },
        package: {
          name: packageName,
          version: packageVersion,
          architecture,
        },
      },
      state,
    });
    return state;
  } catch (error) {
    return recordFailure(
      directory,
      dependencies.now,
      state,
      "managed-run-failed",
      error,
    );
  }
};

const stationStatusRequest = (requestId: string): string =>
  `${JSON.stringify({
    protocol: STATION_SESSION_PROTOCOL,
    frame: "request",
    requestId,
    request: {
      protocol: STATION_API_PROTOCOL,
      op: "status",
    },
  })}\n`;

const parseFixedStationStatus = (
  output: string,
  expectedRequestId: string,
): Record<string, unknown> => {
  const raw = parseJsonObject(output, "fixed vellum-station status");
  const decoded = decodeStationSessionFrame(raw);
  if (Either.isLeft(decoded)) {
    throw new Error("fixed vellum-station emitted a malformed Station frame");
  }
  const frame = decoded.right;
  if (
    frame.frame !== "response" ||
    frame.requestId !== expectedRequestId ||
    !frame.envelope.ok ||
    frame.envelope.response.op !== "status"
  ) {
    throw new Error("fixed vellum-station emitted the wrong status response");
  }
  return frame.envelope.response as unknown as Record<string, unknown>;
};

const readFixedStationStatus = async (
  executor: CommandExecutor,
  orbctlPath: string,
  machine: RunMachine,
  artifact: ArtifactIdentity,
  requestId: string,
): Promise<Record<string, unknown>> => {
  const result = await runGuest(
    executor,
    orbctlPath,
    machine,
    `observe exact packaged Station status on ${machine.name}`,
    runtimeStationCli(machine, artifact),
    [],
    { input: stationStatusRequest(requestId) },
  );
  return parseFixedStationStatus(result.stdout, requestId);
};

const requireReadyStationStatus = (
  station: Record<string, unknown>,
  role: "command-center" | "remote",
  machineName: string,
): void => {
  const configuration =
    typeof station.configuration === "object" &&
      station.configuration !== null &&
      !Array.isArray(station.configuration)
      ? station.configuration as Record<string, unknown>
      : undefined;
  const readiness =
    typeof station.readiness === "object" &&
      station.readiness !== null &&
      !Array.isArray(station.readiness)
      ? station.readiness as Record<string, unknown>
      : undefined;
  if (
    station.state !== "ready" ||
    configuration?.role !== role ||
    readiness?.database !== true ||
    readiness.workControl !== true ||
    readiness.simulation !== true ||
    readiness.session !== true
  ) {
    throw new Error(`packaged Station is not ready as ${role} on ${machineName}`);
  }
};

const waitForFixedStationReady = async (
  executor: CommandExecutor,
  orbctlPath: string,
  machine: RunMachine,
  artifact: ArtifactIdentity,
  role: "command-center" | "remote",
  label: string,
): Promise<Record<string, unknown>> => {
  const deadline = Date.now() + 90_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const status = await readFixedStationStatus(
        executor,
        orbctlPath,
        machine,
        artifact,
        `${label}-${Date.now().toString(36)}`,
      );
      requireReadyStationStatus(status, role, machine.name);
      return status;
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Station did not recover on ${machine.name}`);
};

const parseServiceFields = (
  output: string,
  machineName: string,
): {
  readonly ActiveState: "active";
  readonly SubState: "running";
  readonly MainPID: string;
  readonly ControlGroup: string;
  readonly InvocationID: string;
} => {
  const entries = output
    .trim()
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => {
      const separator = line.indexOf("=");
      if (separator <= 0) {
        throw new Error(`systemd returned malformed service state on ${machineName}`);
      }
      return [line.slice(0, separator), line.slice(separator + 1)] as const;
    });
  const fields = Object.fromEntries(entries);
  const mainPid = Number(fields.MainPID);
  if (
    fields.ActiveState !== "active" ||
    fields.SubState !== "running" ||
    !Number.isSafeInteger(mainPid) ||
    mainPid <= 1 ||
    !/^\/[\x21-\x7e]+$/u.test(fields.ControlGroup ?? "") ||
    !/^[0-9a-f]{32}$/u.test(fields.InvocationID ?? "")
  ) {
    throw new Error(`packaged Vellum service is not ready on ${machineName}`);
  }
  return {
    ActiveState: "active",
    SubState: "running",
    MainPID: String(mainPid),
    ControlGroup: fields.ControlGroup,
    InvocationID: fields.InvocationID,
  };
};

type CommandCenterSecurityObservation = {
  readonly kind: "command-center";
  readonly rendererSandbox: "active";
  readonly rendererNoNewPrivileges: true;
  readonly rendererSeccomp: "filtering";
  readonly rendererCount: number;
  readonly userNamespaceIsolation: true;
  readonly controlMaterialOwnerOnly: true;
  readonly vellumTcpListeners: 0;
  readonly debugAuthority: false;
};

type RemoteSecurityObservation = {
  readonly kind: "remote";
  readonly runtime: "displayless-node";
  readonly mainExecutable: string;
  readonly electronProcesses: 0;
  readonly chromiumRendererProcesses: 0;
  readonly xvfbProcesses: 0;
  readonly displayEnvironment: "unset";
  readonly controlMaterialOwnerOnly: true;
  readonly vellumTcpListeners: 0;
  readonly cdpListeners: 0;
  readonly debugAuthority: false;
};

type RuntimeSecurityObservation =
  | CommandCenterSecurityObservation
  | RemoteSecurityObservation;

const FORBIDDEN_REMOTE_PROCESS =
  /(?:^|\/)(?:electron|chrome|chromium|xvfb-run|Xvfb)(?:\s|$)|(?:^|\s)--type=renderer(?:=|\s|$)|(?:^|\s)--ozone-platform(?:=|\s|$)|(?:^|\s)--vellum-headless(?:=|\s|$)/iu;

const FORBIDDEN_REMOTE_ENV =
  /^(?:DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|ELECTRON_RUN_AS_NODE|ELECTRON_OZONE_PLATFORM_HINT|OZONE_PLATFORM|CHROME_WRAPPER)=/mu;

const observeOwnerOnlyControlMaterial = async (
  executor: CommandExecutor,
  orbctlPath: string,
  machine: RunMachine,
  controlPaths: ReadonlyArray<readonly [string, string]>,
): Promise<true> => {
  const uidResult = await runGuest(
    executor,
    orbctlPath,
    machine,
    `observe station user identity on ${machine.name}`,
    "/usr/bin/id",
    ["-u"],
  );
  const uid = Number(uidResult.stdout.trim());
  if (!Number.isSafeInteger(uid) || uid <= 0) {
    throw new Error(`station user identity is invalid on ${machine.name}`);
  }
  const controlMaterial = await runGuest(
    executor,
    orbctlPath,
    machine,
    `observe owner-only control material on ${machine.name}`,
    "/usr/bin/stat",
    [
      "--format=%n\t%u\t%a\t%F",
      ...controlPaths.map(([candidate]) => candidate),
    ],
  );
  const observedControl = new Map(
    controlMaterial.stdout
      .trim()
      .split(/\r?\n/u)
      .map((line) => {
        const fields = line.split("\t");
        if (fields.length !== 4) {
          throw new Error(
            `control material stat is malformed on ${machine.name}`,
          );
        }
        return [fields[0], fields.slice(1)] as const;
      }),
  );
  for (const [candidate, expectedType] of controlPaths) {
    const fields = observedControl.get(candidate);
    const mode = fields === undefined ? Number.NaN : Number(fields[1]);
    if (
      fields === undefined ||
      Number(fields[0]) !== uid ||
      !Number.isSafeInteger(mode) ||
      mode < 0 ||
      mode > 7777 ||
      mode % 100 !== 0 ||
      fields[2] !== expectedType
    ) {
      throw new Error(
        `control material is not owner-only on ${machine.name}: ${path.posix.basename(candidate)}`,
      );
    }
  }
  return true;
};

const observeCommandCenterRuntimeSecurity = async (
  executor: CommandExecutor,
  orbctlPath: string,
  machine: RunMachine,
  mainPid: number,
  invocationId: string,
): Promise<CommandCenterSecurityObservation> => {
  const processes = await runGuest(
    executor,
    orbctlPath,
    machine,
    `observe Vellum process tree on ${machine.name}`,
    "/bin/ps",
    ["-eo", "pid=,ppid=,args="],
  );
  const descendants = descendantRows(mainPid, parseProcessRows(processes.stdout));
  if (descendants.length < 2) {
    throw new Error(`packaged Vellum process tree is incomplete on ${machine.name}`);
  }
  if (hasDebugAuthority(descendants)) {
    throw new Error(`packaged Vellum exposed debug authority on ${machine.name}`);
  }
  if (
    descendants.some((row) =>
      /(?:^|\s)--(?:no-sandbox|disable-setuid-sandbox)(?:=|\s|$)/u.test(
        row.command,
      )
    )
  ) {
    throw new Error(`packaged Vellum disabled Chromium sandboxing on ${machine.name}`);
  }
  const renderers = descendants.filter((row) =>
    /(?:^|\s)--type=renderer(?:=|\s|$)/u.test(row.command)
  );
  if (renderers.length === 0) {
    throw new Error(`packaged Vellum has no renderer on ${machine.name}`);
  }
  const rootNamespace = await runGuest(
    executor,
    orbctlPath,
    machine,
    `observe host user namespace on ${machine.name}`,
    "/usr/bin/readlink",
    ["/proc/1/ns/user"],
  );
  const rendererNamespaces = await Promise.all(
    renderers.map(async ({ pid }) => {
      const [status, namespace] = await Promise.all([
        runGuest(
          executor,
          orbctlPath,
          machine,
          `observe renderer sandbox on ${machine.name}`,
          "/usr/bin/cat",
          [`/proc/${String(pid)}/status`],
        ),
        runGuest(
          executor,
          orbctlPath,
          machine,
          `observe renderer user namespace on ${machine.name}`,
          "/usr/bin/readlink",
          [`/proc/${String(pid)}/ns/user`],
        ),
      ]);
      parseProcSandboxStatus(status.stdout);
      return namespace.stdout.trim();
    }),
  );
  if (
    !/^user:\[[0-9]+\]$/u.test(rootNamespace.stdout.trim()) ||
    rendererNamespaces.some(
      (namespace) =>
        !/^user:\[[0-9]+\]$/u.test(namespace) ||
        namespace === rootNamespace.stdout.trim(),
    )
  ) {
    throw new Error(
      `packaged renderers are not isolated in user namespaces on ${machine.name}`,
    );
  }
  const listeners = await runGuestUnchecked(
    executor,
    orbctlPath,
    machine,
    "/usr/bin/lsof",
    [
      "-nP",
      "-a",
      "-p",
      [mainPid, ...descendants.map(({ pid }) => pid)].map(String).join(","),
      "-iTCP",
      "-sTCP:LISTEN",
    ],
  );
  assertNoTcpListeners(listeners.exitCode, listeners.stdout);
  const uidResult = await runGuest(
    executor,
    orbctlPath,
    machine,
    `observe station user identity on ${machine.name}`,
    "/usr/bin/id",
    ["-u"],
  );
  const uid = Number(uidResult.stdout.trim());
  if (!Number.isSafeInteger(uid) || uid <= 0) {
    throw new Error(`station user identity is invalid on ${machine.name}`);
  }
  await observeOwnerOnlyControlMaterial(
    executor,
    orbctlPath,
    machine,
    [
      [path.posix.join(guestHome(machine), ".vellum/work"), "directory"],
      [
        path.posix.join(guestHome(machine), ".vellum/work/control.sock"),
        "socket",
      ],
      [path.posix.join(guestHome(machine), ".vellum/work/token"), "regular file"],
      [path.posix.join(guestHome(machine), ".vellum/station"), "directory"],
      [
        path.posix.join(guestHome(machine), ".vellum/station/control.sock"),
        "socket",
      ],
      [path.posix.join(guestHome(machine), ".vellum/operator"), "directory"],
      [
        path.posix.join(guestHome(machine), ".vellum/operator/control.sock"),
        "socket",
      ],
      [
        `/run/user/${String(uid)}/vellum-remote/ready-${invocationId}`,
        "regular file",
      ],
    ],
  );
  return {
    kind: "command-center",
    rendererSandbox: "active",
    rendererNoNewPrivileges: true,
    rendererSeccomp: "filtering",
    rendererCount: renderers.length,
    userNamespaceIsolation: true,
    controlMaterialOwnerOnly: true,
    vellumTcpListeners: 0,
    debugAuthority: false,
  };
};

const observeRemoteDisplaylessSecurity = async (
  executor: CommandExecutor,
  orbctlPath: string,
  machine: RunMachine,
  mainPid: number,
  invocationId: string,
  expectedNodePath: string,
): Promise<RemoteSecurityObservation> => {
  const processes = await runGuest(
    executor,
    orbctlPath,
    machine,
    `observe displayless Remote process tree on ${machine.name}`,
    "/bin/ps",
    ["-eo", "pid=,ppid=,args="],
  );
  const rows = parseProcessRows(processes.stdout);
  const descendants = descendantRows(mainPid, rows);
  const tree = [
    ...rows.filter((row) => row.pid === mainPid),
    ...descendants,
  ];
  if (tree.length === 0) {
    throw new Error(`displayless Remote process tree is empty on ${machine.name}`);
  }
  if (hasDebugAuthority(tree)) {
    throw new Error(`displayless Remote exposed debug authority on ${machine.name}`);
  }
  if (tree.some((row) => FORBIDDEN_REMOTE_PROCESS.test(row.command))) {
    throw new Error(
      `displayless Remote process tree includes Electron/Chromium/Xvfb on ${machine.name}`,
    );
  }
  const executables = await Promise.all(
    tree.map(async ({ pid }) => {
      const result = await runGuestUnchecked(
        executor,
        orbctlPath,
        machine,
        "/usr/bin/readlink",
        ["-f", `/proc/${String(pid)}/exe`],
      );
      return result.exitCode === 0
        ? { pid, executable: result.stdout.trim() }
        : undefined;
    }),
  );
  const packagedNodeProcesses = executables.filter(
    (entry): entry is { readonly pid: number; readonly executable: string } =>
      entry?.executable === expectedNodePath,
  );
  if (packagedNodeProcesses.length !== 1) {
    throw new Error(`displayless Remote is not running packaged Node on ${machine.name}`);
  }
  const mainExecutable = packagedNodeProcesses[0].executable;
  const environ = await runGuest(
    executor,
    orbctlPath,
    machine,
    `observe Remote process environment on ${machine.name}`,
    "/bin/sh",
    [
      "-c",
      `set -eu; /usr/bin/tr '\\0' '\\n' < /proc/${String(mainPid)}/environ`,
    ],
  );
  if (FORBIDDEN_REMOTE_ENV.test(environ.stdout)) {
    throw new Error(
      `displayless Remote inherited display/Electron environment on ${machine.name}`,
    );
  }
  const listeners = await runGuestUnchecked(
    executor,
    orbctlPath,
    machine,
    "/usr/bin/lsof",
    [
      "-nP",
      "-a",
      "-p",
      tree.map(({ pid }) => String(pid)).join(","),
      "-iTCP",
      "-sTCP:LISTEN",
    ],
  );
  assertNoTcpListeners(listeners.exitCode, listeners.stdout);
  const uidResult = await runGuest(
    executor,
    orbctlPath,
    machine,
    `observe Remote user identity on ${machine.name}`,
    "/usr/bin/id",
    ["-u"],
  );
  const uid = Number(uidResult.stdout.trim());
  if (!Number.isSafeInteger(uid) || uid <= 0) {
    throw new Error(`station user identity is invalid on ${machine.name}`);
  }
  // Remote is Node-only: work + station sockets. No operator/renderer surface.
  await observeOwnerOnlyControlMaterial(
    executor,
    orbctlPath,
    machine,
    [
      [path.posix.join(guestHome(machine), ".vellum/work"), "directory"],
      [
        path.posix.join(guestHome(machine), ".vellum/work/control.sock"),
        "socket",
      ],
      [path.posix.join(guestHome(machine), ".vellum/work/token"), "regular file"],
      [path.posix.join(guestHome(machine), ".vellum/station"), "directory"],
      [
        path.posix.join(guestHome(machine), ".vellum/station/control.sock"),
        "socket",
      ],
      [
        `/run/user/${String(uid)}/vellum-remote/ready-${invocationId}`,
        "regular file",
      ],
    ],
  );
  return {
    kind: "remote",
    runtime: "displayless-node",
    mainExecutable,
    electronProcesses: 0,
    chromiumRendererProcesses: 0,
    xvfbProcesses: 0,
    displayEnvironment: "unset",
    controlMaterialOwnerOnly: true,
    vellumTcpListeners: 0,
    cdpListeners: 0,
    debugAuthority: false,
  };
};

const observeRuntimeSecurity = async (
  executor: CommandExecutor,
  orbctlPath: string,
  machine: RunMachine,
  mainPid: number,
  invocationId: string,
  role: "command-center" | "remote",
  expectedRemoteNodePath: string,
): Promise<RuntimeSecurityObservation> =>
  role === "remote"
    ? observeRemoteDisplaylessSecurity(
        executor,
        orbctlPath,
        machine,
        mainPid,
        invocationId,
        expectedRemoteNodePath,
      )
    : observeCommandCenterRuntimeSecurity(
        executor,
        orbctlPath,
        machine,
        mainPid,
        invocationId,
      );

interface MachineObservation {
  readonly machine: { readonly id: string; readonly name: string };
  readonly package: {
    readonly name: string;
    readonly version: string;
    readonly architecture: string;
  };
  readonly service: ReturnType<typeof parseServiceFields>;
  readonly station: Record<string, unknown>;
  readonly security: RuntimeSecurityObservation;
}

const observeMachine = async (
  executor: CommandExecutor,
  orbctlPath: string,
  machine: RunMachine,
  artifact: ArtifactIdentity,
  expectedRole: "command-center" | "remote",
  serviceUnit: string,
): Promise<MachineObservation> => {
  const requestId = `qualification-${machine.name.endsWith("-cc") ? "cc" : "remote"}`;
  const releaseProof =
    expectedRole === "remote"
      ? `set -eu; RELEASE="$HOME/.vellum/runtime/releases/${artifact.version}-${artifact.archiveSha256}"; test -x "$RELEASE/resources/bin/vellum-remote"; test -x "$RELEASE/resources/systemd/vellum-remote-launch"; printf 'vellum\\t%s\\tuserland\\n' "${artifact.version}"`
      : `set -eu; RELEASE="$HOME/.vellum/runtime/releases/${artifact.version}-${artifact.archiveSha256}"; test -x "$RELEASE/vellum"; printf 'vellum\\t%s\\tuserland\\n' "${artifact.version}"`;
  const [packageIdentity, service, fixedStatus] = await Promise.all([
    runGuest(
      executor,
      orbctlPath,
      machine,
      `observe userland runtime health on ${machine.name}`,
      "/bin/sh",
      ["-c", releaseProof],
    ),
    runGuest(
      executor,
      orbctlPath,
      machine,
      `observe service health on ${machine.name}`,
      "/usr/bin/systemctl",
      [
        "--user",
        "show",
        serviceUnit,
        "--property=ActiveState",
        "--property=SubState",
        "--property=MainPID",
        "--property=ControlGroup",
        "--property=InvocationID",
      ],
    ),
    readFixedStationStatus(
      executor,
      orbctlPath,
      machine,
      artifact,
      requestId,
    ),
  ]);
  const [packageName, version, architecture] =
    packageIdentity.stdout.trim().split("\t");
  if (
    packageName !== "vellum" ||
    version !== artifact.version ||
    architecture !== "userland"
  ) {
    throw new Error(`userland runtime health mismatch on ${machine.name}`);
  }
  const serviceFields = parseServiceFields(service.stdout, machine.name);
  const station = fixedStatus;
  requireReadyStationStatus(station, expectedRole, machine.name);
  const security = await observeRuntimeSecurity(
    executor,
    orbctlPath,
    machine,
    Number(serviceFields.MainPID),
    serviceFields.InvocationID,
    expectedRole,
    path.posix.join(
      runtimeReleaseDirectory(machine, artifact),
      "resources/bin/node",
    ),
  );
  return {
    machine: { id: machine.id, name: machine.name },
    package: { name: packageName, version, architecture },
    service: serviceFields,
    station,
    security,
  };
};

const observe = async (
  options: QualificationOptions,
  dependencies: Required<QualificationDependencies>,
): Promise<Record<string, unknown>> => {
  const directory = await assertEvidencePath(options.evidenceDirectory, false);
  const events = await readEvidenceEvents(directory);
  const state = latestState(events);
  const runId = requireRunId(options.runId ?? state.runId);
  if (runId !== state.runId) {
    throw new Error("qualification run id does not match its evidence");
  }
  const { commandCenter, remote } = requirePreparedMachines(state);
  const orbctlPath = options.orbctlPath ??
    (state.virtualization === "box" ? "box" : "orbctl");
  try {
    if (!state.managedDeployReady || state.qualification === undefined) {
      throw new Error("runtime observation requires a completed managed run");
    }
    const [commandCenterObservation, remoteObservation] = await Promise.all([
      observeMachine(
        dependencies.executor,
        orbctlPath,
        commandCenter,
        state.artifact,
        "command-center",
        activationUnitName(runId),
      ),
      observeMachine(
        dependencies.executor,
        orbctlPath,
        remote,
        state.artifact,
        "remote",
        REMOTE_USERLAND_UNIT,
      ),
    ]);
    if (
      commandCenterObservation.station.installationId !==
        state.qualification.commandCenterInstallationId ||
      remoteObservation.station.installationId !==
        state.qualification.remoteInstallationId
    ) {
      throw new Error("runtime observation changed a qualified installation identity");
    }
    const observations = {
      commandCenter: commandCenterObservation,
      remote: remoteObservation,
    };
    await appendEvidence(directory, {
      schema: OBSERVATION_SCHEMA,
      at: dependencies.now().toISOString(),
      runId,
      event: "package-and-station-observed",
      status: "passed",
      detail: {
        commandCenter: commandCenterObservation,
        remote: remoteObservation,
        qualificationStatus: state.kind === "qualification-candidate"
          ? "all-required-phases-passed"
          : "final-release-smoke-passed",
      },
    });
    if (state.kind === "final-release") return observations;

    const evidenceSha256 = await sha256File(evidencePath(directory));
    const commandCenterSecurity = commandCenterObservation.security;
    const remoteSecurity = remoteObservation.security;
    if (commandCenterSecurity.kind !== "command-center") {
      throw new Error("Command Center security observation is not trusted-renderer");
    }
    if (remoteSecurity.kind !== "remote") {
      throw new Error("Remote security observation is not displayless-node");
    }
    const completedAt = dependencies.now().toISOString();
    const receipt = {
      schema: STATION_QUALIFICATION_SCHEMA,
      ok: true as const,
      sourceCommit: state.artifact.sourceCommit,
      manifest: {
        file: LINUX_RELEASE_MANIFEST,
        sha256: state.artifact.manifestSha256,
      },
      package: {
        file: state.artifact.archiveFile,
        bytes: state.artifact.archiveBytes,
        sha256: state.artifact.archiveSha256,
      },
      stationProtocol: STATION_PROTOCOL,
      installations: {
        commandCenter: {
          installationId:
            state.qualification.commandCenterInstallationId,
          appVersion: state.artifact.version,
          nativePlatform: {
            os: "linux" as const,
            distribution: "ubuntu" as const,
            version: "24.04" as const,
            architecture: "x64" as const,
            virtualization: state.virtualization,
          },
        },
        remote: {
          installationId: state.qualification.remoteInstallationId,
          appVersion: state.artifact.version,
          nativePlatform: {
            os: "linux" as const,
            distribution: "ubuntu" as const,
            version: "24.04" as const,
            architecture: "x64" as const,
            virtualization: state.virtualization,
          },
        },
      },
      phases: state.qualification.phases,
      health: {
        commandCenter: {
          appProcess: "running" as const,
          station: "ready" as const,
        },
        remote: {
          package: "installed" as const,
          service: "running" as const,
          station: "ready" as const,
        },
      },
      doctor: {
        observation: state.qualification.doctor,
        browserPolicy: "intentionally-unavailable-linux-beta" as const,
      },
      stationVerbs: state.qualification.stationVerbs,
      pty: state.qualification.pty,
      deployment: state.qualification.deployment,
      security: {
        commandCenter: {
          rendererSandbox: commandCenterSecurity.rendererSandbox,
          rendererNoNewPrivileges:
            commandCenterSecurity.rendererNoNewPrivileges,
          rendererSeccomp: commandCenterSecurity.rendererSeccomp,
          userNamespaceIsolation:
            commandCenterSecurity.userNamespaceIsolation,
          controlMaterialOwnerOnly:
            commandCenterSecurity.controlMaterialOwnerOnly,
          vellumTcpListeners: commandCenterSecurity.vellumTcpListeners,
        },
        remote: {
          runtime: remoteSecurity.runtime,
          mainExecutable: remoteSecurity.mainExecutable,
          electronProcesses: remoteSecurity.electronProcesses,
          chromiumRendererProcesses:
            remoteSecurity.chromiumRendererProcesses,
          xvfbProcesses: remoteSecurity.xvfbProcesses,
          displayEnvironment: remoteSecurity.displayEnvironment,
          controlMaterialOwnerOnly:
            remoteSecurity.controlMaterialOwnerOnly,
          vellumTcpListeners: remoteSecurity.vellumTcpListeners,
          cdpListeners: remoteSecurity.cdpListeners,
        },
      },
      evidence: {
        file: STATION_QUALIFICATION_EVIDENCE_FILE,
        sha256: evidenceSha256,
      },
      completedAt,
    };
    const decoded = decodeStationQualification(receipt);
    if (Either.isLeft(decoded) || decoded.right.ok !== true) {
      throw new Error("completed qualification receipt failed strict decode");
    }
    const receiptFile = path.join(
      directory,
      STATION_QUALIFICATION_RECEIPT_FILE,
    );
    await writeFile(
      receiptFile,
      `${JSON.stringify(decoded.right, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    return { ...observations, receipt: decoded.right };
  } catch (error) {
    return recordFailure(
      directory,
      dependencies.now,
      state,
      "observe-failed",
      error,
    );
  }
};

const cleanup = async (
  options: QualificationOptions,
  dependencies: Required<QualificationDependencies>,
): Promise<QualificationRunState> => {
  const directory = await assertEvidencePath(options.evidenceDirectory, false);
  const events = await readEvidenceEvents(directory);
  let state = latestState(events);
  const confirmation = requireRunId(options.confirmRunId);
  if (confirmation !== state.runId) {
    throw new Error("cleanup confirmation does not match the recorded run id");
  }
  if (state.cleaned) throw new Error("qualification run was already cleaned");
  const recordedMachines = [
    state.machines.commandCenter,
    state.machines.remote,
  ].filter((machine): machine is RunMachine => machine !== undefined);
  if (
    state.machines.commandCenter === undefined ||
    state.machines.remote === undefined
  ) {
    throw new Error("qualification evidence does not record the retained CC and disposable Remote");
  }
  const expectedNames = qualificationMachineNames(state.runId);
  if (
    state.machines.remote.name !== expectedNames.remote ||
    state.machines.commandCenter.name === state.machines.remote.name ||
    (
      state.golden !== undefined &&
      recordedMachines.some(
        (machine) =>
          machine.name === state.golden!.name ||
          machine.id === state.golden!.id,
      )
    )
  ) {
    throw new Error("cleanup evidence does not identify only scoped clones");
  }
  const orbctlPath = options.orbctlPath ??
    (state.virtualization === "box" ? "box" : "orbctl");
  const fresh = await Promise.all(
    recordedMachines.map((machine) =>
      state.virtualization === "box"
        ? boxInfo(
            dependencies.executor,
            orbctlPath,
            machine.id,
            machine.name,
          )
        : orbInfo(dependencies.executor, orbctlPath, machine.name)
    ),
  );
  for (const machine of recordedMachines) {
    const observed = fresh.find((candidate) => candidate.name === machine.name);
    if (observed?.id !== machine.id) {
      throw new Error(
        `cleanup refused: fresh OrbStack identity mismatch for ${machine.name}`,
      );
    }
  }
  const receiptFile = path.join(
    directory,
    STATION_QUALIFICATION_RECEIPT_FILE,
  );
  let evidenceFrozen = false;
  try {
    const receiptMetadata = await lstat(receiptFile);
    if (!receiptMetadata.isFile() || receiptMetadata.isSymbolicLink()) {
      throw new Error("qualification receipt is not a regular file");
    }
    evidenceFrozen = true;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw error;
    }
  }
  if (!evidenceFrozen) {
    await appendEvidence(directory, {
      schema: OBSERVATION_SCHEMA,
      at: dependencies.now().toISOString(),
      runId: state.runId,
      event: "cleanup-authorized",
      status: "observation",
      detail: {
        confirmedRunId: confirmation,
        machines: recordedMachines.map(({ id, name }) => ({ id, name })),
        policy: state.virtualization === "box"
          ? "stop-both-disposable-boxes"
          : "retain-command-center-delete-remote",
      },
    });
  }
  const commandCenter = state.machines.commandCenter;
  const remote = state.machines.remote;
  if (state.virtualization === "box") {
    await Promise.all([
      runOrb(
        dependencies.executor,
        orbctlPath,
        `stop disposable Command Center ${commandCenter.name}`,
        ["stop", commandCenter.id],
        { timeoutMs: DEPLOY_COMMAND_TIMEOUT_MS },
      ),
      runOrb(
        dependencies.executor,
        orbctlPath,
        `stop disposable Remote ${remote.name}`,
        ["stop", remote.id],
        { timeoutMs: DEPLOY_COMMAND_TIMEOUT_MS },
      ),
    ]);
  } else {
    await runOrb(
      dependencies.executor,
      orbctlPath,
      `stop retained Command Center ${commandCenter.name}`,
      ["stop", commandCenter.name],
      { timeoutMs: DEPLOY_COMMAND_TIMEOUT_MS },
    );
    await runOrb(
      dependencies.executor,
      orbctlPath,
      `delete disposable Remote ${remote.name}`,
      ["delete", "--force", remote.name],
      { timeoutMs: DEPLOY_COMMAND_TIMEOUT_MS },
    );
  }
  state = withState(state, { cleaned: true });
  if (!evidenceFrozen) {
    await appendEvidence(directory, {
      schema: OBSERVATION_SCHEMA,
      at: dependencies.now().toISOString(),
      runId: state.runId,
      event: "cleaned",
      status: "passed",
      detail: {
        remote: {
          id: remote.id,
          name: remote.name,
          state: state.virtualization === "box" ? "stopped" : "deleted",
        },
        retainedCommandCenter: {
          id: commandCenter.id,
          name: commandCenter.name,
          state: "stopped",
          reason: state.virtualization === "box"
            ? "disposable Box stopped"
            : "preserve licensed installation and activation slot",
        },
        ...(state.golden === undefined
          ? {}
          : {
              goldenPreserved: {
                id: state.golden.id,
                name: state.golden.name,
              },
            }),
      },
      state,
    });
  }
  return state;
};

export const runQualification = async (
  options: QualificationOptions,
  dependencies: QualificationDependencies = {},
): Promise<unknown> => {
  const resolved: Required<QualificationDependencies> = {
    executor: dependencies.executor ?? defaultExecutor,
    now: dependencies.now ?? (() => new Date()),
  };
  switch (options.mode) {
    case "prepare":
      return prepare(options, resolved);
    case "run":
      return managedRun(options, resolved);
    case "observe":
      return observe(options, resolved);
    case "cleanup":
      return cleanup(options, resolved);
  }
};

const usage = (): string => [
  "Usage:",
  "  bun run linux:qualify:orbstack -- prepare --run-id ID --evidence-dir DIR --golden-vm NAME --golden-id ID [--command-center-vm NAME --command-center-id ID] --kind qualification-candidate|final-release --bundle DIR --source-commit SHA",
  "  bun scripts/linux-orbstack-two-station-qualification.ts prepare --virtualization box --run-id ID --evidence-dir DIR --kind qualification-candidate|final-release --bundle DIR --source-commit SHA",
  "  bun run linux:qualify:orbstack -- run --run-id ID --evidence-dir DIR",
  "  bun run linux:qualify:orbstack -- observe --run-id ID --evidence-dir DIR",
  "  bun run linux:qualify:orbstack -- cleanup --evidence-dir DIR --confirm-run-id ID",
].join("\n");

export const parseQualificationArgs = (
  argv: ReadonlyArray<string>,
): QualificationOptions => {
  const [modeValue, ...rest] = argv;
  if (
    modeValue !== "prepare" &&
    modeValue !== "run" &&
    modeValue !== "observe" &&
    modeValue !== "cleanup"
  ) {
    throw new Error(usage());
  }
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (!flag?.startsWith("--")) throw new Error(`unexpected argument: ${flag}`);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    if (values.has(flag)) throw new Error(`duplicate option: ${flag}`);
    values.set(flag, value);
    index += 1;
  }
  const allowed = new Set([
    "--run-id",
    "--confirm-run-id",
    "--evidence-dir",
    "--golden-vm",
    "--golden-id",
    "--command-center-vm",
    "--command-center-id",
    "--bundle",
    "--source-commit",
    "--kind",
    "--virtualization",
  ]);
  for (const key of values.keys()) {
    if (!allowed.has(key)) throw new Error(`unknown option: ${key}`);
  }
  const allowedForMode = new Set(
    modeValue === "prepare"
      ? [
          "--run-id",
          "--evidence-dir",
          "--golden-vm",
          "--golden-id",
          "--command-center-vm",
          "--command-center-id",
                "--bundle",
          "--source-commit",
          "--kind",
          "--virtualization",
        ]
      : modeValue === "cleanup"
        ? ["--evidence-dir", "--confirm-run-id"]
        : ["--run-id", "--evidence-dir"],
  );
  for (const key of values.keys()) {
    if (!allowedForMode.has(key)) {
      throw new Error(`${key} is not valid for ${modeValue}`);
    }
  }
  const evidenceDirectory = values.get("--evidence-dir");
  if (evidenceDirectory === undefined || !path.isAbsolute(evidenceDirectory)) {
    throw new Error("--evidence-dir must be an absolute path");
  }
  const kind = values.get("--kind");
  if (
    kind !== undefined &&
    kind !== "qualification-candidate" &&
    kind !== "final-release"
  ) {
    throw new Error(
      "--kind must be qualification-candidate or final-release",
    );
  }
  const virtualization = values.get("--virtualization");
  if (
    virtualization !== undefined &&
    virtualization !== "orbstack" &&
    virtualization !== "box"
  ) {
    throw new Error("--virtualization must be orbstack or box");
  }
  return {
    mode: modeValue,
    evidenceDirectory,
    ...(values.get("--run-id") === undefined
      ? {}
      : { runId: values.get("--run-id") }),
    ...(values.get("--confirm-run-id") === undefined
      ? {}
      : { confirmRunId: values.get("--confirm-run-id") }),
    ...(values.get("--golden-vm") === undefined
      ? {}
      : { goldenName: values.get("--golden-vm") }),
    ...(values.get("--golden-id") === undefined
      ? {}
      : { goldenId: values.get("--golden-id") }),
    ...(values.get("--command-center-vm") === undefined
      ? {}
      : { commandCenterName: values.get("--command-center-vm") }),
    ...(values.get("--command-center-id") === undefined
      ? {}
      : { commandCenterId: values.get("--command-center-id") }),
    ...(values.get("--bundle") === undefined
      ? {}
      : { bundleDirectory: values.get("--bundle") }),
    ...(values.get("--source-commit") === undefined
      ? {}
      : { sourceCommit: values.get("--source-commit") }),
    ...(kind === undefined ? {} : { kind }),
    ...(virtualization === undefined ? {} : { virtualization }),
  };
};

if (import.meta.main) {
  try {
    const result = await runQualification(
      parseQualificationArgs(process.argv.slice(2)),
    );
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        result,
      })}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
