#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
const CHILD_TIMEOUT_MS = 10_000;
const CHILD_MAX_INPUT_BYTES = 128 * 1024;
const CHILD_MAX_OUTPUT_BYTES = 64 * 1024;
const CHILD_MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const CHILD_MAX_OLD_SPACE_MIB = 256;
const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  if (index === -1 || args[index + 1] === undefined) {
    throw new Error(`missing ${flag}`);
  }
  return args[index + 1];
};
const ROOT = resolve(
  args.includes("--root") ? valueAfter("--root") : SCRIPT_ROOT,
);
const expectedManifestSha256 = valueAfter("--expected-manifest-sha256");
const expectedVerifierSha256 = valueAfter("--expected-verifier-sha256");
const PROJECT_ROOT = resolve(
  args.includes("--project-root")
    ? valueAfter("--project-root")
    : join(ROOT, "../../.."),
);
const integrityOnly = args.includes("--integrity-only");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

// No temp path, decompression, dynamic import, or child execution exists above
// this barrier. Authenticate the local verifier as inert bytes before importing
// that exact buffer from a data URL. A root-local replacement is never loaded.
assert(/^[a-f0-9]{64}$/u.test(expectedVerifierSha256), "invalid verifier SHA-256 root");
const verifierPath = join(ROOT, "verify-trust-root.mjs");
const verifierStat = lstatSync(verifierPath);
assert(
  verifierStat.isFile() && !verifierStat.isSymbolicLink(),
  "trust verifier is not a regular non-symlink file",
);
assert(verifierStat.size <= 64 * 1024, "trust verifier exceeds 64 KiB");
const verifierBytes = readFileSync(verifierPath);
assert(
  verifierBytes.byteLength === verifierStat.size &&
    sha256(verifierBytes) === expectedVerifierSha256,
  "trust verifier SHA-256 mismatch before import",
);
const verifierModule = await import(
  `data:text/javascript;base64,${verifierBytes.toString("base64")}`
);
assert(
  typeof verifierModule.verifyTrustRoot === "function",
  "authenticated verifier does not export verifyTrustRoot",
);
const trusted = verifierModule.verifyTrustRoot({
  root: ROOT,
  projectRoot: PROJECT_ROOT,
  expectedManifestSha256,
});

const safeChildEnv = (work) => ({
  HOME: work,
  TMPDIR: work,
  LANG: "C",
  LC_ALL: "C",
  TZ: "UTC",
  NO_COLOR: "1",
});
const boundedText = (bytes, label, limit) => {
  if (bytes.byteLength > limit) {
    throw new Error(`${label} exceeded ${limit} bytes`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
};
const runConfinedJson = ({
  executable,
  argv = [],
  input,
  readPaths = [],
  work,
  timeoutMs = CHILD_TIMEOUT_MS,
}) => {
  const inputBytes = Buffer.from(`${JSON.stringify(input)}\n`);
  if (inputBytes.byteLength > CHILD_MAX_INPUT_BYTES) {
    throw new Error(`confined JSON input exceeded ${CHILD_MAX_INPUT_BYTES} bytes`);
  }
  const canonicalExecutable = realpathSync(executable);
  const canonicalReads = [
    canonicalExecutable,
    ...readPaths.map((path) => realpathSync(path)),
  ];
  const permissionArgs = [...new Set(canonicalReads)].map(
    (path) => `--allow-fs-read=${path}`,
  );
  const child = spawnSync(
    process.execPath,
    [
      "--permission",
      "--no-warnings",
      `--max-old-space-size=${CHILD_MAX_OLD_SPACE_MIB}`,
      ...permissionArgs,
      "--",
      canonicalExecutable,
      ...argv,
    ],
    {
      cwd: work,
      env: safeChildEnv(work),
      input: inputBytes,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: null,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: CHILD_MAX_OUTPUT_BYTES,
      windowsHide: true,
    },
  );
  if (child.error !== undefined) {
    throw new Error(
      `confined child failed: ${child.error.code ?? "unknown"}: ${child.error.message}`,
    );
  }
  const stdout = Buffer.from(child.stdout ?? []);
  const stderr = Buffer.from(child.stderr ?? []);
  const diagnostic = boundedText(
    stderr.subarray(0, CHILD_MAX_DIAGNOSTIC_BYTES),
    "confined child stderr",
    CHILD_MAX_DIAGNOSTIC_BYTES,
  );
  if (child.status !== 0 || child.signal !== null) {
    throw new Error(
      `confined child exited status=${String(child.status)} signal=${String(child.signal)}: ${diagnostic}`,
    );
  }
  const text = boundedText(
    stdout,
    "confined child stdout",
    CHILD_MAX_OUTPUT_BYTES,
  );
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `confined child did not emit exactly one JSON value: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};
const ensureStockPermissionNode = () => {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  const requiredFlags = [
    "--permission",
    "--allow-fs-read",
    "--allow-fs-write",
    "--allow-net",
    "--allow-child-process",
    "--allow-addons",
    "--allow-worker",
  ];
  if (
    process.release.name !== "node" ||
    major !== 26 ||
    requiredFlags.some((flag) => !process.allowedNodeEnvironmentFlags.has(flag))
  ) {
    throw new Error(
      "stock Node 26 with the complete permission model is required; there is no ambient fallback",
    );
  }
};

const run = async () => {
  if (integrityOnly) {
    return {
      integrity: {
        manifestSha256: trusted.manifestSha256,
        verifiedFiles: trusted.verifiedFiles,
        receiptsCrossChecked: 3,
        protocolPinsChecked: trusted.manifest.protocolPins.unchangedFiles.length,
      },
    };
  }
  ensureStockPermissionNode();
  const { gunzipSync } = await import("node:zlib");
  const work = realpathSync(
    mkdtempSync(join(tmpdir(), "vellum-command-package-pair-")),
  );
  try {
    const executables = {};
    for (const [name, cohort] of Object.entries(trusted.manifest.cohorts)) {
      const compressed = trusted.buffers.get(cohort.bundle.path);
      const executable = gunzipSync(compressed, {
        maxOutputLength: cohort.bundle.executableBytes,
      });
      assert(
        executable.byteLength === cohort.bundle.executableBytes &&
          sha256(executable) === cohort.bundle.executableSha256,
        `${name} executable bundle hash drift after trusted decompression`,
      );
      const path = join(work, `${name}.mjs`);
      writeFileSync(path, executable, { flag: "wx", mode: 0o400 });
      executables[name] = realpathSync(path);
    }

    const samples = JSON.parse(
      trusted.buffers.get("decoder-samples.json").toString("utf8"),
    ).records;
    const support1 = { preferred: 1, compatibleFrom: 1, warnBelow: 1 };
    const support5 = { preferred: 5, compatibleFrom: 5, warnBelow: 5 };
    const matrix = (name, peer) =>
      runConfinedJson({
        executable: executables[name],
        argv: ["matrix"],
        input: { records: samples, peer, guardedRecord: samples.currentV3 },
        work,
      });

    const released = matrix("released-0.1.14", support1);
    const legacyV2 = matrix("unreleased-protocol1-v2", support1);
    const current = matrix("current-v3", support1);
    const currentAgainstReleased = matrix("current-v3", support5);

    for (const [name, matrix] of [
      ["released-0.1.14", released],
      ["unreleased-protocol1-v2", legacyV2],
      ["current-v3", current],
      ["current-v3", currentAgainstReleased],
    ]) {
      const expected = trusted.manifest.cohorts[name].cohort;
      for (const field of [
        "tasksCreateSchemaId",
        "stateSchemaVersion",
        "stationProtocolBaseline",
        "stationProtocolSupport",
        "workProtocol",
      ]) {
        assert(
          JSON.stringify(matrix.cohort[field]) === JSON.stringify(expected[field]),
          `${name} confined cohort result conflicts with authenticated ${field}`,
        );
      }
    }

    assert(released.cohort.stateSchemaVersion === 18, "release-line source schema is not 18");
    assert(released.cohort.stationProtocolBaseline === 5, "release-line source protocol is not 5");
    assert(released.negotiation._tag === "no-common", "release-line archive driver unexpectedly overlaps protocol 1");
    assert(released.guarded.versionedDecoderInvocations === 0, "release-line archive driver attempted its guarded decode");
    assert(released.guarded.rejection.reason === "no-common-version", "release-line archive driver rejection drifted");
    assert(released.guarded.rejection.retryable === false, "release-line archive driver rejection became retryable");

    for (const older of [released, legacyV2]) {
      assert(older.records.legacy.accepted === true, "older decoder rejected its legacy Task");
      assert(older.records.dependsOnOnly.accepted === true, "older decoder rejected dependsOn");
      assert(older.records.admissionOnly.accepted === false, "older decoder accepted admission");
      assert(older.records.admissionOnly.namesAdmission === true, "older admission failure omitted the field name");
      assert(older.records.raisedByOnly.accepted === false, "older decoder accepted raisedBy");
      assert(older.records.raisedByOnly.namesRaisedBy === true, "older raisedBy failure omitted the field name");
      assert(older.records.currentV3.accepted === false, "older decoder silently accepted the v3 Task");
    }
    assert(legacyV2.cohort.tasksCreateSchemaId === "tasks.create.input/v2", "legacy source is not v2");
    assert(legacyV2.cohort.stationProtocolBaseline === 1, "legacy source is not protocol 1");
    assert(legacyV2.negotiation._tag === "selected", "legacy protocol 1 did not overlap current protocol 1");
    assert(legacyV2.guarded.versionedDecoderInvocations === 1, "legacy archive driver did not invoke its decoder after overlap");
    assert(legacyV2.guarded.result.accepted === false, "legacy decoder silently accepted the v3 Task");

    assert(current.cohort.tasksCreateSchemaId === "tasks.create.input/v3", "current source is not v3");
    assert(current.cohort.stationProtocolBaseline === 1, "current source is not protocol 1");
    for (const outcome of Object.values(current.records)) {
      assert(outcome.accepted === true, "current decoder rejected a valid historical or v3 Task");
    }
    assert(current.guarded.versionedDecoderInvocations === 1, "current archive driver did not invoke its decoder after overlap");
    assert(current.guarded.result.accepted === true, "current decoder rejected the v3 Task");
    assert(currentAgainstReleased.negotiation._tag === "no-common", "current protocol 1 unexpectedly overlaps protocol 5");
    assert(currentAgainstReleased.guarded.versionedDecoderInvocations === 0, "current archive driver attempted its guarded protocol-5 decode");

    const dbPath = join(work, "schema20-sentinel.db");
    writeFileSync(dbPath, trusted.buffers.get("schema20-sentinel.db"), {
      flag: "wx",
      mode: 0o600,
    });
    const canonicalDbPath = realpathSync(dbPath);
    const beforeBytes = readFileSync(canonicalDbPath);
    const beforeMtimeNs = statSync(canonicalDbPath, { bigint: true }).mtimeNs.toString();
    const beforeSidecars = readdirSync(work).filter((name) =>
      name.startsWith(`${basename(canonicalDbPath)}-`),
    );
    const schemaProbe = runConfinedJson({
      executable: executables["released-0.1.14"],
      argv: ["schema-probe", canonicalDbPath],
      input: {},
      readPaths: [canonicalDbPath],
      work,
    });
    const afterBytes = readFileSync(canonicalDbPath);
    const afterMtimeNs = statSync(canonicalDbPath, { bigint: true }).mtimeNs.toString();
    const afterSidecars = readdirSync(work).filter((name) =>
      name.startsWith(`${basename(canonicalDbPath)}-`),
    );
    const database = new DatabaseSync(canonicalDbPath, {
      open: true,
      readOnly: true,
      allowExtension: false,
    });
    const userVersion = Number(database.prepare("PRAGMA user_version").get().user_version);
    const sentinel = database
      .prepare("SELECT id, payload FROM qualification_sentinel")
      .get();
    database.close();
    const schema18Refusal = {
      beforeSha256: sha256(beforeBytes),
      afterSha256: sha256(afterBytes),
      byteIdentical: beforeBytes.equals(afterBytes),
      beforeMtimeNs,
      afterMtimeNs,
      beforeSidecars,
      afterSidecars,
      userVersion,
      sentinel,
      probe: schemaProbe,
    };
    assert(schema18Refusal.byteIdentical, "schema-18 archive source changed schema-20 bytes");
    assert(beforeMtimeNs === afterMtimeNs, "schema-18 archive source changed schema-20 mtime");
    assert(beforeSidecars.length === 0 && afterSidecars.length === 0, "schema-18 archive source created a SQLite sidecar");
    assert(userVersion === 20 && sentinel?.payload === "must-survive", "schema-20 sentinel changed");
    assert(schemaProbe.compatibility.ok === false, "schema-18 archive source admitted schema 20");
    assert(schemaProbe.compatibility.reason === "newer-than-supported", "schema refusal reason drifted");
    assert(schemaProbe.compatibility.supportedVersion === 18, "schema refusal support drifted");

    const canary = join(work, "sandbox-canary");
    const adversary = join(work, "prepended-side-effect-probe.mjs");
    const adversarySource = `
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { connect } from "node:net";
const input = JSON.parse(readFileSync(0, "utf8"));
const outcomes = {};
try {
  writeFileSync(input.canary, "ambient write escaped");
  outcomes.write = { outcome: "allowed" };
} catch (error) {
  outcomes.write = { outcome: "denied", code: error.code, permission: error.permission };
}
outcomes.network = await new Promise((resolveOutcome) => {
  try {
    const socket = connect({ host: "127.0.0.1", port: 9 });
    socket.once("connect", () => {
      socket.destroy();
      resolveOutcome({ outcome: "allowed" });
    });
    socket.once("error", (error) => {
      resolveOutcome({ outcome: "denied", code: error.code, permission: error.permission });
    });
  } catch (error) {
    resolveOutcome({ outcome: "denied", code: error.code, permission: error.permission });
  }
});
try {
  execFileSync(process.execPath, ["-e", "process.exit(0)"]);
  outcomes.child = { outcome: "allowed" };
} catch (error) {
  outcomes.child = { outcome: "denied", code: error.code, permission: error.permission };
}
process.stdout.write(JSON.stringify({
  outcomes,
  inheritedSecret: process.env.VELLUM_COMMAND_SANDBOX_PARENT_SECRET ?? null,
  continuedAfterPrependedAttempts: true,
}));
`;
    writeFileSync(adversary, adversarySource, { flag: "wx", mode: 0o400 });
    const sideEffects = runConfinedJson({
      executable: adversary,
      input: { canary },
      work,
    });
    assert(!existsSync(canary), "confined side-effect probe touched its canary");
    for (const name of ["write", "network", "child"]) {
      assert(sideEffects.outcomes[name].outcome === "denied", `${name} side effect escaped confinement`);
      assert(sideEffects.outcomes[name].code === "ERR_ACCESS_DENIED", `${name} denial code drifted`);
    }
    assert(sideEffects.inheritedSecret === null, "confined child inherited an ambient secret");
    assert(sideEffects.continuedAfterPrependedAttempts === true, "confined probe did not continue after denied prefixes");

    const expectBoundRejection = (label, expectedCode, operation) => {
      try {
        operation();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        assert(message.includes(expectedCode), `${label} failed for the wrong reason: ${message}`);
        return { denied: true, code: expectedCode };
      }
      throw new Error(`${label} unexpectedly escaped its bound`);
    };
    const timeoutProbe = join(work, "timeout-probe.mjs");
    writeFileSync(timeoutProbe, "for (;;) {}\n", { flag: "wx", mode: 0o400 });
    const stdoutProbe = join(work, "stdout-probe.mjs");
    writeFileSync(
      stdoutProbe,
      `process.stdout.write("x".repeat(${CHILD_MAX_OUTPUT_BYTES + 1}));
`,
      { flag: "wx", mode: 0o400 },
    );
    const stderrProbe = join(work, "stderr-probe.mjs");
    writeFileSync(
      stderrProbe,
      `process.stderr.write("x".repeat(${CHILD_MAX_DIAGNOSTIC_BYTES + 1}));
process.stdout.write("{}");
`,
      { flag: "wx", mode: 0o400 },
    );
    const limitProbes = {
      timeout: expectBoundRejection("timeout probe", "ETIMEDOUT", () =>
        runConfinedJson({
          executable: timeoutProbe,
          input: {},
          work,
          timeoutMs: 100,
        })),
      stdout: expectBoundRejection("stdout probe", "ENOBUFS", () =>
        runConfinedJson({ executable: stdoutProbe, input: {}, work })),
      stderr: expectBoundRejection("stderr probe", "ENOBUFS", () =>
        runConfinedJson({ executable: stderrProbe, input: {}, work })),
      input: expectBoundRejection("input probe", "exceeded", () =>
        runConfinedJson({
          executable: adversary,
          input: "x".repeat(CHILD_MAX_INPUT_BYTES + 1),
          work,
        })),
    };

    const staticEvidence = trusted.sliceReceipt;
    return {
      integrity: {
        manifestSha256: trusted.manifestSha256,
        verifiedFiles: trusted.verifiedFiles,
        receiptsCrossChecked: 3,
        protocolPinsChecked: trusted.manifest.protocolPins.unchangedFiles.length,
      },
      confinement: {
        runtime: `stock-node-${process.versions.node}`,
        permissionModel: true,
        allowFsRead: "exact executable and admitted input files only",
        allowFsWrite: false,
        allowNetwork: false,
        allowChildProcess: false,
        allowAddons: false,
        allowWorker: false,
        inheritedEnvironment: false,
        timeoutMs: CHILD_TIMEOUT_MS,
        maxInputBytes: CHILD_MAX_INPUT_BYTES,
        maxOutputBytes: CHILD_MAX_OUTPUT_BYTES,
        maxDiagnosticBytes: CHILD_MAX_DIAGNOSTIC_BYTES,
        maxOldSpaceMiB: CHILD_MAX_OLD_SPACE_MIB,
        prependedSideEffects: sideEffects,
        canaryTouched: existsSync(canary),
        limitProbes,
      },
      matrices: { released, legacyV2, current, currentAgainstReleased },
      releasedPackageStaticEvidence: {
        mode: staticEvidence.proofBoundary.mode,
        archivedBytesExecuted: staticEvidence.proofBoundary.archivedBytesExecuted,
        instrumentedBundlePresent: staticEvidence.proofBoundary.instrumentedBundlePresent,
        sourcePackage: staticEvidence.sourcePackage,
        ranges: staticEvidence.extraction.ranges.map(
          ({ id, path, start, end, bytes, sha256: hash }) => ({
            id,
            path,
            start,
            end,
            bytes,
            sha256: hash,
          }),
        ),
        proves: staticEvidence.proofBoundary.proves,
        doesNotProve: staticEvidence.proofBoundary.doesNotProve,
      },
      schema18ArchiveSourceRefusal: schema18Refusal,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
};

try {
  process.stdout.write(`${JSON.stringify(await run())}\n`);
} catch (error) {
  process.stderr.write(
    `planning package qualification failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
