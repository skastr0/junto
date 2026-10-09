import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { Parser, Unpack, type ReadEntry } from "tar";
import {
  MAX_MACHINE_ARCHIVE_FILES, MAX_MACHINE_ARCHIVE_PATH_BYTES, MAX_MACHINE_UNPACKED_BYTES,
  type MachineReleaseArchive, type MachineReleaseCatalog,
} from "@shared/machine-release";
import { inspectMachineBundle } from "./bundle";
import { machineBundleAttemptPath, type OwnedMachineBundleAttempt } from "./machine-bundle-cache";

const error = (message: string): Error => new Error(`Junto's download failed its check: ${message}. The machine has not changed`);
const boundedExpansion = (): Transform => {
  let bytes = 0;
  // Ustar headers, alignment and end blocks are bounded separately from file contents.
  const maximum = MAX_MACHINE_UNPACKED_BYTES + MAX_MACHINE_ARCHIVE_FILES * 1024 + 1024;
  return new Transform({ transform(chunk: Buffer, _encoding, callback) {
    bytes += chunk.length;
    callback(bytes > maximum ? error("the archive is too large when unpacked") : null, chunk);
  } });
};

const inspectArchive = async (path: string): Promise<void> => {
  const names = new Set<string>();
  let expandedBytes = 0;
  const parser = new Parser({ strict: true, maxMetaEntrySize: 4096 });
  parser.on("ignoredEntry", () => parser.abort(error("unsupported archive member")));
  parser.on("meta", () => parser.abort(error("unsupported archive metadata")));
  parser.on("entry", (entry: ReadEntry) => {
    try {
      const name = entry.path;
      if (Buffer.byteLength(name) > MAX_MACHINE_ARCHIVE_PATH_BYTES ||
        !/^(?:[A-Za-z0-9._@-]+\/)*[A-Za-z0-9._@-]+$/.test(name) ||
        name.split("/").some(part => part === "." || part === "..") || names.has(name)) {
        throw error("unsafe or repeated archive path");
      }
      if (entry.type !== "File" || entry.linkpath) throw error("archive links and special files are refused");
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_MACHINE_UNPACKED_BYTES ||
        (name === "manifest.json" && entry.size > 1024 * 1024)) throw error("invalid archive member size");
      if (entry.mode === undefined || (entry.mode & 0o7022) !== 0 || (entry.mode & 0o400) === 0) throw error("unsafe archive file permissions");
      expandedBytes += entry.size;
      if (names.size >= MAX_MACHINE_ARCHIVE_FILES || expandedBytes > MAX_MACHINE_UNPACKED_BYTES) throw error("archive exceeds unpacking limits");
      names.add(name);
      entry.resume();
    } catch (cause) { parser.abort(cause instanceof Error ? cause : error("invalid archive member")); }
  });
  await pipeline(createReadStream(path), createGunzip(), boundedExpansion(), parser);
  if (!names.has("manifest.json")) throw error("bundle manifest is missing");
  for (const name of names) {
    const pieces = name.split("/");
    for (let index = 1; index < pieces.length; index++) {
      if (names.has(pieces.slice(0, index).join("/"))) throw error("a file is also used as an archive directory");
    }
  }
};

/** Only an authenticated private snapshot reaches the bounded tar parser. No bundled program is run. */
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
  if (createHash("sha256").update(manifestBytes).digest("hex") !== expected.manifestSha256) throw error("bundle manifest differs from this release");
  const manifest = await inspectMachineBundle(bundle);
  if (manifest.build !== catalog.build || manifest.target !== expected.target || manifest.appVersion !== catalog.appVersion) {
    throw error("bundle differs from this build or machine platform");
  }
  return bundle;
};
