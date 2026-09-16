import { extractFile, statFile, uncache } from "@electron/asar";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";

const MAX_HEADER_BYTES = 16 * 1024 * 1024;
const MAX_MAIN_BYTES = 128 * 1024 * 1024;
const PROVENANCE_PATH = "out/package-runtime-provenance.json";
const MAIN_PATH = "out/main/index.js";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Invalid packaged ${label}`);
  return value as Record<string, unknown>;
};

/** Inspect fixed packed members only; reject unbounded ASAR header allocation. */
export const admitPackagedUpdateIdentity = async (input: {
  readonly asarPath: string;
  readonly version: string;
  readonly sourceRevision: string;
}): Promise<void> => {
  const file = await open(input.asarPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  let archiveBytes: number;
  let headerBytes: number;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 16) throw new Error("Packaged update ASAR is not a regular archive");
    archiveBytes = stat.size;
    const size = Buffer.alloc(8);
    if ((await file.read(size, 0, size.length, 0)).bytesRead !== size.length || size.readUInt32LE(0) !== 4) throw new Error("Packaged update ASAR header is malformed");
    headerBytes = size.readUInt32LE(4);
    if (headerBytes < 8 || headerBytes > MAX_HEADER_BYTES || headerBytes > archiveBytes - 8) throw new Error("Packaged update ASAR header exceeds bounds");
  } finally { await file.close(); }
  uncache(input.asarPath);
  try {
    for (const directory of ["out", "out/main"]) {
      const entry = statFile(input.asarPath, directory, false);
      if (!("files" in entry) || "link" in entry) throw new Error("Packaged update identity directory is a link or not a directory");
    }
    const read = (path: string, maximum: number): Buffer => {
      const entry = statFile(input.asarPath, path, false);
      if ("files" in entry || "link" in entry || entry.unpacked || !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > maximum || !/^\d+$/u.test(entry.offset)) {
        throw new Error("Packaged update identity member is not a bounded packed file");
      }
      const offset = Number(entry.offset);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset + entry.size > archiveBytes - headerBytes - 8) throw new Error("Packaged update identity member is outside the archive");
      const contents = extractFile(input.asarPath, path, false);
      if (contents.length !== entry.size) throw new Error("Packaged update identity member size mismatch");
      return contents;
    };
    const pkg = record(JSON.parse(read("package.json", 1024 * 1024).toString("utf8")), "package metadata");
    const receipt = record(JSON.parse(read(PROVENANCE_PATH, 65_536).toString("utf8")), "runtime provenance");
    const build = record(receipt.buildIdentity, "build identity");
    const payload = record(receipt.payload, "runtime payload identity");
    if (
      pkg.version !== input.version || receipt.schema !== "vellum-command/package-runtime-provenance/v2" ||
      receipt.product !== "Junto" || receipt.runtime !== "electron-main" || receipt.appVersion !== input.version || receipt.sourceCommit !== input.sourceRevision ||
      build.schema !== "vellum-command/runtime-build-identity/v1" || build.runtime !== "electron-main" || build.sourceCommit !== input.sourceRevision ||
      typeof build.cohortNonce !== "string" || !UUID.test(build.cohortNonce) || Object.keys(build).length !== 4 ||
      payload.packagedPath !== MAIN_PATH || typeof payload.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(payload.sha256)
    ) throw new Error("Packaged update version or source identity does not match the signed release");
    const main = read(MAIN_PATH, MAX_MAIN_BYTES);
    if (payload.bytes !== main.length || payload.sha256 !== createHash("sha256").update(main).digest("hex")) throw new Error("Packaged update main payload does not match its build receipt");
    const markers = [...main.toString("utf8").matchAll(/\/\* VELLUM_COMMAND_RUNTIME_BUILD_IDENTITY:([A-Za-z0-9_-]+) \*\//gu)];
    if (markers.length !== 1 || markers[0]![1]!.length > 4096) throw new Error("Packaged update main payload must contain one bounded build identity");
    const embedded = record(JSON.parse(Buffer.from(markers[0]![1]!, "base64url").toString("utf8")), "embedded build identity");
    if (Object.keys(embedded).length !== 4 || Object.entries(build).some(([key, value]) => embedded[key] !== value)) throw new Error("Packaged update main build identity does not match its receipt");
  } finally { uncache(input.asarPath); }
};
