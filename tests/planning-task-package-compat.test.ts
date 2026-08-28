import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { Result } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import {
  renderSchemaContract,
  tasksCreateSchema,
} from "../src/cli/core/discovery";
import { CURRENT_STATE_SCHEMA_VERSION } from "../src/main/vellum/state/migrations";
import { STATION_CONTROL_PROTOCOL } from "../src/shared/station-api-envelope";
import { STATION_API_PROTOCOL } from "../src/shared/station-api";
import {
  CURRENT_STATION_PROTOCOL_SUPPORT,
  STATION_PROTOCOL_BASELINE,
  selectStationProtocolCodec,
} from "../src/shared/station-protocol";
import { STATION_SESSION_PROTOCOL } from "../src/shared/station-session";
import {
  WORK_PROTOCOL,
  decodeWorkRecord,
} from "../src/shared/work-protocol";

const FIXTURE_ROOT = fileURLToPath(
  new URL("./fixtures/planning-task-package-compat/", import.meta.url),
);
const PROJECT_ROOT = resolve(FIXTURE_ROOT, "../../..");
const QUALIFIER = join(FIXTURE_ROOT, "qualify.mjs");
const TRUST_VERIFIER = join(FIXTURE_ROOT, "verify-trust-root.mjs");
const MANIFEST_SHA256 =
  "564fdab63b7e4c64caf400f3dd4a408bdf1c71856812ae6e82e9c19c892835ae";
const TRUST_VERIFIER_SHA256 =
  "ca0ca91a1aafe2456dcbaffe3bf0dc89d9104a9a51ff459de6746ef7d2bb1847";
const QUALIFIER_SHA256 =
  "4cfbb9ba2689ef6442bfd7f8216f0fbfa1ec983f3a033898246d2b27c185a7fa";
const SANDBOX_SECRET = "must-not-cross-the-confined-child-boundary";

const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");
const readJson = <A>(path: string): A =>
  JSON.parse(readFileSync(path, "utf8")) as A;
const writeJson = (path: string, value: unknown): void =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const outerEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NO_COLOR: "1",
    VELLUM_COMMAND_SANDBOX_PARENT_SECRET: SANDBOX_SECRET,
  };
  delete env.FORCE_COLOR;
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  return env;
};
const trustArgs = (root: string, expectedManifestSha256: string): string[] => [
  TRUST_VERIFIER,
  "--root",
  root,
  "--project-root",
  PROJECT_ROOT,
  "--expected-manifest-sha256",
  expectedManifestSha256,
];
const qualifierArgs = (
  qualifier: string,
  root: string,
  expectedManifestSha256: string,
  integrityOnly = false,
): string[] => [
  qualifier,
  "--root",
  root,
  "--project-root",
  PROJECT_ROOT,
  "--expected-manifest-sha256",
  expectedManifestSha256,
  "--expected-verifier-sha256",
  TRUST_VERIFIER_SHA256,
  ...(integrityOnly ? ["--integrity-only"] : []),
];
const runNode = (
  argv: ReadonlyArray<string>,
  timeout = 60_000,
): SpawnSyncReturns<string> =>
  spawnSync("node", argv, {
    cwd: PROJECT_ROOT,
    env: outerEnv(),
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });

const runEndToEnd = (
  root: string,
  expectedManifestSha256: string,
): {
  readonly trust: SpawnSyncReturns<string>;
  readonly qualification?: SpawnSyncReturns<string>;
} => {
  const trust = runNode(trustArgs(root, expectedManifestSha256), 10_000);
  if (trust.status !== 0) return { trust };
  const qualifier = join(root, "qualify.mjs");
  const localVerifier = join(root, "verify-trust-root.mjs");
  if (
    sha256(readFileSync(localVerifier)) !== TRUST_VERIFIER_SHA256 ||
    sha256(readFileSync(qualifier)) !== QUALIFIER_SHA256
  ) {
    return {
      trust: {
        ...trust,
        status: 1,
        stderr: "trusted controller changed between verification and use",
      },
    };
  }
  return {
    trust,
    qualification: runNode(
      qualifierArgs(qualifier, root, expectedManifestSha256),
      60_000,
    ),
  };
};

type DecodeOutcome = {
  readonly accepted: boolean;
  readonly namesAdmission?: boolean;
  readonly namesRaisedBy?: boolean;
};
type Matrix = {
  readonly cohort: {
    readonly tasksCreateSchemaId: string;
    readonly stateSchemaVersion: number;
    readonly stationProtocolBaseline: number;
    readonly stationProtocolSupport: {
      readonly preferred: number;
      readonly compatibleFrom: number;
      readonly warnBelow: number;
    };
    readonly workProtocol: string;
  };
  readonly records: Readonly<Record<string, DecodeOutcome>>;
  readonly negotiation: { readonly _tag: string };
  readonly guarded: {
    readonly versionedDecoderInvocations: number;
    readonly result: { readonly accepted: boolean; readonly reason?: string };
    readonly rejection?: {
      readonly reason: string;
      readonly retryable: boolean;
    };
  };
};
type StaticRange = {
  readonly id: string;
  readonly path: string;
  readonly start: number;
  readonly end: number;
  readonly bytes: number;
  readonly sha256: string;
};
type Qualification = {
  readonly integrity: {
    readonly manifestSha256: string;
    readonly verifiedFiles: number;
    readonly receiptsCrossChecked: number;
    readonly protocolPinsChecked: number;
  };
  readonly confinement: {
    readonly runtime: string;
    readonly permissionModel: boolean;
    readonly allowFsRead: string;
    readonly allowFsWrite: boolean;
    readonly allowNetwork: boolean;
    readonly allowChildProcess: boolean;
    readonly allowAddons: boolean;
    readonly allowWorker: boolean;
    readonly inheritedEnvironment: boolean;
    readonly timeoutMs: number;
    readonly maxInputBytes: number;
    readonly maxOutputBytes: number;
    readonly maxDiagnosticBytes: number;
    readonly maxOldSpaceMiB: number;
    readonly prependedSideEffects: {
      readonly outcomes: Readonly<
        Record<
          "write" | "network" | "child",
          { readonly outcome: string; readonly code: string; readonly permission?: string }
        >
      >;
      readonly inheritedSecret: string | null;
      readonly continuedAfterPrependedAttempts: boolean;
    };
    readonly canaryTouched: boolean;
    readonly limitProbes: Readonly<
      Record<"timeout" | "stdout" | "stderr" | "input", {
        readonly denied: boolean;
        readonly code: string;
      }>
    >;
  };
  readonly matrices: {
    readonly released: Matrix;
    readonly legacyV2: Matrix;
    readonly current: Matrix;
    readonly currentAgainstReleased: Matrix;
  };
  readonly releasedPackageStaticEvidence: {
    readonly mode: string;
    readonly archivedBytesExecuted: boolean;
    readonly instrumentedBundlePresent: boolean;
    readonly sourcePackage: {
      readonly productName: string;
      readonly appVersion: string;
      readonly zipBytes: number;
      readonly zipSha256: string;
      readonly appAsarSha256: string;
      readonly mainBytes: number;
      readonly mainSha256: string;
      readonly mainSourceMapPresent: boolean;
    };
    readonly ranges: ReadonlyArray<StaticRange>;
    readonly proves: ReadonlyArray<string>;
    readonly doesNotProve: ReadonlyArray<string>;
  };
  readonly schema18ArchiveSourceRefusal: {
    readonly beforeSha256: string;
    readonly afterSha256: string;
    readonly byteIdentical: boolean;
    readonly beforeMtimeNs: string;
    readonly afterMtimeNs: string;
    readonly beforeSidecars: ReadonlyArray<string>;
    readonly afterSidecars: ReadonlyArray<string>;
    readonly userVersion: number;
    readonly sentinel: { readonly id: string; readonly payload: string };
    readonly probe: {
      readonly compatibility: {
        readonly ok: boolean;
        readonly reason: string;
        readonly userVersion: number;
        readonly supportedVersion: number;
      };
    };
  };
};
type Manifest = {
  readonly contract: string;
  readonly v3Introduction: { readonly commit: string; readonly parent: string };
  readonly cohorts: Readonly<
    Record<
      string,
      {
        readonly commit: string;
        readonly treeOidSha1: string;
        readonly archive: { readonly bytes: number; readonly sha256: string };
        readonly cohort: {
          readonly releaseStatus: string;
          readonly remoteArtifactStatus: string;
          readonly appVersion: string;
          readonly stateSchemaVersion: number;
          readonly tasksCreateSchemaId: string;
          readonly stationProtocolBaseline: number;
        };
        readonly sourceBlobs: ReadonlyArray<{
          readonly path: string;
          readonly gitBlobOidSha1: string;
          readonly sha256: string;
        }>;
        readonly bundle: {
          readonly path: string;
          readonly compressedBytes: number;
          readonly compressedSha256: string;
          readonly executableBytes: number;
          readonly executableSha256: string;
          readonly artifactKind: string;
          readonly isReleasedPackage: boolean;
          readonly deterministicRebuildVerified: boolean;
          readonly repeatBuildExecutableSha256: string;
        };
      }
    >
  >;
  readonly publicPackage: {
    readonly staticEvidence: {
      readonly mode: string;
      readonly ranges: ReadonlyArray<StaticRange>;
      readonly archivedBytesExecuted: boolean;
      readonly instrumentedExecutablePresent: boolean;
    };
  };
  readonly receipts: Readonly<
    Record<string, { readonly path: string; readonly bytes: number; readonly sha256: string }>
  >;
  readonly protocolPins: {
    readonly preTaskBaseCommit: string;
    readonly taskCreateCanonicalJsonSha256: string;
    readonly unchangedFiles: ReadonlyArray<{
      readonly path: string;
      readonly gitBlobOidSha1: string;
      readonly sha256: string;
      readonly bytes: number;
    }>;
  };
  readonly honestFindings: ReadonlyArray<string>;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
  }>;
};
type PublicPackageReceipt = {
  readonly releaseAuthority: {
    readonly kind: string;
    readonly feedSha256: string;
    readonly githubReleaseAbsent: boolean;
  };
  readonly zip: {
    readonly bytes: number;
    readonly sha256: string;
    readonly sha512Base64: string;
  };
  readonly extractedApp: {
    readonly productName: string;
    readonly bundleShortVersion: string;
    readonly codesignDeepStrict: string;
    readonly staplerValidation: string;
    readonly gatekeeperAssessment: string;
    readonly appAsarSha256: string;
    readonly mainBundleBytes: number;
    readonly mainBundleSha256: string;
    readonly cliSha256: string;
  };
  readonly buildTreeProvenance: {
    readonly versionBumpCommit: string;
    readonly embeddedCommit: string | null;
    readonly exactBuildTreeProven: boolean;
    readonly packageIncludesAtLeastCommit: string;
    readonly dirtyBuildExcluded: boolean;
  };
  readonly cohort: {
    readonly stateSchemaVersion: number;
    readonly tasksCreateSchemaId: string;
    readonly stationProtocolBaseline: number;
    readonly stationProtocolSupport: {
      readonly preferred: number;
      readonly compatibleFrom: number;
      readonly warnBelow: number;
    };
  };
  readonly observedPackageCommands: {
    readonly cliVersion: { readonly stdout: string; readonly note: string };
    readonly tasksCreateSchema: {
      readonly exitCode: number;
      readonly stdoutSha256: string;
      readonly data: {
        readonly schema_id: string;
        readonly description: string;
        readonly schema: {
          readonly properties: Readonly<Record<string, unknown>>;
          readonly additionalProperties: boolean;
        };
      };
    };
  };
  readonly observedProtocol1Exchange: {
    readonly authority: string;
    readonly response: {
      readonly frame: string;
      readonly stateSchemaVersion: number;
      readonly support: {
        readonly preferred: number;
        readonly compatibleFrom: number;
        readonly warnBelow: number;
      };
      readonly reason: string;
      readonly retryable: boolean;
    };
    readonly ingressOrderingProven: boolean;
    readonly limitation: string;
  };
  readonly observedPackageSchema20Refusal: {
    readonly authority: string;
    readonly exitCode: number;
    readonly diagnostic: string;
    readonly before: { readonly sha256: string; readonly bytes: number; readonly mtime_ns: number };
    readonly after: { readonly sha256: string; readonly bytes: number; readonly mtime_ns: number };
    readonly byteIdentical: boolean;
    readonly userVersionAfter: number;
    readonly sentinelAfter: string;
    readonly runtimeProofInFocusedQualifier: boolean;
  };
  readonly staticCompiledEvidence: {
    readonly archivedBytesExecuted: boolean;
    readonly instrumentedExecutablePresent: boolean;
    readonly ranges: ReadonlyArray<StaticRange>;
    readonly limitation: string;
  };
  readonly limitation: string;
};
type ExternalReceipt = {
  readonly contract: string;
  readonly driver: { readonly path: string; readonly bytes: number; readonly sha256: string; readonly description: string };
  readonly rebuildScript: { readonly path: string; readonly bytes: number; readonly sha256: string; readonly command: string };
  readonly cohorts: Readonly<
    Record<
      string,
      {
        readonly commit: string;
        readonly treeOidSha1: string;
        readonly archive: { readonly bytes: number; readonly sha256: string };
        readonly decoderBundleBuild: Manifest["cohorts"][string]["bundle"];
      }
    >
  >;
  readonly releasedPackageStaticExtraction: {
    readonly sourceZipSha256: string;
    readonly sourceAppAsarSha256: string;
    readonly sourceMainBundleSha256: string;
    readonly mode: string;
    readonly archivedBytesExecuted: boolean;
    readonly instrumentedExecutablePresent: boolean;
  };
  readonly limitations: ReadonlyArray<string>;
};
type SliceReceipt = {
  readonly sourcePackage: Qualification["releasedPackageStaticEvidence"]["sourcePackage"] & {
    readonly mainAsarOffset: string;
  };
  readonly extraction: {
    readonly script: { readonly path: string; readonly bytes: number; readonly sha256: string };
    readonly commands: ReadonlyArray<string>;
    readonly ranges: ReadonlyArray<
      StaticRange & {
        readonly transform: string;
        readonly markers: ReadonlyArray<{ readonly marker: string; readonly occurrences: number }>;
        readonly forbiddenMarkers: ReadonlyArray<{ readonly marker: string; readonly occurrences: number }>;
      }
    >;
  };
  readonly proofBoundary: {
    readonly mode: string;
    readonly archivedBytesExecuted: boolean;
    readonly instrumentedBundlePresent: boolean;
    readonly doesNotProve: ReadonlyArray<string>;
  };
};
type Samples = { readonly records: Readonly<Record<string, unknown>> };

type MutableManifest = {
  contract: string;
  generatedAt: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
  receipts: Record<
    string,
    { path: string; contract: string; bytes: number; sha256: string }
  >;
  cohorts: Record<
    string,
    {
      bundle: {
        path: string;
        compressedBytes: number;
        compressedSha256: string;
        executableBytes: number;
        executableSha256: string;
      };
    }
  >;
  publicPackage: {
    packageIdentity: {
      extractedApp: { mainBundleSha256: string };
    };
  };
};

let trustSummary: {
  readonly manifestSha256: string;
  readonly verifiedFiles: number;
  readonly releasedPackageEvidence: string;
};
let qualification: Qualification;
let manifest: Manifest;
let publicPackage: PublicPackageReceipt;
let externalReceipt: ExternalReceipt;
let sliceReceipt: SliceReceipt;
let samples: Samples;

beforeAll(() => {
  // This assertion is intentionally the first executable-fixture action.
  // Only this small verifier is trusted directly by reviewed test source.
  expect(sha256(readFileSync(TRUST_VERIFIER))).toBe(TRUST_VERIFIER_SHA256);
  const pipeline = runEndToEnd(FIXTURE_ROOT, MANIFEST_SHA256);
  expect(pipeline.trust.status, pipeline.trust.stderr || pipeline.trust.stdout).toBe(0);
  trustSummary = JSON.parse(pipeline.trust.stdout) as typeof trustSummary;

  expect(sha256(readFileSync(QUALIFIER))).toBe(QUALIFIER_SHA256);
  const child = pipeline.qualification;
  expect(child).toBeDefined();
  expect(child!.status, child!.stderr || child!.stdout).toBe(0);
  qualification = JSON.parse(child!.stdout) as Qualification;

  // Parse receipt text only after the independent trust barrier succeeded.
  manifest = readJson<Manifest>(join(FIXTURE_ROOT, "package-pair.json"));
  publicPackage = readJson<PublicPackageReceipt>(
    join(FIXTURE_ROOT, "public-package-receipt.json"),
  );
  externalReceipt = readJson<ExternalReceipt>(
    join(FIXTURE_ROOT, "external-build-receipt.json"),
  );
  sliceReceipt = readJson<SliceReceipt>(
    join(FIXTURE_ROOT, "released-main-static/released-main-slice-receipt.json"),
  );
  samples = readJson<Samples>(join(FIXTURE_ROOT, "decoder-samples.json"));
}, 70_000);

const withFixtureCopy = (
  run: (copy: string, parent: string, canary: string) => void,
): void => {
  const parent = mkdtempSync(join(tmpdir(), "vellum-command-package-proof-"));
  const copy = join(parent, "fixture");
  const canary = join(parent, "fixture-code-ran");
  try {
    cpSync(FIXTURE_ROOT, copy, { recursive: true });
    run(copy, parent, canary);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
};
const maliciousProgram = (canary: string): Buffer =>
  Buffer.from(
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(canary)}, "fixture code ran");\nprocess.stdout.write("{}\\n");\n`,
  );
const replaceBundle = (
  copy: string,
  canary: string,
  updateManifest: boolean,
): MutableManifest => {
  const manifestPath = join(copy, "package-pair.json");
  const mutable = readJson<MutableManifest>(manifestPath);
  const raw = maliciousProgram(canary);
  const compressed = gzipSync(raw, { level: 9 });
  const bundlePath = "bundles/unreleased-protocol1-v2-decoder.mjs.gz";
  writeFileSync(join(copy, bundlePath), compressed);
  if (updateManifest) {
    const bundle = mutable.cohorts["unreleased-protocol1-v2"]!.bundle;
    bundle.compressedBytes = compressed.byteLength;
    bundle.compressedSha256 = sha256(compressed);
    bundle.executableBytes = raw.byteLength;
    bundle.executableSha256 = sha256(raw);
    const file = mutable.files.find((entry) => entry.path === bundlePath);
    if (file === undefined) throw new Error("missing bundle inventory entry");
    file.bytes = compressed.byteLength;
    file.sha256 = sha256(compressed);
    writeJson(manifestPath, mutable);
  }
  return mutable;
};
const refreshManifestFile = (
  copy: string,
  mutable: MutableManifest,
  relativePath: string,
): void => {
  const bytes = readFileSync(join(copy, relativePath));
  const entry = mutable.files.find((candidate) => candidate.path === relativePath);
  if (entry === undefined) throw new Error(`missing inventory entry: ${relativePath}`);
  entry.bytes = bytes.byteLength;
  entry.sha256 = sha256(bytes);
};

describe("planning Task package provenance", () => {
  it("checks the independent manifest trust root before qualification", () => {
    expect(trustSummary).toMatchObject({
      manifestSha256: MANIFEST_SHA256,
      verifiedFiles: manifest.files.length,
      releasedPackageEvidence: "static-hash-and-marker-only",
    });
    expect(sha256(readFileSync(join(FIXTURE_ROOT, "package-pair.json")))).toBe(
      MANIFEST_SHA256,
    );
    expect(manifest.contract).toBe(
      "vellum-command/planning-task-package-provenance/v3",
    );
    expect(qualification.integrity).toEqual({
      manifestSha256: MANIFEST_SHA256,
      verifiedFiles: manifest.files.length,
      receiptsCrossChecked: 3,
      protocolPinsChecked: manifest.protocolPins.unchangedFiles.length,
    });
    expect(Object.keys(manifest.receipts).sort()).toEqual([
      "externalBuild",
      "publicPackage",
      "releasedMainSlice",
    ]);
    expect(manifest.files.some((entry) => entry.path === "verify-trust-root.mjs")).toBe(
      false,
    );
    expect(sha256(readFileSync(TRUST_VERIFIER))).toBe(TRUST_VERIFIER_SHA256);
    expect(sha256(readFileSync(QUALIFIER))).toBe(QUALIFIER_SHA256);
  });

  it("rejects a changed executable blob before fixture code runs", () => {
    withFixtureCopy((copy, _parent, canary) => {
      replaceBundle(copy, canary, false);
      const checked = runNode(trustArgs(copy, MANIFEST_SHA256), 10_000);
      expect(checked.status).toBe(1);
      expect(checked.stderr).toMatch(/fixture hash mismatch/u);
      expect(existsSync(canary)).toBe(false);
    });
  });

  it("rejects changed manifest bytes before parsing or fixture code", () => {
    withFixtureCopy((copy, _parent, canary) => {
      const mutable = replaceBundle(copy, canary, true);
      mutable.generatedAt = "attacker changed the manifest";
      writeJson(join(copy, "package-pair.json"), mutable);
      const checked = runNode(trustArgs(copy, MANIFEST_SHA256), 10_000);
      expect(checked.status).toBe(1);
      expect(checked.stderr).toMatch(/manifest SHA-256 mismatch/u);
      expect(existsSync(canary)).toBe(false);
    });
  });

  it("rejects a caller constant mismatch before fixture code", () => {
    withFixtureCopy((copy, _parent, canary) => {
      const mutable = readJson<MutableManifest>(join(copy, "package-pair.json"));
      writeFileSync(
        join(copy, "qualify.mjs"),
        maliciousProgram(canary),
      );
      refreshManifestFile(copy, mutable, "qualify.mjs");
      writeJson(join(copy, "package-pair.json"), mutable);
      const checked = runNode(trustArgs(copy, "0".repeat(64)), 10_000);
      expect(checked.status).toBe(1);
      expect(checked.stderr).toMatch(/caller manifest root is not the verifier-owned root/u);
      expect(existsSync(canary)).toBe(false);
    });
  });

  it("rejects a coordinated qualifier, manifest, and expected-hash change through the end-to-end gate", () => {
    withFixtureCopy((copy, _parent, canary) => {
      const manifestPath = join(copy, "package-pair.json");
      const mutable = readJson<MutableManifest>(manifestPath);
      writeFileSync(join(copy, "qualify.mjs"), maliciousProgram(canary));
      refreshManifestFile(copy, mutable, "qualify.mjs");
      writeJson(manifestPath, mutable);
      const changedManifestSha256 = sha256(readFileSync(manifestPath));
      const pipeline = runEndToEnd(copy, changedManifestSha256);
      expect(pipeline.trust.status).toBe(1);
      expect(pipeline.trust.stderr).toMatch(
        /caller manifest root is not the verifier-owned root/u,
      );
      expect(pipeline.qualification).toBeUndefined();
      expect(existsSync(canary)).toBe(false);
    });
  });

  it("rejects a root-local verifier replacement before dynamic import", () => {
    withFixtureCopy((copy, _parent, canary) => {
      writeFileSync(
        join(copy, "verify-trust-root.mjs"),
        `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(canary)}, "verifier ran");
export const verifyTrustRoot = () => ({});
`,
      );
      const qualified = runNode(
        qualifierArgs(join(copy, "qualify.mjs"), copy, MANIFEST_SHA256),
        10_000,
      );
      expect(qualified.status).toBe(1);
      expect(qualified.stderr).toMatch(
        /trust verifier SHA-256 mismatch before import/u,
      );
      expect(existsSync(canary)).toBe(false);
    });
  });

  it("rejects a coordinated blob, manifest, and constant change at the verifier-owned root", () => {
    withFixtureCopy((copy, _parent, canary) => {
      replaceBundle(copy, canary, true);
      const changedManifestSha256 = sha256(
        readFileSync(join(copy, "package-pair.json")),
      );
      const checked = runNode(
        trustArgs(copy, changedManifestSha256),
        10_000,
      );
      expect(checked.status).toBe(1);
      expect(checked.stderr).toMatch(
        /caller manifest root is not the verifier-owned root/u,
      );
      expect(existsSync(canary)).toBe(false);
    });
  });

  it("rejects coordinated feed, lineage, receipt, and qualifier rewrites", () => {
    withFixtureCopy((copy, _parent, canary) => {
      const manifestPath = join(copy, "package-pair.json");
      const mutable = readJson<MutableManifest>(manifestPath);
      writeFileSync(join(copy, "qualify.mjs"), maliciousProgram(canary));
      refreshManifestFile(copy, mutable, "qualify.mjs");

      const receiptPath = "public-package-receipt.json";
      const receipt = readJson<{
        extractedApp: { mainBundleSha256: string };
        releaseAuthority: { feedBytes: number };
        buildTreeProvenance: {
          embeddedCommit: string | null;
          exactBuildTreeProven: boolean;
          dirtyBuildExcluded: boolean;
        };
        staticCompiledEvidence: { extractionReceipt: string };
      }>(join(copy, receiptPath));
      const conflictingHash = "f".repeat(64);
      receipt.extractedApp.mainBundleSha256 = conflictingHash;
      receipt.releaseAuthority.feedBytes = 999;
      receipt.buildTreeProvenance.embeddedCommit = conflictingHash.slice(0, 40);
      receipt.buildTreeProvenance.exactBuildTreeProven = true;
      receipt.buildTreeProvenance.dirtyBuildExcluded = true;
      receipt.staticCompiledEvidence.extractionReceipt = "attacker-receipt.json";
      writeJson(join(copy, receiptPath), receipt);
      refreshManifestFile(copy, mutable, receiptPath);
      const receiptFile = mutable.files.find((entry) => entry.path === receiptPath)!;
      mutable.receipts.publicPackage = {
        ...mutable.receipts.publicPackage!,
        path: receiptPath,
        bytes: receiptFile.bytes,
        sha256: receiptFile.sha256,
      };
      mutable.publicPackage.packageIdentity.extractedApp.mainBundleSha256 =
        conflictingHash;
      writeJson(manifestPath, mutable);

      const changedManifestSha256 = sha256(readFileSync(manifestPath));
      const pipeline = runEndToEnd(copy, changedManifestSha256);
      expect(pipeline.trust.status).toBe(1);
      expect(pipeline.trust.stderr).toMatch(
        /caller manifest root is not the verifier-owned root/u,
      );
      expect(pipeline.qualification).toBeUndefined();
      expect(existsSync(canary)).toBe(false);
    });
  });

  it("runs the revised integrity qualifier from an isolated fixture copy without network", () => {
    withFixtureCopy((copy) => {
      const trust = runNode(trustArgs(copy, MANIFEST_SHA256), 10_000);
      expect(trust.status, trust.stderr || trust.stdout).toBe(0);
      const qualified = runNode(
        qualifierArgs(join(copy, "qualify.mjs"), copy, MANIFEST_SHA256, true),
        10_000,
      );
      expect(qualified.status, qualified.stderr || qualified.stdout).toBe(0);
      expect(JSON.parse(qualified.stdout)).toEqual({
        integrity: {
          manifestSha256: MANIFEST_SHA256,
          verifiedFiles: manifest.files.length,
          receiptsCrossChecked: 3,
          protocolPinsChecked: manifest.protocolPins.unchangedFiles.length,
        },
      });
    });
  });

  it("confines every archived decoder and denies prepended write, network, child, and env effects", () => {
    expect(qualification.confinement).toMatchObject({
      runtime: expect.stringMatching(/^stock-node-26\./u),
      permissionModel: true,
      allowFsRead: "exact executable and admitted input files only",
      allowFsWrite: false,
      allowNetwork: false,
      allowChildProcess: false,
      allowAddons: false,
      allowWorker: false,
      inheritedEnvironment: false,
      timeoutMs: 10_000,
      maxInputBytes: 128 * 1024,
      maxOutputBytes: 64 * 1024,
      maxDiagnosticBytes: 64 * 1024,
      maxOldSpaceMiB: 256,
      canaryTouched: false,
    });
    expect(qualification.confinement.prependedSideEffects).toEqual({
      outcomes: {
        write: {
          outcome: "denied",
          code: "ERR_ACCESS_DENIED",
          permission: "FileSystemWrite",
        },
        network: { outcome: "denied", code: "ERR_ACCESS_DENIED" },
        child: {
          outcome: "denied",
          code: "ERR_ACCESS_DENIED",
          permission: "ChildProcess",
        },
      },
      inheritedSecret: null,
      continuedAfterPrependedAttempts: true,
    });
    expect(qualification.confinement.limitProbes).toEqual({
      timeout: { denied: true, code: "ETIMEDOUT" },
      stdout: { denied: true, code: "ENOBUFS" },
      stderr: { denied: true, code: "ENOBUFS" },
      input: { denied: true, code: "exceeded" },
    });
  });

  it("records only static released-package bytes with reviewable extraction lineage", () => {
    expect(publicPackage.zip).toMatchObject({
      bytes: 176_039_073,
      sha256:
        "e47a0edb0eb1642b517a7916855dae1f911d4c6006bfe9e31c356b3621a6670e",
      sha512Base64:
        "vACmL001sTgBRCe45SNkxDtflhyuuhi+30bWGDwn51vXpz5ELDbv3lnOEKkFgmKLObjAvvdmYermcM9dsZQYvQ==",
    });
    expect(publicPackage.extractedApp).toMatchObject({
      productName: "Vellum Command",
      bundleShortVersion: "0.1.14",
      codesignDeepStrict: "passed",
      staplerValidation: "passed",
      gatekeeperAssessment: "accepted-notarized-developer-id",
      appAsarSha256:
        "11ccaee77152f1e9024c1ac24048370173a058f840c0bd9b6cd25332e5953bbf",
      mainBundleBytes: 3_099_351,
      mainBundleSha256:
        "9564bbabfc5ce075951e70d1a80520ba58454adb27384d6b67bd2594af01ee66",
      cliSha256:
        "17609d6a0a61b9fa36ed9fdff3d72c0b6649a8b6501d0848587e6cdaa05179d5",
    });
    expect(publicPackage.releaseAuthority).toMatchObject({
      kind: "cloudflare-r2-generic-feed",
      feedFixture: "public-latest-mac.yml",
      feedBytes: 534,
      feedSha256:
        "c6f8a2f0e5bba9de4621a067ea2ab3ff1e9820d6e40c013363e8b91f8b38e734",
      githubReleaseAbsent: true,
    });
    expect(publicPackage.buildTreeProvenance).toMatchObject({
      embeddedCommit: null,
      packageIncludesAtLeastCommit: "2dc82e9e8d9a20e99dba5d3c147b590c74332a24",
      exactBuildTreeProven: false,
      dirtyBuildExcluded: false,
    });
    expect(sliceReceipt.sourcePackage).toMatchObject({
      productName: "Vellum Command",
      appVersion: "0.1.14",
      zipSha256: publicPackage.zip.sha256,
      appAsarSha256: publicPackage.extractedApp.appAsarSha256,
      mainSha256: publicPackage.extractedApp.mainBundleSha256,
      mainAsarOffset: "132581232",
      mainSourceMapPresent: false,
    });
    expect(sliceReceipt.extraction.script).toMatchObject({
      path: "extract-released-main-slices.mjs",
      bytes: expect.any(Number),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(sliceReceipt.extraction.commands).toEqual(
      expect.arrayContaining([
        expect.stringContaining("extract-released-main-slices.mjs"),
        expect.stringContaining("diff -r"),
      ]),
    );
    for (const range of sliceReceipt.extraction.ranges) {
      const bytes = readFileSync(join(FIXTURE_ROOT, range.path));
      const text = bytes.toString("utf8");
      expect(bytes.byteLength, range.id).toBe(range.bytes);
      expect(sha256(bytes), range.id).toBe(range.sha256);
      expect(range.end - range.start, range.id).toBe(range.bytes);
      expect(range.transform).toBe("exact Buffer.subarray, no rewriting");
      for (const marker of range.markers) {
        expect(text.split(marker.marker).length - 1, marker.marker).toBe(1);
      }
      for (const marker of range.forbiddenMarkers) {
        expect(text, marker.marker).not.toContain(marker.marker);
      }
    }
    expect(qualification.releasedPackageStaticEvidence).toMatchObject({
      mode: "static-hash-and-marker-only",
      archivedBytesExecuted: false,
      instrumentedBundlePresent: false,
    });
    expect(manifest.publicPackage.staticEvidence).toMatchObject({
      mode: "static-hash-and-marker-only",
      archivedBytesExecuted: false,
      instrumentedExecutablePresent: false,
    });
    expect(publicPackage.staticCompiledEvidence).toMatchObject({
      archivedBytesExecuted: false,
      instrumentedExecutablePresent: false,
    });
    expect(externalReceipt.releasedPackageStaticExtraction).toMatchObject({
      mode: "static-hash-and-marker-only",
      archivedBytesExecuted: false,
      instrumentedExecutablePresent: false,
    });
    expect(
      existsSync(
        join(
          FIXTURE_ROOT,
          "bundles/released-package-instrumented-decoder.mjs.gz",
        ),
      ),
    ).toBe(false);
  });

  it("keeps packaged observations narrow and does not claim production ingress ordering", () => {
    expect(publicPackage.cohort).toMatchObject({
      stateSchemaVersion: 18,
      tasksCreateSchemaId: "tasks.create.input/v2",
      stationProtocolBaseline: 5,
      stationProtocolSupport: {
        preferred: 5,
        compatibleFrom: 5,
        warnBelow: 5,
      },
    });
    expect(publicPackage.observedPackageCommands).toMatchObject({
      cliVersion: {
        exitCode: 0,
        stdout: "vellum-command v0.1.0\n",
      },
      tasksCreateSchema: {
        exitCode: 0,
        data: {
          schema_id: "tasks.create.input/v2",
          schema: { additionalProperties: false },
        },
      },
    });
    expect(publicPackage.observedPackageCommands.cliVersion.note).toContain(
      "not app provenance",
    );
    expect(publicPackage.observedProtocol1Exchange).toMatchObject({
      authority: "hash-pinned unsigned observation, not executable proof",
      response: {
        frame: "reject",
        stateSchemaVersion: 18,
        support: { preferred: 5, compatibleFrom: 5, warnBelow: 5 },
        reason: "no-common-version",
        retryable: false,
      },
      ingressOrderingProven: false,
    });
    expect(publicPackage.observedProtocol1Exchange.limitation).toContain(
      "do not prove production call ordering",
    );
    expect(publicPackage.observedPackageSchema20Refusal).toMatchObject({
      authority:
        "hash-pinned unsigned observation, not a rerun by the focused qualifier",
      exitCode: 1,
      diagnostic: "schema user_version=20 supported=18 appVersion=0.1.14",
      byteIdentical: true,
      userVersionAfter: 20,
      sentinelAfter: "unchanged",
      runtimeProofInFocusedQualifier: false,
    });
    expect(publicPackage.observedPackageSchema20Refusal.before).toEqual(
      publicPackage.observedPackageSchema20Refusal.after,
    );
    expect(sliceReceipt.proofBoundary.doesNotProve).toEqual(
      expect.arrayContaining([
        "production package call ordering",
        "preface rejection before Work decode",
        "a released older Remote pairing",
      ]),
    );
    expect(externalReceipt.driver.description).toContain(
      "proves only this archive driver",
    );
    expect(manifest.honestFindings.join("\n")).toContain(
      "not production package ingress ordering",
    );
    expect(publicPackage.limitation).toContain(
      "No older Remote package has been released",
    );
  });

  it("cross-checks exact archive builds and their byte-identical rebuild receipts", () => {
    const expected = {
      "released-0.1.14": {
        commit: "1719b8d04576fe85332f4a1bbc8eb0d8814c470c",
        treeOidSha1: "335aef843a3d9a5f34c061dd953e9c8bddfc3be1",
        releaseStatus: "public-0.1.14-decoder-source-cohort",
        remoteArtifactStatus: "no-released-remote-artifact",
        archiveSha256:
          "a9996ccdc16abee320dd003a56e7e205d1c2137bf8e6bdd23dacc8aac6a129ef",
      },
      "unreleased-protocol1-v2": {
        commit: "57571f60ba1d2033ec27dc536a151f60c8fc8e87",
        treeOidSha1: "7e62be161016a7165184a899c617e3da8f5ba661",
        releaseStatus: "unreleased-source-cohort",
        remoteArtifactStatus: "remote-stations-not-released",
        archiveSha256:
          "95c5c94159543a346861c2250fb9e64b948d268aedd691b84cd926cccd0f6ee6",
      },
      "current-v3": {
        commit: "e020eb03bd2caf895796f240dc88909983894c8d",
        treeOidSha1: "76835a52d5372338c788845555ba1fd4751d16b6",
        releaseStatus: "unreleased-candidate-source-cohort",
        remoteArtifactStatus: "remote-stations-not-released",
        archiveSha256:
          "0e0a6a89b4939e269150fb8a0771e3a5b3ecf553a7d6a269189ebac30c5a50e9",
      },
    } as const;
    expect(Object.keys(manifest.cohorts).sort()).toEqual(Object.keys(expected).sort());
    expect(Object.keys(externalReceipt.cohorts).sort()).toEqual(
      Object.keys(expected).sort(),
    );
    for (const [name, identity] of Object.entries(expected)) {
      const cohort = manifest.cohorts[name]!;
      const receipt = externalReceipt.cohorts[name]!;
      expect(cohort).toMatchObject({
        commit: identity.commit,
        treeOidSha1: identity.treeOidSha1,
        cohort: {
          releaseStatus: identity.releaseStatus,
          remoteArtifactStatus: identity.remoteArtifactStatus,
        },
        archive: { sha256: identity.archiveSha256 },
      });
      expect(receipt).toMatchObject({
        commit: identity.commit,
        treeOidSha1: identity.treeOidSha1,
        archive: { sha256: identity.archiveSha256 },
      });
      expect(cohort.bundle).toMatchObject({
        artifactKind: "archive-built-source-decoder-bundle",
        isReleasedPackage: false,
        deterministicRebuildVerified: true,
        repeatBuildExecutableSha256: cohort.bundle.executableSha256,
      });
      expect(receipt.decoderBundleBuild).toMatchObject(cohort.bundle);
      const compressed = readFileSync(join(FIXTURE_ROOT, cohort.bundle.path));
      const executable = gunzipSync(compressed, {
        maxOutputLength: cohort.bundle.executableBytes,
      });
      expect(compressed.byteLength, name).toBe(cohort.bundle.compressedBytes);
      expect(sha256(compressed), name).toBe(cohort.bundle.compressedSha256);
      expect(executable.byteLength, name).toBe(cohort.bundle.executableBytes);
      expect(sha256(executable), name).toBe(cohort.bundle.executableSha256);
    }
    expect(externalReceipt.rebuildScript).toMatchObject({
      path: "rebuild-source-decoder.mjs",
      bytes: expect.any(Number),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      command: expect.stringContaining("--cohort"),
    });
  });

  it("executes unreleased v2 and current v3 source decoders only after protocol selection", () => {
    const legacy = qualification.matrices.legacyV2;
    expect(legacy.cohort).toMatchObject({
      tasksCreateSchemaId: "tasks.create.input/v2",
      stateSchemaVersion: 20,
      stationProtocolBaseline: 1,
      stationProtocolSupport: {
        preferred: 1,
        compatibleFrom: 1,
        warnBelow: 1,
      },
      workProtocol: "vellum/work/v2",
    });
    expect(legacy.negotiation._tag).toBe("selected");
    expect(legacy.guarded.versionedDecoderInvocations).toBe(1);
    expect(legacy.guarded.result.accepted).toBe(false);
    expect(legacy.records.legacy?.accepted).toBe(true);
    expect(legacy.records.dependsOnOnly?.accepted).toBe(true);
    expect(legacy.records.admissionOnly).toMatchObject({
      accepted: false,
      namesAdmission: true,
    });
    expect(legacy.records.raisedByOnly).toMatchObject({
      accepted: false,
      namesRaisedBy: true,
    });
    expect(legacy.records.currentV3?.accepted).toBe(false);

    const current = qualification.matrices.current;
    expect(current.cohort).toMatchObject({
      tasksCreateSchemaId: "tasks.create.input/v3",
      stateSchemaVersion: 20,
      stationProtocolBaseline: 1,
      workProtocol: "vellum/work/v2",
    });
    expect(current.negotiation._tag).toBe("selected");
    expect(current.guarded.versionedDecoderInvocations).toBe(1);
    expect(current.guarded.result.accepted).toBe(true);
    expect(Object.values(current.records).every((outcome) => outcome.accepted)).toBe(
      true,
    );
    expect(qualification.matrices.released.negotiation._tag).toBe("no-common");
    expect(
      qualification.matrices.released.guarded.versionedDecoderInvocations,
    ).toBe(0);
    expect(
      qualification.matrices.currentAgainstReleased.guarded
        .versionedDecoderInvocations,
    ).toBe(0);

    expect(manifest.v3Introduction).toMatchObject({
      commit: "e846e7d11d2ed4d0a0d1bcf6a58ccf243ad514e7",
      parent: "57571f60ba1d2033ec27dc536a151f60c8fc8e87",
    });
    const liveSchema = renderSchemaContract(tasksCreateSchema);
    expect(liveSchema.schema_id).toBe("tasks.create.input/v3");
    expect(liveSchema.schema).toMatchObject({
      properties: {
        admission: {
          type: "string",
          enum: ["auto", "operator-gated", "operator-owned"],
        },
        dependsOn: { type: "array" },
      },
      additionalProperties: false,
    });
    expect(Result.isSuccess(decodeWorkRecord(samples.records.currentV3))).toBe(
      true,
    );
  });

  it("proves schema-18 archive-source refusal without mutation and labels package refusal as an observation", () => {
    expect(qualification.schema18ArchiveSourceRefusal).toMatchObject({
      byteIdentical: true,
      beforeSidecars: [],
      afterSidecars: [],
      userVersion: 20,
      sentinel: { id: "sentinel", payload: "must-survive" },
      probe: {
        compatibility: {
          ok: false,
          reason: "newer-than-supported",
          userVersion: 20,
          supportedVersion: 18,
        },
      },
    });
    expect(qualification.schema18ArchiveSourceRefusal.beforeSha256).toBe(
      qualification.schema18ArchiveSourceRefusal.afterSha256,
    );
    expect(qualification.schema18ArchiveSourceRefusal.beforeMtimeNs).toBe(
      qualification.schema18ArchiveSourceRefusal.afterMtimeNs,
    );
    expect(publicPackage.observedPackageSchema20Refusal).toMatchObject({
      authority: "hash-pinned unsigned observation, not a rerun by the focused qualifier",
      exitCode: 1,
      diagnostic: "schema user_version=20 supported=18 appVersion=0.1.14",
      byteIdentical: true,
      userVersionAfter: 20,
      sentinelAfter: "unchanged",
      runtimeProofInFocusedQualifier: false,
    });
    expect(publicPackage.observedPackageSchema20Refusal.before).toEqual(
      publicPackage.observedPackageSchema20Refusal.after,
    );
  });

  it("pins unchanged protocol bytes and current protocol-1 behavior", () => {
    expect(CURRENT_STATE_SCHEMA_VERSION).toBe(21);
    expect(STATION_PROTOCOL_BASELINE).toBe(1);
    expect(CURRENT_STATION_PROTOCOL_SUPPORT).toEqual({
      preferred: 1,
      compatibleFrom: 1,
      warnBelow: 1,
    });
    expect(selectStationProtocolCodec(1)).toEqual(Result.succeed(1));
    expect(selectStationProtocolCodec(5)).toEqual(
      Result.fail("unsupported-station-protocol"),
    );
    expect({
      session: STATION_SESSION_PROTOCOL,
      api: STATION_API_PROTOCOL,
      control: STATION_CONTROL_PROTOCOL,
      work: WORK_PROTOCOL,
    }).toEqual({
      session: "vellum-command/station-session/v1",
      api: "vellum-command/station-api/v1",
      control: "vellum-command/station-control/v1",
      work: "vellum/work/v2",
    });

    expect(manifest.protocolPins.preTaskBaseCommit).toBe(
      "259d29a0518dd1b00d191f3b05b3a0b48adbe8d8",
    );
    for (const pin of manifest.protocolPins.unchangedFiles) {
      const bytes = readFileSync(join(PROJECT_ROOT, pin.path));
      expect(bytes.byteLength, pin.path).toBe(pin.bytes);
      expect(sha256(bytes), pin.path).toBe(pin.sha256);
    }
    const stationCorpus = readJson<{ readonly taskCreateFact: unknown }>(
      join(
        PROJECT_ROOT,
        "tests/fixtures/station-protocol-v1/content-wire-corpus.json",
      ),
    );
    expect(sha256(JSON.stringify(stationCorpus.taskCreateFact))).toBe(
      manifest.protocolPins.taskCreateCanonicalJsonSha256,
    );
  });

  it("keeps product copy and checked evidence free of the banned separator", () => {
    const textPaths = [
      "package-pair.json",
      "verify-trust-root.mjs",
      ...manifest.files
        .map((entry) => entry.path)
        .filter((path) => !path.endsWith(".gz") && !path.endsWith(".db")),
    ];
    for (const path of textPaths) {
      const text = readFileSync(join(FIXTURE_ROOT, path), "utf8");
      expect(text, path).not.toContain("\u00b7");
      expect(text, path).not.toMatch(/\bVellum\b(?! Command|-Command)/u);
    }
  });
});
