import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getRawHeader } from "@electron/asar";
import {
  FuseState,
  FuseV1Options,
  FuseVersion,
  getCurrentFuseWire,
  type FuseConfig,
} from "@electron/fuses";
import rawPolicy from "./package-security-policy.json";

export const FUSE_NAMES = [
  "RunAsNode",
  "EnableCookieEncryption",
  "EnableNodeOptionsEnvironmentVariable",
  "EnableNodeCliInspectArguments",
  "EnableEmbeddedAsarIntegrityValidation",
  "OnlyLoadAppFromAsar",
  "LoadBrowserProcessSpecificV8Snapshot",
  "GrantFileProtocolExtraPrivileges",
  "WasmTrapHandlers",
] as const;

export type FuseName = (typeof FUSE_NAMES)[number];

export interface PackageSecurityPolicy {
  readonly bundleIdentifier: string;
  readonly productName: string;
  readonly teamIdentifier: string;
  readonly builderIdentity: string;
  readonly signingIdentity: string;
  readonly fuses: Readonly<Record<FuseName, boolean>>;
}

export interface CodesignMetadata {
  readonly identifier: string;
  readonly teamIdentifier: string;
  readonly runtimeVersion: string;
  readonly flags: ReadonlySet<string>;
  readonly authorities: ReadonlyArray<string>;
  readonly signature: string | undefined;
}

interface AsarIntegrityEntry {
  readonly algorithm: string;
  readonly hash: string;
}

interface PackageInfoPlist {
  readonly CFBundleIdentifier?: unknown;
  readonly CFBundleExecutable?: unknown;
  readonly ElectronAsarIntegrity?: unknown;
}

export interface PackageAuditReceipt {
  readonly appPath: string;
  readonly bundleIdentifier: string;
  readonly teamIdentifier: string;
  readonly runtimeVersion: string;
  readonly fuses: Readonly<Record<FuseName, "Enabled" | "Disabled">>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const libraryFuseNames = (): ReadonlyArray<string> =>
  Object.keys(FuseV1Options)
    .filter((name) => Number.isNaN(Number(name)))
    .sort(
      (left, right) =>
        FuseV1Options[left as keyof typeof FuseV1Options] -
        FuseV1Options[right as keyof typeof FuseV1Options],
    );

export const validatePackageSecurityPolicy = (
  value: unknown,
): PackageSecurityPolicy => {
  if (!isRecord(value) || !isRecord(value.fuses)) {
    throw new Error("package security policy must be an object with fuses");
  }
  for (const field of [
    "bundleIdentifier",
    "productName",
    "teamIdentifier",
    "builderIdentity",
    "signingIdentity",
  ] as const) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw new Error(`package security policy ${field} must be non-empty`);
    }
  }

  const expectedNames = libraryFuseNames();
  const policyNames = Object.keys(value.fuses).sort(
    (left, right) =>
      expectedNames.indexOf(left) - expectedNames.indexOf(right),
  );
  if (
    expectedNames.length !== FUSE_NAMES.length ||
    expectedNames.some((name, index) => name !== FUSE_NAMES[index])
  ) {
    throw new Error(
      `@electron/fuses and the Vellum policy disagree on the complete fuse set: library=${expectedNames.join(",")} expected=${FUSE_NAMES.join(",")}`,
    );
  }
  if (
    policyNames.length !== FUSE_NAMES.length ||
    policyNames.some((name, index) => name !== FUSE_NAMES[index])
  ) {
    throw new Error(
      `package security policy must configure every Electron fuse exactly once: policy=${policyNames.join(",")} expected=${FUSE_NAMES.join(",")}`,
    );
  }
  for (const name of FUSE_NAMES) {
    if (typeof value.fuses[name] !== "boolean") {
      throw new Error(`package security policy fuse ${name} must be boolean`);
    }
  }

  return value as unknown as PackageSecurityPolicy;
};

export const PACKAGE_SECURITY_POLICY = validatePackageSecurityPolicy(rawPolicy);

const requireSingleCodesignValue = (
  lines: ReadonlyArray<string>,
  prefix: string,
): string => {
  const values = lines
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length).trim());
  if (values.length !== 1 || values[0].length === 0) {
    throw new Error(
      `codesign metadata requires exactly one non-empty ${prefix.slice(0, -1)} field`,
    );
  }
  return values[0];
};

export const parseCodesignMetadata = (output: string): CodesignMetadata => {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const codeDirectoryLines = lines.filter((line) =>
    line.startsWith("CodeDirectory "),
  );
  if (codeDirectoryLines.length !== 1) {
    throw new Error("codesign metadata requires exactly one CodeDirectory field");
  }
  const flagMatch = codeDirectoryLines[0].match(
    /\bflags=0x[0-9a-f]+\(([^)]*)\)/iu,
  );
  if (flagMatch === null) {
    throw new Error("codesign metadata is missing named CodeDirectory flags");
  }
  const signatureValues = lines
    .filter((line) => line.startsWith("Signature="))
    .map((line) => line.slice("Signature=".length).trim());
  if (signatureValues.length > 1) {
    throw new Error("codesign metadata contains duplicate Signature fields");
  }

  return {
    identifier: requireSingleCodesignValue(lines, "Identifier="),
    teamIdentifier: requireSingleCodesignValue(lines, "TeamIdentifier="),
    runtimeVersion: requireSingleCodesignValue(lines, "Runtime Version="),
    flags: new Set(
      flagMatch[1]
        .split(",")
        .map((flag) => flag.trim().toLowerCase())
        .filter((flag) => flag.length > 0),
    ),
    authorities: lines
      .filter((line) => line.startsWith("Authority="))
      .map((line) => line.slice("Authority=".length).trim()),
    signature: signatureValues[0],
  };
};

export const validateCodesignMetadata = (
  metadata: CodesignMetadata,
  policy: PackageSecurityPolicy = PACKAGE_SECURITY_POLICY,
): void => {
  if (metadata.identifier !== policy.bundleIdentifier) {
    throw new Error(
      `signed bundle identifier mismatch: got ${metadata.identifier} want ${policy.bundleIdentifier}`,
    );
  }
  if (metadata.teamIdentifier !== policy.teamIdentifier) {
    throw new Error(
      `signed team identifier mismatch: got ${metadata.teamIdentifier} want ${policy.teamIdentifier}`,
    );
  }
  if (
    metadata.signature?.toLowerCase() === "adhoc" ||
    metadata.flags.has("adhoc")
  ) {
    throw new Error("packaged app has an ad-hoc signature");
  }
  if (!metadata.flags.has("runtime")) {
    throw new Error("packaged app is missing the hardened runtime flag");
  }
  if (!/^\d+(?:\.\d+)+$/u.test(metadata.runtimeVersion)) {
    throw new Error(
      `packaged app has invalid Runtime Version metadata: ${metadata.runtimeVersion}`,
    );
  }
  if (!metadata.authorities.includes(policy.signingIdentity)) {
    throw new Error(
      `packaged app is not signed by the required identity ${policy.signingIdentity}`,
    );
  }
};

export const validateFuseWire = (
  wire: FuseConfig<FuseState>,
  policy: PackageSecurityPolicy = PACKAGE_SECURITY_POLICY,
): Readonly<Record<FuseName, "Enabled" | "Disabled">> => {
  validatePackageSecurityPolicy(policy);
  if (wire.version !== FuseVersion.V1) {
    throw new Error(`unexpected Electron fuse version ${wire.version}`);
  }
  const actualIndexes = Object.keys(wire)
    .filter((key) => /^\d+$/u.test(key))
    .map(Number)
    .sort((left, right) => left - right);
  const expectedIndexes = FUSE_NAMES.map((name) => FuseV1Options[name]);
  if (
    actualIndexes.length !== expectedIndexes.length ||
    actualIndexes.some((value, index) => value !== expectedIndexes[index])
  ) {
    throw new Error(
      `Electron fuse wire is not the exact known set: wire=${actualIndexes.join(",")} expected=${expectedIndexes.join(",")}`,
    );
  }

  const receipt = {} as Record<FuseName, "Enabled" | "Disabled">;
  for (const name of FUSE_NAMES) {
    const expected = policy.fuses[name]
      ? FuseState.ENABLE
      : FuseState.DISABLE;
    const actual = wire[FuseV1Options[name]];
    if (actual !== expected) {
      throw new Error(
        `Electron fuse ${name} mismatch: got ${String(actual)} want ${String(expected)}`,
      );
    }
    receipt[name] = expected === FuseState.ENABLE ? "Enabled" : "Disabled";
  }
  return receipt;
};

export const validateInfoPlist = (
  value: unknown,
  actualAsarHash: string,
  policy: PackageSecurityPolicy = PACKAGE_SECURITY_POLICY,
): AsarIntegrityEntry => {
  if (!isRecord(value)) {
    throw new Error("Info.plist JSON must be an object");
  }
  const plist = value as PackageInfoPlist;
  if (plist.CFBundleIdentifier !== policy.bundleIdentifier) {
    throw new Error("Info.plist bundle identifier does not match policy");
  }
  if (plist.CFBundleExecutable !== policy.productName) {
    throw new Error("Info.plist executable does not match policy");
  }
  if (!isRecord(plist.ElectronAsarIntegrity)) {
    throw new Error("Info.plist is missing ElectronAsarIntegrity");
  }
  const entry = plist.ElectronAsarIntegrity["Resources/app.asar"];
  if (
    !isRecord(entry) ||
    entry.algorithm !== "SHA256" ||
    typeof entry.hash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(entry.hash)
  ) {
    throw new Error("Info.plist has invalid app.asar integrity metadata");
  }
  if (entry.hash !== actualAsarHash) {
    throw new Error("Info.plist app.asar integrity hash does not match app.asar");
  }
  return { algorithm: entry.algorithm, hash: entry.hash };
};

const runFixedCommand = (
  executable: string,
  args: ReadonlyArray<string>,
): string => {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
    shell: false,
  });
  if (result.error !== undefined) {
    throw new Error(`${path.basename(executable)} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`
      .trim()
      .slice(0, 2_000);
    throw new Error(
      `${path.basename(executable)} exited ${String(result.status)}${detail.length > 0 ? `: ${detail}` : ""}`,
    );
  }
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
};

export const hashAsarHeaderString = (headerString: string): string =>
  createHash("sha256").update(headerString).digest("hex");

const requireRegularFile = async (filePath: string): Promise<void> => {
  const metadata = await stat(filePath);
  if (!metadata.isFile() || metadata.size < 1) {
    throw new Error(`required packaged file is missing or empty: ${filePath}`);
  }
};

const requireExecutable = async (filePath: string): Promise<void> => {
  await requireRegularFile(filePath);
  await access(filePath, fsConstants.X_OK);
};

export const auditPackagedApp = async (
  requestedPath: string,
): Promise<PackageAuditReceipt> => {
  const policy = PACKAGE_SECURITY_POLICY;
  const appPath = path.resolve(requestedPath);
  if (path.basename(appPath) !== `${policy.productName}.app`) {
    throw new Error(
      `packaged app path must end in ${policy.productName}.app: ${appPath}`,
    );
  }
  const appMetadata = await stat(appPath);
  if (!appMetadata.isDirectory()) {
    throw new Error(`packaged app is not a directory: ${appPath}`);
  }

  const contentsPath = path.join(appPath, "Contents");
  const infoPlistPath = path.join(contentsPath, "Info.plist");
  const mainExecutablePath = path.join(
    contentsPath,
    "MacOS",
    policy.productName,
  );
  const appAsarPath = path.join(contentsPath, "Resources", "app.asar");
  const browserCliPath = path.join(
    contentsPath,
    "Resources",
    "bin",
    "vellum-browser",
  );
  await requireRegularFile(infoPlistPath);
  await requireExecutable(mainExecutablePath);
  await requireRegularFile(appAsarPath);
  await requireExecutable(browserCliPath);

  runFixedCommand("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    appPath,
  ]);
  const codesign = parseCodesignMetadata(
    runFixedCommand("/usr/bin/codesign", ["-d", "--verbose=4", appPath]),
  );
  validateCodesignMetadata(codesign, policy);

  const plistOutput = runFixedCommand("/usr/bin/plutil", [
    "-convert",
    "json",
    "-o",
    "-",
    infoPlistPath,
  ]);
  let plist: unknown;
  try {
    plist = JSON.parse(plistOutput);
  } catch {
    throw new Error("plutil returned invalid JSON for Info.plist");
  }
  validateInfoPlist(
    plist,
    hashAsarHeaderString(getRawHeader(appAsarPath).headerString),
    policy,
  );

  const fuses = validateFuseWire(await getCurrentFuseWire(appPath), policy);
  return {
    appPath,
    bundleIdentifier: codesign.identifier,
    teamIdentifier: codesign.teamIdentifier,
    runtimeVersion: codesign.runtimeVersion,
    fuses,
  };
};

const modulePath = fileURLToPath(import.meta.url);
const invokedPath =
  process.argv[1] === undefined ? "" : path.resolve(process.argv[1]);
if (invokedPath === modulePath) {
  const requestedPath = process.argv[2];
  if (requestedPath === undefined || process.argv.length !== 3) {
    console.error("usage: bun scripts/audit-packaged-app.ts /path/to/Vellum.app");
    process.exitCode = 2;
  } else {
    auditPackagedApp(requestedPath)
      .then((receipt) => {
        process.stdout.write(`${JSON.stringify({ ok: true, ...receipt })}\n`);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`vellum package security audit failed: ${message}`);
        process.exitCode = 1;
      });
  }
}
