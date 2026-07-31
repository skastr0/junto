/**
 * Local content transfer plane.
 *
 * Receives bytes into a deterministic partial under the content store,
 * supports safe resume by partial size, verifies digest + length on the
 * receiver, and publishes atomically.  Never reports availability before
 * verification.  Duplicate delivery of an already-verified digest is
 * idempotent.
 *
 * This module is pure filesystem + hash; SQLite receipts are written by
 * callers only after a verified publish result.
 */

import {
  chmodSync,
  closeSync,
  constants,
  createReadStream,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { dirname } from "node:path";
import type {
  ContentAvailabilityReason,
  ContentByteLength,
  ContentMediaType,
  ContentRef,
  ContentSha256,
  ContentTimestamp,
} from "@shared/content";
import {
  contentIncomingDir,
  contentObjectPath,
  contentPartialPath,
  contentStoreRoot,
} from "./paths";
import {
  ContentStoreError,
  ensureContentLayout,
  hashContentObjectFile,
} from "./store";

const PARTIAL_MODE = 0o600;
const OBJECT_MODE = 0o444;
const READ_CHUNK = 64 * 1024;

const openAppendFlags =
  constants.O_WRONLY |
  constants.O_APPEND |
  (constants.O_NOFOLLOW ?? 0);

const openCreateFlags =
  constants.O_CREAT |
  constants.O_EXCL |
  constants.O_WRONLY |
  (constants.O_NOFOLLOW ?? 0);

const openReadFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

const openDirFlags =
  constants.O_RDONLY |
  (constants.O_DIRECTORY ?? 0) |
  (constants.O_NOFOLLOW ?? 0);

const isEnoent = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code: unknown }).code === "ENOENT";

const lstatOrUndefined = (path: string): Stats | undefined => {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
};

const safeUnlinkOwnedFile = (path: string): void => {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) return;
    unlinkSync(path);
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
};

const fsyncPath = (path: string, directory: boolean): void => {
  const flags = directory ? openDirFlags : openReadFlags;
  let fd: number | undefined;
  try {
    fd = openSync(path, flags);
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
};

/** Deterministic partial id for a digest so resumes share one file. */
export const contentTransferPartialId = (sha256: string): string => {
  if (!/^[a-f0-9]{64}$/u.test(sha256)) {
    throw new ContentStoreError("invalid", "sha256 must be lower-case hex");
  }
  return `xfer_${sha256}`;
};

export type ContentTransferStat =
  | {
      readonly state: "verified";
      readonly path: string;
      readonly verifiedAt: string;
    }
  | {
      readonly state: "partial";
      readonly partialPath: string;
      readonly partialBytes: number;
    }
  | {
      readonly state: "missing";
      readonly reason: string;
    }
  | {
      readonly state: "corrupt";
      readonly reason: string;
      readonly observedSha256?: string;
      readonly observedByteLength?: number;
    };

/**
 * Inspect local content for transfer planning.  A verified object wins over
 * any partial; a partial larger than the expected length is corrupt.
 */
export const statContentForTransfer = (
  root: string,
  ref: Pick<ContentRef, "sha256" | "byteLength">,
): ContentTransferStat => {
  ensureContentLayout(root);
  const objectPath = contentObjectPath(root, ref.sha256);
  const objectInfo = lstatOrUndefined(objectPath);
  if (objectInfo !== undefined) {
    if (objectInfo.isSymbolicLink() || !objectInfo.isFile()) {
      return {
        state: "corrupt",
        reason: "content object path is not a regular file",
      };
    }
    if (objectInfo.size !== ref.byteLength) {
      return {
        state: "corrupt",
        reason: "content object size does not match ContentRef",
        observedByteLength: objectInfo.size,
      };
    }
    try {
      const observed = hashContentObjectFile(objectPath);
      if (
        observed.sha256 !== ref.sha256 ||
        observed.byteLength !== ref.byteLength
      ) {
        return {
          state: "corrupt",
          reason: "content object digest or length mismatch",
          observedSha256: observed.sha256,
          observedByteLength: observed.byteLength,
        };
      }
      return {
        state: "verified",
        path: objectPath,
        verifiedAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        state: "corrupt",
        reason:
          error instanceof Error
            ? error.message.slice(0, 1024)
            : "content object could not be verified",
      };
    }
  }

  const partialPath = contentPartialPath(
    root,
    contentTransferPartialId(ref.sha256),
  );
  const partialInfo = lstatOrUndefined(partialPath);
  if (partialInfo === undefined) {
    return {
      state: "missing",
      reason: "content object and partial are absent",
    };
  }
  if (partialInfo.isSymbolicLink() || !partialInfo.isFile()) {
    return {
      state: "corrupt",
      reason: "content partial is not a regular file",
    };
  }
  if (partialInfo.size > ref.byteLength) {
    return {
      state: "corrupt",
      reason: "content partial exceeds ContentRef byteLength",
      observedByteLength: partialInfo.size,
    };
  }
  if (partialInfo.size === ref.byteLength) {
    // Full partial awaiting finalize — treat as partial so caller can finalize.
    return {
      state: "partial",
      partialPath,
      partialBytes: partialInfo.size,
    };
  }
  return {
    state: "partial",
    partialPath,
    partialBytes: partialInfo.size,
  };
};

export type ContentReceiveResult =
  | {
      readonly state: "verified";
      readonly ref: ContentRef;
      readonly path: string;
      readonly created: boolean;
      readonly verifiedAt: string;
    }
  | {
      readonly state: "partial";
      readonly ref: ContentRef;
      readonly partialPath: string;
      readonly receivedBytes: number;
    };

export type ContentByteSource =
  | AsyncIterable<Uint8Array | Buffer>
  | Iterable<Uint8Array | Buffer>
  | Uint8Array
  | Buffer;

const chunkToBuffer = (chunk: Uint8Array | Buffer): Buffer =>
  Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

async function* normalizeSource(
  source: ContentByteSource,
): AsyncGenerator<Buffer> {
  if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
    if (source.length > 0) yield chunkToBuffer(source);
    return;
  }
  if (
    typeof (source as AsyncIterable<unknown>)[Symbol.asyncIterator] ===
    "function"
  ) {
    for await (const item of source as AsyncIterable<Uint8Array | Buffer>) {
      const buf = chunkToBuffer(item);
      if (buf.length > 0) yield buf;
    }
    return;
  }
  for (const item of source as Iterable<Uint8Array | Buffer>) {
    const buf = chunkToBuffer(item);
    if (buf.length > 0) yield buf;
  }
};

const publishPartialAsObject = (
  root: string,
  ref: ContentRef,
  partialPath: string,
): {
  readonly path: string;
  readonly created: boolean;
  readonly verifiedAt: string;
} => {
  const observed = hashContentObjectFile(partialPath);
  if (
    observed.sha256 !== ref.sha256 ||
    observed.byteLength !== ref.byteLength
  ) {
    safeUnlinkOwnedFile(partialPath);
    throw new ContentStoreError(
      "corrupt",
      `content transfer digest mismatch: expected ${ref.sha256}/${ref.byteLength}, got ${observed.sha256}/${observed.byteLength}`,
    );
  }

  const objectPath = contentObjectPath(root, ref.sha256);
  const existing = lstatOrUndefined(objectPath);
  if (existing !== undefined) {
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new ContentStoreError(
        "symlink",
        `content object path is not a regular file: ${objectPath}`,
      );
    }
    const existingHash = hashContentObjectFile(objectPath);
    if (
      existingHash.sha256 !== ref.sha256 ||
      existingHash.byteLength !== ref.byteLength
    ) {
      throw new ContentStoreError(
        "corrupt",
        `existing content object does not match digest at ${objectPath}`,
      );
    }
    safeUnlinkOwnedFile(partialPath);
    return {
      path: objectPath,
      created: false,
      verifiedAt: new Date().toISOString(),
    };
  }

  const shardDir = dirname(objectPath);
  mkdirSync(shardDir, { recursive: true, mode: 0o700 });
  renameSync(partialPath, objectPath);
  try {
    chmodSync(objectPath, OBJECT_MODE);
  } catch {
    // best-effort
  }
  fsyncPath(dirname(objectPath), true);
  fsyncPath(contentIncomingDir(root), true);

  const published = lstatSync(objectPath);
  if (published.isSymbolicLink() || !published.isFile()) {
    throw new ContentStoreError(
      "symlink",
      `published content object is not a regular file: ${objectPath}`,
    );
  }
  if (published.size !== ref.byteLength) {
    throw new ContentStoreError(
      "corrupt",
      `published content size mismatch at ${objectPath}`,
    );
  }

  return {
    path: objectPath,
    created: true,
    verifiedAt: new Date().toISOString(),
  };
};

/**
 * Receive a transfer chunk stream into the digest-keyed partial, resume when
 * safe, and publish only after full digest + length verification.
 *
 * `expectedOffset` is the remote-declared resume offset and must equal the
 * local partial size (or 0 when absent).  The source supplies only the
 * remaining bytes.
 */
export const receiveContentTransfer = async (input: {
  readonly root?: string;
  readonly ref: ContentRef;
  readonly source: ContentByteSource;
  readonly expectedOffset?: number;
}): Promise<ContentReceiveResult> => {
  const root = input.root ?? contentStoreRoot();
  ensureContentLayout(root);
  const ref = input.ref;

  // Idempotent: already verified object → success without touching partial.
  const existing = statContentForTransfer(root, ref);
  if (existing.state === "verified") {
    return {
      state: "verified",
      ref,
      path: existing.path,
      created: false,
      verifiedAt: existing.verifiedAt,
    };
  }
  if (existing.state === "corrupt") {
    // Drop a corrupt partial so a clean retry can start.
    if ("partialPath" in existing === false) {
      const partialPath = contentPartialPath(
        root,
        contentTransferPartialId(ref.sha256),
      );
      safeUnlinkOwnedFile(partialPath);
    }
    throw new ContentStoreError("corrupt", existing.reason);
  }

  const partialPath = contentPartialPath(
    root,
    contentTransferPartialId(ref.sha256),
  );
  const partialInfo = lstatOrUndefined(partialPath);
  const currentBytes =
    partialInfo !== undefined &&
    !partialInfo.isSymbolicLink() &&
    partialInfo.isFile()
      ? partialInfo.size
      : 0;

  const expectedOffset = input.expectedOffset ?? currentBytes;
  if (expectedOffset !== currentBytes) {
    throw new ContentStoreError(
      "invalid",
      `content transfer resume offset mismatch: expected ${currentBytes}, got ${expectedOffset}`,
    );
  }
  if (currentBytes > ref.byteLength) {
    safeUnlinkOwnedFile(partialPath);
    throw new ContentStoreError(
      "corrupt",
      "content partial exceeds ContentRef byteLength",
    );
  }

  // Already have a full partial — finalize without more bytes.
  if (currentBytes === ref.byteLength && ref.byteLength >= 0) {
    if (ref.byteLength === 0 && currentBytes === 0 && partialInfo === undefined) {
      // Empty object with no partial yet: create empty then publish.
      const fd = openSync(partialPath, openCreateFlags, PARTIAL_MODE);
      try {
        fchmodSync(fd, PARTIAL_MODE);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    const published = publishPartialAsObject(root, ref, partialPath);
    return {
      state: "verified",
      ref,
      path: published.path,
      created: published.created,
      verifiedAt: published.verifiedAt,
    };
  }

  let fd: number | undefined;
  let receivedBytes = currentBytes;
  try {
    if (currentBytes === 0) {
      // Exclusive create so concurrent receivers fail closed.
      if (lstatOrUndefined(partialPath) !== undefined) {
        safeUnlinkOwnedFile(partialPath);
      }
      fd = openSync(partialPath, openCreateFlags, PARTIAL_MODE);
      fchmodSync(fd, PARTIAL_MODE);
    } else {
      fd = openSync(partialPath, openAppendFlags);
    }

    for await (const chunk of normalizeSource(input.source)) {
      const remaining = ref.byteLength - receivedBytes;
      if (remaining <= 0) {
        throw new ContentStoreError(
          "corrupt",
          "content transfer received more bytes than ContentRef byteLength",
        );
      }
      const toWrite =
        chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      let offset = 0;
      while (offset < toWrite.length) {
        const written = writeSync(fd, toWrite, offset, toWrite.length - offset);
        offset += written;
        receivedBytes += written;
      }
      if (chunk.length > remaining) {
        throw new ContentStoreError(
          "corrupt",
          "content transfer received more bytes than ContentRef byteLength",
        );
      }
    }

    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;

    if (receivedBytes < ref.byteLength) {
      // Interrupted or incomplete stream — keep partial for resume.
      return {
        state: "partial",
        ref,
        partialPath,
        receivedBytes,
      };
    }

    const published = publishPartialAsObject(root, ref, partialPath);
    return {
      state: "verified",
      ref,
      path: published.path,
      created: published.created,
      verifiedAt: published.verifiedAt,
    };
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
    if (error instanceof ContentStoreError) {
      if (error.code === "corrupt" || error.code === "invalid") {
        // Only wipe on verified corruption / contract breach, not transient IO.
        if (error.code === "corrupt") {
          safeUnlinkOwnedFile(partialPath);
        }
      }
      throw error;
    }
    // Leave partial for resume on transient IO failure.
    throw new ContentStoreError(
      "io",
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
};

/**
 * Stream object bytes from `offset` for an outbound transfer.  Fails closed
 * when the local object is not verified.
 */
export async function* sendContentTransfer(input: {
  readonly root?: string;
  readonly ref: Pick<ContentRef, "sha256" | "byteLength"> & {
    readonly mediaType?: string;
  };
  readonly offset?: number;
}): AsyncGenerator<Buffer> {
  const root = input.root ?? contentStoreRoot();
  const offset = input.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new ContentStoreError("invalid", "send offset is invalid");
  }
  const stat = statContentForTransfer(root, input.ref);
  if (stat.state !== "verified") {
    throw new ContentStoreError(
      stat.state === "missing" ? "missing" : "corrupt",
      stat.state === "missing"
        ? "content object is not available to send"
        : "content object is not verified for send",
    );
  }
  if (offset > input.ref.byteLength) {
    throw new ContentStoreError("invalid", "send offset exceeds byteLength");
  }
  if (offset === input.ref.byteLength) {
    return;
  }

  const stream = createReadStream(stat.path, {
    start: offset,
    highWaterMark: READ_CHUNK,
  });
  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (buf.length > 0) yield buf;
    }
  } catch (error) {
    throw new ContentStoreError(
      "io",
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
}

/** Helper-facing ref builder from identity + optional media type. */
export const contentRefForTransfer = (input: {
  readonly sha256: string;
  readonly byteLength: number;
  readonly mediaType?: string;
  readonly displayName?: string;
}): ContentRef => {
  if (!/^[a-f0-9]{64}$/u.test(input.sha256)) {
    throw new ContentStoreError("invalid", "sha256 must be lower-case hex");
  }
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 0) {
    throw new ContentStoreError("invalid", "byteLength must be a safe integer");
  }
  const mediaType = (input.mediaType ?? "application/octet-stream") as ContentMediaType;
  const ref: ContentRef = {
    sha256: input.sha256 as ContentSha256,
    byteLength: input.byteLength as ContentByteLength,
    mediaType,
  };
  if (input.displayName !== undefined) {
    return {
      ...ref,
      displayName: input.displayName as ContentRef["displayName"],
    };
  }
  return ref;
};

export type ContentHelperStatusLine =
  | {
      readonly ok: true;
      readonly state: "verified";
      readonly sha256: string;
      readonly byteLength: number;
      readonly verifiedAt: string;
      readonly created?: boolean;
    }
  | {
      readonly ok: true;
      readonly state: "partial";
      readonly sha256: string;
      readonly byteLength: number;
      readonly receivedBytes: number;
    }
  | {
      readonly ok: true;
      readonly state: "missing";
      readonly sha256: string;
      readonly byteLength: number;
      readonly reason: string;
    }
  | {
      readonly ok: true;
      readonly state: "corrupt";
      readonly sha256: string;
      readonly byteLength: number;
      readonly reason: string;
      readonly observedSha256?: string;
      readonly observedByteLength?: number;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

export const encodeContentHelperStatus = (
  status: ContentHelperStatusLine,
): string => `${JSON.stringify(status)}\n`;

export const parseContentHelperStatus = (
  text: string,
): ContentHelperStatusLine => {
  const line = text.trim();
  if (line.length === 0 || line.length > 4 * 1024) {
    return { ok: false, error: "content helper status line is invalid" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return { ok: false, error: "content helper status is not JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "content helper status is not an object" };
  }
  const row = parsed as Record<string, unknown>;
  if (row.ok === false && typeof row.error === "string") {
    return { ok: false, error: row.error.slice(0, 1024) };
  }
  if (row.ok !== true || typeof row.state !== "string") {
    return { ok: false, error: "content helper status is malformed" };
  }
  // Trust shape lightly — callers re-check identity against ContentRef.
  return parsed as ContentHelperStatusLine;
};

/** Availability view used only after verified publish (never before). */
export const transferResultAsAvailabilityReason = (
  result: ContentReceiveResult,
): ContentAvailabilityReason | undefined => {
  if (result.state === "verified") return undefined;
  return "content transfer incomplete; partial retained for resume" as ContentAvailabilityReason;
};

// Re-export types used by callers without pulling store internals.
export type { ContentTimestamp };
