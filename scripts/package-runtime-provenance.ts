#!/usr/bin/env bun
/**
 * Build and verify provenance for the two packaged Vellum Command runtimes.
 *
 * The manifest hashes the exact runtime payload. Packaging only accepts a
 * manifest that matches the clean source commit, package version, schema head,
 * and payload bytes. Linux Remote output is rebuilt in its one owned directory.
 */
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractFile, listPackage } from "@electron/asar";
import {
  REMOTE_ENTRY_SOURCE_RELATIVE,
  buildRemoteEntryBundle,
} from "./build-linux-remote-runtime";

export const PACKAGE_RUNTIME_PROVENANCE_SCHEMA =
  "vellum-command/package-runtime-provenance/v1" as const;
export const MAIN_PROVENANCE_SOURCE_RELATIVE =
  "out/package-runtime-provenance.json" as const;
export const REMOTE_PROVENANCE_SOURCE_RELATIVE =
  "out/remote/package-runtime-provenance.json" as const;
export const MAIN_PAYLOAD_SOURCE_RELATIVE = "out/main/index.js" as const;
export const MAIN_PROVENANCE_PACKAGED_RELATIVE =
  "out/package-runtime-provenance.json" as const;
export const MAIN_PAYLOAD_PACKAGED_RELATIVE = "out/main/index.js" as const;
export const REMOTE_PROVENANCE_PACKAGED_RELATIVE =
  "resources/app-remote/package-runtime-provenance.json" as const;
export const REMOTE_PAYLOAD_PACKAGED_RELATIVE =
  "resources/app-remote/vellum-command-remote.js" as const;

const PRODUCT_NAME = "Vellum Command" as const;
const SOURCE_COMMIT = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SEMVER =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export type PackageRuntime = "electron-main" | "linux-remote";
export type PackageTarget = "mac" | "linux";

export type PackageSchemaFacts = {
  readonly currentStateSchemaVersion: number;
  readonly migrationHead: {
    readonly fromVersion: number;
    readonly toVersion: number;
    readonly name: string;
  };
  readonly migrationIdentitySha256: string;
};

export type PackageSourceFacts = PackageSchemaFacts & {
  readonly appVersion: string;
  readonly sourceCommit: string;
};

export type PackageRuntimeProvenance = {
  readonly schema: typeof PACKAGE_RUNTIME_PROVENANCE_SCHEMA;
  readonly product: typeof PRODUCT_NAME;
  readonly runtime: PackageRuntime;
  readonly appVersion: string;
  readonly sourceCommit: string;
  readonly state: PackageSchemaFacts;
  readonly payload: {
    readonly packagedPath: string;
    readonly bytes: number;
    readonly sha256: string;
  };
};

export type VerifiedRuntimeProvenance = {
  readonly runtime: PackageRuntime;
  readonly manifestSha256: string;
  readonly payloadSha256: string;
  readonly payloadBytes: number;
  readonly packagedPath: string;
};

export type PackageRuntimeParityVerification = {
  readonly target: PackageTarget;
  readonly appVersion: string;
  readonly sourceCommit: string;
  readonly state: PackageSchemaFacts;
  readonly runtimes: {
    readonly electronMain: VerifiedRuntimeProvenance;
    readonly linuxRemote?: VerifiedRuntimeProvenance;
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requiredString = (
  value: unknown,
  label: string,
  pattern?: RegExp,
): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    (pattern !== undefined && !pattern.test(value))
  ) {
    throw new Error(`invalid ${label}`);
  }
  return value;
};

const requiredInteger = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`invalid ${label}`);
  }
  return Number(value);
};

const requiredRecord = (
  value: unknown,
  label: string,
): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error(`invalid ${label}`);
  return value;
};

const requireRuntime = (value: unknown): PackageRuntime => {
  if (value !== "electron-main" && value !== "linux-remote") {
    throw new Error("invalid package runtime");
  }
  return value;
};

const requireTarget = (value: unknown): PackageTarget => {
  if (value !== "mac" && value !== "linux") {
    throw new Error("package target must be mac or linux");
  }
  return value;
};

const sha256 = (body: Uint8Array | string): string =>
  createHash("sha256").update(body).digest("hex");

export const sha256File = async (file: string): Promise<string> =>
  sha256(await readFile(file));

const requireRegularFile = async (file: string, label: string): Promise<void> => {
  let metadata;
  try {
    metadata = await lstat(file);
  } catch {
    throw new Error(`${label} is missing: ${file}`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink regular file: ${file}`);
  }
};

const requireDirectory = async (
  directory: string,
  label: string,
): Promise<void> => {
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch {
    throw new Error(`${label} is missing: ${directory}`);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink directory: ${directory}`);
  }
};

const runGit = (repoRoot: string, args: ReadonlyArray<string>): string => {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim() || `exit ${String(result.status)}`}`,
    );
  }
  return result.stdout.trim();
};

const uniqueMatch = (
  body: string,
  pattern: RegExp,
  label: string,
): RegExpMatchArray => {
  const global = new RegExp(
    pattern.source,
    `${pattern.flags.replaceAll("g", "")}g`,
  );
  const matches = [...body.matchAll(global)];
  if (matches.length !== 1) {
    throw new Error(
      `${label} must have exactly one source declaration (found ${String(matches.length)})`,
    );
  }
  return matches[0];
};

/** Read the current version, final migration, and exact schema identity witness. */
export const readPackageSchemaFacts = async (
  repoRoot: string,
): Promise<PackageSchemaFacts> => {
  const migrationsPath = path.join(
    path.resolve(repoRoot),
    "src/main/vellum/state/migrations.ts",
  );
  await requireRegularFile(migrationsPath, "state migration source");
  const body = await readFile(migrationsPath, "utf8");
  const versionMatch = uniqueMatch(
    body,
    /export\s+const\s+CURRENT_STATE_SCHEMA_VERSION\s*=\s*([0-9]+)\s*;/u,
    "CURRENT_STATE_SCHEMA_VERSION",
  );
  const currentStateSchemaVersion = requiredInteger(
    Number(versionMatch[1]),
    "CURRENT_STATE_SCHEMA_VERSION",
  );
  if (currentStateSchemaVersion < 2) {
    throw new Error("current state schema version has no migration head");
  }

  const migrationPattern =
    /\{\s*fromVersion:\s*([0-9]+),\s*toVersion:\s*([0-9]+),\s*name:\s*"([^"]+)"/gu;
  const migrations = [...body.matchAll(migrationPattern)].map((match) => ({
    fromVersion: Number(match[1]),
    toVersion: Number(match[2]),
    name: match[3] ?? "",
  }));
  const heads = migrations.filter(
    (migration) => migration.toVersion === currentStateSchemaVersion,
  );
  if (heads.length !== 1) {
    throw new Error(
      `schema v${String(currentStateSchemaVersion)} must have exactly one migration head`,
    );
  }
  const migrationHead = heads[0];
  if (
    migrationHead === undefined ||
    migrationHead.fromVersion !== currentStateSchemaVersion - 1 ||
    migrationHead.name.length === 0
  ) {
    throw new Error("current state migration head is not contiguous");
  }

  const identityName = `STATE_SCHEMA_V${String(currentStateSchemaVersion)}_IDENTITY`;
  const identityMatch = uniqueMatch(
    body,
    new RegExp(
      `export\\s+const\\s+${identityName}\\s*=\\s*\\{\\s*actualSchemaSha256:\\s*"([0-9a-f]{64})"`,
      "u",
    ),
    identityName,
  );
  const migrationIdentitySha256 = requiredString(
    identityMatch[1],
    `${identityName}.actualSchemaSha256`,
    SHA256,
  );
  return {
    currentStateSchemaVersion,
    migrationHead,
    migrationIdentitySha256,
  };
};

export const readPackageSourceFacts = async (input: {
  readonly repoRoot: string;
  readonly requireClean?: boolean;
  readonly expectedSourceCommit?: string;
}): Promise<PackageSourceFacts> => {
  const repoRoot = path.resolve(input.repoRoot);
  await requireDirectory(repoRoot, "repository root");
  const packagePath = path.join(repoRoot, "package.json");
  await requireRegularFile(packagePath, "package.json");
  const parsed = JSON.parse(await readFile(packagePath, "utf8")) as {
    readonly version?: unknown;
  };
  const appVersion = requiredString(
    parsed.version,
    "package.json version",
    SEMVER,
  );
  const sourceCommit = requiredString(
    runGit(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"]),
    "source commit",
    SOURCE_COMMIT,
  );
  const expectedSourceCommit =
    input.expectedSourceCommit ?? process.env.VELLUM_COMMAND_SOURCE_COMMIT;
  if (
    expectedSourceCommit !== undefined &&
    requiredString(
      expectedSourceCommit,
      "VELLUM_COMMAND_SOURCE_COMMIT",
      SOURCE_COMMIT,
    ) !== sourceCommit
  ) {
    throw new Error(
      `source commit mismatch: checkout=${sourceCommit} expected=${expectedSourceCommit}`,
    );
  }
  if (input.requireClean !== false) {
    const trackedStatus = runGit(repoRoot, [
      "status",
      "--porcelain=v1",
      "--untracked-files=no",
    ]);
    if (trackedStatus.length > 0) {
      throw new Error(
        `package source has tracked changes and cannot be identified by commit ${sourceCommit}`,
      );
    }
  }
  return {
    appVersion,
    sourceCommit,
    ...(await readPackageSchemaFacts(repoRoot)),
  };
};

const runtimePackagedPath = (runtime: PackageRuntime): string =>
  runtime === "electron-main"
    ? MAIN_PAYLOAD_PACKAGED_RELATIVE
    : REMOTE_PAYLOAD_PACKAGED_RELATIVE;

export const makePackageRuntimeProvenance = (input: {
  readonly runtime: PackageRuntime;
  readonly source: PackageSourceFacts;
  readonly payload: Uint8Array;
}): PackageRuntimeProvenance => ({
  schema: PACKAGE_RUNTIME_PROVENANCE_SCHEMA,
  product: PRODUCT_NAME,
  runtime: input.runtime,
  appVersion: input.source.appVersion,
  sourceCommit: input.source.sourceCommit,
  state: {
    currentStateSchemaVersion: input.source.currentStateSchemaVersion,
    migrationHead: input.source.migrationHead,
    migrationIdentitySha256: input.source.migrationIdentitySha256,
  },
  payload: {
    packagedPath: runtimePackagedPath(input.runtime),
    bytes: input.payload.byteLength,
    sha256: sha256(input.payload),
  },
});

export const decodePackageRuntimeProvenance = (
  input: unknown,
): PackageRuntimeProvenance => {
  const record = requiredRecord(input, "runtime provenance");
  if (record.schema !== PACKAGE_RUNTIME_PROVENANCE_SCHEMA) {
    throw new Error("invalid runtime provenance schema");
  }
  if (record.product !== PRODUCT_NAME) {
    throw new Error("runtime provenance product is not Vellum Command");
  }
  const runtime = requireRuntime(record.runtime);
  const state = requiredRecord(record.state, "runtime provenance state");
  const head = requiredRecord(state.migrationHead, "migration head");
  const payload = requiredRecord(record.payload, "runtime provenance payload");
  const decoded: PackageRuntimeProvenance = {
    schema: PACKAGE_RUNTIME_PROVENANCE_SCHEMA,
    product: PRODUCT_NAME,
    runtime,
    appVersion: requiredString(record.appVersion, "app version", SEMVER),
    sourceCommit: requiredString(
      record.sourceCommit,
      "source commit",
      SOURCE_COMMIT,
    ),
    state: {
      currentStateSchemaVersion: requiredInteger(
        state.currentStateSchemaVersion,
        "current state schema version",
      ),
      migrationHead: {
        fromVersion: requiredInteger(
          head.fromVersion,
          "migration head fromVersion",
        ),
        toVersion: requiredInteger(head.toVersion, "migration head toVersion"),
        name: requiredString(head.name, "migration head name"),
      },
      migrationIdentitySha256: requiredString(
        state.migrationIdentitySha256,
        "migration identity SHA-256",
        SHA256,
      ),
    },
    payload: {
      packagedPath: requiredString(payload.packagedPath, "payload path"),
      bytes: requiredInteger(payload.bytes, "payload bytes"),
      sha256: requiredString(payload.sha256, "payload SHA-256", SHA256),
    },
  };
  if (decoded.payload.packagedPath !== runtimePackagedPath(runtime)) {
    throw new Error(
      `runtime provenance payload path mismatch for ${runtime}`,
    );
  }
  if (
    decoded.state.migrationHead.toVersion !==
      decoded.state.currentStateSchemaVersion ||
    decoded.state.migrationHead.fromVersion !==
      decoded.state.currentStateSchemaVersion - 1
  ) {
    throw new Error("runtime provenance migration head is not contiguous");
  }
  return decoded;
};

const encodeProvenance = (value: PackageRuntimeProvenance): Uint8Array =>
  Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");

const writeAtomic = async (file: string, body: Uint8Array): Promise<void> => {
  const stage = `${file}.new.${String(process.pid)}.${randomUUID()}`;
  await writeFile(stage, body, { flag: "wx", mode: 0o644 });
  try {
    await rename(stage, file);
  } catch (error) {
    await rm(stage, { force: true });
    throw error;
  }
};

const writeRuntimeProvenance = async (input: {
  readonly repoRoot: string;
  readonly runtime: PackageRuntime;
  readonly source: PackageSourceFacts;
}): Promise<PackageRuntimeProvenance> => {
  const payloadRelative =
    input.runtime === "electron-main"
      ? MAIN_PAYLOAD_SOURCE_RELATIVE
      : REMOTE_ENTRY_SOURCE_RELATIVE;
  const provenanceRelative =
    input.runtime === "electron-main"
      ? MAIN_PROVENANCE_SOURCE_RELATIVE
      : REMOTE_PROVENANCE_SOURCE_RELATIVE;
  const payloadPath = path.join(input.repoRoot, payloadRelative);
  const provenancePath = path.join(input.repoRoot, provenanceRelative);
  await requireRegularFile(payloadPath, `${input.runtime} payload`);
  await requireDirectory(path.dirname(provenancePath), "provenance output parent");
  const provenance = makePackageRuntimeProvenance({
    runtime: input.runtime,
    source: input.source,
    payload: await readFile(payloadPath),
  });
  await writeAtomic(provenancePath, encodeProvenance(provenance));
  return provenance;
};

/** Remove exactly out/remote. Refuse symlinked output parents. */
export const resetOwnedRemoteOutput = async (repoRoot: string): Promise<void> => {
  const root = path.resolve(repoRoot);
  await requireDirectory(root, "repository root");
  const out = path.join(root, "out");
  try {
    await requireDirectory(out, "out directory");
  } catch (error) {
    const metadata = await lstat(out).catch(() => undefined);
    if (metadata !== undefined) throw error;
    await mkdir(out, { mode: 0o755 });
  }
  const remote = path.join(out, "remote");
  const relative = path.relative(root, remote);
  if (
    relative !== path.join("out", "remote") ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error("remote output escaped the repository");
  }
  const metadata = await lstat(remote).catch(() => undefined);
  if (metadata?.isSymbolicLink()) {
    throw new Error("out/remote must not be a symlink");
  }
  if (metadata !== undefined && !metadata.isDirectory()) {
    throw new Error("out/remote must be a directory when present");
  }
  await rm(remote, { recursive: true, force: true });
  await mkdir(remote, { mode: 0o755 });
};

export const preparePackageRuntimes = async (input: {
  readonly repoRoot: string;
  readonly target: PackageTarget;
  readonly source?: PackageSourceFacts;
  readonly buildRemote?: (repoRoot: string) => Promise<void>;
}): Promise<{
  readonly target: PackageTarget;
  readonly source: PackageSourceFacts;
  readonly main: PackageRuntimeProvenance;
  readonly remote?: PackageRuntimeProvenance;
}> => {
  const repoRoot = path.resolve(input.repoRoot);
  const target = requireTarget(input.target);
  const source =
    input.source ??
    (await readPackageSourceFacts({ repoRoot, requireClean: true }));
  const main = await writeRuntimeProvenance({
    repoRoot,
    runtime: "electron-main",
    source,
  });
  if (target === "mac") return { target, source, main };

  await resetOwnedRemoteOutput(repoRoot);
  await (input.buildRemote ?? (async (root) => {
    await buildRemoteEntryBundle({ repoRoot: root });
  }))(repoRoot);
  const remote = await writeRuntimeProvenance({
    repoRoot,
    runtime: "linux-remote",
    source,
  });
  return { target, source, main, remote };
};

const sameSchemaFacts = (
  actual: PackageSchemaFacts,
  expected: PackageSchemaFacts,
): boolean =>
  actual.currentStateSchemaVersion === expected.currentStateSchemaVersion &&
  actual.migrationHead.fromVersion === expected.migrationHead.fromVersion &&
  actual.migrationHead.toVersion === expected.migrationHead.toVersion &&
  actual.migrationHead.name === expected.migrationHead.name &&
  actual.migrationIdentitySha256 === expected.migrationIdentitySha256;

const verifyRuntimeProvenance = (input: {
  readonly runtime: PackageRuntime;
  readonly manifest: Uint8Array;
  readonly payload: Uint8Array;
  readonly expected: PackageSourceFacts;
}): VerifiedRuntimeProvenance => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(input.manifest).toString("utf8"));
  } catch {
    throw new Error(`${input.runtime} provenance is not valid JSON`);
  }
  const provenance = decodePackageRuntimeProvenance(parsed);
  if (provenance.runtime !== input.runtime) {
    throw new Error(`${input.runtime} provenance names ${provenance.runtime}`);
  }
  if (
    provenance.appVersion !== input.expected.appVersion ||
    provenance.sourceCommit !== input.expected.sourceCommit ||
    !sameSchemaFacts(provenance.state, input.expected)
  ) {
    throw new Error(`${input.runtime} provenance does not match package source`);
  }
  const payloadSha256 = sha256(input.payload);
  if (
    provenance.payload.bytes !== input.payload.byteLength ||
    provenance.payload.sha256 !== payloadSha256
  ) {
    throw new Error(`${input.runtime} payload hash does not match provenance`);
  }
  return {
    runtime: input.runtime,
    manifestSha256: sha256(input.manifest),
    payloadSha256,
    payloadBytes: input.payload.byteLength,
    packagedPath: provenance.payload.packagedPath,
  };
};

const readSourceRuntime = async (input: {
  readonly repoRoot: string;
  readonly runtime: PackageRuntime;
  readonly expected: PackageSourceFacts;
}): Promise<VerifiedRuntimeProvenance> => {
  const provenanceRelative =
    input.runtime === "electron-main"
      ? MAIN_PROVENANCE_SOURCE_RELATIVE
      : REMOTE_PROVENANCE_SOURCE_RELATIVE;
  const payloadRelative =
    input.runtime === "electron-main"
      ? MAIN_PAYLOAD_SOURCE_RELATIVE
      : REMOTE_ENTRY_SOURCE_RELATIVE;
  const manifestPath = path.join(input.repoRoot, provenanceRelative);
  const payloadPath = path.join(input.repoRoot, payloadRelative);
  await requireRegularFile(manifestPath, `${input.runtime} provenance`);
  await requireRegularFile(payloadPath, `${input.runtime} payload`);
  return verifyRuntimeProvenance({
    runtime: input.runtime,
    manifest: await readFile(manifestPath),
    payload: await readFile(payloadPath),
    expected: input.expected,
  });
};

export const verifyPreparedPackageRuntimes = async (input: {
  readonly repoRoot: string;
  readonly target: PackageTarget;
  readonly expected?: PackageSourceFacts;
}): Promise<PackageRuntimeParityVerification> => {
  const repoRoot = path.resolve(input.repoRoot);
  const target = requireTarget(input.target);
  const expected =
    input.expected ??
    (await readPackageSourceFacts({ repoRoot, requireClean: true }));
  const electronMain = await readSourceRuntime({
    repoRoot,
    runtime: "electron-main",
    expected,
  });
  const linuxRemote =
    target === "linux"
      ? await readSourceRuntime({
          repoRoot,
          runtime: "linux-remote",
          expected,
        })
      : undefined;
  return {
    target,
    appVersion: expected.appVersion,
    sourceCommit: expected.sourceCommit,
    state: {
      currentStateSchemaVersion: expected.currentStateSchemaVersion,
      migrationHead: expected.migrationHead,
      migrationIdentitySha256: expected.migrationIdentitySha256,
    },
    runtimes: {
      electronMain,
      ...(linuxRemote === undefined ? {} : { linuxRemote }),
    },
  };
};

const asarEntry = (value: string): string =>
  value.replaceAll("\\", "/").replace(/^\/+/, "");

const assertAsarHasNoRemote = (asarPath: string): void => {
  const remoteEntries = listPackage(asarPath, { isPack: false })
    .map(asarEntry)
    .filter(
      (entry) => entry === "out/remote" || entry.startsWith("out/remote/"),
    );
  if (remoteEntries.length > 0) {
    throw new Error(
      `Electron app.asar must exclude the Remote runtime (${remoteEntries[0]})`,
    );
  }
};

const extractRequired = (
  asarPath: string,
  relative: string,
  label: string,
): Buffer => {
  try {
    return extractFile(asarPath, relative);
  } catch {
    throw new Error(`${label} is missing from app.asar: ${relative}`);
  }
};

const verifyPackagedVersion = (
  asarPath: string,
  expectedVersion: string,
): void => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      extractRequired(asarPath, "package.json", "package.json").toString(
        "utf8",
      ),
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("missing from")) {
      throw error;
    }
    throw new Error("packaged package.json is invalid");
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== expectedVersion
  ) {
    throw new Error("packaged app version does not match package source");
  }
};

export const verifyPackagedRuntimeParity = async (input: {
  readonly repoRoot: string;
  readonly target: PackageTarget;
  readonly appBundle?: string;
  readonly runtimeRoot?: string;
  readonly expected?: PackageSourceFacts;
}): Promise<PackageRuntimeParityVerification> => {
  const repoRoot = path.resolve(input.repoRoot);
  const target = requireTarget(input.target);
  const expected =
    input.expected ??
    (await readPackageSourceFacts({ repoRoot, requireClean: true }));
  let asarPath: string;
  let runtimeRoot: string | undefined;
  if (target === "mac") {
    if (input.appBundle === undefined) {
      throw new Error("mac package verification requires --app");
    }
    const appBundle = path.resolve(input.appBundle);
    await requireDirectory(appBundle, "macOS app bundle");
    asarPath = path.join(appBundle, "Contents/Resources/app.asar");
  } else {
    if (input.runtimeRoot === undefined) {
      throw new Error("Linux package verification requires --runtime");
    }
    runtimeRoot = path.resolve(input.runtimeRoot);
    await requireDirectory(runtimeRoot, "Linux runtime root");
    asarPath = path.join(runtimeRoot, "resources/app.asar");
  }
  await requireRegularFile(asarPath, "packaged app.asar");
  assertAsarHasNoRemote(asarPath);
  verifyPackagedVersion(asarPath, expected.appVersion);

  const electronMain = verifyRuntimeProvenance({
    runtime: "electron-main",
    manifest: extractRequired(
      asarPath,
      MAIN_PROVENANCE_PACKAGED_RELATIVE,
      "Electron main provenance",
    ),
    payload: extractRequired(
      asarPath,
      MAIN_PAYLOAD_PACKAGED_RELATIVE,
      "Electron main payload",
    ),
    expected,
  });

  let linuxRemote: VerifiedRuntimeProvenance | undefined;
  if (target === "linux") {
    const admittedRoot = runtimeRoot as string;
    const manifestPath = path.join(
      admittedRoot,
      REMOTE_PROVENANCE_PACKAGED_RELATIVE,
    );
    const payloadPath = path.join(
      admittedRoot,
      REMOTE_PAYLOAD_PACKAGED_RELATIVE,
    );
    await requireRegularFile(manifestPath, "packaged Linux Remote provenance");
    await requireRegularFile(payloadPath, "packaged Linux Remote payload");
    linuxRemote = verifyRuntimeProvenance({
      runtime: "linux-remote",
      manifest: await readFile(manifestPath),
      payload: await readFile(payloadPath),
      expected,
    });
    if (
      linuxRemote.runtime !== "linux-remote" ||
      electronMain.runtime !== "electron-main"
    ) {
      throw new Error("package runtime identity mismatch");
    }
  }

  return {
    target,
    appVersion: expected.appVersion,
    sourceCommit: expected.sourceCommit,
    state: {
      currentStateSchemaVersion: expected.currentStateSchemaVersion,
      migrationHead: expected.migrationHead,
      migrationIdentitySha256: expected.migrationIdentitySha256,
    },
    runtimes: {
      electronMain,
      ...(linuxRemote === undefined ? {} : { linuxRemote }),
    },
  };
};

const parseOptions = (
  args: ReadonlyArray<string>,
): Map<string, string> => {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--")) {
      throw new Error("package runtime provenance options require --name value pairs");
    }
    if (options.has(flag)) throw new Error(`duplicate option: ${flag}`);
    options.set(flag, value);
  }
  return options;
};

const requiredOption = (options: Map<string, string>, name: string): string => {
  const value = options.get(name);
  if (value === undefined || value.length === 0) {
    throw new Error(`missing required option: ${name}`);
  }
  return value;
};

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  const [command, ...rawOptions] = process.argv.slice(2);
  const options = parseOptions(rawOptions);
  const root = path.resolve(options.get("--repo") ?? repoRoot);
  const target = requireTarget(requiredOption(options, "--target"));
  let receipt: unknown;
  if (command === "preflight") {
    receipt = await readPackageSourceFacts({
      repoRoot: root,
      requireClean: true,
    });
  } else if (command === "prepare") {
    receipt = await preparePackageRuntimes({ repoRoot: root, target });
  } else if (command === "verify-source") {
    receipt = await verifyPreparedPackageRuntimes({
      repoRoot: root,
      target,
    });
  } else if (command === "verify-package") {
    receipt = await verifyPackagedRuntimeParity({
      repoRoot: root,
      target,
      ...(target === "mac"
        ? { appBundle: requiredOption(options, "--app") }
        : { runtimeRoot: requiredOption(options, "--runtime") }),
    });
  } else {
    throw new Error(
      "usage: package-runtime-provenance.ts preflight|prepare|verify-source --target mac|linux [--repo PATH] | verify-package --target mac --app PATH [--repo PATH] | verify-package --target linux --runtime PATH [--repo PATH]",
    );
  }
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
