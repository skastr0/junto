/** Node-only local byte verification for Linux desktop release tooling. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  LINUX_DESKTOP_MAX_ARCHIVE_BYTES,
  LINUX_DESKTOP_MAX_METADATA_BYTES,
  LINUX_DESKTOP_MAX_SOURCE_INDEX_BYTES,
  linuxDesktopArchiveName,
} from "./linux-desktop-release";
import {
  verifyLinuxDesktopRelease,
  type VerifiedLinuxDesktopRelease,
  type VerifyLinuxDesktopReleaseOptions,
} from "./linux-desktop-release-crypto";

interface FileDigest {
  readonly bytes: number;
  readonly sha256: string;
}

const withRegularFile = async <A>(
  inputPath: string,
  label: string,
  maximumBytes: number,
  read: (handle: FileHandle, bytes: number) => Promise<A>,
): Promise<A> => {
  const initial = await lstat(inputPath);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.size < 1) {
    throw new Error(`${label} must be a nonempty regular file`);
  }
  const handle = await open(inputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== initial.dev || before.ino !== initial.ino || before.size < 1) {
      throw new Error(`${label} changed before it could be read`);
    }
    if (before.size > maximumBytes) throw new Error(`${label} exceeds its size limit`);
    const result = await read(handle, before.size);
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error(`${label} changed while it was being read`);
    }
    return result;
  } finally {
    await handle.close();
  }
};

const readJsonDigest = async (inputPath: string, label: string, maximumBytes: number): Promise<FileDigest & {
  readonly value: unknown;
}> => withRegularFile(inputPath, label, maximumBytes, async (handle, size) => {
  // Allocate only the admitted size; a concurrent append cannot enlarge this read.
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const result = await handle.read(bytes, offset, size - offset, offset);
    if (result.bytesRead === 0) throw new Error(`${label} changed while it was being read`);
    offset += result.bytesRead;
  }
  try {
    return {
      value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
      bytes: size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch {
    throw new Error(`${label} is not valid UTF-8 JSON`);
  }
});

export const readLinuxDesktopReleaseJson = async (inputPath: string): Promise<unknown> =>
  (await readJsonDigest(inputPath, "release metadata", LINUX_DESKTOP_MAX_METADATA_BYTES)).value;

export const fingerprintLinuxDesktopFile = async (inputPath: string): Promise<FileDigest> =>
  withRegularFile(inputPath, "release input", LINUX_DESKTOP_MAX_ARCHIVE_BYTES, async (handle, bytes) => {
    const hash = createHash("sha256");
    let observedBytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0, end: bytes - 1 })) {
      hash.update(chunk);
      observedBytes += Buffer.byteLength(chunk);
    }
    if (observedBytes !== bytes) throw new Error("release input changed while being hashed");
    return { bytes, sha256: hash.digest("hex") };
  });

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid source index object");
  return value as Record<string, unknown>;
};
const decodeSourceEntry = (value: unknown): FileDigest & { readonly file: string } => {
  const entry = record(value);
  if (typeof entry.file !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.file) ||
      !Number.isSafeInteger(entry.bytes) || Number(entry.bytes) < 1 ||
      typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
    throw new Error("invalid source index file");
  }
  return { file: entry.file, bytes: Number(entry.bytes), sha256: entry.sha256 };
};

/** Binds the index and archive only; complete source-material closure is a publisher gate. */
export const verifyLinuxDesktopSourceBinding = async (input: {
  readonly archivePath: string;
  readonly sourceIndexPath: string;
  readonly version: string;
  readonly sourceRevision: string;
}): Promise<{ readonly archive: FileDigest; readonly sources: FileDigest }> => {
  const archiveName = linuxDesktopArchiveName(input.version);
  if (path.basename(input.archivePath) !== archiveName || path.basename(input.sourceIndexPath) !== "sources.json") {
    throw new Error("release inputs must use the canonical archive and sources.json basenames");
  }
  const [archive, source] = await Promise.all([
    fingerprintLinuxDesktopFile(input.archivePath),
    readJsonDigest(input.sourceIndexPath, "source index", LINUX_DESKTOP_MAX_SOURCE_INDEX_BYTES),
  ]);
  const index = record(source.value);
  if (index.schema !== "vellum-command/release-sources/v1" || index.product !== "Junto" ||
      index.access !== "same-download-location" || !Array.isArray(index.files) || !Array.isArray(index.binaries)) {
    throw new Error("invalid release source index");
  }
  if (index.version !== input.version || index.sourceCommit !== input.sourceRevision) {
    throw new Error("source index version or source commit does not match the desktop release");
  }
  const files = index.files.map(decodeSourceEntry);
  const binaries = index.binaries.map(decodeSourceEntry);
  if (new Set(files.map((entry) => entry.file)).size !== files.length ||
      new Set(binaries.map((entry) => entry.file)).size !== binaries.length) {
    throw new Error("duplicate source index file");
  }
  const binary = binaries[0];
  if (binaries.length !== 1 || binary === undefined || binary.file !== archiveName ||
      binary.bytes !== archive.bytes || binary.sha256 !== archive.sha256) {
    throw new Error("source index does not bind the exact desktop archive bytes");
  }
  return { archive, sources: { bytes: source.bytes, sha256: source.sha256 } };
};

export const verifyLinuxDesktopReleaseFiles = async (input: VerifyLinuxDesktopReleaseOptions & {
  readonly releasePath: string;
  readonly archivePath: string;
  readonly sourceIndexPath: string;
}): Promise<VerifiedLinuxDesktopRelease> => {
  const descriptor = verifyLinuxDesktopRelease(await readLinuxDesktopReleaseJson(input.releasePath), input);
  const files = await verifyLinuxDesktopSourceBinding({
    archivePath: input.archivePath,
    sourceIndexPath: input.sourceIndexPath,
    version: descriptor.version,
    sourceRevision: descriptor.sourceRevision,
  });
  if (files.archive.bytes !== descriptor.archive.bytes || files.archive.sha256 !== descriptor.archive.sha256 ||
      files.sources.bytes !== descriptor.sources.bytes || files.sources.sha256 !== descriptor.sources.sha256) {
    throw new Error("local release bytes differ from the signed descriptor");
  }
  return descriptor;
};
