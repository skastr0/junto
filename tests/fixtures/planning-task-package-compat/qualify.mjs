#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";

const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const rootIndex = args.indexOf("--root");
const ROOT = resolve(
  rootIndex === -1 ? SCRIPT_ROOT : (args[rootIndex + 1] ?? ""),
);
const integrityOnly = args.includes("--integrity-only");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifest = JSON.parse(readFileSync(join(ROOT, "package-pair.json"), "utf8"));

const verifyIntegrity = () => {
  const verified = [];
  for (const expected of manifest.files) {
    const path = join(ROOT, expected.path);
    const bytes = readFileSync(path);
    const actual = {
      path: expected.path,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    };
    if (
      actual.bytes !== expected.bytes ||
      actual.sha256 !== expected.sha256
    ) {
      throw new Error(
        `fixture hash mismatch for ${expected.path}: expected ${expected.sha256}/${expected.bytes}, got ${actual.sha256}/${actual.bytes}`,
      );
    }
    verified.push(actual);
  }
  return verified;
};

const cleanNodeEnv = () => {
  const env = { ...process.env, NO_COLOR: "1" };
  delete env.FORCE_COLOR;
  return env;
};

const runJson = (argv, input) => {
  const child = spawnSync(argv[0], argv.slice(1), {
    cwd: ROOT,
    env: cleanNodeEnv(),
    input: input === undefined ? undefined : JSON.stringify(input),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (child.status !== 0) {
    throw new Error(
      `qualification command failed (${argv.join(" ")}): ${child.stderr || child.stdout}`,
    );
  }
  return JSON.parse(child.stdout);
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const qualify = () => {
  const verifiedFiles = verifyIntegrity();
  if (integrityOnly) {
    return { integrity: { verifiedFiles: verifiedFiles.length } };
  }

  const work = mkdtempSync(join(tmpdir(), "vellum-command-package-pair-"));
  try {
    const executables = {};
    for (const [name, cohort] of Object.entries(manifest.cohorts)) {
      const compressed = readFileSync(join(ROOT, cohort.bundle.path));
      assert(
        sha256(compressed) === cohort.bundle.compressedSha256,
        `${name} compressed bundle hash drift`,
      );
      const executable = gunzipSync(compressed);
      assert(
        executable.byteLength === cohort.bundle.executableBytes &&
          sha256(executable) === cohort.bundle.executableSha256,
        `${name} executable bundle hash drift`,
      );
      const path = join(work, `${name}.mjs`);
      writeFileSync(path, executable);
      executables[name] = path;
    }

    const packageBundle = manifest.publicPackage.instrumentedDecoder;
    const packageCompressed = readFileSync(join(ROOT, packageBundle.path));
    assert(
      sha256(packageCompressed) === packageBundle.compressedSha256,
      "released package instrument bundle hash drift",
    );
    const packageExecutable = gunzipSync(packageCompressed);
    assert(
      packageExecutable.byteLength === packageBundle.executableBytes &&
        sha256(packageExecutable) === packageBundle.executableSha256,
      "released package instrument executable hash drift",
    );
    const packageExecutablePath = join(work, "released-package-instrument.mjs");
    writeFileSync(packageExecutablePath, packageExecutable);

    const samples = JSON.parse(
      readFileSync(join(ROOT, "decoder-samples.json"), "utf8"),
    ).records;
    const support1 = { preferred: 1, compatibleFrom: 1, warnBelow: 1 };
    const support5 = { preferred: 5, compatibleFrom: 5, warnBelow: 5 };
    const matrix = (name, peer) =>
      runJson(
        [process.execPath, executables[name], "matrix"],
        { records: samples, peer, guardedRecord: samples.currentV3 },
      );

    const released = matrix("released-0.1.14", support1);
    const legacyV2 = matrix("unreleased-protocol1-v2", support1);
    const current = matrix("current-v3", support1);
    const currentAgainstReleased = matrix("current-v3", support5);

    const packageSamplePaths = [];
    for (const [name, record] of Object.entries(samples)) {
      const path = join(work, `package-sample-${name}.json`);
      writeFileSync(path, JSON.stringify(record));
      packageSamplePaths.push(path);
    }
    const releasedPackageInstrument = runJson([
      process.execPath,
      packageExecutablePath,
      ...packageSamplePaths,
    ]);
    const packagedOutcomes = Object.fromEntries(
      releasedPackageInstrument.records.map((record) => [
        basename(record.file).replace(/^package-sample-|\.json$/gu, ""),
        record,
      ]),
    );
    assert(releasedPackageInstrument.baseline === 5, "released compiled package protocol is not 5");
    assert(releasedPackageInstrument.protocol1Negotiation._tag === "no-common", "released compiled package unexpectedly overlaps protocol 1");
    assert(packagedOutcomes.legacy.outcome === "accepted", "released compiled decoder rejected its old Task");
    assert(packagedOutcomes.dependsOnOnly.outcome === "accepted", "released compiled decoder rejected dependsOn");
    assert(packagedOutcomes.admissionOnly.outcome === "rejected" && /admission/u.test(packagedOutcomes.admissionOnly.error), "released compiled decoder accepted admission");
    assert(packagedOutcomes.raisedByOnly.outcome === "rejected" && /raisedBy/u.test(packagedOutcomes.raisedByOnly.error), "released compiled decoder accepted raisedBy");
    assert(packagedOutcomes.currentV3.outcome === "rejected", "released compiled decoder silently accepted v3");

    assert(released.cohort.stateSchemaVersion === 18, "released schema is not 18");
    assert(released.cohort.stationProtocolBaseline === 5, "released protocol is not 5");
    assert(released.negotiation._tag === "no-common", "released package unexpectedly overlaps protocol 1");
    assert(released.guarded.versionedDecoderInvocations === 0, "released preface gate attempted partial decode");
    assert(released.guarded.rejection.reason === "no-common-version", "released preface did not reject exactly");
    assert(released.guarded.rejection.retryable === false, "released preface rejection became retryable");

    for (const older of [released, legacyV2]) {
      assert(older.records.legacy.accepted === true, "older decoder rejected its legacy Task");
      assert(older.records.dependsOnOnly.accepted === true, "older decoder rejected the pre-existing dependsOn field");
      assert(older.records.admissionOnly.accepted === false, "older decoder accepted admission");
      assert(older.records.admissionOnly.namesAdmission === true, "older admission failure omitted the field name");
      assert(older.records.raisedByOnly.accepted === false, "older decoder accepted raisedBy");
      assert(older.records.raisedByOnly.namesRaisedBy === true, "older raisedBy failure omitted the field name");
      assert(older.records.currentV3.accepted === false, "older decoder silently accepted the v3 Task");
    }

    assert(legacyV2.cohort.tasksCreateSchemaId === "tasks.create.input/v2", "legacy source is not v2");
    assert(legacyV2.cohort.stationProtocolBaseline === 1, "legacy source is not protocol 1");
    assert(legacyV2.negotiation._tag === "selected", "legacy protocol 1 did not overlap current protocol 1");
    assert(legacyV2.guarded.versionedDecoderInvocations === 1, "legacy overlap did not exercise its decoder");
    assert(legacyV2.guarded.result.accepted === false, "legacy overlap silently accepted the v3 Task");

    assert(current.cohort.tasksCreateSchemaId === "tasks.create.input/v3", "current source is not v3");
    assert(current.cohort.stationProtocolBaseline === 1, "current source is not protocol 1");
    for (const outcome of Object.values(current.records)) {
      assert(outcome.accepted === true, "current decoder rejected a valid historical or v3 Task");
    }
    assert(current.guarded.versionedDecoderInvocations === 1, "current protocol 1 did not exercise its decoder");
    assert(current.guarded.result.accepted === true, "current decoder rejected the v3 Task");
    assert(currentAgainstReleased.negotiation._tag === "no-common", "current protocol 1 unexpectedly overlaps released protocol 5");
    assert(currentAgainstReleased.guarded.versionedDecoderInvocations === 0, "current preface gate attempted protocol 5 decode");

    const sourceDb = join(ROOT, "schema20-sentinel.db");
    const dbPath = join(work, "schema20-sentinel.db");
    copyFileSync(sourceDb, dbPath);
    const beforeBytes = readFileSync(dbPath);
    const beforeSidecars = readdirSync(work).filter((name) =>
      name.startsWith(`${basename(dbPath)}-`),
    );
    const schemaProbe = runJson([
      process.execPath,
      executables["released-0.1.14"],
      "schema-probe",
      dbPath,
    ]);
    const afterBytes = readFileSync(dbPath);
    const afterSidecars = readdirSync(work).filter((name) =>
      name.startsWith(`${basename(dbPath)}-`),
    );
    const database = new DatabaseSync(dbPath, {
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
      beforeSidecars,
      afterSidecars,
      userVersion,
      sentinel,
      probe: schemaProbe,
    };
    assert(schema18Refusal.byteIdentical, "schema-18 source bundle changed schema-20 bytes");
    assert(beforeSidecars.length === 0 && afterSidecars.length === 0, "schema-18 source bundle created a SQLite sidecar");
    assert(userVersion === 20 && sentinel?.payload === "must-survive", "schema-20 sentinel changed");
    assert(schemaProbe.compatibility.ok === false, "schema-18 source bundle admitted schema 20");
    assert(schemaProbe.compatibility.reason === "newer-than-supported", "schema refusal reason drifted");
    assert(schemaProbe.compatibility.supportedVersion === 18, "schema refusal support drifted");

    return {
      integrity: { verifiedFiles: verifiedFiles.length },
      matrices: { released, legacyV2, current, currentAgainstReleased },
      releasedPackageInstrument: {
        ...releasedPackageInstrument,
        records: packagedOutcomes,
      },
      schema18Refusal,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
};

try {
  process.stdout.write(`${JSON.stringify(qualify())}\n`);
} catch (error) {
  process.stderr.write(
    `planning package qualification failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
