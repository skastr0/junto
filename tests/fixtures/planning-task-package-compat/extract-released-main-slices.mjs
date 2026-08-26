#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { extractFile, listPackage, statFile } from "@electron/asar";

const ZIP_URL = "https://vellumreleasedistribution-rele2p3h3apcupwjim2zajqqmhyd.skastr052.workers.dev/mac/arm64/Vellum-Command-0.1.14-arm64-mac.zip";
const ZIP_BYTES = 176_039_073;
const ZIP_SHA256 = "e47a0edb0eb1642b517a7916855dae1f911d4c6006bfe9e31c356b3621a6670e";
const ASAR_ENTRY = "Vellum Command.app/Contents/Resources/app.asar";
const ASAR_BYTES = 147_590_400;
const ASAR_SHA256 = "11ccaee77152f1e9024c1ac24048370173a058f840c0bd9b6cd25332e5953bbf";
const MAIN_ENTRY = "out/main/index.js";
const MAIN_BYTES = 3_099_351;
const MAIN_SHA256 = "9564bbabfc5ce075951e70d1a80520ba58454adb27384d6b67bd2594af01ee66";
const MAIN_ASAR_OFFSET = "132581232";

const RANGES = [
  {
    id: "task-authoring-schema",
    path: "released-main-task-authoring-schema.txt.fixture",
    start: 145_838,
    end: 149_032,
    sha256: "7bf15588530a77a5924207a315d512b500ee43a630db6caa64849b38934e7c03",
    markers: [
      "const TaskAuthoringFields = {",
      "dependsOn: Schema.optionalKey(Schema.Array(Schema.String))",
      "const Task = Schema.Struct({",
      "const TaskProposal = Schema.Struct({",
      "approvedTaskId: Schema.optionalKey(Schema.String)",
    ],
    forbiddenMarkers: ["admission:", "raisedBy:"],
  },
  {
    id: "work-protocol",
    path: "released-main-work-protocol.txt.fixture",
    start: 165_565,
    end: 165_605,
    sha256: "e31056c1d765d7d9221b8af0fe9c23964eb0cf7e2fdb96ddafaf87f6b281267f",
    markers: ['const WORK_PROTOCOL = "vellum/work/v2";'],
  },
  {
    id: "station-preface-api",
    path: "released-main-station-preface-api.txt.fixture",
    start: 186_438,
    end: 191_096,
    sha256: "31dd711582834b089de92dbf2abcdd0c11e541b7bfdd6962cff3d68c4b9a6f7e",
    markers: [
      "const STATION_PROTOCOL_BASELINE = 5;",
      "preferred: STATION_PROTOCOL_BASELINE",
      "compatibleFrom: STATION_PROTOCOL_BASELINE",
      "warnBelow: STATION_PROTOCOL_BASELINE",
      'const STATION_PROTOCOL_PREFACE = "vellum-command/station-protocol-preface/v1";',
      'reason: Schema.Literal("no-common-version")',
      "retryable: Schema.Literal(false)",
      "const STATION_API_PROTOCOL = `vellum-command/station-api/v${STATION_PROTOCOL_BASELINE}`;",
    ],
  },
  {
    id: "station-control",
    path: "released-main-station-control.txt.fixture",
    start: 344_202,
    end: 344_299,
    sha256: "df3239f041a9c56ebec7ade5bd86287f5f57848fe9dd75c462a2f00b3075ceb1",
    markers: [
      "const STATION_CONTROL_PROTOCOL = `vellum-command/station-control/v${STATION_PROTOCOL_BASELINE}`;",
    ],
  },
  {
    id: "station-session",
    path: "released-main-station-session.txt.fixture",
    start: 346_441,
    end: 346_538,
    sha256: "01380a1eca7a4dab945348a7e0b41628121a6591954dd3cf8775a0811e1ed82d",
    markers: [
      "const STATION_SESSION_PROTOCOL = `vellum-command/station-session/v${STATION_PROTOCOL_BASELINE}`;",
    ],
  },
  {
    id: "state-schema-version",
    path: "released-main-state-schema-version.txt.fixture",
    start: 464_139,
    end: 464_308,
    sha256: "1bb1c941e0bf1cd40ffa1df5c9b43dbf0e90779fd3f9eb85a75eb54325812ef3",
    markers: [
      "const STATE_SCHEMA_V17_IDENTITY = {",
      "const CURRENT_STATE_SCHEMA_VERSION = 18;",
    ],
  },
];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const scriptPath = fileURLToPath(import.meta.url);
const scriptBytes = readFileSync(scriptPath);
const fail = (message) => {
  throw new Error(message);
};
const checkBytes = (label, bytes, expectedBytes, expectedSha256) => {
  const actualSha256 = sha256(bytes);
  if (bytes.byteLength !== expectedBytes || actualSha256 !== expectedSha256) {
    fail(
      `${label} mismatch: expected ${expectedSha256}/${expectedBytes}, got ${actualSha256}/${bytes.byteLength}`,
    );
  }
};
const valueAfter = (flag) => {
  const index = process.argv.indexOf(flag);
  if (index === -1 || process.argv[index + 1] === undefined) {
    fail(`missing ${flag}`);
  }
  return process.argv[index + 1];
};

const zipPath = resolve(valueAfter("--zip"));
const outputRoot = resolve(valueAfter("--output-root"));
const zip = readFileSync(zipPath);
checkBytes("public 0.1.14 ZIP", zip, ZIP_BYTES, ZIP_SHA256);
mkdirSync(outputRoot, { recursive: true });

const work = mkdtempSync(join(tmpdir(), "vellum-command-released-slice-"));
try {
  const extracted = spawnSync("/usr/bin/unzip", ["-p", zipPath, ASAR_ENTRY], {
    encoding: null,
    maxBuffer: ASAR_BYTES + 1024,
    timeout: 30_000,
  });
  if (extracted.error !== undefined || extracted.status !== 0) {
    fail(
      `stock unzip failed: ${extracted.error?.message ?? String(extracted.stderr)}`,
    );
  }
  const asarBytes = extracted.stdout;
  checkBytes("app.asar", asarBytes, ASAR_BYTES, ASAR_SHA256);
  const asarPath = join(work, "app.asar");
  writeFileSync(asarPath, asarBytes);

  const packagedPaths = listPackage(asarPath);
  const sourceMapPresent = packagedPaths.includes(`/${MAIN_ENTRY}.map`);
  if (sourceMapPresent) fail("unexpected packaged out/main/index.js.map");
  const stat = statFile(asarPath, MAIN_ENTRY);
  if (
    stat.size !== MAIN_BYTES ||
    stat.offset !== MAIN_ASAR_OFFSET ||
    stat.integrity?.algorithm !== "SHA256" ||
    stat.integrity.hash !== MAIN_SHA256
  ) {
    fail("app.asar main entry metadata mismatch");
  }
  const main = extractFile(asarPath, MAIN_ENTRY);
  checkBytes("out/main/index.js", main, MAIN_BYTES, MAIN_SHA256);

  const rangeReceipts = RANGES.map((range) => {
    const bytes = main.subarray(range.start, range.end);
    checkBytes(range.id, bytes, range.end - range.start, range.sha256);
    const text = bytes.toString("utf8");
    for (const marker of range.markers) {
      const occurrences = text.split(marker).length - 1;
      if (occurrences !== 1) {
        fail(`${range.id} marker count is ${occurrences}: ${marker}`);
      }
    }
    for (const marker of range.forbiddenMarkers ?? []) {
      if (text.includes(marker)) {
        fail(`${range.id} contains forbidden marker: ${marker}`);
      }
    }
    writeFileSync(join(outputRoot, range.path), bytes);
    return {
      id: range.id,
      path: `released-main-static/${range.path}`,
      start: range.start,
      end: range.end,
      bytes: bytes.byteLength,
      sha256: range.sha256,
      transform: "exact Buffer.subarray, no rewriting",
      markers: range.markers.map((marker) => ({ marker, occurrences: 1 })),
      forbiddenMarkers: (range.forbiddenMarkers ?? []).map((marker) => ({
        marker,
        occurrences: 0,
      })),
    };
  });

  const receipt = {
    contract: "vellum-command/released-main-static-slice/v1",
    sourcePackage: {
      productName: "Vellum Command",
      appVersion: "0.1.14",
      zipUrl: ZIP_URL,
      zipFile: basename(zipPath),
      zipBytes: ZIP_BYTES,
      zipSha256: ZIP_SHA256,
      appAsarEntry: ASAR_ENTRY,
      appAsarBytes: ASAR_BYTES,
      appAsarSha256: ASAR_SHA256,
      mainEntry: MAIN_ENTRY,
      mainBytes: MAIN_BYTES,
      mainSha256: MAIN_SHA256,
      mainAsarOffset: MAIN_ASAR_OFFSET,
      mainAsarIntegrityAlgorithm: "SHA256",
      mainSourceMapPresent: false,
    },
    extraction: {
      script: {
        path: "extract-released-main-slices.mjs",
        bytes: scriptBytes.byteLength,
        sha256: sha256(scriptBytes),
      },
      dependency: "stock @electron/asar 3.4.1 from the pinned project lockfile",
      commands: [
        `curl --fail --location --output <zip> ${ZIP_URL}`,
        "node tests/fixtures/planning-task-package-compat/extract-released-main-slices.mjs --zip <zip> --output-root <empty-output-root>",
        "diff -r <empty-output-root> tests/fixtures/planning-task-package-compat/released-main-static",
      ],
      asarExtraction: `/usr/bin/unzip -p <zip> ${JSON.stringify(ASAR_ENTRY)}`,
      ranges: rangeReceipts,
    },
    proofBoundary: {
      mode: "static-hash-and-marker-only",
      archivedBytesExecuted: false,
      instrumentedBundlePresent: false,
      proves: [
        "the pinned signed artifact contains the checked exact source bytes",
        "the static bytes name Station baseline 5, schema 18, Work v2, and the v2 Task authoring shape",
      ],
      doesNotProve: [
        "production package call ordering",
        "preface rejection before Work decode",
        "a released older Remote pairing",
      ],
    },
  };
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  writeFileSync(join(outputRoot, "released-main-slice-receipt.json"), receiptBytes);
  process.stdout.write(
    `${JSON.stringify({
      zipSha256: ZIP_SHA256,
      appAsarSha256: ASAR_SHA256,
      mainSha256: MAIN_SHA256,
      ranges: rangeReceipts.map(({ id, bytes, sha256: hash }) => ({
        id,
        bytes,
        sha256: hash,
      })),
      receiptSha256: sha256(receiptBytes),
    })}\n`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
