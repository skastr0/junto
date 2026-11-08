/** Node-only local byte verification for Linux desktop release tooling. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  LINUX_DESKTOP_MAX_ARCHIVE_BYTES,
  LINUX_DESKTOP_MAX_METADATA_BYTES,
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

export const verifyLinuxDesktopArchiveBinding = async (input: {
  readonly archivePath: string;
  readonly version: string;
}): Promise<FileDigest> => {
  const archiveName = linuxDesktopArchiveName(input.version);
  if (path.basename(input.archivePath) !== archiveName) {
    throw new Error("release archive must use the canonical basename");
  }
  return fingerprintLinuxDesktopFile(input.archivePath);
};

export const verifyLinuxDesktopReleaseFiles = async (input: VerifyLinuxDesktopReleaseOptions & {
  readonly releasePath: string;
  readonly archivePath: string;
}): Promise<VerifiedLinuxDesktopRelease> => {
  const descriptor = verifyLinuxDesktopRelease(await readLinuxDesktopReleaseJson(input.releasePath), input);
  const archive = await verifyLinuxDesktopArchiveBinding({
    archivePath: input.archivePath,
    version: descriptor.version,
  });
  if (archive.bytes !== descriptor.archive.bytes || archive.sha256 !== descriptor.archive.sha256) {
    throw new Error("local release bytes differ from the signed descriptor");
  }
  return descriptor;
};
