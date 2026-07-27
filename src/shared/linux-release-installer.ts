/**
 * Wire and durable-state contract for the independently installed Linux
 * release installer.
 *
 * This protocol deliberately carries bytes and identity facts, never a path
 * or executable name. The privileged helper derives every filesystem and
 * process authority from its own fixed installation.
 */

import type {
  LinuxReleaseBridgeCandidate,
  LinuxReleaseBridgeFile,
  LinuxReleaseBridgeTarget,
} from "./linux-release-bridge";
import {
  decodeLinuxReleaseFence,
  type LinuxReleaseFence,
} from "./linux-release-fence";

export const LINUX_RELEASE_INSTALLER_PROTOCOL =
  "vellum/linux-release-installer/v3" as const;
export const LINUX_RELEASE_INSTALLER_JOURNAL =
  "vellum/linux-release-installer-journal/v3" as const;
export const LINUX_RELEASE_INSTALLER_RECEIPT =
  "vellum/linux-release-installer-receipt/v3" as const;

export const LINUX_RELEASE_INSTALLER_MAX_HEADER_BYTES = 64 * 1024;
export const LINUX_RELEASE_INSTALLER_MAX_FILES = 64;
export const LINUX_RELEASE_INSTALLER_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
export const LINUX_RELEASE_INSTALLER_MAX_BUNDLE_BYTES =
  3 * 1024 * 1024 * 1024;

const SHA256 = /^[0-9a-f]{64}$/u;
const TRANSACTION_ID = /^[0-9a-f]{32}$/u;
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;
const STATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const SOURCE_REVISION = /^[0-9a-f]{40}$/u;
const BUNDLE_FILE = /^[A-Za-z0-9][A-Za-z0-9 ._+()~-]{0,126}[A-Za-z0-9]$/u;
const PROCESS_START_TICKS = /^(0|[1-9][0-9]{0,19})$/u;
const DECIMAL_BIGINT = /^(0|[1-9][0-9]{0,39})$/u;
const BOOT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const GENERATION = /^[0-9a-f]{32}$/u;
const OBSERVATION = /^tm_[0-9a-f]{16}$/u;

export type LinuxReleaseInstallerTarget = LinuxReleaseBridgeTarget;
export type LinuxReleaseInstallerFile = LinuxReleaseBridgeFile;
export type LinuxReleaseInstallerCandidate = LinuxReleaseBridgeCandidate;
export type LinuxReleaseInstallerSudoTarget = Readonly<
  Pick<LinuxReleaseInstallerTarget, "uid" | "gid" | "host">
>;

export type LinuxReleaseInstallerRequest =
  | {
    readonly schema: typeof LINUX_RELEASE_INSTALLER_PROTOCOL;
    readonly kind: "prepare";
    readonly transactionId: string;
    readonly providerNonce: string;
    readonly bridgeNonce: string;
    readonly helperChallenge: string;
    readonly target: LinuxReleaseInstallerTarget;
    readonly candidate: LinuxReleaseInstallerCandidate;
    readonly totalBytes: number;
    readonly files: ReadonlyArray<LinuxReleaseInstallerFile>;
  }
  | {
    readonly schema: typeof LINUX_RELEASE_INSTALLER_PROTOCOL;
    readonly kind: "commit";
    readonly transactionId: string;
    readonly providerNonce: string;
    readonly bridgeNonce: string;
    readonly helperChallenge: string;
    readonly fenceId: string;
    readonly inventorySha256: string;
  };

export interface LinuxReleaseInstallerProcessIdentity {
  readonly pid: number;
  readonly startTicks: string;
  readonly bootId: string;
}

export const LINUX_RELEASE_INSTALLER_JOURNAL_PHASES = [
  "fence-intent",
  "fence-prepared",
  "fence-published",
  "fence-acknowledged",
  "prepared",
  "dpkg-started",
  "dpkg-installed",
  "activation-started",
  "verified",
  "aborted-acknowledged",
  "aborted-fence-clear-started",
  "aborted-fence-cleared",
  "postrestart-acknowledged",
  "fence-clear-started",
  "fence-cleared",
] as const;

export type LinuxReleaseInstallerJournalPhase =
  (typeof LINUX_RELEASE_INSTALLER_JOURNAL_PHASES)[number];

export interface LinuxReleaseInstallerFenceJournal {
  readonly record: LinuxReleaseFence;
  readonly device: string | null;
  readonly inode: string | null;
  readonly preGeneration: string | null;
  readonly postGeneration: string | null;
}

export interface LinuxReleaseInstallerJournal {
  readonly schema: typeof LINUX_RELEASE_INSTALLER_JOURNAL;
  readonly transactionId: string;
  readonly operation: "install" | "adopt";
  readonly owner: LinuxReleaseInstallerProcessIdentity;
  readonly target: LinuxReleaseInstallerTarget;
  readonly fence: LinuxReleaseInstallerFenceJournal;
  readonly manifestSha256: string;
  readonly debSha256: string;
  readonly sourceRevision: string;
  readonly fromVersion: string | null;
  readonly toVersion: string;
  readonly phase: LinuxReleaseInstallerJournalPhase;
}

export type LinuxReleaseInstallerRefusalCode =
  | "identity"
  | "protocol"
  | "busy"
  | "unsafe-state"
  | "verification"
  | "policy"
  | "install-failed"
  | "internal";

export type LinuxReleaseInstallerRepairAction =
  | "invoke-with-fixed-sudo-command"
  | "send-a-new-bounded-frame"
  | "retry-after-current-installer"
  | "repair-root-installer-state-manually"
  | "obtain-a-valid-signed-release"
  | "repair-installed-package-manually"
  | "retry-install";

export interface LinuxReleaseInstallerJournalPredecessor {
  readonly transactionId: string;
  readonly operation: "install" | "adopt";
  readonly phase: LinuxReleaseInstallerJournalPhase;
}

export interface LinuxReleaseInstallerMaintenanceEvidence {
  readonly activeTerminalSessions: 0;
  readonly observationId: string;
}

export interface LinuxReleaseInstallerReadinessEvidence {
  readonly state: "ready";
  readonly generation: string;
  readonly packageVersion: string;
  readonly receiptSha256: string;
}

export type LinuxReleaseInstallerReceipt =
  | {
    readonly schema: typeof LINUX_RELEASE_INSTALLER_RECEIPT;
    readonly ok: true;
    readonly state: "root-armed";
    readonly helperChallenge: string;
    readonly target: LinuxReleaseInstallerSudoTarget;
    readonly machineIdSha256: string;
    readonly bootId: string;
  }
  | {
    readonly schema: typeof LINUX_RELEASE_INSTALLER_RECEIPT;
    readonly ok: true;
    readonly state: "root-ready";
    readonly transactionId: string;
    readonly providerNonce: string;
    readonly bridgeNonce: string;
    readonly helperChallenge: string;
    readonly target: LinuxReleaseInstallerTarget;
    readonly candidate: LinuxReleaseInstallerCandidate;
    readonly fence: LinuxReleaseFence;
    readonly machineIdSha256: string;
    readonly bootId: string;
    readonly operation: "install" | "adopt";
    readonly fromVersion: string | null;
    readonly currentVersion: string | null;
    readonly journalPredecessor: LinuxReleaseInstallerJournalPredecessor | null;
    readonly maintenance: LinuxReleaseInstallerMaintenanceEvidence;
    readonly totalBytes: number;
  }
  | {
    readonly schema: typeof LINUX_RELEASE_INSTALLER_RECEIPT;
    readonly ok: true;
    readonly state: "ready";
    readonly transactionId: string;
    readonly providerNonce: string;
    readonly bridgeNonce: string;
    readonly helperChallenge: string;
    readonly fenceId: string;
    readonly inventorySha256: string;
    readonly operation: "install" | "adopt";
    readonly changed: boolean;
    readonly fromVersion: string | null;
    readonly toVersion: string;
    readonly manifestSha256: string;
    readonly debSha256: string;
    readonly sourceRevision: string;
    readonly recoveredTransactionId: string | null;
    readonly readiness: LinuxReleaseInstallerReadinessEvidence;
  }
  | {
    readonly schema: typeof LINUX_RELEASE_INSTALLER_RECEIPT;
    readonly ok: false;
    readonly state: "refused";
    readonly code: LinuxReleaseInstallerRefusalCode;
    readonly transactionId: string | null;
    readonly action: LinuxReleaseInstallerRepairAction;
  }

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
};

const exactKeys = (
  value: Record<string, unknown>,
  expected: ReadonlyArray<string>,
  label: string,
): void => {
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} contains unexpected fields`);
  }
};

const integer = (
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number => {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
};

const stringMatching = (
  value: unknown,
  expression: RegExp,
  label: string,
): string => {
  if (typeof value !== "string" || !expression.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
};

const decodeTarget = (value: unknown): LinuxReleaseInstallerTarget => {
  const input = record(value, "installer target");
  exactKeys(input, ["uid", "gid", "host", "stationId"], "installer target");
  return Object.freeze({
    uid: integer(input.uid, "installer target uid", 1, 0x7fff_ffff),
    gid: integer(input.gid, "installer target gid", 1, 0x7fff_ffff),
    host: stringMatching(input.host, HOST, "installer target host"),
    stationId: stringMatching(
      input.stationId,
      STATION_ID,
      "installer target station id",
    ),
  });
};

const decodeSudoTarget = (
  value: unknown,
): LinuxReleaseInstallerSudoTarget => {
  const input = record(value, "installer sudo target");
  exactKeys(input, ["uid", "gid", "host"], "installer sudo target");
  return Object.freeze({
    uid: integer(input.uid, "installer sudo target uid", 1, 0x7fff_ffff),
    gid: integer(input.gid, "installer sudo target gid", 1, 0x7fff_ffff),
    host: stringMatching(input.host, HOST, "installer sudo target host"),
  });
};

const decodeFile = (value: unknown): LinuxReleaseInstallerFile => {
  const input = record(value, "installer file");
  exactKeys(input, ["name", "bytes", "sha256"], "installer file");
  const name = stringMatching(input.name, BUNDLE_FILE, "installer file name");
  if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new Error("installer file name is unsafe");
  }
  return Object.freeze({
    name,
    bytes: integer(
      input.bytes,
      "installer file bytes",
      1,
      LINUX_RELEASE_INSTALLER_MAX_FILE_BYTES,
    ),
    sha256: stringMatching(input.sha256, SHA256, "installer file sha256"),
  });
};

const decodeCandidate = (value: unknown): LinuxReleaseInstallerCandidate => {
  const input = record(value, "installer candidate");
  exactKeys(
    input,
    ["version", "debSha256", "manifestSha256", "inventorySha256"],
    "installer candidate",
  );
  return Object.freeze({
    version: stringMatching(
      input.version,
      VERSION,
      "installer candidate version",
    ),
    debSha256: stringMatching(
      input.debSha256,
      SHA256,
      "installer candidate deb sha256",
    ),
    manifestSha256: stringMatching(
      input.manifestSha256,
      SHA256,
      "installer candidate manifest sha256",
    ),
    inventorySha256: stringMatching(
      input.inventorySha256,
      SHA256,
      "installer candidate inventory sha256",
    ),
  });
};

export const decodeLinuxReleaseInstallerRequest = (
  value: unknown,
): LinuxReleaseInstallerRequest => {
  const input = record(value, "installer request");
  if (
    input.schema !== LINUX_RELEASE_INSTALLER_PROTOCOL ||
    (input.kind !== "prepare" && input.kind !== "commit")
  ) {
    throw new Error("installer request schema is unsupported");
  }
  if (input.kind === "prepare") {
    exactKeys(
      input,
      [
        "schema",
        "kind",
        "transactionId",
        "providerNonce",
        "bridgeNonce",
        "helperChallenge",
        "target",
        "candidate",
        "totalBytes",
        "files",
      ],
      "installer prepare request",
    );
    if (
      !Array.isArray(input.files) ||
      input.files.length === 0 ||
      input.files.length > LINUX_RELEASE_INSTALLER_MAX_FILES
    ) {
      throw new Error("installer file inventory is invalid");
    }
    const files = input.files.map(decodeFile);
    let total = 0;
    const names = new Set<string>();
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]!;
      if (names.has(file.name)) {
        throw new Error("installer files must be unique");
      }
      if (index > 0 && files[index - 1]!.name >= file.name) {
        throw new Error("installer files must be strictly ordered");
      }
      names.add(file.name);
      total += file.bytes;
      if (
        !Number.isSafeInteger(total) ||
        total > LINUX_RELEASE_INSTALLER_MAX_BUNDLE_BYTES
      ) {
        throw new Error("installer bundle is oversized");
      }
    }
    if (input.totalBytes !== total) {
      throw new Error("installer total bytes do not match its files");
    }
    return Object.freeze({
      schema: LINUX_RELEASE_INSTALLER_PROTOCOL,
      kind: "prepare",
      transactionId: stringMatching(
        input.transactionId,
        TRANSACTION_ID,
        "installer transaction id",
      ),
      providerNonce: stringMatching(
        input.providerNonce,
        TRANSACTION_ID,
        "installer provider nonce",
      ),
      bridgeNonce: stringMatching(
        input.bridgeNonce,
        TRANSACTION_ID,
        "installer bridge nonce",
      ),
      helperChallenge: stringMatching(
        input.helperChallenge,
        TRANSACTION_ID,
        "installer helper challenge",
      ),
      target: decodeTarget(input.target),
      candidate: decodeCandidate(input.candidate),
      totalBytes: integer(
        input.totalBytes,
        "installer total bytes",
        1,
        LINUX_RELEASE_INSTALLER_MAX_BUNDLE_BYTES,
      ),
      files: Object.freeze(files),
    });
  }
  exactKeys(
    input,
    [
      "schema",
      "kind",
      "transactionId",
      "providerNonce",
      "bridgeNonce",
      "helperChallenge",
      "fenceId",
      "inventorySha256",
    ],
    "installer commit request",
  );
  return Object.freeze({
    schema: LINUX_RELEASE_INSTALLER_PROTOCOL,
    kind: "commit",
    transactionId: stringMatching(
      input.transactionId,
      TRANSACTION_ID,
      "installer commit transaction id",
    ),
    providerNonce: stringMatching(
      input.providerNonce,
      TRANSACTION_ID,
      "installer commit provider nonce",
    ),
    bridgeNonce: stringMatching(
      input.bridgeNonce,
      TRANSACTION_ID,
      "installer commit bridge nonce",
    ),
    helperChallenge: stringMatching(
      input.helperChallenge,
      TRANSACTION_ID,
      "installer commit helper challenge",
    ),
    fenceId: stringMatching(
      input.fenceId,
      TRANSACTION_ID,
      "installer commit fence id",
    ),
    inventorySha256: stringMatching(
      input.inventorySha256,
      SHA256,
      "installer commit inventory sha256",
    ),
  });
};

const decodeProcessIdentity = (
  value: unknown,
): LinuxReleaseInstallerProcessIdentity => {
  const input = record(value, "installer process identity");
  exactKeys(input, ["pid", "startTicks", "bootId"], "installer process identity");
  return Object.freeze({
    pid: integer(input.pid, "installer process pid", 1, 0x7fff_ffff),
    startTicks: stringMatching(
      input.startTicks,
      PROCESS_START_TICKS,
      "installer process start ticks",
    ),
    bootId: stringMatching(input.bootId, BOOT_ID, "installer process boot id"),
  });
};

const decodeFenceJournal = (
  value: unknown,
): LinuxReleaseInstallerFenceJournal => {
  const input = record(value, "installer fence journal");
  exactKeys(
    input,
    [
      "record",
      "device",
      "inode",
      "preGeneration",
      "postGeneration",
    ],
    "installer fence journal",
  );
  const generation = (
    candidate: unknown,
    label: string,
  ): string | null => {
    if (candidate === null) return null;
    return stringMatching(candidate, GENERATION, label);
  };
  const fence = decodeLinuxReleaseFence(input.record);
  if (fence === undefined) {
    throw new Error("installer fence record is invalid");
  }
  return Object.freeze({
    record: fence,
    device: input.device === null
      ? null
      : stringMatching(
        input.device,
        DECIMAL_BIGINT,
        "installer fence device",
      ),
    inode: input.inode === null
      ? null
      : stringMatching(
        input.inode,
        DECIMAL_BIGINT,
        "installer fence inode",
      ),
    preGeneration: generation(
      input.preGeneration,
      "installer fence pre-generation",
    ),
    postGeneration: generation(
      input.postGeneration,
      "installer fence post-generation",
    ),
  });
};

export const decodeLinuxReleaseInstallerJournal = (
  value: unknown,
): LinuxReleaseInstallerJournal => {
  const input = record(value, "installer journal");
  exactKeys(
    input,
    [
      "schema",
      "transactionId",
      "operation",
      "owner",
      "target",
      "fence",
      "manifestSha256",
      "debSha256",
      "sourceRevision",
      "fromVersion",
      "toVersion",
      "phase",
    ],
    "installer journal",
  );
  const phases = new Set<LinuxReleaseInstallerJournalPhase>(
    LINUX_RELEASE_INSTALLER_JOURNAL_PHASES,
  );
  const transactionId = stringMatching(
    input.transactionId,
    TRANSACTION_ID,
    "installer journal transaction id",
  );
  const target = decodeTarget(input.target);
  const fence = decodeFenceJournal(input.fence);
  const phase = input.phase as LinuxReleaseInstallerJournalPhase;
  if (
    input.schema !== LINUX_RELEASE_INSTALLER_JOURNAL ||
    (input.operation !== "install" && input.operation !== "adopt") ||
    (input.fromVersion !== null &&
      (typeof input.fromVersion !== "string" ||
        !VERSION.test(input.fromVersion))) ||
    typeof input.phase !== "string" ||
    !phases.has(input.phase as LinuxReleaseInstallerJournalPhase)
  ) {
    throw new Error("installer journal is malformed");
  }
  if (
    input.operation === "adopt" &&
    (input.fromVersion === null ||
      input.fromVersion !== input.toVersion)
  ) {
    throw new Error("installer adoption journal is inconsistent");
  }
  if (
    fence.record.transactionId !== transactionId ||
    fence.record.targetUid !== target.uid ||
    fence.record.targetGid !== target.gid ||
    fence.record.stationId !== target.stationId ||
    (fence.record.operation !== input.operation &&
      fence.record.operation !== "recover")
  ) {
    throw new Error("installer journal fence binding is inconsistent");
  }
  if (
    (phase === "fence-intent" &&
      (fence.device !== null || fence.inode !== null)) ||
    (phase !== "fence-intent" &&
      (fence.device === null || fence.inode === null))
  ) {
    throw new Error("installer journal fence inode is inconsistent");
  }
  const postrestartPhases = new Set<LinuxReleaseInstallerJournalPhase>([
    "aborted-acknowledged",
    "aborted-fence-clear-started",
    "aborted-fence-cleared",
    "postrestart-acknowledged",
    "fence-clear-started",
    "fence-cleared",
  ]);
  if (
    (postrestartPhases.has(phase) && fence.postGeneration === null) ||
    (!postrestartPhases.has(phase) && fence.postGeneration !== null)
  ) {
    throw new Error("installer journal fence generation is inconsistent");
  }
  return Object.freeze({
    schema: LINUX_RELEASE_INSTALLER_JOURNAL,
    transactionId,
    operation: input.operation,
    owner: decodeProcessIdentity(input.owner),
    target,
    fence,
    manifestSha256: stringMatching(
      input.manifestSha256,
      SHA256,
      "installer journal manifest sha256",
    ),
    debSha256: stringMatching(
      input.debSha256,
      SHA256,
      "installer journal deb sha256",
    ),
    sourceRevision: stringMatching(
      input.sourceRevision,
      SOURCE_REVISION,
      "installer journal source revision",
    ),
    fromVersion: input.fromVersion as string | null,
    toVersion: stringMatching(
      input.toVersion,
      VERSION,
      "installer journal target version",
    ),
    phase,
  });
};

const canonical = (value: unknown): string => `${JSON.stringify(value)}\n`;

export const encodeLinuxReleaseInstallerJournal = (
  journal: LinuxReleaseInstallerJournal,
): string => {
  const decoded = decodeLinuxReleaseInstallerJournal(journal);
  return canonical(decoded);
};

export const encodeLinuxReleaseInstallerRequest = (
  request: LinuxReleaseInstallerRequest,
): string => canonical(decodeLinuxReleaseInstallerRequest(request));

export const encodeLinuxReleaseInstallerReceipt = (
  receipt: LinuxReleaseInstallerReceipt,
): string => canonical(decodeLinuxReleaseInstallerReceipt(receipt));

const decodeNullableVersion = (
  value: unknown,
  label: string,
): string | null => {
  if (value === null) return null;
  return stringMatching(value, VERSION, label);
};

const decodeJournalPredecessor = (
  value: unknown,
): LinuxReleaseInstallerJournalPredecessor | null => {
  if (value === null) return null;
  const input = record(value, "installer journal predecessor");
  exactKeys(
    input,
    ["transactionId", "operation", "phase"],
    "installer journal predecessor",
  );
  const phases = new Set<LinuxReleaseInstallerJournalPhase>(
    LINUX_RELEASE_INSTALLER_JOURNAL_PHASES,
  );
  if (
    (input.operation !== "install" && input.operation !== "adopt") ||
    typeof input.phase !== "string" ||
    !phases.has(input.phase as LinuxReleaseInstallerJournalPhase)
  ) {
    throw new Error("installer journal predecessor is invalid");
  }
  return Object.freeze({
    transactionId: stringMatching(
      input.transactionId,
      TRANSACTION_ID,
      "installer predecessor transaction id",
    ),
    operation: input.operation,
    phase: input.phase as LinuxReleaseInstallerJournalPhase,
  });
};

const decodeMaintenanceEvidence = (
  value: unknown,
): LinuxReleaseInstallerMaintenanceEvidence => {
  const input = record(value, "installer maintenance evidence");
  exactKeys(
    input,
    ["activeTerminalSessions", "observationId"],
    "installer maintenance evidence",
  );
  if (
    input.activeTerminalSessions !== 0 ||
    typeof input.observationId !== "string" ||
    !OBSERVATION.test(input.observationId)
  ) {
    throw new Error("installer maintenance evidence is invalid");
  }
  return Object.freeze({
    activeTerminalSessions: 0,
    observationId: input.observationId,
  });
};

const decodeReadinessEvidence = (
  value: unknown,
): LinuxReleaseInstallerReadinessEvidence => {
  const input = record(value, "installer readiness evidence");
  exactKeys(
    input,
    ["state", "generation", "packageVersion", "receiptSha256"],
    "installer readiness evidence",
  );
  if (input.state !== "ready") {
    throw new Error("installer readiness evidence is invalid");
  }
  return Object.freeze({
    state: "ready",
    generation: stringMatching(
      input.generation,
      GENERATION,
      "installer readiness generation",
    ),
    packageVersion: stringMatching(
      input.packageVersion,
      VERSION,
      "installer readiness package version",
    ),
    receiptSha256: stringMatching(
      input.receiptSha256,
      SHA256,
      "installer readiness receipt sha256",
    ),
  });
};

export const decodeLinuxReleaseInstallerReceipt = (
  value: unknown,
): LinuxReleaseInstallerReceipt => {
  const input = record(value, "installer receipt");
  if (
    input.schema !== LINUX_RELEASE_INSTALLER_RECEIPT ||
    typeof input.ok !== "boolean"
  ) {
    throw new Error("installer receipt schema is unsupported");
  }
  if (input.ok === true && input.state === "root-armed") {
    exactKeys(
      input,
      [
        "schema",
        "ok",
        "state",
        "helperChallenge",
        "target",
        "machineIdSha256",
        "bootId",
      ],
      "installer root-armed receipt",
    );
    return Object.freeze({
      schema: LINUX_RELEASE_INSTALLER_RECEIPT,
      ok: true,
      state: "root-armed",
      helperChallenge: stringMatching(
        input.helperChallenge,
        TRANSACTION_ID,
        "installer root-armed challenge",
      ),
      target: decodeSudoTarget(input.target),
      machineIdSha256: stringMatching(
        input.machineIdSha256,
        SHA256,
        "installer root-armed machine id sha256",
      ),
      bootId: stringMatching(
        input.bootId,
        BOOT_ID,
        "installer root-armed boot id",
      ),
    });
  }
  if (input.ok === true && input.state === "root-ready") {
    exactKeys(
      input,
      [
        "schema",
        "ok",
        "state",
        "transactionId",
        "providerNonce",
        "bridgeNonce",
        "helperChallenge",
        "target",
        "candidate",
        "fence",
        "machineIdSha256",
        "bootId",
        "operation",
        "fromVersion",
        "currentVersion",
        "journalPredecessor",
        "maintenance",
        "totalBytes",
      ],
      "installer root-ready receipt",
    );
    const transactionId = stringMatching(
      input.transactionId,
      TRANSACTION_ID,
      "installer root-ready transaction id",
    );
    const target = decodeTarget(input.target);
    const candidate = decodeCandidate(input.candidate);
    const fence = decodeLinuxReleaseFence(input.fence);
    if (
      fence === undefined ||
      (input.operation !== "install" && input.operation !== "adopt") ||
      !Number.isSafeInteger(input.totalBytes) ||
      (input.totalBytes as number) < 1 ||
      (input.totalBytes as number) > LINUX_RELEASE_INSTALLER_MAX_BUNDLE_BYTES ||
      fence.transactionId !== transactionId ||
      fence.targetUid !== target.uid ||
      fence.targetGid !== target.gid ||
      fence.stationId !== target.stationId ||
      fence.candidateDigest !== candidate.inventorySha256 ||
      fence.machineIdSha256 !== input.machineIdSha256 ||
      fence.bootId !== input.bootId ||
      (input.operation === "install"
        ? fence.operation !== "install"
        : fence.operation !== "adopt")
    ) {
      throw new Error("installer root-ready receipt is inconsistent");
    }
    return Object.freeze({
      schema: LINUX_RELEASE_INSTALLER_RECEIPT,
      ok: true,
      state: "root-ready",
      transactionId,
      providerNonce: stringMatching(
        input.providerNonce,
        TRANSACTION_ID,
        "installer root-ready provider nonce",
      ),
      bridgeNonce: stringMatching(
        input.bridgeNonce,
        TRANSACTION_ID,
        "installer root-ready bridge nonce",
      ),
      helperChallenge: stringMatching(
        input.helperChallenge,
        TRANSACTION_ID,
        "installer helper challenge",
      ),
      target,
      candidate,
      fence,
      machineIdSha256: stringMatching(
        input.machineIdSha256,
        SHA256,
        "installer machine id sha256",
      ),
      bootId: stringMatching(input.bootId, BOOT_ID, "installer boot id"),
      operation: input.operation,
      fromVersion: decodeNullableVersion(
        input.fromVersion,
        "installer root-ready prior version",
      ),
      currentVersion: decodeNullableVersion(
        input.currentVersion,
        "installer root-ready current version",
      ),
      journalPredecessor: decodeJournalPredecessor(
        input.journalPredecessor,
      ),
      maintenance: decodeMaintenanceEvidence(input.maintenance),
      totalBytes: input.totalBytes as number,
    });
  }
  if (input.ok === true && input.state === "ready") {
    exactKeys(
      input,
      [
        "schema",
        "ok",
        "state",
        "transactionId",
        "providerNonce",
        "bridgeNonce",
        "helperChallenge",
        "fenceId",
        "inventorySha256",
        "operation",
        "changed",
        "fromVersion",
        "toVersion",
        "manifestSha256",
        "debSha256",
        "sourceRevision",
        "recoveredTransactionId",
        "readiness",
      ],
      "installer final receipt",
    );
    if (
    input.operation !== "install" && input.operation !== "adopt"
    ) {
      throw new Error("installer final receipt has invalid operation");
    }
    if (
      input.recoveredTransactionId !== null &&
      (typeof input.recoveredTransactionId !== "string" ||
        !TRANSACTION_ID.test(input.recoveredTransactionId))
    ) {
      throw new Error("installer final receipt has invalid recovery");
    }
    if (
      typeof input.changed !== "boolean" ||
      !input.changed
    ) {
      throw new Error("installer final receipt has invalid change state");
    }
    const toVersion = stringMatching(
      input.toVersion,
      VERSION,
      "installer receipt target version",
    );
    const readiness = decodeReadinessEvidence(input.readiness);
    if (readiness.packageVersion !== toVersion) {
      throw new Error("installer final readiness version is inconsistent");
    }
    return Object.freeze({
      schema: LINUX_RELEASE_INSTALLER_RECEIPT,
      ok: true,
      state: "ready",
      transactionId: stringMatching(
        input.transactionId,
        TRANSACTION_ID,
        "installer receipt transaction id",
      ),
      providerNonce: stringMatching(
        input.providerNonce,
        TRANSACTION_ID,
        "installer receipt provider nonce",
      ),
      bridgeNonce: stringMatching(
        input.bridgeNonce,
        TRANSACTION_ID,
        "installer receipt bridge nonce",
      ),
      helperChallenge: stringMatching(
        input.helperChallenge,
        TRANSACTION_ID,
        "installer receipt helper challenge",
      ),
      fenceId: stringMatching(
        input.fenceId,
        TRANSACTION_ID,
        "installer receipt fence id",
      ),
      inventorySha256: stringMatching(
        input.inventorySha256,
        SHA256,
        "installer receipt inventory sha256",
      ),
      operation: input.operation,
      changed: input.changed,
      fromVersion: decodeNullableVersion(
        input.fromVersion,
        "installer receipt prior version",
      ),
      toVersion,
      manifestSha256: stringMatching(
        input.manifestSha256,
        SHA256,
        "installer receipt manifest sha256",
      ),
      debSha256: stringMatching(
        input.debSha256,
        SHA256,
        "installer receipt deb sha256",
      ),
      sourceRevision: stringMatching(
        input.sourceRevision,
        SOURCE_REVISION,
        "installer receipt source revision",
      ),
      recoveredTransactionId: input.recoveredTransactionId as string | null,
      readiness,
    });
  }
  const codes = new Set<LinuxReleaseInstallerRefusalCode>([
    "identity",
    "protocol",
    "busy",
    "unsafe-state",
    "verification",
    "policy",
    "install-failed",
    "internal",
  ]);
  const actions = new Set<LinuxReleaseInstallerRepairAction>([
    "invoke-with-fixed-sudo-command",
    "send-a-new-bounded-frame",
    "retry-after-current-installer",
    "repair-root-installer-state-manually",
    "obtain-a-valid-signed-release",
    "repair-installed-package-manually",
    "retry-install",
  ]);
  exactKeys(
    input,
    ["schema", "ok", "state", "code", "transactionId", "action"],
    "installer refusal receipt",
  );
  if (
    input.ok !== false ||
    input.state !== "refused" ||
    typeof input.code !== "string" ||
    !codes.has(input.code as LinuxReleaseInstallerRefusalCode) ||
    typeof input.action !== "string" ||
    !actions.has(input.action as LinuxReleaseInstallerRepairAction) ||
    (input.transactionId !== null &&
      (typeof input.transactionId !== "string" ||
        !TRANSACTION_ID.test(input.transactionId)))
  ) {
    throw new Error("installer refusal receipt is malformed");
  }
  return Object.freeze({
    schema: LINUX_RELEASE_INSTALLER_RECEIPT,
    ok: false,
    state: "refused",
    code: input.code as LinuxReleaseInstallerRefusalCode,
    transactionId: input.transactionId as string | null,
    action: input.action as LinuxReleaseInstallerRepairAction,
  });
};
