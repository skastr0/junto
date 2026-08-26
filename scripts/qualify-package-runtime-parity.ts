#!/usr/bin/env bun
/**
 * Build the Linux package from an isolated clean clone, plant a synthetic
 * schema-18 Remote output before the official command runs, extract the new
 * archive, and prove Electron main and Linux Remote have one provenance cohort.
 *
 * This command never accepts a prebuilt candidate and never edits a published
 * artifact. Its only persistent output is the requested JSON receipt.
 */
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PACKAGE_RUNTIME_PROVENANCE_SCHEMA,
  REMOTE_PROVENANCE_SOURCE_RELATIVE,
  makePackageRuntimeProvenance,
  readPackageSourceFacts,
  sha256File,
  verifyPackagedRuntimeParity,
  type PackageRuntimeParityVerification,
  type PackageSourceFacts,
} from "./package-runtime-provenance";
import { REMOTE_ENTRY_SOURCE_RELATIVE } from "./build-linux-remote-runtime";
import {
  linuxRuntimeArtifactName,
  validateLinuxRuntimeArchive,
} from "./finalize-linux-package";

export const PACKAGE_RUNTIME_PARITY_RECEIPT_SCHEMA =
  "vellum-command/package-runtime-parity-receipt/v1" as const;
export const HISTORICAL_COMPARISON_RELATIVE =
  "tests/fixtures/package-runtime-parity/public-0.1.14-schema18-historical.json" as const;

const SOURCE_COMMIT = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const PRODUCT_NAME = "Vellum Command" as const;

export type HistoricalPackageComparison = {
  readonly schema: "vellum-command/package-runtime-historical-comparison/v1";
  readonly classification: "historical-comparison-only";
  readonly product: typeof PRODUCT_NAME;
  readonly release: {
    readonly appVersion: "0.1.14";
    readonly sourceComparisonCommit: string;
    readonly currentStateSchemaVersion: 18;
    readonly migrationHead: {
      readonly fromVersion: 17;
      readonly toVersion: 18;
      readonly name: string;
    };
    readonly migrationIdentitySha256: string;
  };
  readonly evidence: ReadonlyArray<{
    readonly path: string;
    readonly sha256: string;
  }>;
  readonly constraint: string;
};

export type StaleRemoteProbe = {
  readonly synthetic: true;
  readonly historicalComparisonOnly: true;
  readonly planted: {
    readonly appVersion: "0.1.14";
    readonly currentStateSchemaVersion: 18;
    readonly payloadSha256: string;
    readonly provenanceSha256: string;
  };
  readonly outcome: "replaced";
  readonly rebuiltPayloadSha256: string;
  readonly packagedPayloadSha256: string;
};

export type PackageRuntimeParityReceipt = {
  readonly schema: typeof PACKAGE_RUNTIME_PARITY_RECEIPT_SCHEMA;
  readonly product: typeof PRODUCT_NAME;
  readonly qualification: "fresh-isolated-linux-package";
  readonly candidatePublished: false;
  readonly qualifiedAt: string;
  readonly source: {
    readonly appVersion: string;
    readonly commit: string;
    readonly currentStateSchemaVersion: number;
    readonly migrationHead: PackageSourceFacts["migrationHead"];
    readonly migrationIdentitySha256: string;
  };
  readonly candidateArchive: {
    readonly file: string;
    readonly bytes: number;
    readonly sha256: string;
  };
  readonly runtimes: PackageRuntimeParityVerification["runtimes"];
  readonly staleRemoteProbe: StaleRemoteProbe;
  readonly historicalComparison: {
    readonly file: typeof HISTORICAL_COMPARISON_RELATIVE;
    readonly fixtureSha256: string;
    readonly appVersion: "0.1.14";
    readonly currentStateSchemaVersion: 18;
    readonly migrationIdentitySha256: string;
    readonly evidence: HistoricalPackageComparison["evidence"];
    readonly use: "historical-comparison-only";
  };
  readonly checks: ReadonlyArray<string>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireString = (
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

const requireRecord = (
  value: unknown,
  label: string,
): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error(`invalid ${label}`);
  return value;
};

const sha256 = (body: Uint8Array | string): string =>
  createHash("sha256").update(body).digest("hex");

const requireRegularFile = async (file: string, label: string): Promise<void> => {
  const metadata = await lstat(file).catch(() => undefined);
  if (
    metadata === undefined ||
    !metadata.isFile() ||
    metadata.isSymbolicLink()
  ) {
    throw new Error(`${label} must be a non-symlink regular file: ${file}`);
  }
};

const run = (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly quiet?: boolean;
}): string => {
  const result = spawnSync(input.command, [...input.args], {
    cwd: input.cwd,
    env: input.env,
    encoding: "utf8",
    shell: false,
    stdio: input.quiet ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) {
    const detail = `${result.stderr || result.stdout || ""}`.trim();
    throw new Error(
      `command failed (${input.command} ${input.args.join(" ")}): ${detail || `exit ${String(result.status)}`}`,
    );
  }
  return `${result.stdout ?? ""}`.trim();
};

export const loadHistoricalPackageComparison = async (
  repoRoot: string,
): Promise<{
  readonly comparison: HistoricalPackageComparison;
  readonly fixtureSha256: string;
}> => {
  const fixturePath = path.join(repoRoot, HISTORICAL_COMPARISON_RELATIVE);
  await requireRegularFile(fixturePath, "historical comparison fixture");
  const fixtureBody = await readFile(fixturePath);
  let input: unknown;
  try {
    input = JSON.parse(fixtureBody.toString("utf8"));
  } catch {
    throw new Error("historical comparison fixture is not valid JSON");
  }
  const record = requireRecord(input, "historical comparison fixture");
  const release = requireRecord(record.release, "historical release");
  const head = requireRecord(release.migrationHead, "historical migration head");
  if (
    record.schema !==
      "vellum-command/package-runtime-historical-comparison/v1" ||
    record.classification !== "historical-comparison-only" ||
    record.product !== PRODUCT_NAME ||
    release.appVersion !== "0.1.14" ||
    release.currentStateSchemaVersion !== 18 ||
    head.fromVersion !== 17 ||
    head.toVersion !== 18
  ) {
    throw new Error("historical comparison must remain public 0.1.14 schema 18");
  }
  const evidenceInput = record.evidence;
  if (!Array.isArray(evidenceInput) || evidenceInput.length === 0) {
    throw new Error("historical comparison has no evidence hashes");
  }
  const evidence = evidenceInput.map((entry, index) => {
    const item = requireRecord(entry, `historical evidence ${String(index)}`);
    return {
      path: requireString(item.path, "historical evidence path"),
      sha256: requireString(
        item.sha256,
        "historical evidence SHA-256",
        SHA256,
      ),
    };
  });
  const fixtureDirectory = path.dirname(fixturePath);
  const fixturesRoot = path.resolve(repoRoot, "tests/fixtures");
  for (const item of evidence) {
    const evidencePath = path.resolve(fixtureDirectory, item.path);
    const relative = path.relative(fixturesRoot, evidencePath);
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      relative.length === 0
    ) {
      throw new Error("historical evidence path escapes tests/fixtures");
    }
    await requireRegularFile(evidencePath, "historical evidence");
    if ((await sha256File(evidencePath)) !== item.sha256) {
      throw new Error(`historical evidence hash mismatch: ${item.path}`);
    }
  }
  const comparison: HistoricalPackageComparison = {
    schema: "vellum-command/package-runtime-historical-comparison/v1",
    classification: "historical-comparison-only",
    product: PRODUCT_NAME,
    release: {
      appVersion: "0.1.14",
      sourceComparisonCommit: requireString(
        release.sourceComparisonCommit,
        "historical source comparison commit",
        SOURCE_COMMIT,
      ),
      currentStateSchemaVersion: 18,
      migrationHead: {
        fromVersion: 17,
        toVersion: 18,
        name: requireString(head.name, "historical migration head name"),
      },
      migrationIdentitySha256: requireString(
        release.migrationIdentitySha256,
        "historical migration identity SHA-256",
        SHA256,
      ),
    },
    evidence,
    constraint: requireString(record.constraint, "historical constraint"),
  };
  return { comparison, fixtureSha256: sha256(fixtureBody) };
};

/** Plant ignored output only. The official package path must remove it. */
export const plantHistoricalStaleRemote = async (input: {
  readonly repoRoot: string;
  readonly comparison: HistoricalPackageComparison;
}): Promise<StaleRemoteProbe["planted"]> => {
  const outputDirectory = path.join(input.repoRoot, "out/remote");
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true, mode: 0o755 });
  const marker = [
    "#!/usr/bin/env node",
    "// Synthetic stale-package probe. Never a published artifact.",
    "var CURRENT_STATE_SCHEMA_VERSION = 18;",
    `var APP_VERSION = ${JSON.stringify(input.comparison.release.appVersion)};`,
    "module.exports = { CURRENT_STATE_SCHEMA_VERSION, APP_VERSION };",
    "// padding proves an old plausible bundle is replaced, not size-rejected",
    "x".repeat(2048),
    "",
  ].join("\n");
  const payload = Buffer.from(marker, "utf8");
  const historicalSource: PackageSourceFacts = {
    appVersion: input.comparison.release.appVersion,
    sourceCommit: input.comparison.release.sourceComparisonCommit,
    currentStateSchemaVersion:
      input.comparison.release.currentStateSchemaVersion,
    migrationHead: input.comparison.release.migrationHead,
    migrationIdentitySha256:
      input.comparison.release.migrationIdentitySha256,
  };
  const provenance = makePackageRuntimeProvenance({
    runtime: "linux-remote",
    source: historicalSource,
    payload,
  });
  const provenanceBody = Buffer.from(
    `${JSON.stringify(provenance, null, 2)}\n`,
    "utf8",
  );
  if (provenance.schema !== PACKAGE_RUNTIME_PROVENANCE_SCHEMA) {
    throw new Error("synthetic stale provenance schema mismatch");
  }
  await writeFile(
    path.join(input.repoRoot, REMOTE_ENTRY_SOURCE_RELATIVE),
    payload,
    { mode: 0o755 },
  );
  await writeFile(
    path.join(input.repoRoot, REMOTE_PROVENANCE_SOURCE_RELATIVE),
    provenanceBody,
    { mode: 0o644 },
  );
  return {
    appVersion: "0.1.14",
    currentStateSchemaVersion: 18,
    payloadSha256: sha256(payload),
    provenanceSha256: sha256(provenanceBody),
  };
};

const cloneAtCommit = (input: {
  readonly sourceRoot: string;
  readonly cloneRoot: string;
  readonly commit: string;
}): void => {
  run({
    command: "git",
    args: [
      "clone",
      "--local",
      "--no-hardlinks",
      "--no-checkout",
      "--",
      input.sourceRoot,
      input.cloneRoot,
    ],
    cwd: input.sourceRoot,
  });
  run({
    command: "git",
    args: ["checkout", "--detach", input.commit],
    cwd: input.cloneRoot,
  });
};

const extractCandidateArchive = async (input: {
  readonly archive: string;
  readonly destination: string;
  readonly appVersion: string;
}): Promise<string> => {
  await mkdir(input.destination, { recursive: true, mode: 0o755 });
  const artifactName = linuxRuntimeArtifactName({
    version: input.appVersion,
    arch: "x64",
  });
  validateLinuxRuntimeArchive({
    archive: input.archive,
    artifactName,
  });
  run({
    command: "/usr/bin/tar",
    args: [
      "--extract",
      "--gzip",
      "--no-same-owner",
      "--no-same-permissions",
      "--file",
      input.archive,
      "--directory",
      input.destination,
    ],
    cwd: input.destination,
  });
  const root = path.join(input.destination, artifactName);
  const metadata = await lstat(root).catch(() => undefined);
  if (
    metadata === undefined ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink()
  ) {
    throw new Error("fresh candidate archive has no expected runtime root");
  }
  return root;
};

const writeReceipt = async (
  destination: string,
  receipt: PackageRuntimeParityReceipt,
): Promise<void> => {
  const target = path.resolve(destination);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
  const stage = `${target}.new.${String(process.pid)}.${randomUUID()}`;
  await writeFile(stage, `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
    mode: 0o644,
  });
  try {
    await rename(stage, target);
  } catch (error) {
    await rm(stage, { force: true });
    throw error;
  }
};

export const qualifyFreshPackageRuntimeParity = async (input: {
  readonly repoRoot: string;
  readonly receiptPath: string;
  readonly keepWorkDirectory?: boolean;
}): Promise<{
  readonly receipt: PackageRuntimeParityReceipt;
  readonly receiptPath: string;
  readonly workDirectory?: string;
}> => {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error(
      "fresh package runtime parity qualification requires native Linux x64",
    );
  }
  const repoRoot = path.resolve(input.repoRoot);
  // The root may have unrelated working files. Qualification intentionally
  // clones and builds the exact committed tree, never those ambient bytes.
  const rootFacts = await readPackageSourceFacts({
    repoRoot,
    requireClean: false,
  });
  if (rootFacts.currentStateSchemaVersion !== 20) {
    throw new Error(
      `package parity qualification requires CURRENT_STATE_SCHEMA_VERSION=20, got ${String(rootFacts.currentStateSchemaVersion)}`,
    );
  }
  const workDirectory = await mkdtemp(
    path.join(tmpdir(), "vellum-command-package-parity-"),
  );
  const cloneRoot = path.join(workDirectory, "source");
  const extractRoot = path.join(workDirectory, "extracted");
  try {
    cloneAtCommit({
      sourceRoot: repoRoot,
      cloneRoot,
      commit: rootFacts.sourceCommit,
    });
    const source = await readPackageSourceFacts({
      repoRoot: cloneRoot,
      requireClean: true,
      expectedSourceCommit: rootFacts.sourceCommit,
    });
    if (source.currentStateSchemaVersion !== 20) {
      throw new Error("isolated source clone is not schema 20");
    }
    const historical = await loadHistoricalPackageComparison(cloneRoot);

    run({
      command: "bun",
      args: ["install", "--frozen-lockfile"],
      cwd: cloneRoot,
    });
    const planted = await plantHistoricalStaleRemote({
      repoRoot: cloneRoot,
      comparison: historical.comparison,
    });

    run({
      command: "bun",
      args: ["run", "app:build:linux", "--fast"],
      cwd: cloneRoot,
      env: {
        ...process.env,
        VELLUM_COMMAND_SOURCE_COMMIT: source.sourceCommit,
      },
    });

    const rebuiltRemotePath = path.join(
      cloneRoot,
      REMOTE_ENTRY_SOURCE_RELATIVE,
    );
    await requireRegularFile(rebuiltRemotePath, "rebuilt Remote payload");
    const rebuiltPayloadSha256 = await sha256File(rebuiltRemotePath);
    if (rebuiltPayloadSha256 === planted.payloadSha256) {
      throw new Error("official package path reused the planted stale Remote");
    }

    const archive = path.join(
      cloneRoot,
      "release",
      `vellum-runtime-${source.appVersion}-linux-x64.tar.gz`,
    );
    await requireRegularFile(archive, "fresh candidate archive");
    const candidateRoot = await extractCandidateArchive({
      archive,
      destination: extractRoot,
      appVersion: source.appVersion,
    });
    const verification = await verifyPackagedRuntimeParity({
      repoRoot: cloneRoot,
      target: "linux",
      runtimeRoot: candidateRoot,
      expected: source,
    });
    const packagedRemote = verification.runtimes.linuxRemote;
    if (packagedRemote === undefined) {
      throw new Error("fresh candidate has no Linux Remote provenance");
    }
    if (packagedRemote.payloadSha256 !== rebuiltPayloadSha256) {
      throw new Error("packaged Remote differs from the fresh source output");
    }
    const archiveMetadata = await lstat(archive);
    const receipt: PackageRuntimeParityReceipt = {
      schema: PACKAGE_RUNTIME_PARITY_RECEIPT_SCHEMA,
      product: PRODUCT_NAME,
      qualification: "fresh-isolated-linux-package",
      candidatePublished: false,
      qualifiedAt: new Date().toISOString(),
      source: {
        appVersion: source.appVersion,
        commit: source.sourceCommit,
        currentStateSchemaVersion: source.currentStateSchemaVersion,
        migrationHead: source.migrationHead,
        migrationIdentitySha256: source.migrationIdentitySha256,
      },
      candidateArchive: {
        file: path.basename(archive),
        bytes: archiveMetadata.size,
        sha256: await sha256File(archive),
      },
      runtimes: verification.runtimes,
      staleRemoteProbe: {
        synthetic: true,
        historicalComparisonOnly: true,
        planted,
        outcome: "replaced",
        rebuiltPayloadSha256,
        packagedPayloadSha256: packagedRemote.payloadSha256,
      },
      historicalComparison: {
        file: HISTORICAL_COMPARISON_RELATIVE,
        fixtureSha256: historical.fixtureSha256,
        appVersion: historical.comparison.release.appVersion,
        currentStateSchemaVersion:
          historical.comparison.release.currentStateSchemaVersion,
        migrationIdentitySha256:
          historical.comparison.release.migrationIdentitySha256,
        evidence: historical.comparison.evidence,
        use: "historical-comparison-only",
      },
      checks: [
        "isolated clone at exact source commit",
        "clean tracked source before build",
        "official Linux package command rebuilt ignored out/remote",
        "candidate archive extracted into owned temporary directory",
        "Electron app.asar excluded out/remote",
        "Electron main provenance matched source and payload hash",
        "Linux Remote provenance matched source and payload hash",
        "both runtimes matched app version, source commit, schema 20, migration head, and migration identity",
        "public 0.1.14 schema 18 used only as historical comparison",
      ],
    };
    await writeReceipt(input.receiptPath, receipt);
    return {
      receipt,
      receiptPath: path.resolve(input.receiptPath),
      ...(input.keepWorkDirectory === true ? { workDirectory } : {}),
    };
  } finally {
    if (input.keepWorkDirectory !== true) {
      await rm(workDirectory, { recursive: true, force: true });
    }
  }
};

const parseCli = (
  args: ReadonlyArray<string>,
): { readonly receiptPath: string; readonly keepWorkDirectory: boolean } => {
  let receiptPath: string | undefined;
  let keepWorkDirectory = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--receipt") {
      const value = args[index + 1];
      if (value === undefined || value.length === 0) {
        throw new Error("--receipt requires a path");
      }
      receiptPath = value;
      index += 1;
    } else if (flag === "--keep-workdir") {
      keepWorkDirectory = true;
    } else {
      throw new Error(
        "usage: qualify-package-runtime-parity.ts [--receipt PATH] [--keep-workdir]",
      );
    }
  }
  return {
    receiptPath:
      receiptPath ??
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../.local/schema-v20-package-parity-receipt.json",
      ),
    keepWorkDirectory,
  };
};

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  const options = parseCli(process.argv.slice(2));
  const result = await qualifyFreshPackageRuntimeParity({
    repoRoot,
    receiptPath: options.receiptPath,
    keepWorkDirectory: options.keepWorkDirectory,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
