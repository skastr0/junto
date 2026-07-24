/**
 * Remote projection applied.ack — owner-only receipt after successful apply.
 *
 * Path: `~/.vellum/projections/applied.ack` (sibling of incoming.frame).
 * One desired generation + one ack — no leases.
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  PROJECTION_ACK_BASENAME,
  PROJECTION_DROP_RELATIVE_DIR,
} from "../ssh/remote-plan";

/** Default drop root — mirrors incoming.projectionDropRoot without a cycle. */
const defaultDropRoot = (): string =>
  resolve(
    process.env.VELLUM_PROJECTION_DROP_DIR ||
      join(homedir(), ".vellum", PROJECTION_DROP_RELATIVE_DIR),
  );

const SHA256_HEX = /^[a-f0-9]{64}$/;
const GENERATION = /^(0|[1-9][0-9]*)$/;

export type StationProjectionAppliedAck = {
  readonly stationHostId: string;
  readonly stationWitness: string;
  readonly generation: string;
  readonly frameSha256: string;
  readonly manifestSha256: string;
  readonly intentSha256: string;
  readonly appliedAt: string;
};

export const appliedProjectionAckPath = (
  dropRoot: string = defaultDropRoot(),
): string => join(dropRoot, PROJECTION_ACK_BASENAME);

export const projectionAckRelativePath = (): string =>
  `${PROJECTION_DROP_RELATIVE_DIR}/${PROJECTION_ACK_BASENAME}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Decode an applied.ack document. Fail closed on any shape / hash violation.
 */
export const decodeProjectionAppliedAck = (
  value: unknown,
): StationProjectionAppliedAck | undefined => {
  if (
    !isRecord(value) ||
    typeof value.stationHostId !== "string" ||
    value.stationHostId.length === 0 ||
    value.stationHostId.length > 64 ||
    typeof value.stationWitness !== "string" ||
    !SHA256_HEX.test(value.stationWitness) ||
    typeof value.generation !== "string" ||
    !GENERATION.test(value.generation) ||
    value.generation.length > 32 ||
    typeof value.frameSha256 !== "string" ||
    !SHA256_HEX.test(value.frameSha256) ||
    typeof value.manifestSha256 !== "string" ||
    !SHA256_HEX.test(value.manifestSha256) ||
    typeof value.intentSha256 !== "string" ||
    !SHA256_HEX.test(value.intentSha256) ||
    typeof value.appliedAt !== "string" ||
    value.appliedAt.length === 0 ||
    value.appliedAt.length > 64
  ) {
    return undefined;
  }
  return {
    stationHostId: value.stationHostId.slice(0, 64),
    stationWitness: value.stationWitness,
    generation: value.generation,
    frameSha256: value.frameSha256,
    manifestSha256: value.manifestSha256,
    intentSha256: value.intentSha256,
    appliedAt: value.appliedAt.slice(0, 64),
  };
};

export const parseProjectionAppliedAckText = (
  text: string,
): StationProjectionAppliedAck | undefined => {
  try {
    return decodeProjectionAppliedAck(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
};

export type WriteProjectionAppliedAckInput = {
  readonly stationHostId: string;
  readonly stationWitness: string;
  readonly generation: string;
  readonly frameSha256: string;
  readonly manifestSha256: string;
  readonly intentSha256: string;
  readonly appliedAt?: string;
  readonly dropRoot?: string;
};

/**
 * Atomically write owner-only applied.ack (mode 0o600) next to the drop path.
 */
export const writeProjectionAppliedAck = async (
  input: WriteProjectionAppliedAckInput,
): Promise<StationProjectionAppliedAck> => {
  const ack: StationProjectionAppliedAck = {
    stationHostId: input.stationHostId.slice(0, 64),
    stationWitness: input.stationWitness,
    generation: input.generation,
    frameSha256: input.frameSha256,
    manifestSha256: input.manifestSha256,
    intentSha256: input.intentSha256,
    appliedAt: input.appliedAt ?? new Date().toISOString(),
  };
  const path = appliedProjectionAckPath(input.dropRoot ?? defaultDropRoot());
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(ack)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(tmp, path);
  return ack;
};

/**
 * True when the remote ack matches the frame CC staged for that host.
 * Compares generation + frame/manifest hashes (intent optional strength).
 */
export const ackMatchesStagedFrame = (
  ack: StationProjectionAppliedAck,
  staged: {
    readonly generation: string;
    readonly frameSha256?: string;
    readonly manifestSha256: string;
  },
): boolean => {
  if (ack.generation !== staged.generation) return false;
  if (ack.manifestSha256 !== staged.manifestSha256) return false;
  if (
    staged.frameSha256 !== undefined &&
    ack.frameSha256 !== staged.frameSha256
  ) {
    return false;
  }
  return true;
};
