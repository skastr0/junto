#!/usr/bin/env bun
/** Prepare exact upstream source downloads. Never publishes a release. */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { create as createTar } from "tar";
import catalog from "../third_party/bun-1.3.13/runtime-source-catalog.json";

export const RUNTIME_SOURCE_INDEX = "runtime-sources.json";
export const RUNTIME_SOURCE_SCHEMA = "junto/runtime-source-materials/v1";
export const RUNTIME_ELECTRON_VERSION = "43.2.0";
const BUN_VERSION = "1.3.13";
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const REVISION = /^[0-9a-f]{40}$/u;
const MAX_INDEX_BYTES = 256 * 1024;

export type RuntimeSourceFile = {
  readonly id: string;
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly sourceUrl: string;
  readonly revision: string;
};
export type RuntimeSourceMaterial = RuntimeSourceFile & {
  readonly repository: string;
  readonly preparation: "download" | "git-archive" | "normalized-tar";
};
export type RuntimeSourceIndex = {
  readonly schema: typeof RUNTIME_SOURCE_SCHEMA;
  readonly bunVersion: typeof BUN_VERSION;
  readonly electronVersion: typeof RUNTIME_ELECTRON_VERSION;
  readonly files: ReadonlyArray<RuntimeSourceFile>;
};
export const RUNTIME_SOURCE_MATERIALS: ReadonlyArray<RuntimeSourceMaterial> =
  catalog as ReadonlyArray<RuntimeSourceMaterial>;

const sourceFile = (material: RuntimeSourceMaterial): RuntimeSourceFile => ({
  id: material.id,
  file: material.file,
  bytes: material.bytes,
  sha256: material.sha256,
  sourceUrl: material.sourceUrl,
  revision: material.revision,
});
const expectedIndex = (): RuntimeSourceIndex => ({
  schema: RUNTIME_SOURCE_SCHEMA,
  bunVersion: BUN_VERSION,
  electronVersion: RUNTIME_ELECTRON_VERSION,
  files: RUNTIME_SOURCE_MATERIALS.map(sourceFile),
});

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid runtime source index object");
  }
  return value as Record<string, unknown>;
};
const exactKeys = (value: Record<string, unknown>, keys: ReadonlyArray<string>): void => {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error("runtime source index has unexpected fields");
  }
};

/** An index cannot substitute a different revision, URL, filename, size, or digest. */
export const decodeRuntimeSourceIndex = (value: unknown): RuntimeSourceIndex => {
  const input = record(value);
  exactKeys(input, ["schema", "bunVersion", "electronVersion", "files"]);
  if (input.schema !== RUNTIME_SOURCE_SCHEMA || input.bunVersion !== BUN_VERSION ||
      input.electronVersion !== RUNTIME_ELECTRON_VERSION ||
      !Array.isArray(input.files)) throw new Error("invalid runtime source index");
  const files = input.files.map((value): RuntimeSourceFile => {
    const entry = record(value);
    exactKeys(entry, ["id", "file", "bytes", "sha256", "sourceUrl", "revision"]);
    if (typeof entry.id !== "string" || !SAFE_FILE.test(entry.id) ||
        typeof entry.file !== "string" || !SAFE_FILE.test(entry.file) ||
        !Number.isSafeInteger(entry.bytes) || Number(entry.bytes) <= 0 ||
        typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256) ||
        typeof entry.revision !== "string" || !REVISION.test(entry.revision) ||
        typeof entry.sourceUrl !== "string" || !entry.sourceUrl.startsWith("https://")) {
      throw new Error("invalid runtime source file identity");
    }
    return {
      id: entry.id,
      file: entry.file,
      bytes: Number(entry.bytes),
      sha256: entry.sha256,
      sourceUrl: entry.sourceUrl,
      revision: entry.revision,
    };
  });
  const decoded: RuntimeSourceIndex = {
    schema: RUNTIME_SOURCE_SCHEMA,
    bunVersion: BUN_VERSION,
    electronVersion: RUNTIME_ELECTRON_VERSION,
    files,
  };
  if (JSON.stringify(decoded) !== JSON.stringify(expectedIndex())) {
    throw new Error("runtime source index differs from the pinned source catalog");
  }
  return decoded;
};

const requireDirectory = async (directory: string): Promise<void> => {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("runtime source directory must be a non-symlink directory");
  }
};

/** Verify bytes before any archive can be selected for copying or publication. */
export const verifyRuntimeSourceFile = async (
  directory: string,
  expected: RuntimeSourceFile,
): Promise<void> => {
  if (!SAFE_FILE.test(expected.file)) throw new Error("unsafe runtime source filename");
  const file = path.join(directory, expected.file);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== expected.bytes) {
    throw new Error(`runtime source must be a regular file of the pinned size: ${expected.file}`);
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest("hex") !== expected.sha256) {
    throw new Error(`runtime source digest differs: ${expected.file}`);
  }
};

export const verifyRuntimeSources = async (
  directory: string,
  options: { readonly allowedAdditionalFiles?: ReadonlyArray<string> } = {},
): Promise<RuntimeSourceIndex> => {
  await requireDirectory(directory);
  const additional = options.allowedAdditionalFiles ?? [];
  if (additional.some((name) => !SAFE_FILE.test(name))) {
    throw new Error("unsafe additional source filename");
  }
  const indexFile = path.join(directory, RUNTIME_SOURCE_INDEX);
  const metadata = await lstat(indexFile);
  if (!metadata.isFile() || metadata.isSymbolicLink() ||
      metadata.size < 1 || metadata.size > MAX_INDEX_BYTES) {
    throw new Error("runtime source index must be a bounded regular file");
  }
  const index = decodeRuntimeSourceIndex(JSON.parse(await readFile(indexFile, "utf8")));
  const allowed = new Set([RUNTIME_SOURCE_INDEX, ...index.files.map((file) => file.file), ...additional]);
  const unexpected = (await readdir(directory)).find((name) => !allowed.has(name));
  if (unexpected !== undefined) throw new Error(`unexpected runtime source directory entry: ${unexpected}`);
  for (const file of index.files) await verifyRuntimeSourceFile(directory, file);
  return index;
};

const runGit = async (args: ReadonlyArray<string>): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", [...args], { stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    child.stderr.on("data", (chunk: Buffer) => {
      error = (error + chunk.toString()).slice(-16 * 1024);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`runtime source Git operation failed: ${error.trim() || String(code)}`));
    });
  });
};

async function* responseChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      yield chunk.value;
    }
  } finally {
    reader.releaseLock();
  }
}

const archiveGitSource = async (
  material: RuntimeSourceMaterial,
  output: string,
  sourceCacheDirectory: string,
): Promise<void> => {
  if (process.versions.bun !== BUN_VERSION) {
    throw new Error(`Git source archive preparation requires Bun ${BUN_VERSION} for the pinned gzip output`);
  }
  await mkdir(sourceCacheDirectory, { recursive: true, mode: 0o700 });
  await requireDirectory(sourceCacheDirectory);
  const cache = path.join(sourceCacheDirectory, `${material.id}-git-cache`);
  await mkdir(cache, { recursive: true, mode: 0o700 });
  await requireDirectory(cache);
  await runGit(["init", "--bare", cache]);
  try {
    await runGit(["-C", cache, "cat-file", "-e", `${material.revision}^{commit}`]);
  } catch {
    await runGit(["-C", cache, "fetch", "--depth=1", material.sourceUrl, material.revision]);
  }
  const child = spawn("git", [
    "-C", cache, "archive", "--format=tar",
    `--prefix=${material.id}-${material.revision}/`, material.revision,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16 * 1024); });
  const completion = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`runtime source archive failed: ${stderr.trim() || String(code)}`));
    });
  });
  // gzip's zero timestamp, fixed level, and pinned Bun implementation preserve
  // the archive identity. Node and Bun can produce different deflate bytes.
  // No checkout or generated build output enters this tar.
  await Promise.all([
    pipeline(child.stdout, createGzip({ level: 9 }), createWriteStream(output, { flags: "wx", mode: 0o600 })),
    completion,
  ]);
};

/** Gitiles stamps entries at download time. Preserve source bytes and modes,
 * but remove that request-specific metadata before checking the pinned digest.
 * Repacking reads archive entries; it never extracts them to the filesystem.
 */
export const normalizeRuntimeSourceArchive = async (input: string, output: string): Promise<void> => {
  await pipeline(
    // tar's asynchronous @archive reader stalls on directory entries. The
    // synchronous reader also keeps archive entry ordering deterministic.
    createTar({ sync: true, portable: true, noMtime: true, strict: true }, [`@${input}`]),
    createGzip({ level: 9 }),
    createWriteStream(output, { flags: "wx", mode: 0o600 }),
  );
};

export const prepareRuntimeSources = async (input: {
  readonly destinationDirectory: string;
  readonly sourceCacheDirectory?: string;
}): Promise<RuntimeSourceIndex> => {
  const directory = path.resolve(input.destinationDirectory);
  const index = decodeRuntimeSourceIndex(expectedIndex());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await requireDirectory(directory);
  const allowed = new Set([RUNTIME_SOURCE_INDEX, ...index.files.map((file) => file.file)]);
  for (const file of await readdir(directory)) {
    if (!allowed.has(file)) throw new Error(`unexpected runtime source directory entry: ${file}`);
  }
  for (const material of RUNTIME_SOURCE_MATERIALS) {
    const destination = path.join(directory, material.file);
    const existing = await lstat(destination).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (existing !== undefined) {
      await verifyRuntimeSourceFile(directory, material);
      continue;
    }
    const temporary = path.join(directory, `runtime-stage-${randomUUID()}.partial`);
    const downloaded = `${temporary}.download`;
    try {
      if (material.preparation === "git-archive") {
        await archiveGitSource(material, temporary,
          input.sourceCacheDirectory ?? path.join(path.dirname(directory), ".runtime-source-cache"));
      } else {
        if (material.preparation === "normalized-tar" && process.versions.bun !== BUN_VERSION) {
          throw new Error(`Source archive normalization requires Bun ${BUN_VERSION} for the pinned gzip output`);
        }
        const response = await fetch(material.sourceUrl, { signal: AbortSignal.timeout(30 * 60 * 1000) });
        if (!response.ok || response.body === null) {
          throw new Error(`runtime source download failed for ${material.id}: HTTP ${response.status}`);
        }
        await pipeline(Readable.from(responseChunks(response.body)), createWriteStream(
          material.preparation === "normalized-tar" ? downloaded : temporary,
          { flags: "wx", mode: 0o600 },
        ));
        if (material.preparation === "normalized-tar") {
          await normalizeRuntimeSourceArchive(downloaded, temporary);
        }
      }
      await verifyRuntimeSourceFile(directory, { ...material, file: path.basename(temporary) });
      // Install exclusively: a concurrent preparer must never replace a file
      // that appeared after the initial absence check.
      await link(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
      await rm(downloaded, { force: true });
    }
  }
  const body = `${JSON.stringify(index, null, 2)}\n`;
  const indexPath = path.join(directory, RUNTIME_SOURCE_INDEX);
  const existingIndex = await lstat(indexPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (existingIndex === undefined) await writeFile(indexPath, body, { flag: "wx", mode: 0o600 });
  return verifyRuntimeSources(directory);
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || !["--directory", "--cache-dir"].includes(flag) ||
        value === undefined || value.startsWith("--") || flags.has(flag)) {
      throw new Error("usage: bun scripts/prepare-runtime-sources.ts --directory PATH [--cache-dir PATH]");
    }
    flags.set(flag, value);
  }
  const directory = flags.get("--directory");
  if (directory === undefined) throw new Error("--directory is required");
  const result = await prepareRuntimeSources({
    destinationDirectory: directory,
    ...(flags.has("--cache-dir") ? { sourceCacheDirectory: flags.get("--cache-dir")! } : {}),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
