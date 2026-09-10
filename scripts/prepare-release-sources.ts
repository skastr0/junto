#!/usr/bin/env bun
/** Prepare distributor-held source downloads. Never uploads or notarizes. */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import {
  assertExactCommittedCheckout,
  verifyPackagedRuntimeParity,
} from "./package-runtime-provenance";
import {
  verifyRuntimeSources,
  RUNTIME_SOURCE_MATERIALS,
  RUNTIME_ELECTRON_VERSION,
} from "./prepare-runtime-sources";
import {
  linuxRuntimeArtifactName,
  linuxRuntimeArchiveName,
  validateLinuxRuntimeArchive,
} from "./finalize-linux-package";

export const RELEASE_SOURCE_INDEX = "sources.json";
export const RELEASE_SOURCE_SCHEMA = "vellum-command/release-sources/v1";
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const REVISION = /^[0-9a-f]{40}$/u;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
export const SOURCE_DOWNLOAD_PART_BYTES = 128 * 1024 * 1024;
export type SourceDigest = {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
};
export type SourceFile = SourceDigest & {
  readonly parts?: ReadonlyArray<SourceDigest>;
};
export type ReleaseSources = {
  readonly schema: typeof RELEASE_SOURCE_SCHEMA;
  readonly product: "Vellum Command";
  readonly version: string;
  readonly sourceCommit: string;
  readonly access: "same-download-location";
  readonly files: ReadonlyArray<SourceFile>;
  readonly binaries: ReadonlyArray<SourceFile>;
};

export const fingerprintSourceFile = async (
  directory: string,
  file: string,
): Promise<SourceFile> => {
  if (!SAFE_FILE.test(file))
    throw new Error("source material filename is not path-safe");
  const filePath = path.join(directory, file);
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1)
    throw new Error(`source material must be a nonempty regular file: ${file}`);
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return { file, bytes: info.size, sha256: digest.digest("hex") };
};
const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid source index object");
  return value as Record<string, unknown>;
};
const decodeFile = (value: unknown): SourceFile => {
  const item = record(value);
  if (
    typeof item.file !== "string" ||
    !SAFE_FILE.test(item.file) ||
    typeof item.sha256 !== "string" ||
    !SHA256.test(item.sha256) ||
    !Number.isSafeInteger(item.bytes) ||
    Number(item.bytes) < 1
  )
    throw new Error("invalid source index file");
  return { file: item.file, bytes: Number(item.bytes), sha256: item.sha256 };
};
export const decodeReleaseSources = (value: unknown): ReleaseSources => {
  const item = record(value);
  if (
    item.schema !== RELEASE_SOURCE_SCHEMA ||
    item.product !== "Vellum Command" ||
    item.access !== "same-download-location" ||
    typeof item.version !== "string" ||
    !VERSION.test(item.version) ||
    typeof item.sourceCommit !== "string" ||
    !REVISION.test(item.sourceCommit) ||
    !Array.isArray(item.files) ||
    !Array.isArray(item.binaries)
  )
    throw new Error("invalid release source index");
  const files: SourceFile[] = item.files.map((value) => {
    const file = decodeFile(value);
    const parts = record(value).parts;
    if (parts === undefined) return file;
    if (!Array.isArray(parts)) throw new Error("invalid source download parts");
    const decoded = parts.map(decodeFile);
    const expectedNames = sourcePartNames(file.file, file.bytes);
    if (
      JSON.stringify(decoded.map((part) => part.file)) !==
        JSON.stringify(expectedNames) ||
      decoded.some(
        (part, i) =>
          part.bytes !==
          Math.min(
            SOURCE_DOWNLOAD_PART_BYTES,
            file.bytes - i * SOURCE_DOWNLOAD_PART_BYTES,
          ),
      )
    )
      throw new Error("source download part order or size differs");
    return { ...file, parts: decoded };
  });
  const binaries = item.binaries.map(decodeFile);
  if (
    new Set(files.map((file) => file.file)).size !== files.length ||
    new Set(binaries.map((file) => file.file)).size !== binaries.length
  )
    throw new Error("duplicate source index file");
  return {
    schema: RELEASE_SOURCE_SCHEMA,
    product: "Vellum Command",
    access: "same-download-location",
    version: item.version,
    sourceCommit: item.sourceCommit,
    files,
    binaries,
  };
};
const assertFingerprint = (actual: SourceFile, expected: SourceFile): void => {
  if (
    actual.file !== expected.file ||
    actual.bytes !== expected.bytes ||
    actual.sha256 !== expected.sha256
  )
    throw new Error(`source material digest differs: ${expected.file}`);
};

export const sourcePartNames = (
  file: string,
  bytes: number,
  partBytes = SOURCE_DOWNLOAD_PART_BYTES,
): string[] => {
  if (bytes <= partBytes) return [];
  const count = Math.ceil(bytes / partBytes);
  if (count > 999 || partBytes < 1)
    throw new Error("source download exceeds bounded part inventory");
  return Array.from(
    { length: count },
    (_, i) => `${file}.part-${String(i + 1).padStart(3, "0")}`,
  );
};
const catalogPartNames = (): string[] =>
  RUNTIME_SOURCE_MATERIALS.flatMap((file) =>
    sourcePartNames(file.file, file.bytes),
  );
export const prepareSourceDownload = async (
  directory: string,
  source: SourceDigest,
  partBytes = SOURCE_DOWNLOAD_PART_BYTES,
): Promise<SourceFile> => {
  const names = sourcePartNames(source.file, source.bytes, partBytes);
  if (names.length === 0) return source;
  const parts: SourceDigest[] = [];
  for (let i = 0; i < names.length; i++) {
    const temporary = path.join(directory, `source-part-stage-${randomUUID()}`);
    try {
      await pipeline(
        createReadStream(path.join(directory, source.file), {
          start: i * partBytes,
          end: Math.min(source.bytes, (i + 1) * partBytes) - 1,
        }),
        createWriteStream(temporary, { flags: "wx" }),
      );
      await installExact(temporary, directory, names[i]!);
      parts.push(await fingerprintSourceFile(directory, names[i]!));
    } finally {
      await rm(temporary, { force: true });
    }
  }
  const result = { ...source, parts };
  await verifySourceDownload(directory, result);
  return result;
};
export const verifySourceDownload = async (
  directory: string,
  source: SourceFile,
): Promise<ReadonlyArray<SourceDigest>> => {
  if (source.parts === undefined) {
    if (source.bytes > SOURCE_DOWNLOAD_PART_BYTES)
      throw new Error("source archive requires bounded download parts");
    return [source];
  }
  const hash = createHash("sha256");
  let bytes = 0;
  for (const part of source.parts) {
    assertFingerprint(await fingerprintSourceFile(directory, part.file), part);
    for await (const chunk of createReadStream(
      path.join(directory, part.file),
    )) {
      bytes += chunk.length;
      hash.update(chunk);
    }
  }
  if (bytes !== source.bytes || hash.digest("hex") !== source.sha256)
    throw new Error(
      "source download parts do not reconstruct the exact archive",
    );
  return source.parts;
};

export const relinkSourceNames = (version: string): string[] => [
  `Vellum-Command-${version}-cli.js`,
  `Vellum-Command-${version}-cli-relink.json`,
  `Vellum-Command-${version}-cli-notices.txt`,
  "RELINK.md",
];
const validateRelinkReceipt = (
  value: unknown,
  sourceCommit: string,
  bunVersion: string,
): Record<string, unknown> => {
  const receipt = record(value);
  if (
    receipt.schema !== "vellum-command/cli-relink/v1" ||
    receipt.sourceCommit !== sourceCommit ||
    receipt.bunVersion !== bunVersion ||
    typeof receipt.featureFingerprint !== "string" ||
    typeof receipt.featureProfile !== "string"
  )
    throw new Error(
      "CLI relink receipt does not match clean release source/runtime",
    );
  return receipt;
};
const assertRelinkFingerprint = (actual: SourceFile, value: unknown): void => {
  const expected = record(value);
  if (expected.bytes !== actual.bytes || expected.sha256 !== actual.sha256)
    throw new Error(
      "CLI relink material no longer matches the compiled payload",
    );
};
export const verifyReleaseSources = async (input: {
  readonly indexPath: string;
  readonly version: string;
  readonly binaryPaths: ReadonlyArray<string>;
}): Promise<{
  readonly index: ReleaseSources;
  readonly assets: ReadonlyArray<SourceFile & { readonly path: string }>;
}> => {
  const directory = path.dirname(input.indexPath);
  if (path.basename(input.indexPath) !== RELEASE_SOURCE_INDEX)
    throw new Error("release source index must be sources.json");
  await fingerprintSourceFile(directory, RELEASE_SOURCE_INDEX);
  const index = decodeReleaseSources(
    JSON.parse(await readFile(input.indexPath, "utf8")),
  );
  if (index.version !== input.version)
    throw new Error("source index version does not match release");
  const runtime = await verifyRuntimeSources(directory, {
    allowedAdditionalFiles: [
      RELEASE_SOURCE_INDEX,
      `Vellum-Command-${index.version}-${index.sourceCommit}-source.tar.gz`,
      ...relinkSourceNames(index.version),
      ...catalogPartNames(),
      ...index.files.flatMap(
        (file) => file.parts?.map((part) => part.file) ?? [],
      ),
    ],
  });
  const expectedFiles = [
    "runtime-sources.json",
    `Vellum-Command-${index.version}-${index.sourceCommit}-source.tar.gz`,
    ...relinkSourceNames(index.version),
    ...runtime.files.map((file) => file.file),
  ].sort();
  if (
    JSON.stringify(index.files.map((file) => file.file).sort()) !==
    JSON.stringify(expectedFiles)
  )
    throw new Error(
      "release source index is missing exact corresponding-source material",
    );
  for (const file of index.files)
    assertFingerprint(await fingerprintSourceFile(directory, file.file), file);
  const receipt = validateRelinkReceipt(
    JSON.parse(
      await readFile(
        path.join(directory, `Vellum-Command-${index.version}-cli-relink.json`),
        "utf8",
      ),
    ),
    index.sourceCommit,
    runtime.bunVersion,
  );
  assertRelinkFingerprint(
    await fingerprintSourceFile(
      directory,
      `Vellum-Command-${index.version}-cli.js`,
    ),
    receipt.payload,
  );
  assertRelinkFingerprint(
    await fingerprintSourceFile(
      directory,
      `Vellum-Command-${index.version}-cli-notices.txt`,
    ),
    receipt.notices,
  );
  const actualBinaries = await Promise.all(
    input.binaryPaths.map((file) =>
      fingerprintSourceFile(path.dirname(file), path.basename(file)),
    ),
  );
  if (
    actualBinaries.length === 0 ||
    actualBinaries.length !== index.binaries.length
  )
    throw new Error(
      "source index lacks exact release binary bindings; prepare again with the final packaged artifact",
    );
  for (const actual of actualBinaries) {
    const expected = index.binaries.find((file) => file.file === actual.file);
    if (expected === undefined)
      throw new Error("source index binary set differs from release");
    assertFingerprint(actual, expected);
  }
  const downloadAssets: SourceDigest[] = [];
  for (const file of index.files)
    downloadAssets.push(...(await verifySourceDownload(directory, file)));
  const indexFile = await fingerprintSourceFile(
    directory,
    RELEASE_SOURCE_INDEX,
  );
  return {
    index,
    assets: [...downloadAssets, indexFile].map((file) => ({
      ...file,
      path: path.join(directory, file.file),
    })),
  };
};

/** Developer ID signing changes Mach-O bytes. Compare all remaining bytes after
 * removing only signatures from private copies; never mutate either input. */
export const assertPackagedCliCorresponds = async (
  original: string,
  packaged: string,
): Promise<void> => {
  const expected = await fingerprintSourceFile(
    path.dirname(original),
    path.basename(original),
  );
  const actual = await fingerprintSourceFile(
    path.dirname(packaged),
    path.basename(packaged),
  );
  if (expected.bytes === actual.bytes && expected.sha256 === actual.sha256)
    return;
  if (process.platform !== "darwin")
    throw new Error("packaged CLI bytes differ from compiled relink object");
  const temporary = await mkdtemp(
    path.join(tmpdir(), "vellum-command-cli-signature-"),
  );
  try {
    const normalized: SourceFile[] = [];
    for (const [input, name] of [
      [original, "original"],
      [packaged, "packaged"],
    ] as const) {
      const copy = path.join(temporary, name);
      await copyFile(input, copy, constants.COPYFILE_EXCL);
      const result = spawnSync("codesign", ["--remove-signature", copy], {
        encoding: "utf8",
      });
      if (result.status !== 0)
        throw new Error(
          `cannot normalize CLI code signature: ${result.stderr}`,
        );
      normalized.push(await fingerprintSourceFile(temporary, name));
    }
    if (
      normalized[0]!.bytes !== normalized[1]!.bytes ||
      normalized[0]!.sha256 !== normalized[1]!.sha256
    )
      throw new Error(
        "packaged CLI content differs after removing code signatures",
      );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
};

const assertZipContainsAppFile = async (
  zipPath: string,
  appBundle: string,
  relative: string,
): Promise<void> => {
  const input = path.join(appBundle, relative);
  const expected = await fingerprintSourceFile(
    path.dirname(input),
    path.basename(input),
  );
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "unzip",
      ["-p", zipPath, `Vellum Command.app/${relative}`],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const hash = createHash("sha256");
    let bytes = 0;
    let errorText = "";
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errorText = (errorText + chunk.toString()).slice(0, 2048);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0)
        return reject(
          new Error(
            `cannot verify source archive binding to ZIP: ${errorText}`,
          ),
        );
      if (bytes !== expected.bytes || hash.digest("hex") !== expected.sha256)
        return reject(
          new Error(
            `release ZIP does not contain the verified source app file: ${relative}`,
          ),
        );
      resolve();
    });
  });
};

/** Stream the archive's application/CLI bytes independently of its directory. */
export const assertLinuxArchiveContainsRuntime = async (input: {
  readonly archivePath: string;
  readonly runtimeRoot: string;
  readonly version: string;
}): Promise<void> => {
  const artifactName = linuxRuntimeArtifactName({ version: input.version, arch: "x64" });
  if (path.basename(input.archivePath) !== linuxRuntimeArchiveName({ version: input.version, arch: "x64" }))
    throw new Error("Linux source binding requires the canonical archive name");
  validateLinuxRuntimeArchive({ archive: input.archivePath, artifactName });
  for (const relative of ["resources/app.asar", "resources/bin/vellum-command"]) {
    const expected = await fingerprintSourceFile(path.join(input.runtimeRoot, path.dirname(relative)), path.basename(relative));
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/usr/bin/tar", ["-xOzf", input.archivePath, `${artifactName}/${relative}`], { stdio: ["ignore", "pipe", "pipe"] });
      const hash = createHash("sha256");
      let bytes = 0;
      let errorText = "";
      child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; hash.update(chunk); });
      child.stderr.on("data", (chunk: Buffer) => { errorText = (errorText + chunk.toString()).slice(0, 2048); });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) return reject(new Error(`cannot verify Linux archive source binding: ${errorText}`));
        if (bytes !== expected.bytes || hash.digest("hex") !== expected.sha256)
          return reject(new Error(`Linux archive does not contain the verified runtime file: ${relative}`));
        resolve();
      });
    });
  }
};

const installExact = async (
  source: string,
  directory: string,
  file: string,
): Promise<void> => {
  const expected = await fingerprintSourceFile(
    path.dirname(source),
    path.basename(source),
  );
  try {
    await copyFile(source, path.join(directory, file), constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    assertFingerprint(await fingerprintSourceFile(directory, file), {
      ...expected,
      file,
    });
  }
};

export const prepareReleaseSources = async (input: {
  readonly repoRoot: string;
  readonly runtimeSources: string;
  readonly releaseDirectory: string;
  readonly appBundle?: string;
  readonly linuxRuntime?: string;
  readonly linuxArchive?: string;
}): Promise<ReleaseSources> => {
  if ((input.linuxRuntime === undefined) !== (input.linuxArchive === undefined) ||
      (input.appBundle !== undefined && input.linuxRuntime !== undefined))
    throw new Error("choose --app or both --linux-runtime and --linux-archive");
  const root = path.resolve(input.repoRoot);
  const { commit } = await assertExactCommittedCheckout(root);
  const pkg = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  ) as { version?: unknown; packageManager?: unknown };
  if (typeof pkg.version !== "string" || !VERSION.test(pkg.version))
    throw new Error("invalid source package version");
  const version = pkg.version;
  const existingSourceArchive = `Vellum-Command-${version}-${commit}-source.tar.gz`;
  const existingArchiveInfo = await lstat(
    path.join(input.runtimeSources, existingSourceArchive),
  ).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  const runtime = await verifyRuntimeSources(input.runtimeSources, {
    allowedAdditionalFiles: [
      RELEASE_SOURCE_INDEX,
      `Vellum-Command-${version}-${commit}-source.tar.gz`,
      ...relinkSourceNames(version),
      ...catalogPartNames(),
      ...sourcePartNames(existingSourceArchive, existingArchiveInfo?.size ?? 0),
    ],
  });
  if (pkg.packageManager !== `bun@${runtime.bunVersion}`)
    throw new Error("source runtime does not match packageManager compiler");
  const electron = JSON.parse(
    await readFile(
      path.join(root, "node_modules/electron/package.json"),
      "utf8",
    ),
  ) as { version?: unknown };
  if (electron.version !== RUNTIME_ELECTRON_VERSION)
    throw new Error(
      "Electron runtime does not match corresponding-source catalog",
    );
  const directory = path.join(path.resolve(input.releaseDirectory), "sources");
  await mkdir(directory, { recursive: true });
  if ((await lstat(directory)).isSymbolicLink())
    throw new Error("source output directory must not be a symlink");
  for (const file of [
    "runtime-sources.json",
    ...runtime.files.map((entry) => entry.file),
  ]) {
    await installExact(path.join(input.runtimeSources, file), directory, file);
  }
  const cliDirectory = path.join(root, "dist");
  const receipt = validateRelinkReceipt(
    JSON.parse(
      await readFile(
        path.join(cliDirectory, "vellum-command-relink.json"),
        "utf8",
      ),
    ),
    commit,
    runtime.bunVersion,
  );
  assertRelinkFingerprint(
    await fingerprintSourceFile(cliDirectory, "vellum-command-relink.js"),
    receipt.payload,
  );
  assertRelinkFingerprint(
    await fingerprintSourceFile(
      cliDirectory,
      "vellum-command-relink-notices.txt",
    ),
    receipt.notices,
  );
  assertRelinkFingerprint(
    await fingerprintSourceFile(cliDirectory, "vellum-command"),
    receipt.binary,
  );
  for (const [from, to] of [
    ["vellum-command-relink.js", `Vellum-Command-${version}-cli.js`],
    ["vellum-command-relink.json", `Vellum-Command-${version}-cli-relink.json`],
    [
      "vellum-command-relink-notices.txt",
      `Vellum-Command-${version}-cli-notices.txt`,
    ],
  ] as const)
    await installExact(path.join(cliDirectory, from), directory, to);
  const reconstruction = RUNTIME_SOURCE_MATERIALS.filter(
    (file) => file.bytes > SOURCE_DOWNLOAD_PART_BYTES,
  )
    .map(
      (file) =>
        `cat ${sourcePartNames(file.file, file.bytes).join(" ")} > ${file.file}`,
    )
    .join("\n");
  const recipe = `# Rebuilding the Vellum Command control CLI\n\nThis download contains the exact dependency-bundled application object compiled into this release. Its digest, feature profile and compiler version are recorded in Vellum-Command-${version}-cli-relink.json; its application and bundled dependency licenses are in Vellum-Command-${version}-cli-notices.txt.\n\nVerify every download against sources.json. Large source archives are transported as ordered 128 MiB parts because the existing Cloudflare HTTP upload API has a 300 MB limit. Concatenate their parts and verify the resulting whole-archive SHA-256 in the index before extracting:\n\n\`\`\`sh\n${reconstruction}\n\`\`\`\n\nExtract the matching application source archive and follow third_party/bun-1.3.13/README.md to rebuild Bun with your changed LGPL libraries using the runtime source archives here. The Bun source includes its build driver, dependency pins and patches. Compiler/build-tool prerequisites are described upstream.\n\nUsing that rebuilt native Bun executable, run from a directory containing this application object:\n\n\`\`\`sh\n/path/to/rebuilt/bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig --no-compile-autoload-tsconfig --no-compile-autoload-package-json --outfile vellum-command Vellum-Command-${version}-cli.js\n./vellum-command --help\n\`\`\`\n\nThe application-object compile needs no npm packages, repository checkout, or network access. It uses the running Bun executable as the runtime, so the output contains your rebuilt library. It does not inherit the official macOS signature. App/Station control admission and process identity checks still apply. This does not claim byte-identical output or an executed full WebKit rebuild.\n`;
  try {
    await writeFile(path.join(directory, "RELINK.md"), recipe, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    assertFingerprint(await fingerprintSourceFile(directory, "RELINK.md"), {
      file: "RELINK.md",
      bytes: Buffer.byteLength(recipe),
      sha256: createHash("sha256").update(recipe).digest("hex"),
    });
  }
  const archive = `Vellum-Command-${version}-${commit}-source.tar.gz`;
  const temporary = path.join(directory, `source-stage-${randomUUID()}.tar.gz`);
  try {
    const result = spawnSync(
      "git",
      [
        "-C",
        root,
        "archive",
        "--format=tar.gz",
        `--prefix=Vellum-Command-${version}/`,
        `--output=${temporary}`,
        commit,
      ],
      { encoding: "utf8" },
    );
    if (result.status !== 0)
      throw new Error(`source git archive failed: ${result.stderr}`);
    await installExact(temporary, directory, archive);
  } finally {
    await rm(temporary, { force: true });
  }
  let binaries: SourceFile[] = [];
  if (input.appBundle !== undefined) {
    const parity = await verifyPackagedRuntimeParity({
      repoRoot: root,
      target: "mac",
      appBundle: input.appBundle,
    });
    if (parity.sourceCommit !== commit || parity.appVersion !== version)
      throw new Error("packaged app and source archive disagree");
    await assertPackagedCliCorresponds(
      path.join(cliDirectory, "vellum-command"),
      path.join(input.appBundle, "Contents/Resources/bin/vellum-command"),
    );
    for (const relative of [
      "Contents/Resources/app.asar",
      "Contents/Resources/bin/vellum-command",
    ]) {
      await assertZipContainsAppFile(
        path.join(
          input.releaseDirectory,
          `Vellum-Command-${version}-arm64-mac.zip`,
        ),
        input.appBundle,
        relative,
      );
    }
    binaries = await Promise.all(
      [
        `Vellum-Command-${version}-arm64-mac.zip`,
        `Vellum-Command-${version}-arm64-mac.dmg`,
      ].map((file) => fingerprintSourceFile(input.releaseDirectory, file)),
    );
  } else if (input.linuxRuntime !== undefined && input.linuxArchive !== undefined) {
    const parity = await verifyPackagedRuntimeParity({ repoRoot: root, target: "linux", runtimeRoot: input.linuxRuntime });
    if (parity.sourceCommit !== commit || parity.appVersion !== version)
      throw new Error("packaged Linux runtime and source archive disagree");
    await assertPackagedCliCorresponds(path.join(cliDirectory, "vellum-command"), path.join(input.linuxRuntime, "resources/bin/vellum-command"));
    await assertLinuxArchiveContainsRuntime({ archivePath: input.linuxArchive, runtimeRoot: input.linuxRuntime, version });
    binaries = [await fingerprintSourceFile(path.dirname(input.linuxArchive), path.basename(input.linuxArchive))];
  }
  const sourceFiles = await Promise.all(
    [
      archive,
      "runtime-sources.json",
      ...relinkSourceNames(version),
      ...runtime.files.map((entry) => entry.file),
    ]
      .sort()
      .map((file) => fingerprintSourceFile(directory, file)),
  );
  const files: SourceFile[] = [];
  for (const file of sourceFiles)
    files.push(await prepareSourceDownload(directory, file));
  const index: ReleaseSources = {
    schema: RELEASE_SOURCE_SCHEMA,
    product: "Vellum Command",
    version,
    sourceCommit: commit,
    access: "same-download-location",
    files,
    binaries,
  };
  const indexTemporary = path.join(directory, `.${randomUUID()}.json`);
  await writeFile(indexTemporary, `${JSON.stringify(index, null, 2)}\n`, {
    flag: "wx",
  });
  await rename(indexTemporary, path.join(directory, RELEASE_SOURCE_INDEX));
  return index;
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const arg = args[i];
    const value = args[i + 1];
    if (
      arg === undefined ||
      !["--repo", "--runtime-sources", "--release-dir", "--app", "--linux-runtime", "--linux-archive"].includes(
        arg,
      ) ||
      value === undefined ||
      value.startsWith("--") ||
      options.has(arg)
    )
      throw new Error(
        "usage: bun scripts/prepare-release-sources.ts --runtime-sources PATH [--repo PATH] [--release-dir PATH] [--app PATH | --linux-runtime PATH --linux-archive PATH]",
      );
    options.set(arg, value);
  }
  const root = path.resolve(
    options.get("--repo") ?? path.join(import.meta.dirname, ".."),
  );
  const runtimeSources = options.get("--runtime-sources");
  if (runtimeSources === undefined)
    throw new Error("--runtime-sources is required");
  const result = await prepareReleaseSources({
    repoRoot: root,
    runtimeSources,
    releaseDirectory:
      options.get("--release-dir") ?? path.join(root, "release"),
    ...(options.has("--app") ? { appBundle: options.get("--app")! } : {}),
    ...(options.has("--linux-runtime") ? { linuxRuntime: options.get("--linux-runtime")! } : {}),
    ...(options.has("--linux-archive") ? { linuxArchive: options.get("--linux-archive")! } : {}),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
