/**
 * Fixed cross-privilege rendezvous for Linux release maintenance.
 *
 * The root installer is the only writer. The unprivileged Remote process may
 * only observe whether the fixed path is occupied and close terminal create
 * admission while it is. Keeping this outside the user home makes a forged
 * same-UID marker impossible.
 */
export const LINUX_RELEASE_FENCE_DIRECTORY =
  "/var/lib/vellum-release-fence" as const;
export const LINUX_RELEASE_FENCE_PATH =
  "/var/lib/vellum-release-fence/active" as const;
export const LINUX_RELEASE_FENCE_PROTOCOL =
  "vellum/linux-release-fence/v1" as const;
export const LINUX_RELEASE_FENCE_MAX_BYTES = 4 * 1024;

const HEX_32 = /^[0-9a-f]{32}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const BOOT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const STATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export interface LinuxReleaseFence {
  readonly schema: typeof LINUX_RELEASE_FENCE_PROTOCOL;
  readonly fenceId: string;
  readonly transactionId: string;
  readonly operation: "install" | "adopt";
  readonly targetUid: number;
  readonly targetGid: number;
  readonly stationId: string;
  readonly machineIdSha256: string;
  readonly bootId: string;
  readonly candidateDigest: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (
  value: Record<string, unknown>,
  expected: ReadonlyArray<string>,
): boolean => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
};

const positiveId = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value > 0 &&
  value <= 0x7fff_ffff;

export const decodeLinuxReleaseFence = (
  value: unknown,
): LinuxReleaseFence | undefined => {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "schema",
      "fenceId",
      "transactionId",
      "operation",
      "targetUid",
      "targetGid",
      "stationId",
      "machineIdSha256",
      "bootId",
      "candidateDigest",
    ]) ||
    value.schema !== LINUX_RELEASE_FENCE_PROTOCOL ||
    typeof value.fenceId !== "string" ||
    !HEX_32.test(value.fenceId) ||
    typeof value.transactionId !== "string" ||
    !HEX_32.test(value.transactionId) ||
    (value.operation !== "install" && value.operation !== "adopt") ||
    !positiveId(value.targetUid) ||
    !positiveId(value.targetGid) ||
    typeof value.stationId !== "string" ||
    !STATION_ID.test(value.stationId) ||
    typeof value.machineIdSha256 !== "string" ||
    !SHA256.test(value.machineIdSha256) ||
    typeof value.bootId !== "string" ||
    !BOOT_ID.test(value.bootId) ||
    typeof value.candidateDigest !== "string" ||
    !SHA256.test(value.candidateDigest)
  ) {
    return undefined;
  }
  return Object.freeze({
    schema: LINUX_RELEASE_FENCE_PROTOCOL,
    fenceId: value.fenceId,
    transactionId: value.transactionId,
    operation: value.operation,
    targetUid: value.targetUid,
    targetGid: value.targetGid,
    stationId: value.stationId,
    machineIdSha256: value.machineIdSha256,
    bootId: value.bootId,
    candidateDigest: value.candidateDigest,
  });
};

export const encodeLinuxReleaseFence = (value: LinuxReleaseFence): string => {
  const decoded = decodeLinuxReleaseFence(value);
  if (decoded === undefined) throw new Error("Linux release fence is invalid");
  return `${JSON.stringify(decoded)}\n`;
};
