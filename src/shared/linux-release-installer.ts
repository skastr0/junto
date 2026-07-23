/**
 * Wire and durable-state contract for the independently installed Linux
 * release installer.
 *
 * This protocol deliberately carries bytes and identity facts, never a path
 * or executable name. The privileged helper derives every filesystem and
 * process authority from its own fixed installation.
 */

export const LINUX_RELEASE_INSTALLER_PROTOCOL =
  "vellum/linux-release-installer/v1" as const;
export const LINUX_RELEASE_INSTALLER_JOURNAL =
  "vellum/linux-release-installer-journal/v1" as const;
export const LINUX_RELEASE_INSTALLER_RECEIPT =
  "vellum/linux-release-installer-receipt/v1" as const;

export const LINUX_RELEASE_INSTALLER_MAX_HEADER_BYTES = 64 * 1024;
export const LINUX_RELEASE_INSTALLER_MAX_FILES = 64;
export const LINUX_RELEASE_INSTALLER_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
export const LINUX_RELEASE_INSTALLER_MAX_BUNDLE_BYTES =
  3 * 1024 * 1024 * 1024;

const SHA256 = /^[0-9a-f]{64}$/u;
const TRANSACTION_ID = /^[0-9a-f]{32}$/u;
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const SOURCE_REVISION = /^[0-9a-f]{40}$/u;
const BUNDLE_FILE = /^[A-Za-z0-9][A-Za-z0-9 ._+()~-]{0,126}[A-Za-z0-9]$/u;
const PROCESS_START_TICKS = /^(0|[1-9][0-9]{0,19})$/u;
const BOOT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export interface LinuxReleaseInstallerTarget {
  readonly uid: number;
  readonly gid: number;
  readonly host: string;
}

export interface LinuxReleaseInstallerFile {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface LinuxReleaseInstallerCandidate {
  readonly version: string;
  readonly debSha256: string;
  readonly manifestSha256: string;
}

export type LinuxReleaseInstallerRequest =
  | {
    readonly schema: typeof LINUX_RELEASE_INSTALLER_PROTOCOL;
    readonly kind: "probe";
    readonly target: LinuxReleaseInstallerTarget;
    readonly candidate: LinuxReleaseInstallerCandidate;
  }
  | {
    readonly schema: typeof LINUX_RELEASE_INSTALLER_PROTOCOL;
    readonly kind: "install";
    readonly transactionId: string;
    readonly target: LinuxReleaseInstallerTarget;
    readonly files: ReadonlyArray<LinuxReleaseInstallerFile>;
  };

export interface LinuxReleaseInstallerProcessIdentity {
  readonly pid: number;
  readonly startTicks: string;
  readonly bootId: string;
}

export type LinuxReleaseInstallerJournalPhase =
  | "prepared"
  | "dpkg-started"
  | "dpkg-installed"
  | "activation-started"
  | "verified"
  | "rollback-started"
  | "rolled-back";

export interface LinuxReleaseInstallerJournal {
  readonly schema: typeof LINUX_RELEASE_INSTALLER_JOURNAL;
  readonly transactionId: string;
  readonly operation: "install" | "adopt";
  readonly owner: LinuxReleaseInstallerProcessIdentity;
  readonly target: LinuxReleaseInstallerTarget;
  readonly manifestSha256: string;
  readonly debSha256: string;
  readonly sourceRevision: string;
  readonly fromVersion: string | null;
  readonly toVersion: string;
  readonly priorArtifactSha256: string | null;
  readonly oldServiceState: "enabled-active" | "enabled-inactive" |
    "disabled-active" | "disabled-inactive" | "absent-inactive";
  readonly oldLinger: boolean;
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
  | "rollback-failed"
  | "internal";

export type LinuxReleaseInstallerRepairAction =
  | "invoke-with-fixed-sudo-command"
  | "send-a-new-bounded-frame"
  | "retry-after-current-installer"
  | "repair-root-installer-state-manually"
  | "obtain-a-valid-signed-release"
  | "repair-installed-package-manually"
  | "retry-install";

export type LinuxReleaseInstallerReceipt =
  | {
    readonly schema: typeof LINUX_RELEASE_INSTALLER_RECEIPT;
    readonly ok: true;
    readonly state: "ready";
    readonly protocol: typeof LINUX_RELEASE_INSTALLER_PROTOCOL;
    readonly target: LinuxReleaseInstallerTarget;
    readonly currentVersion: string | null;
    readonly artifactMatches: boolean;
    readonly journalState:
      | "clear"
      | "recoverable"
      | "manual-repair"
      | "busy";
  }
  | {
    readonly schema: typeof LINUX_RELEASE_INSTALLER_RECEIPT;
    readonly ok: true;
    readonly state: "installed";
    readonly transactionId: string;
    readonly fromVersion: string | null;
    readonly toVersion: string;
    readonly manifestSha256: string;
    readonly debSha256: string;
    readonly sourceRevision: string;
    readonly recoveredTransactionId: string | null;
  }
  | {
    readonly schema: typeof LINUX_RELEASE_INSTALLER_RECEIPT;
    readonly ok: false;
    readonly state: "refused" | "rolled-back";
    readonly code: LinuxReleaseInstallerRefusalCode;
    readonly transactionId: string | null;
    readonly action: LinuxReleaseInstallerRepairAction;
  };

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
  exactKeys(input, ["uid", "gid", "host"], "installer target");
  return Object.freeze({
    uid: integer(input.uid, "installer target uid", 1, 0x7fff_ffff),
    gid: integer(input.gid, "installer target gid", 1, 0x7fff_ffff),
    host: stringMatching(input.host, HOST, "installer target host"),
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
    ["version", "debSha256", "manifestSha256"],
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
  });
};

export const decodeLinuxReleaseInstallerRequest = (
  value: unknown,
): LinuxReleaseInstallerRequest => {
  const input = record(value, "installer request");
  if (
    input.schema !== LINUX_RELEASE_INSTALLER_PROTOCOL ||
    (input.kind !== "probe" && input.kind !== "install")
  ) {
    throw new Error("installer request schema is unsupported");
  }
  if (input.kind === "probe") {
    exactKeys(
      input,
      ["schema", "kind", "target", "candidate"],
      "installer probe request",
    );
    return Object.freeze({
      schema: LINUX_RELEASE_INSTALLER_PROTOCOL,
      kind: "probe",
      target: decodeTarget(input.target),
      candidate: decodeCandidate(input.candidate),
    });
  }
  exactKeys(
    input,
    ["schema", "kind", "transactionId", "target", "files"],
    "installer install request",
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
  for (const file of files) {
    if (names.has(file.name)) {
      throw new Error("installer files must be unique");
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
  return Object.freeze({
    schema: LINUX_RELEASE_INSTALLER_PROTOCOL,
    kind: "install",
    transactionId: stringMatching(
      input.transactionId,
      TRANSACTION_ID,
      "installer transaction id",
    ),
    target: decodeTarget(input.target),
    files: Object.freeze(files),
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
      "manifestSha256",
      "debSha256",
      "sourceRevision",
      "fromVersion",
      "toVersion",
      "priorArtifactSha256",
      "oldServiceState",
      "oldLinger",
      "phase",
    ],
    "installer journal",
  );
  const phases = new Set<LinuxReleaseInstallerJournalPhase>([
    "prepared",
    "dpkg-started",
    "dpkg-installed",
    "activation-started",
    "verified",
    "rollback-started",
    "rolled-back",
  ]);
  const serviceStates = new Set([
    "enabled-active",
    "enabled-inactive",
    "disabled-active",
    "disabled-inactive",
    "absent-inactive",
  ]);
  if (
    input.schema !== LINUX_RELEASE_INSTALLER_JOURNAL ||
    (input.operation !== "install" && input.operation !== "adopt") ||
    (input.fromVersion !== null &&
      (typeof input.fromVersion !== "string" ||
        !VERSION.test(input.fromVersion))) ||
    (input.priorArtifactSha256 !== null &&
      (typeof input.priorArtifactSha256 !== "string" ||
        !SHA256.test(input.priorArtifactSha256))) ||
    typeof input.oldLinger !== "boolean" ||
    typeof input.phase !== "string" ||
    !phases.has(input.phase as LinuxReleaseInstallerJournalPhase) ||
    typeof input.oldServiceState !== "string" ||
    !serviceStates.has(input.oldServiceState)
  ) {
    throw new Error("installer journal is malformed");
  }
  if (
    input.operation === "install" &&
    (input.fromVersion === null) !== (input.priorArtifactSha256 === null)
  ) {
    throw new Error("installer journal prior artifact is inconsistent");
  }
  if (
    input.operation === "adopt" &&
    (input.fromVersion === null ||
      input.fromVersion !== input.toVersion ||
      input.priorArtifactSha256 !== null)
  ) {
    throw new Error("installer adoption journal is inconsistent");
  }
  return Object.freeze({
    schema: LINUX_RELEASE_INSTALLER_JOURNAL,
    transactionId: stringMatching(
      input.transactionId,
      TRANSACTION_ID,
      "installer journal transaction id",
    ),
    operation: input.operation,
    owner: decodeProcessIdentity(input.owner),
    target: decodeTarget(input.target),
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
    priorArtifactSha256: input.priorArtifactSha256 as string | null,
    oldServiceState: input.oldServiceState as LinuxReleaseInstallerJournal[
      "oldServiceState"
    ],
    oldLinger: input.oldLinger,
    phase: input.phase as LinuxReleaseInstallerJournalPhase,
  });
};

const canonical = (value: unknown): string => `${JSON.stringify(value)}\n`;

export const encodeLinuxReleaseInstallerJournal = (
  journal: LinuxReleaseInstallerJournal,
): string => {
  const decoded = decodeLinuxReleaseInstallerJournal(journal);
  return canonical(decoded);
};

export const encodeLinuxReleaseInstallerReceipt = (
  receipt: LinuxReleaseInstallerReceipt,
): string => canonical(receipt);

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
  if (input.ok === true && input.state === "ready") {
    exactKeys(
      input,
      [
        "schema",
        "ok",
        "state",
        "protocol",
        "target",
        "currentVersion",
        "artifactMatches",
        "journalState",
      ],
      "installer ready receipt",
    );
    const journalStates = new Set([
      "clear",
      "recoverable",
      "manual-repair",
      "busy",
    ]);
    if (
      input.protocol !== LINUX_RELEASE_INSTALLER_PROTOCOL ||
      (input.currentVersion !== null &&
        (typeof input.currentVersion !== "string" ||
          !VERSION.test(input.currentVersion))) ||
      typeof input.artifactMatches !== "boolean" ||
      typeof input.journalState !== "string" ||
      !journalStates.has(input.journalState)
    ) {
      throw new Error("installer ready receipt protocol is unsupported");
    }
    return Object.freeze({
      schema: LINUX_RELEASE_INSTALLER_RECEIPT,
      ok: true,
      state: "ready",
      protocol: LINUX_RELEASE_INSTALLER_PROTOCOL,
      target: decodeTarget(input.target),
      currentVersion: input.currentVersion as string | null,
      artifactMatches: input.artifactMatches,
      journalState: input.journalState as
        | "clear"
        | "recoverable"
        | "manual-repair"
        | "busy",
    });
  }
  if (input.ok === true && input.state === "installed") {
    exactKeys(
      input,
      [
        "schema",
        "ok",
        "state",
        "transactionId",
        "fromVersion",
        "toVersion",
        "manifestSha256",
        "debSha256",
        "sourceRevision",
        "recoveredTransactionId",
      ],
      "installer installed receipt",
    );
    if (
      input.fromVersion !== null &&
      (typeof input.fromVersion !== "string" || !VERSION.test(input.fromVersion))
    ) {
      throw new Error("installer installed receipt has invalid prior version");
    }
    if (
      input.recoveredTransactionId !== null &&
      (typeof input.recoveredTransactionId !== "string" ||
        !TRANSACTION_ID.test(input.recoveredTransactionId))
    ) {
      throw new Error("installer installed receipt has invalid recovery");
    }
    return Object.freeze({
      schema: LINUX_RELEASE_INSTALLER_RECEIPT,
      ok: true,
      state: "installed",
      transactionId: stringMatching(
        input.transactionId,
        TRANSACTION_ID,
        "installer receipt transaction id",
      ),
      fromVersion: input.fromVersion as string | null,
      toVersion: stringMatching(
        input.toVersion,
        VERSION,
        "installer receipt target version",
      ),
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
    });
  }
  exactKeys(
    input,
    ["schema", "ok", "state", "code", "transactionId", "action"],
    "installer refusal receipt",
  );
  const states = new Set(["refused", "rolled-back"]);
  const codes = new Set<LinuxReleaseInstallerRefusalCode>([
    "identity",
    "protocol",
    "busy",
    "unsafe-state",
    "verification",
    "policy",
    "install-failed",
    "rollback-failed",
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
  if (
    input.ok !== false ||
    typeof input.state !== "string" ||
    !states.has(input.state) ||
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
    state: input.state as "refused" | "rolled-back",
    code: input.code as LinuxReleaseInstallerRefusalCode,
    transactionId: input.transactionId as string | null,
    action: input.action as LinuxReleaseInstallerRepairAction,
  });
};
