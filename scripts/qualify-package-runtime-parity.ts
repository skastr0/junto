#!/usr/bin/env bun
/**
 * Qualify one Linux x64 execution build from an isolated exact-commit clone.
 * The command never claims physical amd64 hardware and never accepts prebuilt
 * candidates. Its requested receipt is invalidated before any gate can fail.
 */
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
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
  RUNTIME_BUILD_IDENTITY_SCHEMA,
  assertExactCommittedCheckout,
  embedRuntimeBuildIdentity,
  makePackageRuntimeProvenance,
  readPackageSourceFacts,
  sha256File,
  verifyPackagedRuntimeParity,
  type PackageRuntimeParityVerification,
  type PackageSourceFacts,
  type RuntimeBuildIdentity,
} from "./package-runtime-provenance";
import { REMOTE_ENTRY_SOURCE_RELATIVE } from "./build-linux-remote-runtime";
import {
  LINUX_RUNTIME_AUDIT_SCHEMA,
  auditLinuxRuntime,
  decodeLinuxRuntimeAuditReceipt,
  type LinuxRuntimeAuditReceipt,
} from "./audit-linux-package";
import {
  linuxRuntimeArtifactName,
  validateLinuxRuntimeArchive,
} from "./finalize-linux-package";

export const PACKAGE_RUNTIME_PARITY_RECEIPT_SCHEMA =
  "vellum-command/package-runtime-parity-receipt/v2" as const;
export const PACKAGE_RUNTIME_PARITY_ATTEMPT_SCHEMA =
  "vellum-command/package-runtime-parity-attempt/v1" as const;
export const HISTORICAL_COMPARISON_RELATIVE =
  "tests/fixtures/package-runtime-parity/public-0.1.14-schema18-historical.json" as const;

const SOURCE_COMMIT = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
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

export type LinuxX64ExecutionFacts = {
  readonly architectureClaim: "linux-x64-process";
  readonly process: {
    readonly platform: string;
    readonly arch: string;
  };
  readonly kernel: {
    readonly system: string;
    readonly machine: string;
    readonly release: string;
  };
  readonly runner: {
    readonly runtime: "bun";
    readonly bunVersion: string;
    readonly nodeCompatibilityVersion: string;
    readonly executable: string;
    readonly ciProvider: string | null;
  };
  readonly emulation: {
    readonly status: "observed" | "not-determined";
    readonly evidence: ReadonlyArray<string>;
  };
};

export type PackageRuntimeParityReceipt = {
  readonly schema: typeof PACKAGE_RUNTIME_PARITY_RECEIPT_SCHEMA;
  readonly product: typeof PRODUCT_NAME;
  readonly qualification: "fresh-isolated-linux-x64-execution";
  readonly externalCandidatePublished: false;
  readonly qualifiedAt: string;
  readonly attempt: {
    readonly nonce: string;
    readonly startedAt: string;
    readonly completedAt: string;
    readonly sourceCommit: string;
  };
  readonly execution: LinuxX64ExecutionFacts;
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
  readonly compilerCohort: {
    readonly nonce: string;
    readonly runtimes: PackageRuntimeParityVerification["compiledRuntimes"];
  };
  readonly packagedRuntimes: PackageRuntimeParityVerification["runtimes"];
  readonly linuxRuntimeAudit: LinuxRuntimeAuditReceipt;
  readonly linuxRuntimeAuditSha256: string;
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
};

export type QualificationAttemptMarker = {
  readonly schema: typeof PACKAGE_RUNTIME_PARITY_ATTEMPT_SCHEMA;
  readonly product: typeof PRODUCT_NAME;
  readonly status: "in-progress" | "failed";
  readonly nonce: string;
  readonly startedAt: string;
  readonly sourceCommit: string | null;
  readonly failedAt?: string;
  readonly failure?: string;
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

const cleanGitEnvironment = (): NodeJS.ProcessEnv => {
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
  return env;
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
    env: input.env ?? process.env,
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

const runGit = (
  repoRoot: string,
  args: ReadonlyArray<string>,
): string =>
  run({
    command: "git",
    args: ["-C", repoRoot, ...args],
    cwd: repoRoot,
    env: cleanGitEnvironment(),
    quiet: true,
  });

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

/** Plant ignored output only. The official cohort build must remove it. */
export const plantHistoricalStaleRemote = async (input: {
  readonly repoRoot: string;
  readonly comparison: HistoricalPackageComparison;
}): Promise<StaleRemoteProbe["planted"]> => {
  const outputDirectory = path.join(input.repoRoot, "out/remote");
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true, mode: 0o755 });
  const rawMarker = Buffer.from(
    [
      "#!/usr/bin/env node",
      "// Synthetic stale-package probe. Never a published artifact.",
      "var CURRENT_STATE_SCHEMA_VERSION = 18;",
      `var APP_VERSION = ${JSON.stringify(input.comparison.release.appVersion)};`,
      "module.exports = { CURRENT_STATE_SCHEMA_VERSION, APP_VERSION };",
      "// padding proves an old plausible bundle is replaced, not size-rejected",
      "x".repeat(2048),
      "",
    ].join("\n"),
    "utf8",
  );
  const identity: RuntimeBuildIdentity = {
    schema: RUNTIME_BUILD_IDENTITY_SCHEMA,
    cohortNonce: randomUUID(),
    sourceCommit: input.comparison.release.sourceComparisonCommit,
    runtime: "linux-remote",
  };
  const payload = embedRuntimeBuildIdentity({ payload: rawMarker, identity });
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

export const cloneExactCommit = async (input: {
  readonly sourceRoot: string;
  readonly cloneRoot: string;
  readonly commit: string;
}): Promise<{ readonly commit: string; readonly tree: string }> => {
  const expectedCommit = requireString(input.commit, "clone commit", SOURCE_COMMIT);
  const expectedTree = runGit(input.sourceRoot, [
    "rev-parse",
    `${expectedCommit}^{tree}`,
  ]);
  run({
    command: "git",
    args: [
      "clone",
      "--no-local",
      "--dissociate",
      "--no-checkout",
      "--",
      input.sourceRoot,
      input.cloneRoot,
    ],
    cwd: input.sourceRoot,
    env: cleanGitEnvironment(),
  });
  run({
    command: "git",
    args: ["checkout", "--detach", expectedCommit],
    cwd: input.cloneRoot,
    env: cleanGitEnvironment(),
  });
  const actualCommit = runGit(input.cloneRoot, [
    "rev-parse",
    "--verify",
    "HEAD^{commit}",
  ]);
  const actualTree = runGit(input.cloneRoot, ["rev-parse", "HEAD^{tree}"]);
  if (actualCommit !== expectedCommit || actualTree !== expectedTree) {
    throw new Error("isolated clone commit/tree differs from requested source");
  }
  const alternatesPath = runGit(input.cloneRoot, [
    "rev-parse",
    "--git-path",
    "objects/info/alternates",
  ]);
  if ((await lstatIfPresent(path.resolve(input.cloneRoot, alternatesPath))) !== undefined) {
    throw new Error("isolated clone retained an object alternates file");
  }
  if (/^alternate:/mu.test(runGit(input.cloneRoot, ["count-objects", "-v"]))) {
    throw new Error("isolated clone retained an object alternate");
  }
  const checkout = await assertExactCommittedCheckout(input.cloneRoot);
  if (checkout.commit !== expectedCommit || checkout.tree !== expectedTree) {
    throw new Error("isolated clone checkout bytes differ from requested tree");
  }
  return checkout;
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
  const metadata = await lstatIfPresent(root);
  if (
    metadata === undefined ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink()
  ) {
    throw new Error("fresh candidate archive has no expected runtime root");
  }
  return root;
};

const writeAtomicReplace = async (
  destination: string,
  body: string,
): Promise<void> => {
  const target = path.resolve(destination);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
  const parent = await lstat(path.dirname(target));
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new Error("qualification receipt parent must be a non-symlink directory");
  }
  const existing = await lstatIfPresent(target);
  if (existing?.isSymbolicLink() === true || (existing !== undefined && !existing.isFile())) {
    throw new Error("qualification receipt target must be absent or a regular file");
  }
  const stage = `${target}.new.${String(process.pid)}.${randomUUID()}`;
  await writeFile(stage, body, { flag: "wx", mode: 0o644 });
  try {
    await rename(stage, target);
  } catch (error) {
    await rm(stage, { force: true });
    throw error;
  }
};

const readAttemptMarker = async (
  receiptPath: string,
): Promise<QualificationAttemptMarker> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path.resolve(receiptPath), "utf8"));
  } catch {
    throw new Error("qualification attempt marker is unreadable");
  }
  const record = requireRecord(parsed, "qualification attempt marker");
  if (
    record.schema !== PACKAGE_RUNTIME_PARITY_ATTEMPT_SCHEMA ||
    record.product !== PRODUCT_NAME ||
    (record.status !== "in-progress" && record.status !== "failed")
  ) {
    throw new Error("requested receipt is no longer this qualification attempt");
  }
  return record as unknown as QualificationAttemptMarker;
};

export type QualificationAttemptContext = {
  readonly nonce: string;
  readonly startedAt: string;
  readonly receiptPath: string;
  setSourceCommit(commit: string): Promise<void>;
};

export const beginQualificationReceiptAttempt = async (
  receiptPath: string,
  nonce = randomUUID(),
): Promise<QualificationAttemptContext> => {
  const admittedNonce = requireString(nonce, "qualification attempt nonce", UUID);
  const target = path.resolve(receiptPath);
  const startedAt = new Date().toISOString();
  let sourceCommit: string | null = null;
  const writeMarker = async (
    status: "in-progress" | "failed",
    failure?: string,
  ): Promise<void> => {
    const marker: QualificationAttemptMarker = {
      schema: PACKAGE_RUNTIME_PARITY_ATTEMPT_SCHEMA,
      product: PRODUCT_NAME,
      status,
      nonce: admittedNonce,
      startedAt,
      sourceCommit,
      ...(status === "failed"
        ? {
            failedAt: new Date().toISOString(),
            failure: (failure ?? "qualification failed").slice(0, 1_000),
          }
        : {}),
    };
    await writeAtomicReplace(target, `${JSON.stringify(marker, null, 2)}\n`);
  };
  await writeMarker("in-progress");
  return {
    nonce: admittedNonce,
    startedAt,
    receiptPath: target,
    async setSourceCommit(commit: string): Promise<void> {
      const current = await readAttemptMarker(target);
      if (current.nonce !== admittedNonce || current.status !== "in-progress") {
        throw new Error("qualification attempt was superseded");
      }
      sourceCommit = requireString(commit, "attempt source commit", SOURCE_COMMIT);
      await writeMarker("in-progress");
    },
  };
};

export const decodePackageRuntimeParityReceipt = (
  input: unknown,
): PackageRuntimeParityReceipt => {
  const record = requireRecord(input, "package runtime parity receipt");
  if (
    record.schema !== PACKAGE_RUNTIME_PARITY_RECEIPT_SCHEMA ||
    record.product !== PRODUCT_NAME ||
    record.qualification !== "fresh-isolated-linux-x64-execution" ||
    record.externalCandidatePublished !== false
  ) {
    throw new Error("invalid package runtime parity receipt schema");
  }
  const attempt = requireRecord(record.attempt, "qualification attempt");
  const source = requireRecord(record.source, "qualification source");
  const cohort = requireRecord(record.compilerCohort, "compiler cohort");
  const runtimes = requireRecord(cohort.runtimes, "compiler cohort runtimes");
  const main = requireRecord(runtimes.electronMain, "compiled Electron main");
  const remote = requireRecord(runtimes.linuxRemote, "compiled Linux Remote");
  const mainIdentity = requireRecord(main.buildIdentity, "main build identity");
  const remoteIdentity = requireRecord(remote.buildIdentity, "Remote build identity");
  const nonce = requireString(attempt.nonce, "attempt nonce", UUID);
  const commit = requireString(source.commit, "source commit", SOURCE_COMMIT);
  if (
    requireString(attempt.sourceCommit, "attempt source commit", SOURCE_COMMIT) !==
      commit ||
    requireString(cohort.nonce, "compiler cohort nonce", UUID) !== nonce ||
    mainIdentity.cohortNonce !== nonce ||
    remoteIdentity.cohortNonce !== nonce ||
    mainIdentity.sourceCommit !== commit ||
    remoteIdentity.sourceCommit !== commit ||
    mainIdentity.runtime !== "electron-main" ||
    remoteIdentity.runtime !== "linux-remote"
  ) {
    throw new Error("qualification attempt/compiler cohort/source binding mismatch");
  }
  const audit = decodeLinuxRuntimeAuditReceipt(record.linuxRuntimeAudit);
  const auditSha = requireString(
    record.linuxRuntimeAuditSha256,
    "Linux runtime audit SHA-256",
    SHA256,
  );
  if (auditSha !== sha256(JSON.stringify(audit))) {
    throw new Error("Linux runtime audit receipt hash mismatch");
  }
  const execution = requireRecord(record.execution, "Linux x64 execution facts");
  if (execution.architectureClaim !== "linux-x64-process") {
    throw new Error("qualification receipt overclaims execution architecture");
  }
  const candidate = requireRecord(record.candidateArchive, "candidate archive");
  requireString(candidate.sha256, "candidate archive SHA-256", SHA256);
  requireString(record.qualifiedAt, "qualification time");
  return record as unknown as PackageRuntimeParityReceipt;
};

export const withQualificationReceiptAttempt = async <T>(input: {
  readonly receiptPath: string;
  readonly body: (
    attempt: QualificationAttemptContext,
  ) => Promise<{ readonly value: T; readonly receipt: PackageRuntimeParityReceipt }>;
}): Promise<T> => {
  const attempt = await beginQualificationReceiptAttempt(input.receiptPath);
  try {
    const completed = await input.body(attempt);
    const receipt = decodePackageRuntimeParityReceipt(completed.receipt);
    const marker = await readAttemptMarker(attempt.receiptPath);
    if (marker.nonce !== attempt.nonce || marker.status !== "in-progress") {
      throw new Error("qualification attempt was superseded before publication");
    }
    await writeAtomicReplace(
      attempt.receiptPath,
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    return completed.value;
  } catch (error) {
    const marker = await readAttemptMarker(attempt.receiptPath).catch(
      () => undefined,
    );
    if (marker?.nonce === attempt.nonce && marker.status === "in-progress") {
      const failed: QualificationAttemptMarker = {
        ...marker,
        status: "failed",
        failedAt: new Date().toISOString(),
        failure: (error instanceof Error ? error.message : String(error)).slice(
          0,
          1_000,
        ),
      };
      await writeAtomicReplace(
        attempt.receiptPath,
        `${JSON.stringify(failed, null, 2)}\n`,
      );
    }
    throw error;
  }
};

const uname = (flag: "-s" | "-m" | "-r"): string => {
  const result = spawnSync("/usr/bin/uname", [flag], {
    encoding: "utf8",
    shell: false,
  });
  return result.status === 0 ? result.stdout.trim() : "unknown";
};

export const readLinuxX64ExecutionFacts = (input?: {
  readonly platform?: string;
  readonly arch?: string;
  readonly kernelSystem?: string;
  readonly kernelMachine?: string;
  readonly kernelRelease?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly bunVersion?: string;
  readonly nodeVersion?: string;
  readonly executable?: string;
}): LinuxX64ExecutionFacts => {
  const platform = input?.platform ?? process.platform;
  const arch = input?.arch ?? process.arch;
  const kernelSystem = input?.kernelSystem ?? uname("-s");
  const kernelMachine = input?.kernelMachine ?? uname("-m");
  const kernelRelease = input?.kernelRelease ?? uname("-r");
  const env = input?.env ?? process.env;
  const evidence: string[] = [];
  if (
    arch === "x64" &&
    !["x86_64", "amd64", "unknown"].includes(kernelMachine.toLowerCase())
  ) {
    evidence.push(`x64 process on kernel machine ${kernelMachine}`);
  }
  if (env.QEMU_CPU !== undefined || env.QEMU_LD_PREFIX !== undefined) {
    evidence.push("QEMU environment signal present");
  }
  if (
    arch === "x64" &&
    typeof env.RUNNER_ARCH === "string" &&
    /arm|aarch/iu.test(env.RUNNER_ARCH)
  ) {
    evidence.push(`runner reports ${env.RUNNER_ARCH}`);
  }
  const ciProvider =
    env.GITHUB_ACTIONS === "true"
      ? "github-actions"
      : env.GITLAB_CI === "true"
        ? "gitlab-ci"
        : env.BUILDKITE === "true"
          ? "buildkite"
          : env.CI === "true"
            ? "unspecified-ci"
            : null;
  return {
    architectureClaim: "linux-x64-process",
    process: { platform, arch },
    kernel: {
      system: kernelSystem,
      machine: kernelMachine,
      release: kernelRelease,
    },
    runner: {
      runtime: "bun",
      bunVersion: input?.bunVersion ?? Bun.version,
      nodeCompatibilityVersion: input?.nodeVersion ?? process.version,
      executable: path.basename(input?.executable ?? process.execPath),
      ciProvider,
    },
    emulation: {
      status: evidence.length > 0 ? "observed" : "not-determined",
      evidence,
    },
  };
};

export const qualifyFreshPackageRuntimeParity = async (input: {
  readonly repoRoot: string;
  readonly receiptPath: string;
  readonly keepWorkDirectory?: boolean;
}): Promise<{
  readonly receipt: PackageRuntimeParityReceipt;
  readonly receiptPath: string;
  readonly workDirectory?: string;
}> =>
  withQualificationReceiptAttempt({
    receiptPath: input.receiptPath,
    body: async (attempt) => {
      const execution = readLinuxX64ExecutionFacts();
      if (process.platform !== "linux" || process.arch !== "x64") {
        throw new Error(
          "fresh package runtime parity qualification requires a Linux x64 execution process",
        );
      }
      const repoRoot = path.resolve(input.repoRoot);
      // Ambient worktree bytes are not build inputs. Read only HEAD identity,
      // then clone Git objects without local sharing or alternates.
      const rootFacts = await readPackageSourceFacts({
        repoRoot,
        requireClean: false,
      });
      await attempt.setSourceCommit(rootFacts.sourceCommit);
      if (rootFacts.currentStateSchemaVersion !== 20) {
        throw new Error(
          `package parity qualification requires CURRENT_STATE_SCHEMA_VERSION=20, got ${String(rootFacts.currentStateSchemaVersion)}`,
        );
      }
      const workDirectory = await mkdtemp(
        path.join(tmpdir(), "vellum-command-package-parity-"),
      );
      await chmod(workDirectory, 0o700);
      const cloneRoot = path.join(workDirectory, "source");
      const extractRoot = path.join(workDirectory, "extracted");
      let result:
        | {
            readonly receipt: PackageRuntimeParityReceipt;
            readonly receiptPath: string;
            readonly workDirectory?: string;
          }
        | undefined;
      try {
        await cloneExactCommit({
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
            VELLUM_COMMAND_PACKAGE_COHORT_NONCE: attempt.nonce,
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
        if (verification.cohortNonce !== attempt.nonce) {
          throw new Error("package compiler cohort is not bound to attempt nonce");
        }
        const packagedRemote = verification.runtimes.linuxRemote;
        if (packagedRemote === undefined) {
          throw new Error("fresh candidate has no Linux Remote provenance");
        }
        if (packagedRemote.payloadSha256 !== rebuiltPayloadSha256) {
          throw new Error("packaged Remote differs from fresh compiler output");
        }
        const linuxRuntimeAudit = decodeLinuxRuntimeAuditReceipt(
          await auditLinuxRuntime({
            runtimePath: candidateRoot,
            version: source.appVersion,
          }),
        );
        if (
          verification.linuxRuntimeClosure?.inventory.rootSha256 !==
          linuxRuntimeAudit.inventory.rootSha256
        ) {
          throw new Error("parity and execution audits saw different runtime trees");
        }
        const archiveMetadata = await lstat(archive);
        const completedAt = new Date().toISOString();
        const receipt: PackageRuntimeParityReceipt = {
          schema: PACKAGE_RUNTIME_PARITY_RECEIPT_SCHEMA,
          product: PRODUCT_NAME,
          qualification: "fresh-isolated-linux-x64-execution",
          externalCandidatePublished: false,
          qualifiedAt: completedAt,
          attempt: {
            nonce: attempt.nonce,
            startedAt: attempt.startedAt,
            completedAt,
            sourceCommit: source.sourceCommit,
          },
          execution,
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
          compilerCohort: {
            nonce: verification.cohortNonce,
            runtimes: verification.compiledRuntimes,
          },
          packagedRuntimes: verification.runtimes,
          linuxRuntimeAudit,
          linuxRuntimeAuditSha256: sha256(JSON.stringify(linuxRuntimeAudit)),
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
        };
        decodePackageRuntimeParityReceipt(receipt);
        result = {
          receipt,
          receiptPath: path.resolve(input.receiptPath),
          ...(input.keepWorkDirectory === true ? { workDirectory } : {}),
        };
        return { value: result, receipt };
      } finally {
        if (input.keepWorkDirectory !== true) {
          await rm(workDirectory, { recursive: true, force: true });
        }
      }
    },
  });

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
