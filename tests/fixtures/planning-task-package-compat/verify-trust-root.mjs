#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

const IS_FILE_MODULE = import.meta.url.startsWith("file:");
const SCRIPT_ROOT = IS_FILE_MODULE
  ? dirname(fileURLToPath(import.meta.url))
  : process.cwd();
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_FIXTURE_BYTES = 2 * 1024 * 1024;
const MAX_COMPRESSED_BUNDLE_BYTES = 1024 * 1024;
const MAX_EXECUTABLE_BUNDLE_BYTES = 2 * 1024 * 1024;
const EXPECTED_COHORT_NAMES = [
  "current-v3",
  "released-0.1.14",
  "unreleased-protocol1-v2",
];
const EXPECTED_RECEIPT_NAMES = [
  "externalBuild",
  "publicPackage",
  "releasedMainSlice",
];
// Filled only after package-pair.json is generated without this verifier in its
// file inventory. The TypeScript test separately pins this verifier's bytes.
const TRUSTED_MANIFEST_SHA256 =
  "564fdab63b7e4c64caf400f3dd4a408bdf1c71856812ae6e82e9c19c892835ae";

// These leaves are independent of package-pair.json. Changing the manifest and
// its caller-provided digest cannot bless new ambient orchestration or rewrite
// the receipts that authenticate source builds and released static bytes.
// Any legitimate leaf update requires a visible edit to this review-pinned
// verifier and therefore a new verifier digest in the TypeScript test.
const TRUSTED_LEAVES = {
  "external-build-receipt.json": {
    bytes: 11_027,
    sha256: "9953bc7e0b45f1cfd7f785f720eee4a2155e806a2aa62de7ff5e0c5492ee55f9",
  },
  "public-package-receipt.json": {
    bytes: 15_817,
    sha256: "55540bccd9538329cea3df55846cdcaa2585a7a1374ff0129528d4cb7249e7c5",
  },
  "released-main-static/released-main-slice-receipt.json": {
    bytes: 7_282,
    sha256: "c417ff2d4285f60539a85b7cbb2f6598f0b3d3336b9fbda00bd05085c28fcc1b",
  },
  "qualify.mjs": {
    bytes: 19_756,
    sha256: "4cfbb9ba2689ef6442bfd7f8216f0fbfa1ec983f3a033898246d2b27c185a7fa",
  },
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const gitBlobOid = (bytes) =>
  createHash("sha1")
    .update(Buffer.from(`blob ${bytes.byteLength}\0`))
    .update(bytes)
    .digest("hex");
const fail = (message) => {
  throw new Error(`trust root rejected: ${message}`);
};
const requireObject = (value, label) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
};
const requireArray = (value, label) => {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
};
const requireString = (value, label) => {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
};
const requireInteger = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be a non-negative safe integer`);
  }
  return value;
};
const same = (label, left, right) => {
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    fail(`${label} conflicts with its independent receipt`);
  }
};
const count = (text, marker) => text.split(marker).length - 1;
const containsPath = (root, candidate) => {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
};
const safeRelativePath = (value, label) => {
  const path = requireString(value, label);
  if (
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    fail(`${label} is not a safe relative path: ${path}`);
  }
  return path;
};
const readRegular = (root, relativePath, maxBytes = MAX_FIXTURE_BYTES) => {
  const path = safeRelativePath(relativePath, "fixture path");
  const absolute = resolve(root, path);
  if (!containsPath(root, absolute)) fail(`fixture path escapes root: ${path}`);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`fixture path is not a regular non-symlink file: ${path}`);
  }
  const canonical = realpathSync(absolute);
  if (!containsPath(root, canonical)) fail(`fixture path resolves outside root: ${path}`);
  if (stat.size > maxBytes) fail(`fixture path exceeds ${maxBytes} bytes: ${path}`);
  const bytes = readFileSync(canonical);
  if (bytes.byteLength !== stat.size) fail(`fixture path changed while reading: ${path}`);
  return bytes;
};
const parseJson = (bytes, label) => {
  try {
    return requireObject(JSON.parse(bytes.toString("utf8")), label);
  } catch (error) {
    fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
};
const fileEntryFor = (files, path) => {
  const entry = files.get(path);
  if (entry === undefined) fail(`manifest does not inventory ${path}`);
  return entry;
};
const receiptPin = (manifest, name, path) => {
  const pin = requireObject(
    requireObject(manifest.receipts, "manifest.receipts")[name],
    `manifest.receipts.${name}`,
  );
  if (pin.path !== path) fail(`manifest receipt path drift for ${name}`);
  return pin;
};

export const verifyTrustRoot = ({
  root = SCRIPT_ROOT,
  expectedManifestSha256,
  projectRoot = resolve(root, "../../.."),
} = {}) => {
  if (!SHA256.test(expectedManifestSha256 ?? "")) {
    fail("--expected-manifest-sha256 must be an exact lowercase SHA-256");
  }
  if (expectedManifestSha256 !== TRUSTED_MANIFEST_SHA256) {
    fail(
      `caller manifest root is not the verifier-owned root: expected ${TRUSTED_MANIFEST_SHA256}`,
    );
  }
  const canonicalRoot = realpathSync(resolve(root));
  const canonicalProjectRoot = realpathSync(resolve(projectRoot));

  // This comparison is the independent barrier. The bytes are not parsed until
  // they match the root owned by this separately review-pinned verifier.
  const manifestBytes = readRegular(
    canonicalRoot,
    "package-pair.json",
    MAX_MANIFEST_BYTES,
  );
  const actualManifestSha256 = sha256(manifestBytes);
  if (actualManifestSha256 !== TRUSTED_MANIFEST_SHA256) {
    fail(
      `manifest SHA-256 mismatch: expected ${TRUSTED_MANIFEST_SHA256}, got ${actualManifestSha256}`,
    );
  }
  const manifest = parseJson(manifestBytes, "package-pair.json");
  if (manifest.contract !== "vellum-command/planning-task-package-provenance/v3") {
    fail(`unsupported manifest contract: ${String(manifest.contract)}`);
  }

  const listed = requireArray(manifest.files, "manifest.files");
  const files = new Map();
  const buffers = new Map();
  for (const raw of listed) {
    const entry = requireObject(raw, "manifest.files entry");
    const path = safeRelativePath(entry.path, "manifest.files path");
    if (path === "package-pair.json") fail("manifest must not self-pin its own bytes");
    if (files.has(path)) fail(`duplicate manifest file path: ${path}`);
    const expectedBytes = requireInteger(entry.bytes, `${path} bytes`);
    const expectedSha256 = requireString(entry.sha256, `${path} SHA-256`);
    if (!SHA256.test(expectedSha256)) fail(`invalid SHA-256 for ${path}`);
    const bytes = readRegular(canonicalRoot, path);
    const actual = sha256(bytes);
    if (bytes.byteLength !== expectedBytes || actual !== expectedSha256) {
      fail(
        `fixture hash mismatch for ${path}: expected ${expectedSha256}/${expectedBytes}, got ${actual}/${bytes.byteLength}`,
      );
    }
    files.set(path, { path, bytes: expectedBytes, sha256: expectedSha256 });
    buffers.set(path, bytes);
  }
  for (const [path, expected] of Object.entries(TRUSTED_LEAVES)) {
    const actual = fileEntryFor(files, path);
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
      fail(`independent trusted leaf mismatch: ${path}`);
    }
  }

  const executableInventory = readdirSync(join(canonicalRoot, "bundles"))
    .filter((name) => name.endsWith(".gz"))
    .map((name) => `bundles/${name}`)
    .sort();
  const referencedBundles = Object.values(
    requireObject(manifest.cohorts, "manifest.cohorts"),
  )
    .map((raw) => safeRelativePath(requireObject(raw, "cohort").bundle.path, "bundle path"))
    .sort();
  same("executable bundle inventory", executableInventory, referencedBundles);

  for (const pinRaw of requireArray(
    requireObject(manifest.protocolPins, "manifest.protocolPins").unchangedFiles,
    "protocolPins.unchangedFiles",
  )) {
    const pin = requireObject(pinRaw, "protocol pin");
    const path = safeRelativePath(pin.path, "protocol pin path");
    const bytes = readRegular(canonicalProjectRoot, path, MAX_FIXTURE_BYTES);
    if (
      bytes.byteLength !== pin.bytes ||
      sha256(bytes) !== pin.sha256 ||
      gitBlobOid(bytes) !== pin.gitBlobOidSha1
    ) {
      fail(`protocol-pinned worktree file drift: ${path}`);
    }
  }

  const externalPath = "external-build-receipt.json";
  const publicPath = "public-package-receipt.json";
  const slicePath = "released-main-static/released-main-slice-receipt.json";
  const external = parseJson(buffers.get(externalPath), externalPath);
  const publicReceipt = parseJson(buffers.get(publicPath), publicPath);
  const slice = parseJson(buffers.get(slicePath), slicePath);
  if (external.contract !== "vellum-command/planning-task-package-build-receipt/v2") {
    fail("external build receipt contract drift");
  }
  if (publicReceipt.contract !== "vellum-command/public-macos-0.1.14-package-receipt/v2") {
    fail("public package receipt contract drift");
  }
  if (slice.contract !== "vellum-command/released-main-static-slice/v1") {
    fail("released main slice receipt contract drift");
  }
  for (const [name, path, contract] of [
    ["externalBuild", externalPath, external.contract],
    ["publicPackage", publicPath, publicReceipt.contract],
    ["releasedMainSlice", slicePath, slice.contract],
  ]) {
    const pin = receiptPin(manifest, name, path);
    const file = fileEntryFor(files, path);
    if (
      pin.contract !== contract ||
      pin.bytes !== file.bytes ||
      pin.sha256 !== file.sha256
    ) {
      fail(`manifest receipt identity does not match file inventory: ${name}`);
    }
  }

  const manifestCohorts = requireObject(manifest.cohorts, "manifest.cohorts");
  const externalCohorts = requireObject(external.cohorts, "external.cohorts");
  same("manifest cohort key set", Object.keys(manifestCohorts).sort(), EXPECTED_COHORT_NAMES);
  same("external cohort key set", Object.keys(externalCohorts).sort(), EXPECTED_COHORT_NAMES);
  same(
    "manifest receipt key set",
    Object.keys(requireObject(manifest.receipts, "manifest.receipts")).sort(),
    EXPECTED_RECEIPT_NAMES,
  );
  for (const [name, raw] of Object.entries(manifestCohorts)) {
    const cohort = requireObject(raw, `manifest cohort ${name}`);
    const receipt = requireObject(externalCohorts[name], `external cohort ${name}`);
    const expectedReleaseStatus = {
      "released-0.1.14": "public-0.1.14-decoder-source-cohort",
      "unreleased-protocol1-v2": "unreleased-source-cohort",
      "current-v3": "unreleased-candidate-source-cohort",
    }[name];
    const expectedRemoteArtifactStatus = {
      "released-0.1.14": "no-released-remote-artifact",
      "unreleased-protocol1-v2": "remote-stations-not-released",
      "current-v3": "remote-stations-not-released",
    }[name];
    if (
      cohort.cohort.releaseStatus !== expectedReleaseStatus ||
      cohort.cohort.remoteArtifactStatus !== expectedRemoteArtifactStatus
    ) {
      fail(`${name} source/release status widened`);
    }
    for (const field of [
      "commit",
      "treeOidSha1",
      "commitObjectSha256",
      "parents",
      "authorDate",
      "committerDate",
      "subject",
      "tagsPointingAt",
      "tagsContaining",
      "archive",
    ]) {
      same(`${name}.${field}`, cohort[field], receipt[field]);
    }
    const bundle = requireObject(cohort.bundle, `${name}.bundle`);
    const built = requireObject(receipt.decoderBundleBuild, `${name} build receipt`);
    for (const field of [
      "path",
      "compression",
      "compressedBytes",
      "compressedSha256",
      "executableBytes",
      "executableSha256",
      "artifactKind",
      "isReleasedPackage",
      "deterministicRebuildVerified",
      "repeatBuildExecutableSha256",
    ]) {
      same(`${name}.bundle.${field}`, bundle[field], built[field]);
    }
    if (
      bundle.compression !== "gzip" ||
      bundle.artifactKind !== "archive-built-source-decoder-bundle" ||
      bundle.isReleasedPackage !== false ||
      bundle.deterministicRebuildVerified !== true ||
      bundle.repeatBuildExecutableSha256 !== bundle.executableSha256
    ) {
      fail(`${name} is not an exact repeated archive-source build`);
    }
    if (
      bundle.compressedBytes > MAX_COMPRESSED_BUNDLE_BYTES ||
      bundle.executableBytes > MAX_EXECUTABLE_BUNDLE_BYTES
    ) {
      fail(`${name} bundle exceeds the fixed decompression ceiling`);
    }
    const file = fileEntryFor(files, safeRelativePath(bundle.path, `${name} bundle path`));
    if (file.bytes !== bundle.compressedBytes || file.sha256 !== bundle.compressedSha256) {
      fail(`${name} bundle conflicts with file inventory`);
    }
  }
  const driver = requireObject(external.driver, "external.driver");
  const driverFile = fileEntryFor(files, driver.path);
  if (driver.bytes !== driverFile.bytes || driver.sha256 !== driverFile.sha256) {
    fail("archive driver conflicts with file inventory");
  }
  const rebuild = requireObject(external.rebuildScript, "external.rebuildScript");
  const rebuildFile = fileEntryFor(files, rebuild.path);
  if (rebuild.bytes !== rebuildFile.bytes || rebuild.sha256 !== rebuildFile.sha256) {
    fail("source rebuild script conflicts with file inventory");
  }

  const packageIdentity = requireObject(
    requireObject(manifest.publicPackage, "manifest.publicPackage").packageIdentity,
    "manifest.publicPackage.packageIdentity",
  );
  same("public ZIP identity", packageIdentity.zip, {
    bytes: publicReceipt.zip.bytes,
    sha256: publicReceipt.zip.sha256,
    sha512Base64: publicReceipt.zip.sha512Base64,
  });
  same("public app identity", packageIdentity.extractedApp, {
    productName: publicReceipt.extractedApp.productName,
    bundleShortVersion: publicReceipt.extractedApp.bundleShortVersion,
    appAsarSha256: publicReceipt.extractedApp.appAsarSha256,
    mainBundleBytes: publicReceipt.extractedApp.mainBundleBytes,
    mainBundleSha256: publicReceipt.extractedApp.mainBundleSha256,
    cliBytes: publicReceipt.extractedApp.cliBytes,
    cliSha256: publicReceipt.extractedApp.cliSha256,
  });
  same("public cohort identity", packageIdentity.cohort, publicReceipt.cohort);
  if (
    publicReceipt.extractedApp.productName !== "Vellum Command" ||
    publicReceipt.extractedApp.bundleShortVersion !== "0.1.14" ||
    !publicReceipt.limitation.includes("No older Remote package has been released") ||
    !publicReceipt.limitation.includes("do not prove production ingress ordering")
  ) {
    fail("public package identity drift");
  }
  const releaseLine = requireObject(
    requireObject(manifest.cohorts, "manifest.cohorts")["released-0.1.14"],
    "release-line source cohort",
  );
  if (
    publicReceipt.buildTreeProvenance.versionBumpCommit !== releaseLine.commit ||
    publicReceipt.buildTreeProvenance.versionBumpTree !== releaseLine.treeOidSha1 ||
    publicReceipt.buildTreeProvenance.embeddedCommit !== null ||
    publicReceipt.buildTreeProvenance.exactBuildTreeProven !== false ||
    publicReceipt.buildTreeProvenance.dirtyBuildExcluded !== false ||
    publicReceipt.buildTreeProvenance.packageIncludesAtLeastCommit !==
      "2dc82e9e8d9a20e99dba5d3c147b590c74332a24"
  ) {
    fail("public package build-tree limitations widened");
  }
  for (const field of [
    "appVersion",
    "stateSchemaVersion",
    "tasksCreateSchemaId",
    "taskCreateSemantics",
    "stationProtocolBaseline",
    "stationProtocolSupport",
    "stationPreface",
    "stationSession",
    "stationApi",
    "stationControl",
    "workProtocol",
  ]) {
    same(
      `public release-line cohort ${field}`,
      publicReceipt.cohort[field],
      releaseLine.cohort[field],
    );
  }
  const currentLine = requireObject(
    manifestCohorts["current-v3"],
    "current source cohort",
  );
  const packageCommands = requireObject(
    publicReceipt.observedPackageCommands,
    "observed package commands",
  );
  if (
    packageCommands.cliVersion.stdout !== "vellum-command v0.1.0\n" ||
    !packageCommands.cliVersion.note.includes("not app provenance") ||
    packageCommands.tasksCreateSchema.exitCode !== 0 ||
    packageCommands.tasksCreateSchema.data.schema_id !==
      releaseLine.cohort.tasksCreateSchemaId ||
    packageCommands.tasksCreateSchema.data.schema.additionalProperties !== false
  ) {
    fail("observed package command scope or v2 schema identity drifted");
  }
  const exchange = requireObject(
    publicReceipt.observedProtocol1Exchange,
    "observed protocol-1 exchange",
  );
  if (
    exchange.authority !==
      "hash-pinned unsigned observation, not executable proof" ||
    exchange.ingressOrderingProven !== false ||
    !exchange.limitation.includes("do not prove production call ordering") ||
    exchange.offer.protocol !== currentLine.cohort.stationPreface ||
    exchange.offer.stateSchemaVersion !== currentLine.cohort.stateSchemaVersion ||
    exchange.response.protocol !== releaseLine.cohort.stationPreface ||
    exchange.response.stateSchemaVersion !== releaseLine.cohort.stateSchemaVersion ||
    exchange.response.frame !== "reject" ||
    exchange.response.reason !== "no-common-version" ||
    exchange.response.retryable !== false
  ) {
    fail("unsigned package protocol observation widened or conflicts with cohorts");
  }
  same(
    "observed protocol offer support",
    exchange.offer.support,
    currentLine.cohort.stationProtocolSupport,
  );
  same(
    "observed protocol response support",
    exchange.response.support,
    releaseLine.cohort.stationProtocolSupport,
  );
  const observedSchema = requireObject(
    publicReceipt.observedPackageSchema20Refusal,
    "observed package schema refusal",
  );
  if (
    observedSchema.authority !==
      "hash-pinned unsigned observation, not a rerun by the focused qualifier" ||
    observedSchema.exitCode !== 1 ||
    observedSchema.diagnostic !==
      "schema user_version=20 supported=18 appVersion=0.1.14" ||
    observedSchema.byteIdentical !== true ||
    observedSchema.userVersionAfter !== currentLine.cohort.stateSchemaVersion ||
    observedSchema.sentinelAfter !== "unchanged" ||
    observedSchema.runtimeProofInFocusedQualifier !== false
  ) {
    fail("unsigned package schema observation widened or conflicts with cohorts");
  }
  same("observed package schema before/after", observedSchema.before, observedSchema.after);

  const feedPin = requireObject(
    requireObject(manifest.publicPackage, "manifest.publicPackage").feed,
    "manifest public feed",
  );
  const feedFile = fileEntryFor(files, feedPin.path);
  const feedUrl = new URL(publicReceipt.releaseAuthority.feedUrl);
  const zipUrl = new URL(publicReceipt.zip.url);
  if (
    feedPin.path !== publicReceipt.releaseAuthority.feedFixture ||
    feedFile.bytes !== feedPin.bytes ||
    feedFile.bytes !== publicReceipt.releaseAuthority.feedBytes ||
    feedFile.sha256 !== feedPin.sha256 ||
    feedPin.sha256 !== publicReceipt.releaseAuthority.feedSha256 ||
    basename(feedUrl.pathname) !== "latest-mac.yml" ||
    feedUrl.origin !== zipUrl.origin ||
    basename(zipUrl.pathname) !== "Vellum-Command-0.1.14-arm64-mac.zip"
  ) {
    fail("public feed or ZIP URL identity conflict");
  }
  const feed = buffers.get(feedPin.path).toString("utf8");
  for (const line of [
    "version: 0.1.14",
    "path: Vellum-Command-0.1.14-arm64-mac.zip",
    `sha512: ${publicReceipt.zip.sha512Base64}`,
    `size: ${publicReceipt.zip.bytes}`,
  ]) {
    if (!feed.includes(line)) fail(`public feed is missing ${line}`);
  }
  if (
    Buffer.from(publicReceipt.zip.sha512Base64, "base64").toString("hex") !==
    publicReceipt.zip.sha512Hex
  ) {
    fail("public ZIP SHA-512 encodings conflict");
  }

  const staticManifest = requireObject(
    requireObject(manifest.publicPackage, "manifest.publicPackage").staticEvidence,
    "manifest static evidence",
  );
  const staticExternal = requireObject(
    external.releasedPackageStaticExtraction,
    "external static extraction",
  );
  const staticPublic = requireObject(
    publicReceipt.staticCompiledEvidence,
    "public static compiled evidence",
  );
  const source = requireObject(slice.sourcePackage, "slice sourcePackage");
  for (const [label, value, expected] of [
    ["slice ZIP", source.zipSha256, publicReceipt.zip.sha256],
    ["slice app.asar", source.appAsarSha256, publicReceipt.extractedApp.appAsarSha256],
    ["slice main", source.mainSha256, publicReceipt.extractedApp.mainBundleSha256],
    ["external ZIP", staticExternal.sourceZipSha256, publicReceipt.zip.sha256],
    ["external app.asar", staticExternal.sourceAppAsarSha256, publicReceipt.extractedApp.appAsarSha256],
    ["external main", staticExternal.sourceMainBundleSha256, publicReceipt.extractedApp.mainBundleSha256],
  ]) {
    if (value !== expected) fail(`${label} package identity conflict`);
  }
  if (
    source.zipUrl !== publicReceipt.zip.url ||
    source.zipFile !== basename(zipUrl.pathname) ||
    source.zipBytes !== publicReceipt.zip.bytes ||
    source.appAsarEntry !== "Vellum Command.app/Contents/Resources/app.asar" ||
    source.appAsarBytes !== 147_590_400 ||
    source.mainEntry !== "out/main/index.js" ||
    source.mainBytes !== publicReceipt.extractedApp.mainBundleBytes ||
    source.mainAsarOffset !== "132581232" ||
    source.mainAsarIntegrityAlgorithm !== "SHA256" ||
    source.productName !== "Vellum Command" ||
    source.appVersion !== "0.1.14" ||
    source.mainSourceMapPresent !== false
  ) {
    fail("slice source metadata conflicts with the public package");
  }
  const extraction = requireObject(slice.extraction, "slice extraction");
  const extractionScript = requireObject(extraction.script, "slice extraction script");
  const extractionFile = fileEntryFor(files, extractionScript.path);
  if (
    extractionScript.bytes !== extractionFile.bytes ||
    extractionScript.sha256 !== extractionFile.sha256
  ) {
    fail("slice extraction script conflicts with file inventory");
  }
  same("external extraction script", staticExternal.script, extractionScript);
  const sliceFile = fileEntryFor(files, slicePath);
  same("external slice receipt", staticExternal.receipt, {
    path: slicePath,
    bytes: sliceFile.bytes,
    sha256: sliceFile.sha256,
  });
  if (
    staticManifest.receipt !== slicePath ||
    staticPublic.extractionReceipt !== slicePath ||
    staticPublic.extractionReceiptSha256 !== sliceFile.sha256
  ) {
    fail("public slice receipt path or hash conflict");
  }

  const ranges = requireArray(extraction.ranges, "slice extraction ranges");
  const rangeProjection = [];
  for (const raw of ranges) {
    const range = requireObject(raw, "slice range");
    const path = safeRelativePath(range.path, "slice range path");
    const file = fileEntryFor(files, path);
    if (
      range.bytes !== range.end - range.start ||
      range.bytes !== file.bytes ||
      range.sha256 !== file.sha256 ||
      range.transform !== "exact Buffer.subarray, no rewriting"
    ) {
      fail(`slice range metadata conflict: ${range.id}`);
    }
    const text = buffers.get(path).toString("utf8");
    for (const markerRaw of requireArray(range.markers, `${range.id} markers`)) {
      const marker = requireObject(markerRaw, "slice marker");
      if (count(text, marker.marker) !== marker.occurrences || marker.occurrences !== 1) {
        fail(`slice marker mismatch in ${range.id}: ${marker.marker}`);
      }
    }
    for (const markerRaw of requireArray(
      range.forbiddenMarkers,
      `${range.id} forbidden markers`,
    )) {
      const marker = requireObject(markerRaw, "slice forbidden marker");
      if (count(text, marker.marker) !== 0 || marker.occurrences !== 0) {
        fail(`slice forbidden marker present in ${range.id}: ${marker.marker}`);
      }
    }
    rangeProjection.push({
      id: range.id,
      path,
      start: range.start,
      end: range.end,
      bytes: range.bytes,
      sha256: range.sha256,
    });
  }
  same("manifest static ranges", staticManifest.ranges, rangeProjection);
  same("public static ranges", staticPublic.ranges, rangeProjection);
  if (
    staticManifest.mode !== "static-hash-and-marker-only" ||
    staticExternal.mode !== "static-hash-and-marker-only" ||
    slice.proofBoundary.mode !== "static-hash-and-marker-only" ||
    staticExternal.archivedBytesExecuted !== false ||
    staticExternal.instrumentedExecutablePresent !== false ||
    staticPublic.archivedBytesExecuted !== false ||
    staticPublic.instrumentedExecutablePresent !== false ||
    slice.proofBoundary.archivedBytesExecuted !== false ||
    slice.proofBoundary.instrumentedBundlePresent !== false
  ) {
    fail("released package evidence widened beyond static proof");
  }

  return {
    root: canonicalRoot,
    projectRoot: canonicalProjectRoot,
    manifestSha256: actualManifestSha256,
    manifest,
    externalReceipt: external,
    publicReceipt,
    sliceReceipt: slice,
    files,
    buffers,
    verifiedFiles: files.size,
    ceilings: {
      compressedBundleBytes: MAX_COMPRESSED_BUNDLE_BYTES,
      executableBundleBytes: MAX_EXECUTABLE_BUNDLE_BYTES,
    },
  };
};

const valueAfter = (args, flag) => {
  const index = args.indexOf(flag);
  if (index === -1 || args[index + 1] === undefined) fail(`missing ${flag}`);
  return args[index + 1];
};

if (
  IS_FILE_MODULE &&
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    const args = process.argv.slice(2);
    const root = args.includes("--root") ? valueAfter(args, "--root") : SCRIPT_ROOT;
    const projectRoot = args.includes("--project-root")
      ? valueAfter(args, "--project-root")
      : resolve(root, "../../..");
    const expectedManifestSha256 = valueAfter(args, "--expected-manifest-sha256");
    const verified = verifyTrustRoot({ root, projectRoot, expectedManifestSha256 });
    process.stdout.write(
      `${JSON.stringify({
        manifestSha256: verified.manifestSha256,
        verifiedFiles: verified.verifiedFiles,
        cohorts: Object.keys(verified.manifest.cohorts).sort(),
        releasedPackageEvidence: "static-hash-and-marker-only",
      })}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `planning package trust verification failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
