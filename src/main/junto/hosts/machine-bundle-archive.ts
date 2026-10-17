import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { Schema } from "effect";
import { Unpack } from "tar";
import {
  MAX_MACHINE_ARCHIVE_FILES, MAX_MACHINE_ARCHIVE_PATH_BYTES, MAX_MACHINE_UNPACKED_BYTES,
  type MachineReleaseArchive, type MachineReleaseCatalog,
} from "@shared/machine-release";
import { inspectMachineBundle } from "./bundle";
import { machineBundleAttemptPath, type OwnedMachineBundleAttempt } from "./machine-bundle-cache";

/** Which archive admission check refused the download; each check has one fixed reason. */
export const MachineArchiveCheck = Schema.Literals(["unpacked-too-large", "numeric-field", "path-field", "data-after-end-block", "over-limits", "not-ustar", "special-member", "header-checksum", "unsafe-path", "member-size", "unsafe-mode", "nonzero-padding", "data-after-end", "invalid-member", "truncated", "manifest-missing", "file-as-directory", "manifest-differs", "bundle-differs"]);
type MachineArchiveCheck = typeof MachineArchiveCheck.Type;
const reasons: Record<MachineArchiveCheck, string> = {
  "unpacked-too-large": "the archive is too large when unpacked",
  "numeric-field": "invalid ustar numeric field",
  "path-field": "unsafe archive path field",
  "data-after-end-block": "data follows an archive end block",
  "over-limits": "archive exceeds unpacking limits",
  "not-ustar": "the archive is not the required ustar format",
  "special-member": "archive metadata, links and special files are refused",
  "header-checksum": "invalid archive header checksum",
  "unsafe-path": "unsafe or repeated archive path",
  "member-size": "invalid archive member size",
  "unsafe-mode": "unsafe archive file permissions",
  "nonzero-padding": "nonzero archive file padding",
  "data-after-end": "data follows the archive end",
  "invalid-member": "invalid archive member",
  "truncated": "the archive is truncated or has invalid end blocks",
  "manifest-missing": "bundle manifest is missing",
  "file-as-directory": "a file is also used as an archive directory",
  "manifest-differs": "bundle manifest differs from this release",
  "bundle-differs": "bundle differs from this build or machine platform",
};
export class MachineArchiveRefused extends Schema.TaggedError<MachineArchiveRefused>()("MachineArchiveRefused", {
  check: MachineArchiveCheck,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}
const error = (check: MachineArchiveCheck, cause?: unknown): MachineArchiveRefused => new MachineArchiveRefused({
  check, message: `Junto's download failed its check: ${reasons[check]}. The machine has not changed`, ...(cause === undefined ? {} : { cause }),
});
const boundedExpansion = (): Transform => {
  let bytes = 0;
  // Ustar headers, alignment and end blocks are bounded separately from file contents.
  const maximum = MAX_MACHINE_UNPACKED_BYTES + MAX_MACHINE_ARCHIVE_FILES * 1024 + 1024;
  return new Transform({ transform(chunk: Buffer, _encoding, callback) {
    bytes += chunk.length;
    callback(bytes > maximum ? error("unpacked-too-large") : null, chunk);
  } });
};

const octalField = (header: Buffer, offset: number, width: number): number => {
  const field = header.subarray(offset, offset + width).toString("latin1");
  const match = /^ *([0-7]+)[ \0]*/.exec(field);
  if (!match || match[0].length !== width) throw error("numeric-field");
  const value = Number.parseInt(match[1]!, 8);
  if (!Number.isSafeInteger(value)) throw error("numeric-field");
  return value;
};
const pathField = (header: Buffer, offset: number, width: number): string => {
  const field = header.subarray(offset, offset + width), end = field.indexOf(0);
  if (field.some(byte => byte > 127) || (end >= 0 && field.subarray(end).some(byte => byte !== 0))) throw error("path-field");
  return field.subarray(0, end < 0 ? width : end).toString("ascii");
};

const inspectArchive = async (path: string): Promise<void> => {
  const names = new Set<string>();
  const header = Buffer.alloc(512), ustar = Buffer.from("ustar\0" + "00", "ascii");
  let filled = 0, bodyBytes = 0, paddingBytes = 0, endBlocks = 0, members = 0, expandedBytes = 0;
  const admitHeader = (): void => {
    if (header.every(byte => byte === 0)) { endBlocks++; return; }
    if (endBlocks > 0) throw error("data-after-end-block");
    // Count raw headers, including metadata that a tar parser can silently consume.
    if (++members > MAX_MACHINE_ARCHIVE_FILES) throw error("over-limits");
    if (!header.subarray(257, 265).equals(ustar)) throw error("not-ustar");
    if (header[156] !== 48 || header.subarray(157, 257).some(byte => byte !== 0)) throw error("special-member");
    let checksum = 8 * 32;
    for (let index = 0; index < 512; index++) if (index < 148 || index >= 156) checksum += header[index]!;
    if (checksum !== octalField(header, 148, 8)) throw error("header-checksum");
    const leaf = pathField(header, 0, 100), prefix = pathField(header, 345, 155);
    const name = prefix ? `${prefix}/${leaf}` : leaf;
    if (Buffer.byteLength(name) > MAX_MACHINE_ARCHIVE_PATH_BYTES ||
      /^(?:[A-Za-z0-9._@-]+\/)*[A-Za-z0-9._@-]+/.exec(name)?.[0] !== name ||
      name.split("/").some(part => part === "." || part === "..") || names.has(name)) throw error("unsafe-path");
    const size = octalField(header, 124, 12), mode = octalField(header, 100, 8);
    if (size > MAX_MACHINE_UNPACKED_BYTES || (name === "manifest.json" && size > 1024 * 1024)) throw error("member-size");
    if (mode > 0o777 || (mode & 0o022) !== 0 || (mode & 0o400) === 0) throw error("unsafe-mode");
    expandedBytes += size;
    if (expandedBytes > MAX_MACHINE_UNPACKED_BYTES) throw error("over-limits");
    names.add(name); bodyBytes = size; paddingBytes = (512 - size % 512) % 512;
  };
  const scan = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      try {
        let offset = 0;
        while (offset < chunk.length) {
          if (bodyBytes > 0) {
            const take = Math.min(bodyBytes, chunk.length - offset); bodyBytes -= take; offset += take;
          } else if (paddingBytes > 0) {
            const take = Math.min(paddingBytes, chunk.length - offset);
            if (chunk.subarray(offset, offset + take).some(byte => byte !== 0)) throw error("nonzero-padding");
            paddingBytes -= take; offset += take;
          } else {
            if (endBlocks === 2) throw error("data-after-end");
            const take = Math.min(512 - filled, chunk.length - offset);
            chunk.copy(header, filled, offset, offset + take); filled += take; offset += take;
            if (filled === 512) { filled = 0; admitHeader(); }
          }
        }
        callback();
      } catch (cause) { callback(cause instanceof Error ? cause : error("invalid-member", cause)); }
    },
    final(callback) {
      callback(filled !== 0 || bodyBytes !== 0 || paddingBytes !== 0 || endBlocks !== 2 ? error("truncated") : null);
    },
  });
  await pipeline(createReadStream(path), createGunzip(), boundedExpansion(), scan);
  if (!names.has("manifest.json")) throw error("manifest-missing");
  for (const name of names) {
    const pieces = name.split("/");
    for (let index = 1; index < pieces.length; index++) {
      if (names.has(pieces.slice(0, index).join("/"))) throw error("file-as-directory");
    }
  }
};

/** Raw ustar admission precedes extraction of an authenticated private snapshot. No bundled program is run. */
export const unpackMachineReleaseArchive = async (
  attempt: OwnedMachineBundleAttempt, expected: MachineReleaseArchive, catalog: MachineReleaseCatalog,
): Promise<string> => {
  const root = await machineBundleAttemptPath(attempt);
  const snapshot = join(root, "archive.tar.gz");
  await inspectArchive(snapshot);
  const bundle = join(root, "bundle");
  await mkdir(bundle, { mode: 0o700 });
  const unpack = new Unpack({
    cwd: bundle, strict: true, preservePaths: false, preserveOwner: false,
    keep: true, noMtime: true, chmod: true, processUmask: 0o022,
    maxDepth: 64, maxMetaEntrySize: 4096,
  });
  await pipeline(createReadStream(snapshot), createGunzip(), boundedExpansion(), unpack);
  const manifestBytes = await readFile(join(bundle, "manifest.json"));
  if (createHash("sha256").update(manifestBytes).digest("hex") !== expected.manifestSha256) throw error("manifest-differs");
  const manifest = await inspectMachineBundle(bundle);
  if (manifest.build !== catalog.build || manifest.target !== expected.target || manifest.appVersion !== catalog.appVersion) {
    throw error("bundle-differs");
  }
  return bundle;
};
