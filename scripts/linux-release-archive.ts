import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGunzip } from "node:zlib";

const TAR_BLOCK_BYTES = 512;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_ARCHIVE_FILE = /^[^/\\\u0000-\u001f\u007f]+$/u;

export interface LinuxReleaseArchiveExpectedFile {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface InspectedLinuxReleaseArchive {
  readonly archiveBytes: number;
  readonly archiveSha256: string;
  /** Private immutable snapshot that publication must upload. */
  readonly verifiedArchivePath: string;
  readonly extractedDirectory: string;
  readonly cleanup: () => Promise<void>;
}

const isZeroBlock = (block: Buffer): boolean => {
  for (const byte of block) {
    if (byte !== 0) return false;
  }
  return true;
};

const decodeTarString = (field: Buffer, label: string): string => {
  const nul = field.indexOf(0);
  const bytes = nul < 0 ? field : field.subarray(0, nul);
  if (bytes.some((byte) => byte > 0x7f)) {
    throw new Error(`Linux release archive has non-ASCII ${label}`);
  }
  return bytes.toString("ascii");
};

const decodeTarOctal = (field: Buffer, label: string): number => {
  if ((field[0] ?? 0) >= 0x80) {
    throw new Error(`Linux release archive uses unsupported ${label} encoding`);
  }
  const value = decodeTarString(field, label).trim();
  if (!/^[0-7]+$/u.test(value)) {
    throw new Error(`Linux release archive has malformed ${label}`);
  }
  const decoded = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(decoded) || decoded < 0) {
    throw new Error(`Linux release archive has invalid ${label}`);
  }
  return decoded;
};

const requireValidHeaderChecksum = (header: Buffer): void => {
  const expected = decodeTarOctal(
    header.subarray(148, 156),
    "header checksum",
  );
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
  }
  if (actual !== expected) {
    throw new Error("Linux release archive header checksum mismatch");
  }
};

const normalizeArchivePath = (raw: string): string => {
  if (raw.startsWith("/")) {
    throw new Error("Linux release archive contains an unsafe absolute path");
  }
  let normalized = raw;
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  if (normalized === "") return ".";
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.includes("/") ||
    !SAFE_ARCHIVE_FILE.test(normalized)
  ) {
    throw new Error("Linux release archive contains an unsafe nested path");
  }
  return normalized;
};

const expectedFileMap = (
  files: ReadonlyArray<LinuxReleaseArchiveExpectedFile>,
): ReadonlyMap<string, LinuxReleaseArchiveExpectedFile> => {
  const expected = new Map<string, LinuxReleaseArchiveExpectedFile>();
  for (const entry of files) {
    if (
      normalizeArchivePath(entry.file) !== entry.file ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      !SHA256.test(entry.sha256) ||
      expected.has(entry.file)
    ) {
      throw new Error("Linux release archive expected inventory is malformed");
    }
    expected.set(entry.file, entry);
  }
  if (expected.size === 0) {
    throw new Error("Linux release archive expected inventory is empty");
  }
  return expected;
};

interface CurrentFile {
  readonly name: string;
  readonly expected: LinuxReleaseArchiveExpectedFile;
  readonly handle: FileHandle;
  readonly digest: ReturnType<typeof createHash>;
  readonly declaredBytes: number;
  remainingBytes: number;
  writtenBytes: number;
}

class FlatUstarExtractor {
  readonly #directory: string;
  readonly #expected: ReadonlyMap<string, LinuxReleaseArchiveExpectedFile>;
  readonly #seen = new Set<string>();
  readonly #header = Buffer.alloc(TAR_BLOCK_BYTES);
  #headerOffset = 0;
  #current: CurrentFile | undefined;
  #paddingBytes = 0;
  #zeroBlocks = 0;
  #rootDirectorySeen = false;

  constructor(
    directory: string,
    expected: ReadonlyMap<string, LinuxReleaseArchiveExpectedFile>,
  ) {
    this.#directory = directory;
    this.#expected = expected;
  }

  async push(chunk: Buffer): Promise<void> {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.#current !== undefined) {
        const length = Math.min(
          this.#current.remainingBytes,
          chunk.length - offset,
        );
        if (length > 0) {
          const body = chunk.subarray(offset, offset + length);
          const write = await this.#current.handle.write(body);
          if (write.bytesWritten !== body.length) {
            throw new Error("Linux release archive extraction write was short");
          }
          this.#current.digest.update(body);
          this.#current.writtenBytes += body.length;
          this.#current.remainingBytes -= body.length;
          offset += body.length;
        }
        if (this.#current.remainingBytes === 0) {
          await this.#finishCurrent();
        }
        continue;
      }

      if (this.#paddingBytes > 0) {
        const length = Math.min(this.#paddingBytes, chunk.length - offset);
        const padding = chunk.subarray(offset, offset + length);
        if (!isZeroBlock(padding)) {
          throw new Error("Linux release archive has non-zero file padding");
        }
        this.#paddingBytes -= length;
        offset += length;
        continue;
      }

      const length = Math.min(
        TAR_BLOCK_BYTES - this.#headerOffset,
        chunk.length - offset,
      );
      chunk.copy(
        this.#header,
        this.#headerOffset,
        offset,
        offset + length,
      );
      this.#headerOffset += length;
      offset += length;
      if (this.#headerOffset === TAR_BLOCK_BYTES) {
        const header = Buffer.from(this.#header);
        this.#header.fill(0);
        this.#headerOffset = 0;
        await this.#startEntry(header);
      }
    }
  }

  async finish(): Promise<void> {
    if (
      this.#current !== undefined ||
      this.#paddingBytes !== 0 ||
      this.#headerOffset !== 0
    ) {
      throw new Error("Linux release archive ended inside an entry");
    }
    if (this.#zeroBlocks < 2) {
      throw new Error("Linux release archive lacks its end marker");
    }
    const missing = [...this.#expected.keys()].filter(
      (file) => !this.#seen.has(file),
    );
    if (missing.length > 0) {
      throw new Error(
        `Linux release archive is missing expected file: ${missing[0]}`,
      );
    }
  }

  async abort(): Promise<void> {
    const current = this.#current;
    this.#current = undefined;
    if (current !== undefined) {
      await current.handle.close().catch(() => undefined);
    }
  }

  async #startEntry(header: Buffer): Promise<void> {
    if (isZeroBlock(header)) {
      this.#zeroBlocks += 1;
      return;
    }
    if (this.#zeroBlocks > 0) {
      throw new Error("Linux release archive has data after its end marker");
    }
    requireValidHeaderChecksum(header);
    const magic = decodeTarString(
      header.subarray(257, 263),
      "format magic",
    );
    if (magic !== "ustar") {
      throw new Error("Linux release archive must use flat ustar format");
    }
    const name = decodeTarString(header.subarray(0, 100), "entry path");
    const prefix = decodeTarString(header.subarray(345, 500), "entry prefix");
    const rawPath = prefix === "" ? name : `${prefix}/${name}`;
    const normalized = normalizeArchivePath(rawPath);
    const size = decodeTarOctal(header.subarray(124, 136), "entry size");
    const typeByte = header[156] ?? 0;
    const type = typeByte === 0 ? "0" : String.fromCharCode(typeByte);

    if (type === "5") {
      if (
        normalized !== "." ||
        size !== 0 ||
        this.#rootDirectorySeen
      ) {
        throw new Error(
          "Linux release archive contains an unsupported directory entry",
        );
      }
      this.#rootDirectorySeen = true;
      return;
    }
    if (type !== "0") {
      throw new Error(
        `Linux release archive contains an unsupported entry type: ${type}`,
      );
    }
    if (normalized === ".") {
      throw new Error("Linux release archive contains an unsafe file path");
    }
    const expected = this.#expected.get(normalized);
    if (expected === undefined) {
      throw new Error(
        `Linux release archive contains unexpected file: ${normalized}`,
      );
    }
    if (this.#seen.has(normalized)) {
      throw new Error(
        `Linux release archive contains duplicate file: ${normalized}`,
      );
    }
    if (size !== expected.bytes) {
      throw new Error(
        `Linux release archive file byte count differs: ${normalized}`,
      );
    }
    const noFollow = "O_NOFOLLOW" in fsConstants
      ? fsConstants.O_NOFOLLOW
      : 0;
    const handle = await open(
      path.join(this.#directory, normalized),
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        noFollow,
      0o600,
    );
    this.#current = {
      name: normalized,
      expected,
      handle,
      digest: createHash("sha256"),
      declaredBytes: size,
      remainingBytes: size,
      writtenBytes: 0,
    };
    if (size === 0) await this.#finishCurrent();
  }

  async #finishCurrent(): Promise<void> {
    const current = this.#current;
    if (current === undefined) return;
    this.#current = undefined;
    try {
      await current.handle.chmod(0o400);
    } finally {
      await current.handle.close();
    }
    if (
      current.writtenBytes !== current.declaredBytes ||
      current.digest.digest("hex") !== current.expected.sha256
    ) {
      throw new Error(
        `Linux release archive file digest differs: ${current.name}`,
      );
    }
    this.#seen.add(current.name);
    this.#paddingBytes =
      (TAR_BLOCK_BYTES - (current.declaredBytes % TAR_BLOCK_BYTES)) %
      TAR_BLOCK_BYTES;
  }
}

export const inspectLinuxReleaseArchive = async (input: {
  readonly archivePath: string;
  readonly expectedFiles: ReadonlyArray<LinuxReleaseArchiveExpectedFile>;
}): Promise<InspectedLinuxReleaseArchive> => {
  const archivePath = path.resolve(input.archivePath);
  const expected = expectedFileMap(input.expectedFiles);
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "vellum-linux-release-archive-"),
  );
  const extractedDirectory = path.join(temporaryRoot, "bundle");
  const verifiedArchivePath = path.join(
    temporaryRoot,
    path.basename(archivePath),
  );
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await chmod(temporaryRoot, 0o700).catch(() => undefined);
    await chmod(extractedDirectory, 0o700).catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  };
  const noFollow = "O_NOFOLLOW" in fsConstants
    ? fsConstants.O_NOFOLLOW
    : 0;
  let archiveBytes = 0;
  const archiveDigest = createHash("sha256");
  let sourceHandle: FileHandle | undefined;
  let snapshotHandle: FileHandle | undefined;
  try {
    try {
      sourceHandle = await open(
        archivePath,
        fsConstants.O_RDONLY | noFollow,
      );
    } catch (cause) {
      throw new Error("Linux release archive is not a regular file", {
        cause,
      });
    }
    const initial = await sourceHandle.stat();
    if (!initial.isFile()) {
      throw new Error("Linux release archive is not a regular file");
    }
    if (!Number.isSafeInteger(initial.size) || initial.size < 1) {
      throw new Error("Linux release archive is empty or too large");
    }
    snapshotHandle = await open(
      verifiedArchivePath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        noFollow,
      0o600,
    );
    for await (const chunk of sourceHandle.createReadStream({
      autoClose: false,
    })) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      archiveDigest.update(bytes);
      archiveBytes += bytes.length;
      let offset = 0;
      while (offset < bytes.length) {
        const write = await snapshotHandle.write(
          bytes,
          offset,
          bytes.length - offset,
        );
        if (write.bytesWritten < 1) {
          throw new Error(
            "Linux release archive snapshot write was short",
          );
        }
        offset += write.bytesWritten;
      }
    }
    const [finalSource, snapshot] = await Promise.all([
      sourceHandle.stat(),
      snapshotHandle.stat(),
    ]);
    if (
      archiveBytes !== initial.size ||
      finalSource.size !== initial.size ||
      finalSource.mtimeMs !== initial.mtimeMs ||
      snapshot.size !== archiveBytes
    ) {
      throw new Error("Linux release archive changed while being snapshotted");
    }
    await snapshotHandle.sync();
    await snapshotHandle.close();
    snapshotHandle = undefined;
    await sourceHandle.close();
    sourceHandle = undefined;

    await mkdir(extractedDirectory, { mode: 0o700 });
    const extractor = new FlatUstarExtractor(extractedDirectory, expected);
    const source = (await open(
      verifiedArchivePath,
      fsConstants.O_RDONLY | noFollow,
    )).createReadStream();
    const gunzip = createGunzip();
    const snapshotDigest = createHash("sha256");
    let snapshotBytes = 0;
    source.on("data", (chunk: Buffer) => {
      snapshotDigest.update(chunk);
      snapshotBytes += chunk.length;
    });
    source.on("error", (error) => gunzip.destroy(error));
    source.pipe(gunzip);
    try {
      for await (const chunk of gunzip) {
        await extractor.push(
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
        );
      }
      await extractor.finish();
    } catch (error) {
      await extractor.abort();
      throw error;
    } finally {
      source.destroy();
      gunzip.destroy();
    }

    const archiveSha256 = archiveDigest.digest("hex");
    if (
      snapshotBytes !== archiveBytes ||
      snapshotDigest.digest("hex") !== archiveSha256
    ) {
      throw new Error("Linux release archive snapshot digest differs");
    }
    await chmod(verifiedArchivePath, 0o400);
    await chmod(extractedDirectory, 0o500);
    await chmod(temporaryRoot, 0o500);

    return {
      archiveBytes,
      archiveSha256,
      verifiedArchivePath,
      extractedDirectory,
      cleanup,
    };
  } catch (error) {
    await snapshotHandle?.close().catch(() => undefined);
    await sourceHandle?.close().catch(() => undefined);
    await cleanup();
    throw error;
  }
};
