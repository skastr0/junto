/**
 * Disk-admission policy for the local content store.
 *
 * New writes and transfers must leave a fixed reserve free so the store cannot
 * fill the volume and corrupt SQLite/WAL or other product state. Rejection is
 * retryable and observable (`disk-low`) — never silent partial publish.
 */

import { statfsSync } from "node:fs";
import { ContentStoreError } from "./store";

/** Minimum free bytes that must remain after a content write is admitted. */
export const DEFAULT_CONTENT_DISK_RESERVE_BYTES = 256 * 1024 * 1024;

export type ContentDiskSpace = {
  readonly freeBytes: number;
  readonly totalBytes: number;
  readonly path: string;
};

export type ContentDiskAdmission =
  | {
      readonly ok: true;
      readonly freeBytes: number;
      readonly needBytes: number;
      readonly reserveBytes: number;
      readonly remainingAfter: number;
    }
  | {
      readonly ok: false;
      readonly freeBytes: number;
      readonly needBytes: number;
      readonly reserveBytes: number;
      readonly shortfallBytes: number;
      readonly reason: string;
      readonly retryable: true;
    };

/**
 * Probe free space for the volume that holds the content store root.
 * `freeBytes` is the non-privileged available count (`bavail * bsize`).
 */
export const probeContentDiskSpace = (
  path: string,
  inject?: { readonly freeBytes?: number; readonly totalBytes?: number },
): ContentDiskSpace => {
  if (inject?.freeBytes !== undefined) {
    return {
      freeBytes: inject.freeBytes,
      totalBytes: inject.totalBytes ?? inject.freeBytes,
      path,
    };
  }
  const stats = statfsSync(path);
  const bsize = Number(stats.bsize);
  const bavail = Number(stats.bavail);
  const blocks = Number(stats.blocks);
  if (
    !Number.isFinite(bsize) ||
    bsize <= 0 ||
    !Number.isFinite(bavail) ||
    bavail < 0 ||
    !Number.isFinite(blocks) ||
    blocks < 0
  ) {
    throw new ContentStoreError(
      "io",
      `content disk probe returned unusable statfs for ${path}`,
    );
  }
  const freeBytes = bsize * bavail;
  const totalBytes = bsize * blocks;
  if (!Number.isSafeInteger(freeBytes) || !Number.isSafeInteger(totalBytes)) {
    throw new ContentStoreError(
      "io",
      `content disk probe overflow for ${path}`,
    );
  }
  return { freeBytes, totalBytes, path };
};

/**
 * Admit a content write when free space covers `needBytes + reserve`.
 * `needBytes` is remaining payload (for resume: full length − partial size).
 */
export const admitContentWrite = (input: {
  readonly root: string;
  readonly needBytes: number;
  readonly reserveBytes?: number;
  readonly freeBytes?: number;
  readonly totalBytes?: number;
}): ContentDiskAdmission => {
  if (!Number.isSafeInteger(input.needBytes) || input.needBytes < 0) {
    throw new ContentStoreError(
      "invalid",
      "content disk admission needBytes must be a safe non-negative integer",
    );
  }
  const reserveBytes =
    input.reserveBytes ?? DEFAULT_CONTENT_DISK_RESERVE_BYTES;
  if (!Number.isSafeInteger(reserveBytes) || reserveBytes < 0) {
    throw new ContentStoreError(
      "invalid",
      "content disk admission reserveBytes must be a safe non-negative integer",
    );
  }
  const space = probeContentDiskSpace(input.root, {
    freeBytes: input.freeBytes,
    totalBytes: input.totalBytes,
  });
  const required = input.needBytes + reserveBytes;
  if (!Number.isSafeInteger(required)) {
    throw new ContentStoreError(
      "invalid",
      "content disk admission required bytes overflow",
    );
  }
  if (space.freeBytes < required) {
    return {
      ok: false,
      freeBytes: space.freeBytes,
      needBytes: input.needBytes,
      reserveBytes,
      shortfallBytes: required - space.freeBytes,
      reason: `content disk free ${space.freeBytes} bytes is below need ${input.needBytes} plus reserve ${reserveBytes}`,
      retryable: true,
    };
  }
  return {
    ok: true,
    freeBytes: space.freeBytes,
    needBytes: input.needBytes,
    reserveBytes,
    remainingAfter: space.freeBytes - required,
  };
};

/** Throw a retryable `disk-low` ContentStoreError when admission fails. */
export const assertContentDiskAdmission = (input: {
  readonly root: string;
  readonly needBytes: number;
  readonly reserveBytes?: number;
  readonly freeBytes?: number;
  readonly totalBytes?: number;
}): ContentDiskAdmission & { readonly ok: true } => {
  const admission = admitContentWrite(input);
  if (!admission.ok) {
    throw new ContentStoreError("disk-low", admission.reason);
  }
  return admission;
};
