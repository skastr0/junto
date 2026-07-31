import { createHash } from "node:crypto";
import { constants as fsConstants, createWriteStream } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isDeepStrictEqual } from "node:util";
import { createGunzip, createGzip } from "node:zlib";
import {
  LINUX_RELEASE_CHECKSUMS,
  LINUX_RELEASE_MANIFEST,
  LINUX_RELEASE_SIGNATURE,
  LINUX_RELEASE_TARGET,
  linuxUserlandRuntimeArchiveName,
  type LinuxReleaseVerificationReceipt,
} from "./linux-release-bundle";

const TAR_BLOCK_BYTES = 512;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_ARCHIVE_FILE = /^[\u0020-\u002e\u0030-\u005b\u005d-\u007e]+$/u;
const RELEASE_VERSION =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const MAX_VERIFICATION_RECEIPT_BYTES = 1024 * 1024;
const REQUIRED_METADATA_FILES = Object.freeze([
  LINUX_RELEASE_CHECKSUMS,
  LINUX_RELEASE_MANIFEST,
  LINUX_RELEASE_SIGNATURE,
]);

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

export interface CreatedLinuxReleaseArchive {
  readonly schema: "vellum/linux-release-archive-receipt/v1";
  readonly ok: true;
  readonly version: string;
  readonly archiveFile: string;
  readonly archiveBytes: number;
  readonly archiveSha256: string;
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
      if (this.#zeroBlocks >= 2) {
        throw new Error(
          "Linux release archive has data after its end marker",
        );
      }
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
  readonly temporaryParent?: string;
}): Promise<InspectedLinuxReleaseArchive> => {
  const archivePath = path.resolve(input.archivePath);
  const expected = expectedFileMap(input.expectedFiles);
  const temporaryRoot = await mkdtemp(
    path.join(
      input.temporaryParent === undefined
        ? tmpdir()
        : path.resolve(input.temporaryParent),
      "vellum-linux-release-archive-",
    ),
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

const putTarString = (
  header: Buffer,
  offset: number,
  length: number,
  value: string,
): void => {
  const bytes = Buffer.from(value, "ascii");
  if (bytes.length > length) {
    throw new Error("Linux release archive field exceeds ustar limits");
  }
  bytes.copy(header, offset);
};

const putTarOctal = (
  header: Buffer,
  offset: number,
  length: number,
  value: number,
): void => {
  const encoded = value.toString(8);
  if (encoded.length > length - 1) {
    throw new Error("Linux release archive value exceeds ustar limits");
  }
  putTarString(
    header,
    offset,
    length,
    `${encoded.padStart(length - 1, "0")}\0`,
  );
};

const fileHeader = (entry: LinuxReleaseArchiveExpectedFile): Buffer => {
  const header = Buffer.alloc(TAR_BLOCK_BYTES);
  putTarString(header, 0, 100, entry.file);
  putTarOctal(
    header,
    100,
    8,
    entry.file === "vellum-linux-verify-x64" ? 0o755 : 0o644,
  );
  putTarOctal(header, 108, 8, 0);
  putTarOctal(header, 116, 8, 0);
  putTarOctal(header, 124, 12, entry.bytes);
  putTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  putTarString(header, 156, 1, "0");
  putTarString(header, 257, 6, "ustar\0");
  putTarString(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  putTarString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
};

const assertExactBundleInventory = async (
  bundleDirectory: string,
  expected: ReadonlyMap<string, LinuxReleaseArchiveExpectedFile>,
): Promise<void> => {
  const directory = await lstat(bundleDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error("Linux release bundle is not a real directory");
  }
  const entries = await readdir(bundleDirectory, { withFileTypes: true });
  const names = entries.map(({ name }) => name).sort();
  const expectedNames = [...expected.keys()].sort();
  if (
    names.length !== expectedNames.length ||
    names.some((name, index) => name !== expectedNames[index]) ||
    entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())
  ) {
    throw new Error(
      "Linux release bundle inventory differs from independent verification",
    );
  }
};

const readVerificationReceipt = async (
  receiptPath: string,
): Promise<LinuxReleaseVerificationReceipt> => {
  const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path.resolve(receiptPath),
      fsConstants.O_RDONLY | noFollow,
    );
    const initial = await handle.stat();
    if (
      !initial.isFile() ||
      initial.size < 1 ||
      initial.size > MAX_VERIFICATION_RECEIPT_BYTES
    ) {
      throw new Error("Linux verification receipt is not a bounded file");
    }
    const bytes = await handle.readFile();
    const final = await handle.stat();
    if (
      bytes.length !== initial.size ||
      final.size !== initial.size ||
      final.mtimeMs !== initial.mtimeMs
    ) {
      throw new Error("Linux verification receipt changed while being read");
    }
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Linux verification receipt is malformed");
    }
    const receipt = value as Partial<LinuxReleaseVerificationReceipt>;
    if (
      receipt.schema !== "vellum/linux-release-verification-receipt/v1" ||
      receipt.ok !== true ||
      typeof receipt.version !== "string" ||
      !RELEASE_VERSION.test(receipt.version) ||
      typeof receipt.sourceRevision !== "string" ||
      receipt.sourceRevision.length === 0 ||
      !isDeepStrictEqual(receipt.target, LINUX_RELEASE_TARGET) ||
      typeof receipt.keyId !== "string" ||
      receipt.keyId.length === 0 ||
      !Number.isSafeInteger(receipt.keyringRevision) ||
      (receipt.keyringRevision ?? 0) < 1 ||
      typeof receipt.signedAt !== "string" ||
      typeof receipt.expiresAt !== "string" ||
      !Number.isSafeInteger(receipt.filesVerified) ||
      (receipt.filesVerified ?? -1) < 1 ||
      !Array.isArray(receipt.bundleFiles) ||
      receipt.bundleFiles.length < 4 ||
      receipt.bundleFiles.length > 64 ||
      typeof receipt.packageFile !== "string" ||
      !Number.isSafeInteger(receipt.packageBytes) ||
      (receipt.packageBytes ?? -1) < 1 ||
      typeof receipt.packageSha256 !== "string" ||
      !SHA256.test(receipt.packageSha256)
    ) {
      throw new Error("Linux verification receipt is malformed");
    }
    const verifiedReceipt = receipt as LinuxReleaseVerificationReceipt;
    const expected = expectedFileMap(verifiedReceipt.bundleFiles);
    if (
      verifiedReceipt.filesVerified + REQUIRED_METADATA_FILES.length !==
        verifiedReceipt.bundleFiles.length ||
      verifiedReceipt.packageFile !==
        linuxUserlandRuntimeArchiveName(verifiedReceipt.version) ||
      REQUIRED_METADATA_FILES.some(
        (file) =>
          verifiedReceipt.bundleFiles.filter((entry) => entry.file === file)
            .length !== 1,
      )
    ) {
      throw new Error("Linux verification receipt inventory is malformed");
    }
    const packageEntry = expected.get(verifiedReceipt.packageFile);
    if (
      packageEntry === undefined ||
      packageEntry.bytes !== verifiedReceipt.packageBytes ||
      packageEntry.sha256 !== verifiedReceipt.packageSha256
    ) {
      throw new Error("Linux verification receipt package binding differs");
    }
    return verifiedReceipt;
  } catch (cause) {
    if (
      cause instanceof Error &&
      cause.message.startsWith("Linux verification receipt")
    ) {
      throw cause;
    }
    throw new Error("Linux verification receipt is malformed", { cause });
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

const verifiedTarStream = async function* (
  bundleDirectory: string,
  files: ReadonlyArray<LinuxReleaseArchiveExpectedFile>,
): AsyncGenerator<Buffer> {
  const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  for (const entry of [...files].sort((left, right) =>
    left.file < right.file ? -1 : left.file > right.file ? 1 : 0,
  )) {
    yield fileHeader(entry);
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        path.join(bundleDirectory, entry.file),
        fsConstants.O_RDONLY | noFollow,
      );
      const initial = await handle.stat();
      if (!initial.isFile() || initial.size !== entry.bytes) {
        throw new Error(
          `Linux release bundle file byte count differs: ${entry.file}`,
        );
      }
      const digest = createHash("sha256");
      let bytesRead = 0;
      for await (const chunk of handle.createReadStream({
        autoClose: false,
      })) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        digest.update(bytes);
        bytesRead += bytes.length;
        yield bytes;
      }
      const final = await handle.stat();
      if (
        bytesRead !== entry.bytes ||
        final.size !== initial.size ||
        final.mtimeMs !== initial.mtimeMs ||
        digest.digest("hex") !== entry.sha256
      ) {
        throw new Error(
          `Linux release bundle file digest differs: ${entry.file}`,
        );
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }
    const padding =
      (TAR_BLOCK_BYTES - (entry.bytes % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
    if (padding > 0) yield Buffer.alloc(padding);
  }
  yield Buffer.alloc(TAR_BLOCK_BYTES * 2);
};

export const createLinuxReleaseArchive = async (input: {
  readonly bundleDirectory: string;
  readonly verificationReceiptPath: string;
  readonly archivePath: string;
}): Promise<CreatedLinuxReleaseArchive> => {
  const bundleDirectory = path.resolve(input.bundleDirectory);
  const archivePath = path.resolve(input.archivePath);
  const receipt = await readVerificationReceipt(input.verificationReceiptPath);
  const expected = expectedFileMap(receipt.bundleFiles);
  const expectedBasename = linuxUserlandRuntimeArchiveName(receipt.version);
  if (path.basename(archivePath) !== expectedBasename) {
    throw new Error(`Linux release archive must be named ${expectedBasename}`);
  }
  await assertExactBundleInventory(bundleDirectory, expected);

  const temporaryRoot = await mkdtemp(
    path.join(path.dirname(archivePath), ".vellum-linux-archive-"),
  );
  const temporaryArchive = path.join(temporaryRoot, expectedBasename);
  try {
    await pipeline(
      Readable.from(verifiedTarStream(bundleDirectory, receipt.bundleFiles)),
      createGzip({ level: 9 }),
      createWriteStream(temporaryArchive, {
        flags: "wx",
        mode: 0o600,
      }),
    );
    await assertExactBundleInventory(bundleDirectory, expected);

    const inspected = await inspectLinuxReleaseArchive({
      archivePath: temporaryArchive,
      expectedFiles: receipt.bundleFiles,
      temporaryParent: path.dirname(archivePath),
    });
    const result: CreatedLinuxReleaseArchive = {
      schema: "vellum/linux-release-archive-receipt/v1",
      ok: true,
      version: receipt.version,
      archiveFile: path.basename(archivePath),
      archiveBytes: inspected.archiveBytes,
      archiveSha256: inspected.archiveSha256,
    };
    try {
      await link(inspected.verifiedArchivePath, archivePath);
      return result;
    } finally {
      await inspected.cleanup();
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
};

const archiveOptions = (
  args: ReadonlyArray<string>,
): {
  readonly bundleDirectory: string;
  readonly verificationReceiptPath: string;
  readonly archivePath: string;
} => {
  const [command, ...rest] = args;
  if (command !== "create" || rest.length !== 6) {
    throw new Error(
      "usage: linux-release-archive.ts create --bundle DIR --verification-receipt FILE --archive FILE",
    );
  }
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const option = rest[index];
    const value = rest[index + 1];
    if (
      option === undefined ||
      value === undefined ||
      !new Set(["--bundle", "--verification-receipt", "--archive"]).has(
        option,
      ) ||
      values.has(option)
    ) {
      throw new Error("Linux release archive options are invalid");
    }
    values.set(option, value);
  }
  const bundleDirectory = values.get("--bundle");
  const verificationReceiptPath = values.get("--verification-receipt");
  const archivePath = values.get("--archive");
  if (
    bundleDirectory === undefined ||
    verificationReceiptPath === undefined ||
    archivePath === undefined
  ) {
    throw new Error("Linux release archive options are incomplete");
  }
  return { bundleDirectory, verificationReceiptPath, archivePath };
};

if (import.meta.main) {
  createLinuxReleaseArchive(archiveOptions(process.argv.slice(2)))
    .then((receipt) => {
      process.stdout.write(`${JSON.stringify(receipt)}\n`);
    })
    .catch((error: unknown) => {
      const message =
        error instanceof Error ? error.message : "unknown failure";
      process.stderr.write(`Linux release archive failed: ${message}\n`);
      process.exitCode = 1;
    });
}
