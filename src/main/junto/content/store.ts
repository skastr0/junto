import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { dirname, relative, sep } from "node:path";
import type {
  ContentAvailability,
  ContentAvailabilityReason,
  ContentByteLength,
  ContentLocalPathProjection,
  ContentMediaType,
  ContentRef,
  ContentSha256,
  ContentTimestamp,
} from "@shared/content";
import {
  contentDigestRoot,
  contentIncomingDir,
  contentObjectPath,
  contentPartialPath,
  contentStoreRoot,
} from "./paths";

const DIR_MODE = 0o700;
const PARTIAL_MODE = 0o600;
const OBJECT_MODE = 0o444;
const READ_CHUNK = 64 * 1024;

const openWriteFlags =
  constants.O_CREAT |
  constants.O_EXCL |
  constants.O_WRONLY |
  (constants.O_NOFOLLOW ?? 0);

const openReadFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

const openDirFlags =
  constants.O_RDONLY |
  (constants.O_DIRECTORY ?? 0) |
  (constants.O_NOFOLLOW ?? 0);

export type ContentByteSource =
  | AsyncIterable<Uint8Array | Buffer | string>
  | Iterable<Uint8Array | Buffer | string>
  | Uint8Array
  | Buffer
  | string;

export type ContentIngestInput = {
  readonly root?: string;
  readonly source: ContentByteSource;
  /** Optional expected identity; mismatch fails closed as corrupt. */
  readonly expected?: Pick<ContentRef, "sha256" | "byteLength">;
  readonly mediaType: ContentMediaType | string;
  readonly displayName?: string;
  /** Test hook for deterministic partial names. */
  readonly ingestId?: string;
};

export type ContentIngestResult = {
  readonly ref: ContentRef;
  readonly path: string;
  readonly created: boolean;
  readonly verifiedAt: string;
};

export class ContentStoreError extends Error {
  readonly code:
    | "layout"
    | "symlink"
    | "corrupt"
    | "missing"
    | "io"
    | "invalid"
    /** Retryable: free disk below reserve after accounting for the write. */
    | "disk-low";

  constructor(
    code: ContentStoreError["code"],
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(
      message,
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = "ContentStoreError";
    this.code = code;
  }
}

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

/**
 * Create `path` as a real (non-symlink) directory. Parent path components
 * outside the content store may legitimately be symlinks (e.g. macOS `/var` →
 * `/private/var`); we only refuse a symlink *at the leaf we own*.
 */
const assertRealDirectory = (path: string): void => {
  mkdirSync(path, { recursive: true, mode: DIR_MODE });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new ContentStoreError(
      "symlink",
      `content path is not a real directory: ${path}`,
    );
  }
  try {
    chmodSync(path, DIR_MODE);
  } catch {
    // Platform may ignore mode bits.
  }
};

/** True when `candidate` resolves inside `root` (both real paths). */
const isInsideRoot = (root: string, candidate: string): boolean => {
  const realRoot = realpathSync(root);
  const realCandidate = realpathSync(candidate);
  const rel = relative(realRoot, realCandidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(".."));
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

const chunkToBuffer = (chunk: Uint8Array | Buffer | string): Buffer => {
  if (typeof chunk === "string") return Buffer.from(chunk, "utf8");
  if (Buffer.isBuffer(chunk)) return chunk;
  return Buffer.from(chunk);
};

async function* normalizeSource(
  source: ContentByteSource,
): AsyncGenerator<Buffer> {
  if (
    typeof source === "string" ||
    Buffer.isBuffer(source) ||
    source instanceof Uint8Array
  ) {
    yield chunkToBuffer(source);
    return;
  }

  const candidate = source as
    | AsyncIterable<Uint8Array | Buffer | string>
    | Iterable<Uint8Array | Buffer | string>;

  if (
    typeof (candidate as AsyncIterable<unknown>)[Symbol.asyncIterator] ===
    "function"
  ) {
    for await (const item of candidate as AsyncIterable<
      Uint8Array | Buffer | string
    >) {
      yield chunkToBuffer(item);
    }
    return;
  }

  for (const item of candidate as Iterable<Uint8Array | Buffer | string>) {
    yield chunkToBuffer(item);
  }
}

const decodeRef = (input: {
  readonly sha256: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly displayName?: string;
}): ContentRef => {
  if (!/^[a-f0-9]{64}$/u.test(input.sha256)) {
    throw new ContentStoreError("invalid", "sha256 must be lower-case hex");
  }
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 0) {
    throw new ContentStoreError("invalid", "byteLength must be a safe integer");
  }
  if (input.mediaType.length === 0 || input.mediaType.length > 255) {
    throw new ContentStoreError("invalid", "mediaType length out of range");
  }
  const ref: ContentRef = {
    sha256: input.sha256 as ContentSha256,
    byteLength: input.byteLength as ContentByteLength,
    mediaType: input.mediaType as ContentMediaType,
  };
  if (input.displayName !== undefined) {
    return {
      ...ref,
      displayName: input.displayName as ContentRef["displayName"],
    };
  }
  return ref;
};

/**
 * Ensure the versioned content layout exists with safe directory permissions
 * and no symlink substitution on the roots we own.
 */
export const ensureContentLayout = (root: string): void => {
  assertRealDirectory(root);
  assertRealDirectory(contentIncomingDir(root));
  // Algorithm root must be a real directory — never a symlink into attacker space.
  assertRealDirectory(contentDigestRoot(root));
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

/** Stream-hash a regular file without loading it entirely into memory. */
export const hashContentObjectFile = (
  path: string,
): { readonly sha256: string; readonly byteLength: number } => {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new ContentStoreError(
      "symlink",
      `content object is not a regular file: ${path}`,
    );
  }
  const hash = createHash("sha256");
  let byteLength = 0;
  const fd = openSync(path, openReadFlags);
  try {
    const buffer = Buffer.alloc(READ_CHUNK);
    while (true) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (n === 0) break;
      hash.update(buffer.subarray(0, n));
      byteLength += n;
    }
  } finally {
    closeSync(fd);
  }
  return { sha256: hash.digest("hex"), byteLength };
};

/**
 * Stream bytes into a private partial file, hash and size while writing,
 * fsync, verify, and atomically publish under the content-addressed path.
 *
 * Ordering: the object file is durable on disk before this returns. Callers
 * must record SQLite object/ref rows only after a successful return.
 */
export const ingestContentBytes = async (
  input: ContentIngestInput,
): Promise<ContentIngestResult> => {
  const root = input.root ?? contentStoreRoot();
  ensureContentLayout(root);

  const ingestId = input.ingestId ?? randomBytes(16).toString("hex");
  const partial = contentPartialPath(root, ingestId);
  if (lstatOrUndefined(partial) !== undefined) {
    throw new ContentStoreError(
      "io",
      `content partial already exists: ${partial}`,
    );
  }

  const hash = createHash("sha256");
  let byteLength = 0;
  let fd: number | undefined;

  try {
    fd = openSync(partial, openWriteFlags, PARTIAL_MODE);
    fchmodSync(fd, PARTIAL_MODE);

    for await (const chunk of normalizeSource(input.source)) {
      if (chunk.length === 0) continue;
      hash.update(chunk);
      byteLength += chunk.length;
      if (!Number.isSafeInteger(byteLength)) {
        throw new ContentStoreError(
          "invalid",
          "content exceeded safe integer length",
        );
      }
      let offset = 0;
      while (offset < chunk.length) {
        const written = writeSync(fd, chunk, offset, chunk.length - offset);
        offset += written;
      }
    }

    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;

    const sha256 = hash.digest("hex");
    if (input.expected !== undefined) {
      if (
        input.expected.sha256 !== sha256 ||
        input.expected.byteLength !== byteLength
      ) {
        throw new ContentStoreError(
          "corrupt",
          `content digest mismatch: expected ${input.expected.sha256}/${input.expected.byteLength}, got ${sha256}/${byteLength}`,
        );
      }
    }

    const ref = decodeRef({
      sha256,
      byteLength,
      mediaType: input.mediaType,
      displayName: input.displayName,
    });
    const objectPath = contentObjectPath(root, sha256);
    const verifiedAt = new Date().toISOString();

    const existing = lstatOrUndefined(objectPath);
    if (existing !== undefined) {
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new ContentStoreError(
          "symlink",
          `content object path is not a regular file: ${objectPath}`,
        );
      }
      const observed = hashContentObjectFile(objectPath);
      if (observed.sha256 !== sha256 || observed.byteLength !== byteLength) {
        throw new ContentStoreError(
          "corrupt",
          `existing content object does not match digest at ${objectPath}`,
        );
      }
      safeUnlinkOwnedFile(partial);
      return { ref, path: objectPath, created: false, verifiedAt };
    }

    const digestRoot = contentDigestRoot(root);
    assertRealDirectory(digestRoot);
    const shardDir = dirname(objectPath);
    assertRealDirectory(shardDir);
    if (!isInsideRoot(digestRoot, shardDir)) {
      throw new ContentStoreError(
        "symlink",
        `content object shard escaped the digest root: ${shardDir}`,
      );
    }
    // Publish: rename is atomic on the same filesystem. Partial was fsynced.
    renameSync(partial, objectPath);
    if (!isInsideRoot(digestRoot, objectPath)) {
      // Extremely defensive: if rename landed outside, refuse to keep it.
      safeUnlinkOwnedFile(objectPath);
      throw new ContentStoreError(
        "symlink",
        `published content object escaped the digest root: ${objectPath}`,
      );
    }
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
    if (published.size !== byteLength) {
      throw new ContentStoreError(
        "corrupt",
        `published content size mismatch at ${objectPath}`,
      );
    }

    return { ref, path: objectPath, created: true, verifiedAt };
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
    safeUnlinkOwnedFile(partial);
    if (error instanceof ContentStoreError) throw error;
    throw new ContentStoreError(
      "io",
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
};

/** Resolve a local path projection only when the object file is present. */
export const projectContentLocalPath = (
  root: string,
  ref: ContentRef,
): ContentLocalPathProjection | ContentAvailability => {
  const path = contentObjectPath(root, ref.sha256);
  const info = lstatOrUndefined(path);
  if (info === undefined) {
    return {
      ref,
      state: "missing",
      reason: "content object file is absent" as ContentAvailabilityReason,
    };
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    return {
      ref,
      state: "corrupt",
      reason: "content object path is not a regular file" as ContentAvailabilityReason,
    };
  }
  if (info.size !== ref.byteLength) {
    return {
      ref,
      state: "corrupt",
      reason: "content object size does not match ContentRef" as ContentAvailabilityReason,
      observedByteLength: info.size as ContentByteLength,
    };
  }
  return {
    kind: "local-path",
    ref,
    path,
  };
};

/**
 * Fully re-hash an object and compare to the ref. Used after restart and for
 * recovery when SQLite says the object exists.
 */
export const verifyContentObjectFile = (
  root: string,
  ref: ContentRef,
  verifiedAt: string = new Date().toISOString(),
): ContentAvailability => {
  const path = contentObjectPath(root, ref.sha256);
  const info = lstatOrUndefined(path);
  if (info === undefined) {
    return {
      ref,
      state: "missing",
      reason: "content object file is absent" as ContentAvailabilityReason,
    };
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    return {
      ref,
      state: "corrupt",
      reason: "content object path is not a regular file" as ContentAvailabilityReason,
    };
  }
  try {
    const observed = hashContentObjectFile(path);
    if (
      observed.sha256 !== ref.sha256 ||
      observed.byteLength !== ref.byteLength
    ) {
      return {
        ref,
        state: "corrupt",
        reason: "content object digest or length mismatch" as ContentAvailabilityReason,
        observedSha256: observed.sha256 as ContentSha256,
        observedByteLength: observed.byteLength as ContentByteLength,
      };
    }
    return {
      ref,
      state: "verified",
      verifiedSha256: observed.sha256 as ContentSha256,
      verifiedByteLength: observed.byteLength as ContentByteLength,
      verifiedAt: verifiedAt as ContentTimestamp,
    };
  } catch (error) {
    return {
      ref,
      state: "unavailable",
      reason: (error instanceof Error
        ? error.message.slice(0, 1024)
        : "content object could not be verified") as ContentAvailabilityReason,
    };
  }
};
