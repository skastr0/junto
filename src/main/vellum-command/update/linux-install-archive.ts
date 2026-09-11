import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { Parser, Unpack, type ReadEntry } from "tar";
import {
  LINUX_DESKTOP_MAX_ARCHIVE_BYTES,
  LINUX_DESKTOP_MAX_EXPANDED_BYTES,
} from "../../../shared/linux-desktop-release";

const MAX_ARCHIVE_BYTES = LINUX_DESKTOP_MAX_ARCHIVE_BYTES;
const MAX_EXPANDED_BYTES = LINUX_DESKTOP_MAX_EXPANDED_BYTES;
const MAX_FILE_BYTES = 1_000_000_000;
const MAX_MEMBERS = 100_000;
const MAX_PATH_BYTES = 1_024;
const MAX_DEPTH = 64;

export interface LinuxDesktopArchiveIdentity {
  readonly version: string;
  readonly bytes: number;
  readonly sha256: string;
}

const boundedBytes = (maximum: number): Transform => {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > maximum ? new Error("Linux desktop archive exceeds expansion limit") : null, chunk);
    },
  });
};

/** Snapshot and authenticate before a single archive member can reach disk. */
const snapshotArchive = async (
  archivePath: string,
  snapshotPath: string,
  expected: LinuxDesktopArchiveIdentity,
): Promise<void> => {
  if (!Number.isSafeInteger(expected.bytes) || expected.bytes <= 0 || expected.bytes > MAX_ARCHIVE_BYTES) {
    throw new Error("Linux desktop archive size is outside the supported bound");
  }
  const source = await open(archivePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  let destination: FileHandle | undefined;
  try {
    const before = await source.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size !== expected.bytes) {
      throw new Error("Linux desktop archive is not a regular file of the signed size");
    }
    destination = await open(snapshotPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
    const hash = createHash("sha256");
    let bytes = 0;
    const buffer = Buffer.allocUnsafe(128 * 1024);
    for (;;) {
      const read = await source.read(buffer, 0, buffer.length, null);
      if (read.bytesRead === 0) break;
      bytes += read.bytesRead;
      if (bytes > expected.bytes) throw new Error("Linux desktop archive grew while being authenticated");
      const chunk = buffer.subarray(0, read.bytesRead);
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const wrote = await destination.write(chunk, offset, chunk.length - offset, null);
        if (wrote.bytesWritten === 0) throw new Error("Linux desktop archive snapshot write made no progress");
        offset += wrote.bytesWritten;
      }
    }
    if (bytes !== expected.bytes || hash.digest("hex") !== expected.sha256) {
      throw new Error("Linux desktop archive checksum does not match the signed release");
    }
    await destination.sync();
  } finally {
    await destination?.close();
    await source.close();
  }
};

interface ArchiveMember {
  readonly path: string;
  readonly kind: "File" | "Directory";
  readonly bytes: number;
  readonly mode: number;
}

const rejectEmbeddedNuls = (bytes: string): void => {
  const firstNul = bytes.indexOf("\0");
  if (firstNul === -1) return;
  const pax = /^\d+ /u.test(bytes) || bytes.includes("\n");
  if (pax || firstNul !== bytes.length - 1) {
    throw new Error("Linux desktop archive contains an embedded NUL in archive metadata");
  }
};

const inspectArchive = async (snapshotPath: string, root: string): Promise<ReadonlyMap<string, ArchiveMember>> => {
  const members = new Map<string, ArchiveMember>();
  let expandedBytes = 0;
  const parser = new Parser({ strict: true, maxMetaEntrySize: 4096 });
  parser.on("ignoredEntry", () => parser.abort(new Error("Linux desktop archive contains an unsupported member")));
  parser.on("meta", (meta: string) => {
    try {
      rejectEmbeddedNuls(meta);
    } catch (error) {
      parser.abort(error instanceof Error ? error : new Error(String(error)));
    }
  });
  parser.on("entry", (entry: ReadEntry) => {
    try {
      let name = entry.path;
      if (name.startsWith("./")) name = name.slice(2);
      if (entry.type === "Directory" && name.endsWith("/")) name = name.slice(0, -1);
      const pieces = name.split("/");
      if (
        Buffer.byteLength(name) > MAX_PATH_BYTES || pieces.length > MAX_DEPTH ||
        /[\\\u0000-\u001f\u007f]/u.test(name) || pieces.some((piece) => piece === "" || piece === "." || piece === "..") ||
        pieces[0] !== root || members.has(name)
      ) throw new Error("Linux desktop archive contains an unsafe or duplicate path");
      if (entry.type !== "File" && entry.type !== "OldFile" && entry.type !== "Directory") {
        throw new Error("Linux desktop archive permits regular files and directories only");
      }
      const kind = entry.type === "Directory" ? "Directory" : "File";
      const mode = entry.mode ?? 0;
      if (entry.linkpath || (mode & 0o7022) !== 0 || (mode & 0o400) === 0) {
        throw new Error("Linux desktop archive contains an unsafe mode or link");
      }
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE_BYTES || (kind === "Directory" && entry.size !== 0)) {
        throw new Error("Linux desktop archive contains an invalid member size");
      }
      if (kind === "Directory" && (mode & 0o100) === 0) throw new Error("Linux desktop archive directory is not traversable");
      if (name === root && kind !== "Directory") throw new Error("Linux desktop archive root is not a directory");
      expandedBytes += entry.size;
      if (members.size >= MAX_MEMBERS || expandedBytes > MAX_EXPANDED_BYTES) {
        throw new Error("Linux desktop archive exceeds member limits");
      }
      members.set(name, { path: name, kind, bytes: entry.size, mode: mode & 0o777 });
      entry.resume();
    } catch (error) {
      parser.abort(error instanceof Error ? error : new Error(String(error)));
    }
  });
  await pipeline(createReadStream(snapshotPath), createGunzip(), boundedBytes(MAX_EXPANDED_BYTES), parser);
  if (members.get(root)?.kind !== "Directory") throw new Error("Linux desktop archive is missing its expected root directory");
  for (const member of members.values()) {
    const pieces = member.path.split("/");
    for (let index = 1; index < pieces.length; index += 1) {
      if (members.get(pieces.slice(0, index).join("/"))?.kind !== "Directory") {
        throw new Error("Linux desktop archive is missing an explicit parent directory");
      }
    }
  }
  const executable = members.get(`${root}/vellum-command`);
  if (executable?.kind !== "File" || (executable.mode & 0o111) === 0) {
    throw new Error("Linux desktop archive is missing its executable vellum-command");
  }
  return members;
};

/** The caller owns an empty private attempt directory; no subprocess is needed. */
export const extractLinuxDesktopArchive = async (input: {
  readonly archivePath: string;
  readonly attemptRoot: string;
  readonly expected: LinuxDesktopArchiveIdentity;
}): Promise<string> => {
  const snapshotPath = join(input.attemptRoot, "archive.tar.gz");
  await snapshotArchive(input.archivePath, snapshotPath, input.expected);
  const root = `vellum-command-runtime-${input.expected.version}-linux-x64`;
  await inspectArchive(snapshotPath, root);
  const extracted = join(input.attemptRoot, "extracted");
  await mkdir(extracted, { mode: 0o700 });
  const unpack = new Unpack({
    cwd: extracted,
    strict: true,
    strip: 1,
    preservePaths: false,
    preserveOwner: false,
    keep: true,
    noMtime: true,
    chmod: true,
    processUmask: 0o022,
    maxDepth: MAX_DEPTH,
    maxMetaEntrySize: 4096,
  });
  await pipeline(createReadStream(snapshotPath), createGunzip(), boundedBytes(MAX_EXPANDED_BYTES), unpack);
  return extracted;
};
