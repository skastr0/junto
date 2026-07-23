/**
 * Unprivileged half of the Linux release authorization boundary.
 *
 * The bridge only stages caller-owned bytes and launches one fixed sudo child.
 * Nothing in this contract makes the stage trusted: the root installer must
 * secure-import and reverify every byte and binding.
 */

export const LINUX_RELEASE_BRIDGE_STAGE_PROTOCOL =
  "vellum/linux-release-bridge-stage/v1" as const;
export const LINUX_RELEASE_BRIDGE_AUTH_PROTOCOL =
  "vellum/linux-release-bridge-auth/v1" as const;
export const LINUX_RELEASE_BRIDGE_CLEAN_PROTOCOL =
  "vellum/linux-release-bridge-clean/v1" as const;
export const LINUX_RELEASE_BRIDGE_STAGE_ROOT =
  "/var/tmp/vellum-release-bridge" as const;
export const LINUX_RELEASE_BRIDGE_STAGE_METADATA = "stage.json" as const;
export const LINUX_RELEASE_BRIDGE_AUTH_METADATA = "auth.json" as const;

export const LINUX_RELEASE_BRIDGE_MAX_HEADER_BYTES = 64 * 1024;
export const LINUX_RELEASE_BRIDGE_MAX_AUTH_BYTES = 4 * 1024;
export const LINUX_RELEASE_BRIDGE_MAX_CLEAN_BYTES = 8 * 1024;
export const LINUX_RELEASE_BRIDGE_MAX_FILES = 64;
export const LINUX_RELEASE_BRIDGE_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
export const LINUX_RELEASE_BRIDGE_MAX_TOTAL_BYTES = 3 * 1024 * 1024 * 1024;

const SHA256 = /^[0-9a-f]{64}$/u;
const HEX_32 = /^[0-9a-f]{32}$/u;
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;
const STATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const FILE_NAME =
  /^[A-Za-z0-9][A-Za-z0-9 ._+()~-]{0,126}[A-Za-z0-9]$/u;

export interface LinuxReleaseBridgeTarget {
  readonly uid: number;
  readonly gid: number;
  readonly host: string;
  readonly stationId: string;
}

export interface LinuxReleaseBridgeFile {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface LinuxReleaseBridgeCandidate {
  readonly version: string;
  readonly manifestSha256: string;
  readonly debSha256: string;
  readonly inventorySha256: string;
}

export interface LinuxReleaseBridgeStageRequest {
  readonly schema: typeof LINUX_RELEASE_BRIDGE_STAGE_PROTOCOL;
  readonly kind: "stage";
  readonly transactionId: string;
  readonly providerNonce: string;
  readonly target: LinuxReleaseBridgeTarget;
  readonly candidate: LinuxReleaseBridgeCandidate;
  readonly totalBytes: number;
  readonly files: ReadonlyArray<LinuxReleaseBridgeFile>;
}

export interface LinuxReleaseBridgeAuthArmed {
  readonly schema: typeof LINUX_RELEASE_BRIDGE_AUTH_PROTOCOL;
  readonly kind: "AUTH_ARMED";
  readonly transactionId: string;
  readonly providerNonce: string;
  readonly bridgeNonce: string;
  readonly target: LinuxReleaseBridgeTarget;
  readonly candidate: LinuxReleaseBridgeCandidate;
  readonly totalBytes: number;
}

export type LinuxReleaseBridgeCleanupReason =
  | "authorization-failed"
  | "installer-refused"
  | "installer-terminal"
  | "interrupted";

/**
 * Emitted by the unprivileged bridge only after its fixed sudo child has been
 * reaped and the exact directory inode containing the staged payload has been
 * emptied and unlinked. This is cleanup evidence, never installation evidence.
 */
export interface LinuxReleaseBridgeStageCleared {
  readonly schema: typeof LINUX_RELEASE_BRIDGE_CLEAN_PROTOCOL;
  readonly kind: "STAGE_CLEARED";
  readonly transactionId: string;
  readonly providerNonce: string;
  readonly bridgeNonce: string;
  readonly target: LinuxReleaseBridgeTarget;
  readonly candidate: LinuxReleaseBridgeCandidate;
  readonly totalBytes: number;
  readonly reason: LinuxReleaseBridgeCleanupReason;
  readonly cleanup: {
    readonly files: "cleared";
    readonly directory: "removed";
  };
}

export interface LinuxReleaseBridgeInventory {
  readonly version: string;
  readonly manifestSha256: string;
  readonly debSha256: string;
  readonly totalBytes: number;
  readonly files: ReadonlyArray<LinuxReleaseBridgeFile>;
}

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
};

const exactKeys = (
  input: Record<string, unknown>,
  expected: ReadonlyArray<string>,
  label: string,
): void => {
  const actual = Object.keys(input).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
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

const matching = (
  value: unknown,
  expression: RegExp,
  label: string,
): string => {
  if (typeof value !== "string" || !expression.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
};

const decodeTarget = (value: unknown): LinuxReleaseBridgeTarget => {
  const input = record(value, "release bridge target");
  exactKeys(input, ["uid", "gid", "host", "stationId"], "release bridge target");
  return Object.freeze({
    uid: integer(input.uid, "release bridge target uid", 1, 0x7fff_ffff),
    gid: integer(input.gid, "release bridge target gid", 1, 0x7fff_ffff),
    host: matching(input.host, HOST, "release bridge target host"),
    stationId: matching(
      input.stationId,
      STATION_ID,
      "release bridge target station id",
    ),
  });
};

const decodeCandidate = (value: unknown): LinuxReleaseBridgeCandidate => {
  const input = record(value, "release bridge candidate");
  exactKeys(
    input,
    ["version", "manifestSha256", "debSha256", "inventorySha256"],
    "release bridge candidate",
  );
  return Object.freeze({
    version: matching(
      input.version,
      VERSION,
      "release bridge candidate version",
    ),
    manifestSha256: matching(
      input.manifestSha256,
      SHA256,
      "release bridge manifest sha256",
    ),
    debSha256: matching(
      input.debSha256,
      SHA256,
      "release bridge deb sha256",
    ),
    inventorySha256: matching(
      input.inventorySha256,
      SHA256,
      "release bridge inventory sha256",
    ),
  });
};

const decodeFile = (value: unknown): LinuxReleaseBridgeFile => {
  const input = record(value, "release bridge file");
  exactKeys(input, ["name", "bytes", "sha256"], "release bridge file");
  const name = matching(input.name, FILE_NAME, "release bridge file name");
  if (
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name === LINUX_RELEASE_BRIDGE_STAGE_METADATA ||
    name === LINUX_RELEASE_BRIDGE_AUTH_METADATA
  ) {
    throw new Error("release bridge file name is unsafe");
  }
  return Object.freeze({
    name,
    bytes: integer(
      input.bytes,
      "release bridge file bytes",
      1,
      LINUX_RELEASE_BRIDGE_MAX_FILE_BYTES,
    ),
    sha256: matching(
      input.sha256,
      SHA256,
      "release bridge file sha256",
    ),
  });
};

const decodeFiles = (
  value: unknown,
): {
  readonly files: ReadonlyArray<LinuxReleaseBridgeFile>;
  readonly totalBytes: number;
} => {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > LINUX_RELEASE_BRIDGE_MAX_FILES
  ) {
    throw new Error("release bridge file inventory is invalid");
  }
  const files = value.map(decodeFile);
  let totalBytes = 0;
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]!;
    if (
      index > 0 &&
      files[index - 1]!.name >= file.name
    ) {
      throw new Error("release bridge files are not strictly ordered");
    }
    totalBytes += file.bytes;
    if (
      !Number.isSafeInteger(totalBytes) ||
      totalBytes > LINUX_RELEASE_BRIDGE_MAX_TOTAL_BYTES
    ) {
      throw new Error("release bridge stage is oversized");
    }
  }
  return {
    files: Object.freeze(files),
    totalBytes,
  };
};

export const decodeLinuxReleaseBridgeStageRequest = (
  value: unknown,
): LinuxReleaseBridgeStageRequest => {
  const input = record(value, "release bridge stage request");
  exactKeys(
    input,
    [
      "schema",
      "kind",
      "transactionId",
      "providerNonce",
      "target",
      "candidate",
      "totalBytes",
      "files",
    ],
    "release bridge stage request",
  );
  if (
    input.schema !== LINUX_RELEASE_BRIDGE_STAGE_PROTOCOL ||
    input.kind !== "stage"
  ) {
    throw new Error("release bridge stage schema is unsupported");
  }
  const inventory = decodeFiles(input.files);
  const totalBytes = integer(
    input.totalBytes,
    "release bridge total bytes",
    1,
    LINUX_RELEASE_BRIDGE_MAX_TOTAL_BYTES,
  );
  if (totalBytes !== inventory.totalBytes) {
    throw new Error("release bridge total bytes do not match its files");
  }
  return Object.freeze({
    schema: LINUX_RELEASE_BRIDGE_STAGE_PROTOCOL,
    kind: "stage",
    transactionId: matching(
      input.transactionId,
      HEX_32,
      "release bridge transaction id",
    ),
    providerNonce: matching(
      input.providerNonce,
      HEX_32,
      "release bridge provider nonce",
    ),
    target: decodeTarget(input.target),
    candidate: decodeCandidate(input.candidate),
    totalBytes,
    files: inventory.files,
  });
};

export const decodeLinuxReleaseBridgeAuthArmed = (
  value: unknown,
): LinuxReleaseBridgeAuthArmed => {
  const input = record(value, "release bridge auth record");
  exactKeys(
    input,
    [
      "schema",
      "kind",
      "transactionId",
      "providerNonce",
      "bridgeNonce",
      "target",
      "candidate",
      "totalBytes",
    ],
    "release bridge auth record",
  );
  if (
    input.schema !== LINUX_RELEASE_BRIDGE_AUTH_PROTOCOL ||
    input.kind !== "AUTH_ARMED"
  ) {
    throw new Error("release bridge auth schema is unsupported");
  }
  return Object.freeze({
    schema: LINUX_RELEASE_BRIDGE_AUTH_PROTOCOL,
    kind: "AUTH_ARMED",
    transactionId: matching(
      input.transactionId,
      HEX_32,
      "release bridge auth transaction id",
    ),
    providerNonce: matching(
      input.providerNonce,
      HEX_32,
      "release bridge auth provider nonce",
    ),
    bridgeNonce: matching(
      input.bridgeNonce,
      HEX_32,
      "release bridge nonce",
    ),
    target: decodeTarget(input.target),
    candidate: decodeCandidate(input.candidate),
    totalBytes: integer(
      input.totalBytes,
      "release bridge auth total bytes",
      1,
      LINUX_RELEASE_BRIDGE_MAX_TOTAL_BYTES,
    ),
  });
};

export const decodeLinuxReleaseBridgeStageCleared = (
  value: unknown,
): LinuxReleaseBridgeStageCleared => {
  const input = record(value, "release bridge cleanup record");
  exactKeys(
    input,
    [
      "schema",
      "kind",
      "transactionId",
      "providerNonce",
      "bridgeNonce",
      "target",
      "candidate",
      "totalBytes",
      "reason",
      "cleanup",
    ],
    "release bridge cleanup record",
  );
  const reasons = new Set<LinuxReleaseBridgeCleanupReason>([
    "authorization-failed",
    "installer-refused",
    "installer-terminal",
    "interrupted",
  ]);
  const cleanup = record(input.cleanup, "release bridge cleanup proof");
  exactKeys(
    cleanup,
    ["files", "directory"],
    "release bridge cleanup proof",
  );
  if (
    input.schema !== LINUX_RELEASE_BRIDGE_CLEAN_PROTOCOL ||
    input.kind !== "STAGE_CLEARED" ||
    typeof input.reason !== "string" ||
    !reasons.has(input.reason as LinuxReleaseBridgeCleanupReason) ||
    cleanup.files !== "cleared" ||
    cleanup.directory !== "removed"
  ) {
    throw new Error("release bridge cleanup record is unsupported");
  }
  return Object.freeze({
    schema: LINUX_RELEASE_BRIDGE_CLEAN_PROTOCOL,
    kind: "STAGE_CLEARED",
    transactionId: matching(
      input.transactionId,
      HEX_32,
      "release bridge cleanup transaction id",
    ),
    providerNonce: matching(
      input.providerNonce,
      HEX_32,
      "release bridge cleanup provider nonce",
    ),
    bridgeNonce: matching(
      input.bridgeNonce,
      HEX_32,
      "release bridge cleanup nonce",
    ),
    target: decodeTarget(input.target),
    candidate: decodeCandidate(input.candidate),
    totalBytes: integer(
      input.totalBytes,
      "release bridge cleanup total bytes",
      1,
      LINUX_RELEASE_BRIDGE_MAX_TOTAL_BYTES,
    ),
    reason: input.reason as LinuxReleaseBridgeCleanupReason,
    cleanup: Object.freeze({
      files: "cleared",
      directory: "removed",
    }),
  });
};

const canonical = (value: unknown): string => `${JSON.stringify(value)}\n`;

export const encodeLinuxReleaseBridgeStageRequest = (
  request: LinuxReleaseBridgeStageRequest,
): string => canonical(decodeLinuxReleaseBridgeStageRequest(request));

export const encodeLinuxReleaseBridgeAuthArmed = (
  auth: LinuxReleaseBridgeAuthArmed,
): string => {
  const encoded = canonical(decodeLinuxReleaseBridgeAuthArmed(auth));
  if (
    new TextEncoder().encode(encoded).byteLength >
      LINUX_RELEASE_BRIDGE_MAX_AUTH_BYTES
  ) {
    throw new Error("release bridge auth record is oversized");
  }
  return encoded;
};

export const encodeLinuxReleaseBridgeStageCleared = (
  receipt: LinuxReleaseBridgeStageCleared,
): string => {
  const encoded = canonical(decodeLinuxReleaseBridgeStageCleared(receipt));
  if (
    new TextEncoder().encode(encoded).byteLength >
      LINUX_RELEASE_BRIDGE_MAX_CLEAN_BYTES
  ) {
    throw new Error("release bridge cleanup record is oversized");
  }
  return encoded;
};

export const linuxReleaseBridgeInventory = (
  request: Pick<
    LinuxReleaseBridgeStageRequest,
    "candidate" | "totalBytes" | "files"
  >,
): LinuxReleaseBridgeInventory =>
  Object.freeze({
    version: request.candidate.version,
    manifestSha256: request.candidate.manifestSha256,
    debSha256: request.candidate.debSha256,
    totalBytes: request.totalBytes,
    files: Object.freeze([...request.files]),
  });

export const encodeLinuxReleaseBridgeInventory = (
  request: Pick<
    LinuxReleaseBridgeStageRequest,
    "candidate" | "totalBytes" | "files"
  >,
): string => canonical(linuxReleaseBridgeInventory(request));

export const linuxReleaseBridgeStagePath = (
  uid: number,
  transactionId: string,
  root: string = LINUX_RELEASE_BRIDGE_STAGE_ROOT,
): string => {
  const decodedUid = integer(uid, "release bridge stage uid", 1, 0x7fff_ffff);
  const decodedTransaction = matching(
    transactionId,
    HEX_32,
    "release bridge stage transaction id",
  );
  if (!root.startsWith("/") || root.endsWith("/") || root.includes("\u0000")) {
    throw new Error("release bridge stage root is invalid");
  }
  return `${root}/u-${decodedUid}-${decodedTransaction}`;
};
