#!/usr/bin/env bun
/**
 * Build the runtimes shipped by one package target and prove that package bytes
 * are the exact outputs from that build and committed source.
 */
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractFile, getRawHeader, uncache } from "@electron/asar";

export const PACKAGE_RUNTIME_PROVENANCE_SCHEMA =
  "junto/package-runtime-provenance/v2" as const;
export const RUNTIME_BUILD_IDENTITY_SCHEMA =
  "junto/runtime-build-identity/v1" as const;
export const MAIN_PROVENANCE_SOURCE_RELATIVE =
  "out/package-runtime-provenance.json" as const;
export const MAIN_PAYLOAD_SOURCE_RELATIVE = "out/main/index.js" as const;
export const MAIN_PROVENANCE_PACKAGED_RELATIVE =
  "out/package-runtime-provenance.json" as const;
export const MAIN_PAYLOAD_PACKAGED_RELATIVE = "out/main/index.js" as const;

const PRODUCT_NAME = "Junto" as const;
const SOURCE_COMMIT = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
// Strict SemVer 2.0.0 admission: numeric prerelease identifiers may not
// contain leading zeroes, while build metadata permits them.
const SEMVER =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const BUILD_MARKER =
  /\/\* JUNTO_RUNTIME_BUILD_IDENTITY:([A-Za-z0-9_-]+) \*\//gu;

export type PackageRuntime = "electron-main";
export type PackageTarget = "mac" | "linux";

export type PackageSchemaFacts = {
  readonly currentStateSchemaVersion: number;
  /** The version-1 baseline has no migration; later versions require a head. */
  readonly migrationHead: {
    readonly fromVersion: number;
    readonly toVersion: number;
    readonly name: string;
  } | null;
  readonly migrationIdentitySha256: string;
};

export type PackageSourceFacts = PackageSchemaFacts & {
  readonly appVersion: string;
  readonly sourceCommit: string;
};

export type RuntimeBuildIdentity = {
  readonly schema: typeof RUNTIME_BUILD_IDENTITY_SCHEMA;
  readonly cohortNonce: string;
  readonly sourceCommit: string;
  readonly runtime: PackageRuntime;
};

export type PackageRuntimeProvenance = {
  readonly schema: typeof PACKAGE_RUNTIME_PROVENANCE_SCHEMA;
  readonly product: typeof PRODUCT_NAME;
  readonly runtime: PackageRuntime;
  readonly appVersion: string;
  readonly sourceCommit: string;
  readonly buildIdentity: RuntimeBuildIdentity;
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
  readonly buildIdentity: RuntimeBuildIdentity;
};

export type PackageRuntimeParityVerification = {
  readonly target: PackageTarget;
  readonly appVersion: string;
  readonly sourceCommit: string;
  readonly cohortNonce: string;
  readonly state: PackageSchemaFacts;
  readonly compiledRuntimes: {
    readonly electronMain: VerifiedRuntimeProvenance;
  };
  readonly runtimes: {
    readonly electronMain: VerifiedRuntimeProvenance;
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
  if (value !== "electron-main") {
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

const lstatIfPresent = async (file: string) => {
  try {
    return await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

const requireRegularFile = async (file: string, label: string): Promise<void> => {
  const metadata = await lstatIfPresent(file);
  if (
    metadata === undefined ||
    !metadata.isFile() ||
    metadata.isSymbolicLink()
  ) {
    throw new Error(`${label} must be a non-symlink regular file: ${file}`);
  }
};

const requireDirectory = async (
  directory: string,
  label: string,
): Promise<void> => {
  const metadata = await lstatIfPresent(directory);
  if (
    metadata === undefined ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink()
  ) {
    throw new Error(`${label} must be a non-symlink directory: ${directory}`);
  }
};

const runGit = (
  repoRoot: string,
  args: ReadonlyArray<string>,
  options: { readonly nul?: boolean } = {},
): string | Buffer => {
  const env = { ...process.env };
  for (const key of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_OBJECT_DIRECTORY",
    "GIT_INDEX_FILE",
    "GIT_WORK_TREE",
    "GIT_DIR",
    "GIT_COMMON_DIR",
  ]) {
    delete env[key];
  }
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: options.nul === true ? "buffer" : "utf8",
    shell: false,
    maxBuffer: 256 * 1024 * 1024,
    env,
  });
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8")
      : result.stderr;
    const stdout = Buffer.isBuffer(result.stdout)
      ? result.stdout.toString("utf8")
      : result.stdout;
    throw new Error(
      `git ${args.join(" ")} failed: ${(stderr || stdout || "").trim() || `exit ${String(result.status)}`}`,
    );
  }
  return result.stdout;
};

const runGitText = (repoRoot: string, args: ReadonlyArray<string>): string =>
  String(runGit(repoRoot, args)).trim();

const runGitNul = (repoRoot: string, args: ReadonlyArray<string>): string[] =>
  (runGit(repoRoot, args, { nul: true }) as Buffer)
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry.length > 0);

const gitBlobSha1 = (body: Uint8Array): string =>
  createHash("sha1")
    .update(`blob ${String(body.byteLength)}\0`)
    .update(body)
    .digest("hex");

const unsafeIndexFlag = (entry: string): boolean => {
  const tag = entry[0] ?? "";
  return tag === "S" || (tag >= "a" && tag <= "z");
};

/**
 * Verify checkout bytes and executable modes against HEAD without consulting
 * assume-unchanged/skip-worktree hints. Also reject source-affecting extras.
 */
export const assertExactCommittedCheckout = async (
  repoRootInput: string,
): Promise<{ readonly commit: string; readonly tree: string }> => {
  const repoRoot = path.resolve(repoRootInput);
  await requireDirectory(repoRoot, "repository root");
  if (runGitText(repoRoot, ["rev-parse", "--show-object-format"]) !== "sha1") {
    throw new Error("package source requires a SHA-1 Git object repository");
  }
  const commit = requiredString(
    runGitText(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"]),
    "source commit",
    SOURCE_COMMIT,
  );
  const tree = runGitText(repoRoot, ["rev-parse", "HEAD^{tree}"]);
  if (runGitText(repoRoot, ["write-tree"]) !== tree) {
    throw new Error("package source index tree differs from HEAD");
  }

  const flagged = runGitNul(repoRoot, ["ls-files", "-v", "-z"]).find(
    unsafeIndexFlag,
  );
  if (flagged !== undefined) {
    throw new Error(
      `package source rejects assume-unchanged/skip-worktree index flag: ${flagged.slice(2)}`,
    );
  }

  const tracked = runGitNul(repoRoot, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    "HEAD",
  ]);
  for (const entry of tracked) {
    const separator = entry.indexOf("\t");
    if (separator < 0) throw new Error("invalid git ls-tree entry");
    const header = entry.slice(0, separator).split(" ");
    const relative = entry.slice(separator + 1);
    const [mode, type, expectedOid] = header;
    if (mode === undefined || type === undefined || expectedOid === undefined) {
      throw new Error("invalid git ls-tree header");
    }
    if (type !== "blob") {
      throw new Error(`package source cannot use tracked ${type}: ${relative}`);
    }
    const absolute = path.join(repoRoot, relative);
    const metadata = await lstatIfPresent(absolute);
    if (metadata === undefined) {
      throw new Error(`tracked package source is missing: ${relative}`);
    }
    let body: Buffer;
    if (mode === "120000") {
      if (!metadata.isSymbolicLink()) {
        throw new Error(`tracked symlink changed type: ${relative}`);
      }
      body = Buffer.from(await readlink(absolute), "utf8");
    } else if (mode === "100644" || mode === "100755") {
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(`tracked source changed file type: ${relative}`);
      }
      const executable = (metadata.mode & 0o111) !== 0;
      if (executable !== (mode === "100755")) {
        throw new Error(`tracked source mode differs from HEAD: ${relative}`);
      }
      body = await readFile(absolute);
    } else {
      throw new Error(`unsupported tracked source mode ${mode}: ${relative}`);
    }
    if (gitBlobSha1(body) !== expectedOid) {
      throw new Error(`tracked source bytes differ from HEAD: ${relative}`);
    }
  }

  const untracked = runGitNul(repoRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  if (untracked.length > 0) {
    throw new Error(`package source has untracked input: ${untracked[0]}`);
  }
  const ignoredSource = runGitNul(repoRoot, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "-z",
    "--",
    "src",
    "scripts",
    "station",
    "assets",
    "build",
    ":(top,glob).env*",
    ":(top,glob)electron.vite.config.*",
    ":(top,glob)tsconfig*.json",
    ":(top,glob)bunfig*",
  ]);
  if (ignoredSource.length > 0) {
    throw new Error(
      `package source has ignored source-affecting input: ${ignoredSource[0]}`,
    );
  }
  return { commit, tree };
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
    "src/main/junto/state/migrations.ts",
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
  if (currentStateSchemaVersion < 1) {
    throw new Error("current state schema version must be at least 1");
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
  if (currentStateSchemaVersion === 1 && migrations.length !== 0) {
    throw new Error("schema v1 baseline must have no migrations");
  }
  if (currentStateSchemaVersion > 1 && heads.length !== 1) {
    throw new Error(
      `schema v${String(currentStateSchemaVersion)} must have exactly one migration head`,
    );
  }
  const migrationHead = heads[0] ?? null;
  if (
    migrationHead !== null && (
      migrationHead.fromVersion !== currentStateSchemaVersion - 1 ||
      migrationHead.name.length === 0
    )
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
  if (input.requireClean !== false) {
    await assertExactCommittedCheckout(repoRoot);
  }
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
    runGitText(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"]),
    "source commit",
    SOURCE_COMMIT,
  );
  const expectedSourceCommit =
    input.expectedSourceCommit ?? process.env.JUNTO_SOURCE_COMMIT;
  if (
    expectedSourceCommit !== undefined &&
    requiredString(
      expectedSourceCommit,
      "JUNTO_SOURCE_COMMIT",
      SOURCE_COMMIT,
    ) !== sourceCommit
  ) {
    throw new Error(
      `source commit mismatch: checkout=${sourceCommit} expected=${expectedSourceCommit}`,
    );
  }
  const schema = await readPackageSchemaFacts(repoRoot);
  // Construct the admitted value ourselves from primitive reads. Freeze both
  // levels so downstream compiler and qualifier operations cannot mutate it.
  const migrationHead = schema.migrationHead === null ? null : Object.freeze({
    fromVersion: schema.migrationHead.fromVersion,
    toVersion: schema.migrationHead.toVersion,
    name: schema.migrationHead.name,
  });
  return Object.freeze({
    appVersion,
    sourceCommit,
    currentStateSchemaVersion: schema.currentStateSchemaVersion,
    migrationHead,
    migrationIdentitySha256: schema.migrationIdentitySha256,
  });
};

type PackageSourceFactsEquality = (
  root: PackageSourceFacts,
  clone: PackageSourceFacts,
) => boolean;
type PackageSourceFactsEqualityEntry = {
  readonly label: string;
  readonly equal: PackageSourceFactsEquality;
  readonly values: (
    root: PackageSourceFacts,
    clone: PackageSourceFacts,
  ) => readonly [unknown, unknown];
};

// Keep this map exhaustive so adding a source fact cannot silently bypass the
// parity comparison. Nested migration-head fields have their own exhaustive
// map for the same reason.
const PACKAGE_SOURCE_MIGRATION_HEAD_EQUALITY = {
  fromVersion: {
    label: "migrationHead.fromVersion",
    equal: (root, clone) =>
      root.migrationHead?.fromVersion === clone.migrationHead?.fromVersion,
    values: (root, clone) => [
      root.migrationHead?.fromVersion,
      clone.migrationHead?.fromVersion,
    ],
  },
  toVersion: {
    label: "migrationHead.toVersion",
    equal: (root, clone) =>
      root.migrationHead?.toVersion === clone.migrationHead?.toVersion,
    values: (root, clone) => [
      root.migrationHead?.toVersion,
      clone.migrationHead?.toVersion,
    ],
  },
  name: {
    label: "migrationHead.name",
    equal: (root, clone) => root.migrationHead?.name === clone.migrationHead?.name,
    values: (root, clone) => [root.migrationHead?.name, clone.migrationHead?.name],
  },
} as const satisfies Record<
  keyof NonNullable<PackageSourceFacts["migrationHead"]>,
  PackageSourceFactsEqualityEntry
>;

const PACKAGE_SOURCE_FACTS_EQUALITY = {
  appVersion: {
    label: "appVersion",
    equal: (root, clone) => root.appVersion === clone.appVersion,
    values: (root, clone) => [root.appVersion, clone.appVersion],
  },
  sourceCommit: {
    label: "sourceCommit",
    equal: (root, clone) => root.sourceCommit === clone.sourceCommit,
    values: (root, clone) => [root.sourceCommit, clone.sourceCommit],
  },
  currentStateSchemaVersion: {
    label: "currentStateSchemaVersion",
    equal: (root, clone) =>
      root.currentStateSchemaVersion === clone.currentStateSchemaVersion,
    values: (root, clone) => [
      root.currentStateSchemaVersion,
      clone.currentStateSchemaVersion,
    ],
  },
  migrationHead: {
    label: "migrationHead",
    equal: (root, clone) =>
      Object.values(PACKAGE_SOURCE_MIGRATION_HEAD_EQUALITY).every(({ equal }) =>
        equal(root, clone),
      ),
    values: (root, clone) => [root.migrationHead, clone.migrationHead],
  },
  migrationIdentitySha256: {
    label: "currentStateSchemaIdentity",
    equal: (root, clone) =>
      root.migrationIdentitySha256 === clone.migrationIdentitySha256,
    values: (root, clone) => [
      root.migrationIdentitySha256,
      clone.migrationIdentitySha256,
    ],
  },
} as const satisfies Record<
  keyof PackageSourceFacts,
  PackageSourceFactsEqualityEntry
>;

export type PackageSourceFactsComparison = {
  readonly root: PackageSourceFacts;
  readonly clone: PackageSourceFacts;
};

/** Compare every source fact, including every migration-head field. */
export const assertPackageSourceFactsEqual = (
  rootFacts: PackageSourceFacts,
  cloneFacts: PackageSourceFacts,
): PackageSourceFactsComparison => {
  for (const [key, entry] of Object.entries(PACKAGE_SOURCE_FACTS_EQUALITY)) {
    if (entry.equal(rootFacts, cloneFacts)) continue;
    if (key === "migrationHead") {
      for (const headEntry of Object.values(
        PACKAGE_SOURCE_MIGRATION_HEAD_EQUALITY,
      )) {
        if (!headEntry.equal(rootFacts, cloneFacts)) {
          const [rootValue, cloneValue] = headEntry.values(
            rootFacts,
            cloneFacts,
          );
          throw new Error(
            `isolated clone PackageSourceFacts mismatch for ${headEntry.label}: root=${String(rootValue)} clone=${String(cloneValue)}`,
          );
        }
      }
    }
    const [rootValue, cloneValue] = entry.values(rootFacts, cloneFacts);
    throw new Error(
      `isolated clone PackageSourceFacts mismatch for ${entry.label}: root=${String(rootValue)} clone=${String(cloneValue)}`,
    );
  }
  return { root: rootFacts, clone: cloneFacts };
};

const decodeRuntimeBuildIdentity = (input: unknown): RuntimeBuildIdentity => {
  const record = requiredRecord(input, "runtime build identity");
  if (record.schema !== RUNTIME_BUILD_IDENTITY_SCHEMA) {
    throw new Error("invalid runtime build identity schema");
  }
  return {
    schema: RUNTIME_BUILD_IDENTITY_SCHEMA,
    cohortNonce: requiredString(record.cohortNonce, "cohort nonce", UUID),
    sourceCommit: requiredString(
      record.sourceCommit,
      "build identity source commit",
      SOURCE_COMMIT,
    ),
    runtime: requireRuntime(record.runtime),
  };
};

export const extractRuntimeBuildIdentity = (
  payload: Uint8Array,
): RuntimeBuildIdentity => {
  const body = Buffer.from(payload).toString("utf8");
  const matches = [...body.matchAll(BUILD_MARKER)];
  if (matches.length !== 1) {
    throw new Error(
      `compiled runtime must contain exactly one build identity marker (found ${String(matches.length)})`,
    );
  }
  const match = matches[0];
  if (match === undefined || match.index === undefined) {
    throw new Error("compiled runtime build identity marker is malformed");
  }
  const suffix = body.slice(match.index + match[0].length);
  if (!/^\s*$/u.test(suffix)) {
    throw new Error("compiled runtime build identity must be the final marker");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      Buffer.from(requiredString(match[1], "build identity body"), "base64url").toString(
        "utf8",
      ),
    );
  } catch {
    throw new Error("compiled runtime build identity is not valid JSON");
  }
  return decodeRuntimeBuildIdentity(decoded);
};

export const embedRuntimeBuildIdentity = (input: {
  readonly payload: Uint8Array;
  readonly identity: RuntimeBuildIdentity;
}): Buffer => {
  if ([...Buffer.from(input.payload).toString("utf8").matchAll(BUILD_MARKER)].length > 0) {
    throw new Error("compiler output already contains a runtime build identity");
  }
  const encoded = Buffer.from(JSON.stringify(input.identity), "utf8").toString(
    "base64url",
  );
  return Buffer.concat([
    Buffer.from(input.payload),
    Buffer.from(`\n/* JUNTO_RUNTIME_BUILD_IDENTITY:${encoded} */\n`, "utf8"),
  ]);
};

export const makePackageRuntimeProvenance = (input: {
  readonly runtime: PackageRuntime;
  readonly source: PackageSourceFacts;
  readonly payload: Uint8Array;
}): PackageRuntimeProvenance => {
  const buildIdentity = extractRuntimeBuildIdentity(input.payload);
  if (
    buildIdentity.runtime !== input.runtime ||
    buildIdentity.sourceCommit !== input.source.sourceCommit
  ) {
    throw new Error("compiled runtime identity does not match source/runtime");
  }
  return {
    schema: PACKAGE_RUNTIME_PROVENANCE_SCHEMA,
    product: PRODUCT_NAME,
    runtime: input.runtime,
    appVersion: input.source.appVersion,
    sourceCommit: input.source.sourceCommit,
    buildIdentity,
    state: {
      currentStateSchemaVersion: input.source.currentStateSchemaVersion,
      migrationHead: input.source.migrationHead,
      migrationIdentitySha256: input.source.migrationIdentitySha256,
    },
    payload: {
      packagedPath: MAIN_PAYLOAD_PACKAGED_RELATIVE,
      bytes: input.payload.byteLength,
      sha256: sha256(input.payload),
    },
  };
};

export const decodePackageRuntimeProvenance = (
  input: unknown,
): PackageRuntimeProvenance => {
  const record = requiredRecord(input, "runtime provenance");
  if (record.schema !== PACKAGE_RUNTIME_PROVENANCE_SCHEMA) {
    throw new Error("invalid runtime provenance schema");
  }
  if (record.product !== PRODUCT_NAME) {
    throw new Error("runtime provenance product is not Junto");
  }
  const runtime = requireRuntime(record.runtime);
  const state = requiredRecord(record.state, "runtime provenance state");
  const head = state.migrationHead === null
    ? null
    : requiredRecord(state.migrationHead, "migration head");
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
    buildIdentity: decodeRuntimeBuildIdentity(record.buildIdentity),
    state: {
      currentStateSchemaVersion: requiredInteger(
        state.currentStateSchemaVersion,
        "current state schema version",
      ),
      migrationHead: head === null ? null : {
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
  if (
    decoded.payload.packagedPath !== MAIN_PAYLOAD_PACKAGED_RELATIVE ||
    decoded.buildIdentity.runtime !== runtime ||
    decoded.buildIdentity.sourceCommit !== decoded.sourceCommit
  ) {
    throw new Error("runtime provenance identity/path mismatch");
  }
  const { currentStateSchemaVersion, migrationHead } = decoded.state;
  if (
    currentStateSchemaVersion === 1
      ? migrationHead !== null
      : migrationHead === null ||
        migrationHead.toVersion !== currentStateSchemaVersion ||
        migrationHead.fromVersion !== currentStateSchemaVersion - 1
  ) {
    throw new Error("runtime provenance migration head is not contiguous");
  }
  return decoded;
};

const encodeProvenance = (value: PackageRuntimeProvenance): Uint8Array =>
  Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");

const writeAtomic = async (file: string, body: Uint8Array): Promise<void> => {
  const parent = path.dirname(file);
  await requireDirectory(parent, "atomic output parent");
  const existing = await lstatIfPresent(file);
  if (existing?.isSymbolicLink() === true || (existing !== undefined && !existing.isFile())) {
    throw new Error(`atomic output destination is not a regular file: ${file}`);
  }
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
  const payloadPath = path.join(input.repoRoot, MAIN_PAYLOAD_SOURCE_RELATIVE);
  const provenancePath = path.join(input.repoRoot, MAIN_PROVENANCE_SOURCE_RELATIVE);
  await requireRegularFile(payloadPath, `${input.runtime} payload`);
  const provenance = makePackageRuntimeProvenance({
    runtime: input.runtime,
    source: input.source,
    payload: await readFile(payloadPath),
  });
  await writeAtomic(provenancePath, encodeProvenance(provenance));
  return provenance;
};

const resetOwnedOutputDirectory = async (
  repoRoot: string,
  relative: "out/main",
): Promise<void> => {
  const root = path.resolve(repoRoot);
  await requireDirectory(root, "repository root");
  const out = path.join(root, "out");
  const outMetadata = await lstatIfPresent(out);
  if (outMetadata === undefined) {
    await mkdir(out, { mode: 0o755 });
  } else if (!outMetadata.isDirectory() || outMetadata.isSymbolicLink()) {
    throw new Error("out must be a non-symlink directory");
  }
  const owned = path.join(root, relative);
  if (path.relative(root, owned) !== relative) {
    throw new Error("owned compiler output escaped repository");
  }
  const metadata = await lstatIfPresent(owned);
  if (metadata?.isSymbolicLink() === true) {
    throw new Error(`${relative} must not be a symlink`);
  }
  if (metadata !== undefined && !metadata.isDirectory()) {
    throw new Error(`${relative} must be a directory when present`);
  }
  await rm(owned, { recursive: true, force: true });
  await mkdir(owned, { mode: 0o755 });
};

const stampRuntimePayload = async (input: {
  readonly repoRoot: string;
  readonly runtime: PackageRuntime;
  readonly identity: RuntimeBuildIdentity;
}): Promise<void> => {
  const file = path.join(input.repoRoot, MAIN_PAYLOAD_SOURCE_RELATIVE);
  await requireRegularFile(file, `${input.runtime} fresh compiler output`);
  const body = embedRuntimeBuildIdentity({
    payload: await readFile(file),
    identity: input.identity,
  });
  await writeAtomic(file, body);
  await chmod(file, 0o644);
};

const runCompiler = (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
}): void => {
  const result = spawnSync(input.command, [...input.args], {
    cwd: input.cwd,
    env: process.env,
    shell: false,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `runtime compiler failed (${input.command} ${input.args.join(" ")}): exit ${String(result.status)}`,
    );
  }
};

export type PreparedPackageRuntimes = {
  readonly target: PackageTarget;
  readonly source: PackageSourceFacts;
  readonly cohortNonce: string;
  readonly main: PackageRuntimeProvenance;
};

/** One coordinator compiles the runtime shipped for the selected target. */
export const preparePackageRuntimes = async (input: {
  readonly repoRoot: string;
  readonly target: PackageTarget;
  readonly source?: PackageSourceFacts;
  readonly cohortNonce?: string;
  readonly buildMain?: (repoRoot: string) => Promise<void>;
}): Promise<PreparedPackageRuntimes> => {
  const repoRoot = path.resolve(input.repoRoot);
  const target = requireTarget(input.target);
  const source =
    input.source ??
    (await readPackageSourceFacts({ repoRoot, requireClean: true }));
  const cohortNonce = requiredString(
    input.cohortNonce ??
      process.env.JUNTO_PACKAGE_COHORT_NONCE ??
      randomUUID(),
    "cohort nonce",
    UUID,
  );

  await resetOwnedOutputDirectory(repoRoot, "out/main");
  const priorMainManifest = path.join(repoRoot, MAIN_PROVENANCE_SOURCE_RELATIVE);
  const priorMainMetadata = await lstatIfPresent(priorMainManifest);
  if (priorMainMetadata?.isSymbolicLink() === true) {
    throw new Error("Electron main provenance output must not be a symlink");
  }
  await rm(priorMainManifest, { force: true });
  await (input.buildMain ?? (async (root) => {
    runCompiler({
      command: "bunx",
      args: ["--no-install", "electron-vite", "build"],
      cwd: root,
    });
  }))(repoRoot);
  await stampRuntimePayload({
    repoRoot,
    runtime: "electron-main",
    identity: {
      schema: RUNTIME_BUILD_IDENTITY_SCHEMA,
      cohortNonce,
      sourceCommit: source.sourceCommit,
      runtime: "electron-main",
    },
  });

  if (input.source === undefined) {
    const after = await readPackageSourceFacts({
      repoRoot,
      requireClean: true,
      expectedSourceCommit: source.sourceCommit,
    });
    if (
      after.appVersion !== source.appVersion ||
      after.migrationIdentitySha256 !== source.migrationIdentitySha256
    ) {
      throw new Error("package source facts changed during compiler cohort build");
    }
  }

  // Write the manifest only after the fresh output and source re-admission pass.
  const main = await writeRuntimeProvenance({
    repoRoot,
    runtime: "electron-main",
    source,
  });
  return { target, source, cohortNonce, main };
};

const sameSchemaFacts = (
  actual: PackageSchemaFacts,
  expected: PackageSchemaFacts,
): boolean =>
  actual.currentStateSchemaVersion === expected.currentStateSchemaVersion &&
  actual.migrationHead?.fromVersion === expected.migrationHead?.fromVersion &&
  actual.migrationHead?.toVersion === expected.migrationHead?.toVersion &&
  actual.migrationHead?.name === expected.migrationHead?.name &&
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
  const buildIdentity = extractRuntimeBuildIdentity(input.payload);
  if (
    provenance.runtime !== input.runtime ||
    buildIdentity.runtime !== input.runtime ||
    JSON.stringify(buildIdentity) !== JSON.stringify(provenance.buildIdentity)
  ) {
    throw new Error(`${input.runtime} provenance/build identity mismatch`);
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
    buildIdentity,
  };
};

const readSourceRuntime = async (input: {
  readonly repoRoot: string;
  readonly runtime: PackageRuntime;
  readonly expected: PackageSourceFacts;
}): Promise<VerifiedRuntimeProvenance> => {
  const manifestPath = path.join(input.repoRoot, MAIN_PROVENANCE_SOURCE_RELATIVE);
  const payloadPath = path.join(input.repoRoot, MAIN_PAYLOAD_SOURCE_RELATIVE);
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
  return {
    target,
    appVersion: expected.appVersion,
    sourceCommit: expected.sourceCommit,
    cohortNonce: electronMain.buildIdentity.cohortNonce,
    state: {
      currentStateSchemaVersion: expected.currentStateSchemaVersion,
      migrationHead: expected.migrationHead,
      migrationIdentitySha256: expected.migrationIdentitySha256,
    },
    compiledRuntimes: { electronMain },
    runtimes: { electronMain },
  };
};

type RawAsarNode = {
  readonly path: string;
  readonly value: Record<string, unknown>;
  readonly ancestors: ReadonlyArray<Record<string, unknown>>;
};

export type ValidatedRawAsarHeader = {
  readonly paths: ReadonlyArray<string>;
  readonly nodes: ReadonlyMap<string, RawAsarNode>;
};

const requireSafeAsarLink = (value: unknown, label: string): string => {
  const link = requiredString(value, label);
  if (
    link.startsWith("/") ||
    link.includes("\\") ||
    link.includes("\0") ||
    link
      .split("/")
      .some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(`unsafe ASAR link target: ${link}`);
  }
  return link;
};

/** Validate raw keys/nodes before any ASAR path normalization or link following. */
export const validateRawAsarHeader = (input: {
  readonly header: unknown;
  readonly headerString?: string;
  readonly headerSize?: number;
  readonly archiveBytes?: number;
  readonly criticalPaths?: ReadonlyArray<string>;
}): ValidatedRawAsarHeader => {
  const header = requiredRecord(input.header, "ASAR header");
  if (
    input.headerString !== undefined &&
    input.headerString !== JSON.stringify(header)
  ) {
    throw new Error("ASAR raw header is non-canonical or has duplicate keys");
  }
  const rootFiles = requiredRecord(header.files, "ASAR root files");
  const nodes = new Map<string, RawAsarNode>();
  const normalizedPaths = new Map<string, string>();

  const walk = (
    files: Record<string, unknown>,
    parent: string,
    ancestors: ReadonlyArray<Record<string, unknown>>,
  ): void => {
    for (const [rawKey, rawValue] of Object.entries(files)) {
      if (
        rawKey.length === 0 ||
        rawKey === "." ||
        rawKey === ".." ||
        rawKey.includes("\0") ||
        rawKey.includes("/") ||
        rawKey.includes("\\")
      ) {
        throw new Error(`unsafe raw ASAR key: ${JSON.stringify(rawKey)}`);
      }
      const nodePath = parent.length === 0 ? rawKey : `${parent}/${rawKey}`;
      const normalized = nodePath.normalize("NFC");
      const collision = normalizedPaths.get(normalized);
      if (collision !== undefined && collision !== nodePath) {
        throw new Error(`normalized ASAR path collision: ${collision} / ${nodePath}`);
      }
      normalizedPaths.set(normalized, nodePath);
      if (nodes.has(nodePath)) {
        throw new Error(`duplicate ASAR path: ${nodePath}`);
      }
      const value = requiredRecord(rawValue, `ASAR node ${nodePath}`);
      const hasFiles = Object.prototype.hasOwnProperty.call(value, "files");
      const hasLink = Object.prototype.hasOwnProperty.call(value, "link");
      const hasSize = Object.prototype.hasOwnProperty.call(value, "size");
      if (Number(hasFiles) + Number(hasLink) + Number(hasSize) !== 1) {
        throw new Error(`ASAR node has an ambiguous shape: ${nodePath}`);
      }
      nodes.set(nodePath, { path: nodePath, value, ancestors });
      if (hasFiles) {
        walk(
          requiredRecord(value.files, `ASAR directory ${nodePath}`),
          nodePath,
          [...ancestors, value],
        );
      } else if (hasLink) {
        requireSafeAsarLink(value.link, `ASAR link ${nodePath}`);
      } else {
        const size = requiredInteger(value.size, `ASAR file size ${nodePath}`);
        if (value.unpacked !== true) {
          const offset = requiredString(
            value.offset,
            `ASAR file offset ${nodePath}`,
            /^(?:0|[1-9][0-9]*)$/u,
          );
          const offsetNumber = Number(offset);
          if (!Number.isSafeInteger(offsetNumber)) {
            throw new Error(`ASAR file offset is unsafe: ${nodePath}`);
          }
          if (
            input.archiveBytes !== undefined &&
            input.headerSize !== undefined &&
            8 + input.headerSize + offsetNumber + size > input.archiveBytes
          ) {
            throw new Error(`ASAR file range escapes archive: ${nodePath}`);
          }
        }
      }
    }
  };
  walk(rootFiles, "", []);

  for (const node of nodes.values()) {
    if (Object.prototype.hasOwnProperty.call(node.value, "link")) {
      const visited = new Set<string>([node.path]);
      let target = requireSafeAsarLink(node.value.link, `ASAR link ${node.path}`);
      while (true) {
        const targetNode = nodes.get(target);
        if (targetNode === undefined) {
          throw new Error(`ASAR link target is missing: ${node.path} -> ${target}`);
        }
        if (!Object.prototype.hasOwnProperty.call(targetNode.value, "link")) break;
        if (visited.has(target)) throw new Error(`ASAR link cycle: ${node.path}`);
        visited.add(target);
        target = requireSafeAsarLink(
          targetNode.value.link,
          `ASAR link ${targetNode.path}`,
        );
      }
    }
  }

  for (const critical of input.criticalPaths ?? []) {
    const node = nodes.get(critical);
    if (node === undefined) {
      throw new Error(`critical ASAR entry is missing: ${critical}`);
    }
    if (
      Object.prototype.hasOwnProperty.call(node.value, "link") ||
      Object.prototype.hasOwnProperty.call(node.value, "files") ||
      node.value.unpacked === true ||
      node.ancestors.some(
        (ancestor) =>
          ancestor.unpacked === true ||
          Object.prototype.hasOwnProperty.call(ancestor, "link"),
      )
    ) {
      throw new Error(
        `critical ASAR entry must be a direct packed regular file: ${critical}`,
      );
    }
  }
  return {
    paths: [...nodes.keys()].sort((left, right) => left.localeCompare(right)),
    nodes,
  };
};

export const validateRawAsarArchive = async (
  asarPath: string,
  criticalPaths: ReadonlyArray<string> = [
    "package.json",
    MAIN_PROVENANCE_PACKAGED_RELATIVE,
    MAIN_PAYLOAD_PACKAGED_RELATIVE,
  ],
): Promise<ValidatedRawAsarHeader> => {
  await requireRegularFile(asarPath, "packaged app.asar");
  uncache(asarPath);
  const raw = getRawHeader(asarPath);
  const metadata = await lstat(asarPath);
  return validateRawAsarHeader({
    header: raw.header,
    headerString: raw.headerString,
    headerSize: raw.headerSize,
    archiveBytes: metadata.size,
    criticalPaths,
  });
};

const extractRequired = (
  asarPath: string,
  relative: string,
  label: string,
): Buffer => {
  try {
    return extractFile(asarPath, relative, false);
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
      extractRequired(asarPath, "package.json", "package.json").toString("utf8"),
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("missing from")) {
      throw error;
    }
    throw new Error("packaged package.json is invalid");
  }
  if (!isRecord(parsed) || parsed.version !== expectedVersion) {
    throw new Error("packaged app version does not match package source");
  }
};

const requireExactCompiledRuntime = (
  packaged: VerifiedRuntimeProvenance,
  compiled: VerifiedRuntimeProvenance,
): void => {
  if (
    packaged.runtime !== compiled.runtime ||
    packaged.manifestSha256 !== compiled.manifestSha256 ||
    packaged.payloadSha256 !== compiled.payloadSha256 ||
    packaged.payloadBytes !== compiled.payloadBytes ||
    JSON.stringify(packaged.buildIdentity) !== JSON.stringify(compiled.buildIdentity)
  ) {
    throw new Error(
      `${packaged.runtime} package bytes differ from the exact fresh compiler output`,
    );
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
  const prepared = await verifyPreparedPackageRuntimes({
    repoRoot,
    target,
    expected,
  });
  let asarPath: string;
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
    const runtimeRoot = path.resolve(input.runtimeRoot);
    await requireDirectory(runtimeRoot, "Linux runtime root");
    asarPath = path.join(runtimeRoot, "resources/app.asar");
  }
  await validateRawAsarArchive(asarPath);
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
  requireExactCompiledRuntime(
    electronMain,
    prepared.compiledRuntimes.electronMain,
  );

  return {
    target,
    appVersion: expected.appVersion,
    sourceCommit: expected.sourceCommit,
    cohortNonce: prepared.cohortNonce,
    state: {
      currentStateSchemaVersion: expected.currentStateSchemaVersion,
      migrationHead: expected.migrationHead,
      migrationIdentitySha256: expected.migrationIdentitySha256,
    },
    compiledRuntimes: prepared.compiledRuntimes,
    runtimes: { electronMain },
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
      throw new Error(
        "package runtime provenance options require --name value pairs",
      );
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
  if (command === "prepare") {
    receipt = await preparePackageRuntimes({ repoRoot: root, target });
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
      "usage: package-runtime-provenance.ts prepare --target mac|linux [--repo PATH] | verify-package --target mac --app PATH [--repo PATH] | verify-package --target linux --runtime PATH [--repo PATH]",
    );
  }
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
