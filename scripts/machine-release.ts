import { createHash } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { decodeMachineReleaseCatalog, MACHINE_RELEASE_ORIGIN, MAX_MACHINE_ARCHIVE_BYTES, MAX_MACHINE_ARCHIVE_FILES, MAX_MACHINE_ARCHIVE_PATH_BYTES, MAX_MACHINE_UNPACKED_BYTES, type MachineReleaseArchive, type MachineReleaseCatalog } from "../src/shared/machine-release";
import { inspectMachineBundle } from "../src/main/junto/hosts/bundle";
import { checkMachinePackage, sourceMachinePackage } from "./machine-package";
import { auditMachineBundleSignatures } from "./audit-packaged-app";

const digestFile = async (file: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};

/** Flat, canonical ustar: regular members only; no extensions or links. */
export const machineTarHeader = (name: string, bytes: number, mode: number): Buffer => {
  if (Buffer.byteLength(name) > MAX_MACHINE_ARCHIVE_PATH_BYTES || !/^(?:[A-Za-z0-9._@-]+\/)*[A-Za-z0-9._@-]+$/.test(name) || name.split("/").some(part => part === "." || part === "..")) throw new Error("machine archive path is unsafe");
  const header = Buffer.alloc(512);
  let leaf = name, prefix = "";
  if (Buffer.byteLength(leaf) > 100) {
    const slash = name.lastIndexOf("/");
    prefix = name.slice(0, slash); leaf = name.slice(slash + 1);
    if (slash < 0 || Buffer.byteLength(prefix) > 155 || Buffer.byteLength(leaf) > 100) throw new Error("machine archive path does not fit ustar");
  }
  header.write(leaf, 0, 100, "ascii");
  const octal = (value: number, offset: number, width: number) => {
    const digits = value.toString(8);
    if (!Number.isSafeInteger(value) || value < 0 || digits.length >= width) throw new Error("machine archive numeric field is out of bounds");
    header.write(digits.padStart(width - 1, "0") + "\0", offset, width, "ascii");
  };
  octal(mode, 100, 8); octal(0, 108, 8); octal(0, 116, 8); octal(bytes, 124, 12); octal(0, 136, 12);
  header.fill(32, 148, 156); header[156] = 48;
  header.write("ustar\0", 257, 6, "ascii"); header.write("00", 263, 2, "ascii"); header.write(prefix, 345, 155, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return header;
};

export const archiveMachineBundle = async (bundle: string, output: string): Promise<MachineReleaseArchive> => {
  const manifest = await inspectMachineBundle(bundle);
  const manifestBytes = await readFile(path.join(bundle, "manifest.json"));
  const entries = [...manifest.files, { path: "manifest.json", bytes: manifestBytes.length, mode: 0o644, sha256: createHash("sha256").update(manifestBytes).digest("hex") }].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (entries.length > MAX_MACHINE_ARCHIVE_FILES || entries.reduce((total, entry) => total + entry.bytes, 0) > MAX_MACHINE_UNPACKED_BYTES) throw new Error("machine archive exceeds unpacking bounds");
  async function* tar() {
    for (const entry of entries) {
      const file = path.join(bundle, entry.path);
      const metadata = await lstat(file);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size !== entry.bytes || (metadata.mode & 0o777) !== entry.mode) throw new Error("machine archive input changed or is linked");
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const admitted = await handle.stat();
        if (admitted.ino !== metadata.ino || admitted.dev !== metadata.dev || admitted.nlink !== 1) throw new Error("machine archive input changed identity");
        yield machineTarHeader(entry.path, entry.bytes, entry.mode);
        const hash = createHash("sha256"); let bytes = 0;
        for await (const chunk of handle.createReadStream({ autoClose: false })) { bytes += chunk.length; if (bytes > entry.bytes) throw new Error("machine archive input grew"); hash.update(chunk); yield chunk; }
        if (bytes !== entry.bytes || hash.digest("hex") !== entry.sha256) throw new Error("machine archive input changed bytes");
        const padding = (512 - entry.bytes % 512) % 512;
        if (padding) yield Buffer.alloc(padding);
      } finally { await handle.close(); }
    }
    yield Buffer.alloc(1024);
  }
  await pipeline(Readable.from(tar()), createGzip({ level: 9 }), createWriteStream(output, { flags: "wx", mode: 0o644 }));
  await inspectMachineBundle(bundle);
  const archiveBytes = (await stat(output)).size;
  if (archiveBytes > MAX_MACHINE_ARCHIVE_BYTES) throw new Error("machine archive exceeds release upload bound");
  return { target: manifest.target, archivePath: `/machines/${manifest.build}/${manifest.target}.tar.gz`, archiveBytes, archiveSha256: await digestFile(output), manifestSha256: createHash("sha256").update(manifestBytes).digest("hex") };
};

export const prepareMachineRelease = async (root: string): Promise<MachineReleaseCatalog> => {
  const expected = await sourceMachinePackage();
  const manifests = await checkMachinePackage(path.join(root, "dist/machines"), expected);
  const release = path.join(root, "dist/machine-release");
  // Refuse old output. Immutable archive bytes must be deliberately preserved,
  // not silently replaced by another timestamped signature of the same source.
  try { await lstat(release); throw new Error("machine release output already exists; preserve it and use a clean build"); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  const attempt = await mkdtemp(path.join(root, "dist/.machine-release-"));
  await chmod(attempt, 0o700);
  const build = manifests[0]!.build;
  await mkdir(path.join(attempt, "machines", build), { recursive: true });
  const archives: MachineReleaseArchive[] = [];
  for (const manifest of manifests) {
    const bundle = path.join(root, "dist/machines", manifest.target);
    if (manifest.target === "darwin-arm64") await auditMachineBundleSignatures(bundle);
    archives.push(await archiveMachineBundle(bundle, path.join(attempt, "machines", build, `${manifest.target}.tar.gz`)));
  }
  const catalog = decodeMachineReleaseCatalog({ schema: "junto/machine-release/v1", build, appVersion: manifests[0]!.appVersion, origin: MACHINE_RELEASE_ORIGIN, archives });
  const encoded = JSON.stringify(catalog) + "\n";
  await writeFile(path.join(attempt, "machine-release-catalog.json"), encoded, { flag: "wx", mode: 0o644 });
  await rename(attempt, release);
  await writeFile(path.join(root, "dist/machine-release-catalog.json"), encoded, { flag: "wx", mode: 0o644 });
  return catalog;
};

if (import.meta.main) process.stdout.write(JSON.stringify(await prepareMachineRelease(process.cwd())) + "\n");
