import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
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
import { validateElectronObservation, validateElectronSecurityPolicy, decodeElectronObservation, decodeElectronSecurityPolicy } from "./electron-security-policy";
import rawRuntimePolicy from "./macos-runtime-policy.json";

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
  readonly minimumSystemVersion: string;
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

export type RuntimeEntitlementProfile = "none" | "jit";

export interface MachORuntimePolicyEntry {
  readonly path: string;
  readonly identifier: string;
  readonly profile: RuntimeEntitlementProfile;
}

export interface MacOSRuntimePolicy {
  readonly version: 1;
  readonly profiles: Readonly<
    Record<RuntimeEntitlementProfile, Readonly<Record<string, true>>>
  >;
  readonly machO: ReadonlyArray<MachORuntimePolicyEntry>;
}

interface AsarIntegrityEntry {
  readonly algorithm: string;
  readonly hash: string;
}

interface PackageInfoPlist {
  readonly CFBundleIdentifier?: unknown;
  readonly CFBundleExecutable?: unknown;
  readonly LSMinimumSystemVersion?: unknown;
  readonly ElectronAsarIntegrity?: unknown;
}

export interface PackageAuditReceipt {
  readonly appPath: string;
  readonly bundleIdentifier: string;
  readonly teamIdentifier: string;
  readonly runtimeVersion: string;
  readonly minimumSystemVersion: string;
  readonly fuses: Readonly<Record<FuseName, "Enabled" | "Disabled">>;
  readonly machO: {
    readonly count: number;
    readonly maxMinOS: string;
    readonly jitPaths: ReadonlyArray<string>;
    readonly emptyEntitlementsCount: number;
    readonly forbiddenEntitlementsCount: 0;
  };
}

export const EXPECTED_JIT_MACHO_PATHS = [
  "Contents/MacOS/Vellum Command",
  "Contents/Frameworks/Vellum Command Helper (Renderer).app/Contents/MacOS/Vellum Command Helper (Renderer)",
  "Contents/Frameworks/Vellum Command Helper (GPU).app/Contents/MacOS/Vellum Command Helper (GPU)",
  "Contents/Frameworks/Vellum Command Helper.app/Contents/MacOS/Vellum Command Helper",
] as const;

const MAC_O_MAGICS = new Set([
  "feedface",
  "cefaedfe",
  "feedfacf",
  "cffaedfe",
  "cafebabe",
  "bebafeca",
  "cafebabf",
  "bfbafeca",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const MACOS_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))?$/u;

const macOSVersionParts = (value: string): readonly [number, number, number] => {
  if (Buffer.byteLength(value) > 32 || !MACOS_VERSION_PATTERN.test(value)) {
    throw new Error(`invalid macOS version ${value}`);
  }
  const parts = value.split(".").map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) {
    throw new Error(`invalid macOS version ${value}`);
  }
  return [parts[0], parts[1], parts[2] ?? 0];
};

export const compareMacOSVersions = (left: string, right: string): number => {
  const leftParts = macOSVersionParts(left);
  const rightParts = macOSVersionParts(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    const comparison = leftParts[index] - rightParts[index];
    if (comparison !== 0) return comparison;
  }
  return 0;
};

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
    "minimumSystemVersion",
    "teamIdentifier",
    "builderIdentity",
    "signingIdentity",
  ] as const) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw new Error(`package security policy ${field} must be non-empty`);
    }
  }
  try {
    macOSVersionParts(value.minimumSystemVersion as string);
  } catch {
    throw new Error(
      "package security policy minimumSystemVersion must be a canonical macOS version",
    );
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

const exactRecordKeys = (
  value: Record<string, unknown>,
  expected: ReadonlyArray<string>,
): boolean => {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
};

const isCanonicalBundlePath = (value: string): boolean =>
  value.length > 0 &&
  Buffer.byteLength(value) <= 4_096 &&
  !/[\u0000-\u001f\u007f\\]/u.test(value) &&
  !path.posix.isAbsolute(value) &&
  value.startsWith("Contents/") &&
  path.posix.normalize(value) === value;

export const validateMacOSRuntimePolicy = (
  value: unknown,
): MacOSRuntimePolicy => {
  if (
    !isRecord(value) ||
    !exactRecordKeys(value, ["version", "profiles", "machO"]) ||
    value.version !== 1 ||
    !isRecord(value.profiles) ||
    !exactRecordKeys(value.profiles, ["none", "jit"]) ||
    !isRecord(value.profiles.none) ||
    !isRecord(value.profiles.jit) ||
    !Array.isArray(value.machO)
  ) {
    throw new Error("macOS runtime policy has an invalid top-level shape");
  }
  if (
    !exactRecordKeys(value.profiles.none, []) ||
    !exactRecordKeys(value.profiles.jit, ["com.apple.security.cs.allow-jit"]) ||
    value.profiles.jit["com.apple.security.cs.allow-jit"] !== true
  ) {
    throw new Error("macOS runtime policy must expose only empty and allow-jit profiles");
  }
  if (value.machO.length !== 24) {
    throw new Error(
      `macOS runtime policy must name exactly 24 Mach-O objects, got ${value.machO.length}`,
    );
  }

  const seenPaths = new Set<string>();
  const jitPaths: string[] = [];
  for (const candidate of value.machO) {
    if (
      !isRecord(candidate) ||
      !exactRecordKeys(candidate, ["path", "identifier", "profile"]) ||
      typeof candidate.path !== "string" ||
      !isCanonicalBundlePath(candidate.path) ||
      typeof candidate.identifier !== "string" ||
      candidate.identifier.length === 0 ||
      Buffer.byteLength(candidate.identifier) > 256 ||
      /[\u0000-\u001f\u007f]/u.test(candidate.identifier) ||
      (candidate.profile !== "none" && candidate.profile !== "jit") ||
      seenPaths.has(candidate.path)
    ) {
      throw new Error("macOS runtime policy has an invalid or duplicate Mach-O entry");
    }
    seenPaths.add(candidate.path);
    if (candidate.profile === "jit") jitPaths.push(candidate.path);
  }

  const expectedJit = [...EXPECTED_JIT_MACHO_PATHS].sort();
  const actualJit = jitPaths.sort();
  if (
    actualJit.length !== expectedJit.length ||
    actualJit.some((entry, index) => entry !== expectedJit[index])
  ) {
    throw new Error(
      `macOS runtime policy JIT roles mismatch: got ${actualJit.join(",")} want ${expectedJit.join(",")}`,
    );
  }

  const browserCli = value.machO.find(
    (entry) => isRecord(entry) && entry.path === "Contents/Resources/bin/vellum-browser",
  );
  if (browserCli?.profile !== "none") {
    throw new Error("packaged vellum-browser must have the empty entitlement profile");
  }

  return value as unknown as MacOSRuntimePolicy;
};

export const MACOS_RUNTIME_POLICY = validateMacOSRuntimePolicy(rawRuntimePolicy);

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
  validateMachOCodesignMetadata(metadata, policy.bundleIdentifier, policy);
};

export const validateMachOCodesignMetadata = (
  metadata: CodesignMetadata,
  expectedIdentifier: string,
  policy: PackageSecurityPolicy = PACKAGE_SECURITY_POLICY,
): void => {
  if (metadata.identifier !== expectedIdentifier) {
    throw new Error(
      `signed identifier mismatch: got ${metadata.identifier} want ${expectedIdentifier}`,
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
  const expectedAuthorities = [
    policy.signingIdentity,
    "Developer ID Certification Authority",
    "Apple Root CA",
  ];
  if (
    metadata.authorities.length !== expectedAuthorities.length ||
    metadata.authorities.some(
      (authority, index) => authority !== expectedAuthorities[index],
    )
  ) {
    throw new Error(
      `signed authority chain mismatch: got ${metadata.authorities.join(" -> ")} want ${expectedAuthorities.join(" -> ")}`,
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
  if (plist.LSMinimumSystemVersion !== policy.minimumSystemVersion) {
    throw new Error(
      `Info.plist minimum system version mismatch: got ${String(plist.LSMinimumSystemVersion)} want ${policy.minimumSystemVersion}`,
    );
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

const runFixedCommandWithInput = (
  executable: string,
  args: ReadonlyArray<string>,
  input?: string,
): { readonly stdout: string; readonly stderr: string } => {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
    shell: false,
    ...(input === undefined ? {} : { input }),
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
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
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

export const isMachOMagic = (bytes: Uint8Array): boolean =>
  bytes.byteLength >= 4 &&
  MAC_O_MAGICS.has(Buffer.from(bytes.subarray(0, 4)).toString("hex"));

const pathIsWithin = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
};

export const enumerateMachOPaths = async (
  requestedAppPath: string,
): Promise<ReadonlyArray<string>> => {
  const root = await realpath(requestedAppPath);
  const discovered: string[] = [];

  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) {
        const target = await realpath(absolutePath);
        if (!pathIsWithin(root, target)) {
          throw new Error("packaged app contains a symlink that escapes the bundle");
        }
        continue;
      }
      if (metadata.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!metadata.isFile() || metadata.size < 4) continue;
      const handle = await open(absolutePath, "r");
      try {
        const magic = Buffer.allocUnsafe(4);
        const { bytesRead } = await handle.read(magic, 0, 4, 0);
        if (bytesRead === 4 && isMachOMagic(magic)) {
          discovered.push(path.relative(root, absolutePath).split(path.sep).join("/"));
        }
      } finally {
        await handle.close();
      }
    }
  };

  await walk(root);
  return discovered.sort();
};

export const validateMachOInventory = (
  actualPaths: ReadonlyArray<string>,
  policy: MacOSRuntimePolicy = MACOS_RUNTIME_POLICY,
): void => {
  const expected = policy.machO.map((entry) => entry.path).sort();
  const actual = [...actualPaths].sort();
  const missing = expected.filter((entry) => !actual.includes(entry));
  const extra = actual.filter((entry) => !expected.includes(entry));
  if (missing.length > 0 || extra.length > 0 || new Set(actual).size !== actual.length) {
    throw new Error(
      `packaged Mach-O inventory mismatch: missing=${missing.join(",") || "none"} extra=${extra.join(",") || "none"}`,
    );
  }
};

export const parseMachOArchitectures = (output: string): ReadonlyArray<string> => {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    throw new Error("lipo output is missing Mach-O architectures");
  }
  const architectures = trimmed.split(/\s+/u);
  if (
    architectures.length > 32 ||
    architectures.some(
      (architecture) =>
        architecture.length > 64 || !/^[a-z0-9_]+$/iu.test(architecture),
    ) ||
    new Set(architectures).size !== architectures.length
  ) {
    throw new Error("lipo output has invalid or duplicate Mach-O architectures");
  }
  return architectures;
};

interface MachOLoadCommand {
  readonly name: string;
  readonly fields: ReadonlyArray<string>;
}

const parseMachOLoadCommands = (output: string): ReadonlyArray<MachOLoadCommand> => {
  const commands: MachOLoadCommand[] = [];
  let fields: string[] | undefined;

  const finishCommand = (): void => {
    if (fields === undefined) return;
    const names = fields
      .map((line) => line.match(/^cmd\s+(\S+)$/u)?.[1])
      .filter((name): name is string => name !== undefined);
    if (names.length !== 1) {
      throw new Error("otool load command must contain exactly one cmd field");
    }
    commands.push({ name: names[0], fields });
  };

  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (/^Load command \d+$/u.test(line)) {
      finishCommand();
      fields = [];
    } else if (fields !== undefined) {
      fields.push(line);
    }
  }
  finishCommand();
  return commands;
};

const requireSingleLoadCommandField = (
  command: MachOLoadCommand,
  field: "platform" | "minos" | "version",
): string => {
  const values = command.fields
    .map((line) => line.match(new RegExp(`^${field}\\s+(\\S+)$`, "u"))?.[1])
    .filter((value): value is string => value !== undefined);
  if (values.length !== 1) {
    throw new Error(
      `${command.name} must contain exactly one ${field} field`,
    );
  }
  return values[0];
};

export const parseMachOSliceMinimumSystemVersion = (
  output: string,
  sliceLabel = "Mach-O slice",
): string => {
  const deploymentCommands = parseMachOLoadCommands(output).filter(
    (command) =>
      command.name === "LC_BUILD_VERSION" ||
      command.name === "LC_VERSION_MIN_MACOSX",
  );
  if (deploymentCommands.length !== 1) {
    throw new Error(
      `${sliceLabel} must contain exactly one macOS deployment declaration`,
    );
  }

  const command = deploymentCommands[0];
  const version =
    command.name === "LC_BUILD_VERSION"
      ? requireSingleLoadCommandField(command, "minos")
      : requireSingleLoadCommandField(command, "version");
  if (
    command.name === "LC_BUILD_VERSION" &&
    requireSingleLoadCommandField(command, "platform") !== "1"
  ) {
    throw new Error(`${sliceLabel} LC_BUILD_VERSION must target macOS platform 1`);
  }
  macOSVersionParts(version);
  return version;
};

type FixedCommandRunner = (
  executable: string,
  args: ReadonlyArray<string>,
) => string;

export const readMachOMinimumSystemVersions = (
  filePath: string,
  runCommand: FixedCommandRunner = runFixedCommand,
): ReadonlyArray<string> => {
  const architectures = parseMachOArchitectures(
    runCommand("/usr/bin/lipo", ["-archs", filePath]),
  );
  return architectures.map((architecture) =>
    parseMachOSliceMinimumSystemVersion(
      runCommand("/usr/bin/otool", [
        "-arch",
        architecture,
        "-m",
        "-l",
        filePath,
      ]),
      `${filePath} architecture ${architecture}`,
    ),
  );
};

export const validateMachOMinimumSystemVersions = (
  versions: ReadonlyArray<string>,
  declaredMinimumSystemVersion: string,
  relativePath = "Mach-O",
): string => {
  macOSVersionParts(declaredMinimumSystemVersion);
  if (versions.length === 0) {
    throw new Error(`${relativePath} has no macOS minimum system version`);
  }

  let maximum = versions[0];
  for (const version of versions) {
    macOSVersionParts(version);
    if (compareMacOSVersions(version, declaredMinimumSystemVersion) > 0) {
      throw new Error(
        `packaged Mach-O minimum system version exceeds app declaration: path=${relativePath} minos=${version} declared=${declaredMinimumSystemVersion}`,
      );
    }
    if (compareMacOSVersions(version, maximum) > 0) maximum = version;
  }
  return maximum;
};

export const validateEntitlementProfile = (
  actual: unknown,
  profile: RuntimeEntitlementProfile,
  policy: MacOSRuntimePolicy = MACOS_RUNTIME_POLICY,
): void => {
  if (!isRecord(actual)) {
    throw new Error("signed entitlements must decode to an object");
  }
  const expected = policy.profiles[profile];
  if (!exactRecordKeys(actual, Object.keys(expected))) {
    throw new Error(
      `signed entitlement keys mismatch for ${profile}: got ${Object.keys(actual).sort().join(",") || "none"}`,
    );
  }
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) {
      throw new Error(`signed entitlement ${key} has the wrong value`);
    }
  }
};

const readSignedEntitlements = (filePath: string): unknown => {
  const { stdout } = runFixedCommandWithInput("/usr/bin/codesign", [
    "-d",
    "--entitlements",
    ":-",
    filePath,
  ]);
  if (stdout.trim().length === 0) return {};
  const converted = runFixedCommandWithInput(
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", "-"],
    stdout,
  ).stdout;
  try {
    return JSON.parse(converted);
  } catch {
    throw new Error("plutil returned invalid JSON for signed entitlements");
  }
};

const auditMachOObjects = async (
  appPath: string,
  declaredMinimumSystemVersion: string,
  policy: MacOSRuntimePolicy = MACOS_RUNTIME_POLICY,
): Promise<PackageAuditReceipt["machO"]> => {
  const actualPaths = await enumerateMachOPaths(appPath);
  validateMachOInventory(actualPaths, policy);
  const entries = new Map(policy.machO.map((entry) => [entry.path, entry]));
  let maxMinOS: string | undefined;

  for (const relativePath of actualPaths) {
    const expected = entries.get(relativePath);
    if (expected === undefined) {
      throw new Error("packaged Mach-O path has no signing policy");
    }
    const filePath = path.join(appPath, ...relativePath.split("/"));
    const objectMaxMinOS = validateMachOMinimumSystemVersions(
      readMachOMinimumSystemVersions(filePath),
      declaredMinimumSystemVersion,
      relativePath,
    );
    if (
      maxMinOS === undefined ||
      compareMacOSVersions(objectMaxMinOS, maxMinOS) > 0
    ) {
      maxMinOS = objectMaxMinOS;
    }
    const metadata = parseCodesignMetadata(
      runFixedCommand("/usr/bin/codesign", ["-d", "--verbose=4", filePath]),
    );
    validateMachOCodesignMetadata(metadata, expected.identifier);
    validateEntitlementProfile(readSignedEntitlements(filePath), expected.profile, policy);
  }

  const jitPaths = policy.machO
    .filter((entry) => entry.profile === "jit")
    .map((entry) => entry.path)
    .sort();
  if (maxMinOS === undefined) {
    throw new Error("packaged Mach-O inventory is empty");
  }
  return {
    count: actualPaths.length,
    maxMinOS,
    jitPaths,
    emptyEntitlementsCount: actualPaths.length - jitPaths.length,
    forbiddenEntitlementsCount: 0,
  };
};

export const auditPackagedApp = async (
  requestedPath: string,
): Promise<PackageAuditReceipt> => {
  const policy = PACKAGE_SECURITY_POLICY;
  const appPath = path.resolve(requestedPath);
  const embeddedPolicyPath = path.join(appPath, "Contents", "Resources", "policy", "electron-security-policy.json");
  const embeddedObservationPath = path.join(appPath, "Contents", "Resources", "policy", "electron-observation.json");
  const workspacePolicyPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "electron-security-policy.json");
  const embeddedHighWaterPath = path.join(appPath, "Contents", "Resources", "policy", "electron-observation-high-water.json");
  const [embeddedPolicyRaw, workspacePolicyRaw, embeddedObservationRaw, embeddedHighWaterRaw] = await Promise.all([readFile(embeddedPolicyPath, "utf8"), readFile(workspacePolicyPath, "utf8"), readFile(embeddedObservationPath, "utf8"), readFile(embeddedHighWaterPath, "utf8")]);
  if (embeddedPolicyRaw !== workspacePolicyRaw) throw new Error("embedded Electron policy differs from reviewed workspace policy");
  const electronInfoPath = path.join(appPath, "Contents", "Frameworks", "Electron Framework.framework", "Versions", "A", "Resources", "Info.plist");
  const electronInfo = JSON.parse(runFixedCommand("/usr/bin/plutil", ["-convert", "json", "-o", "-", electronInfoPath])) as Record<string, unknown>;
  const embeddedVersion = electronInfo.CFBundleVersion;
  if (typeof embeddedVersion !== "string") throw new Error("Electron framework Info.plist is missing CFBundleVersion");
  const electronPolicy = decodeElectronSecurityPolicy(JSON.parse(embeddedPolicyRaw));
  validateElectronSecurityPolicy(electronPolicy, { now: new Date(), manifestVersion: electronPolicy.electron.exactVersion, installedPackageVersion: electronPolicy.electron.exactVersion, installedRuntimeVersion: embeddedVersion });
  const embeddedObservation = decodeElectronObservation(JSON.parse(embeddedObservationRaw));
  const embeddedHighWater = decodeElectronObservation(JSON.parse(embeddedHighWaterRaw));
  validateElectronObservation(embeddedObservation, electronPolicy, embeddedPolicyRaw, new Date());
  validateElectronObservation(embeddedHighWater, electronPolicy, embeddedPolicyRaw, new Date());
  if (JSON.stringify(embeddedObservation) !== JSON.stringify(embeddedHighWater)) throw new Error("embedded Electron observation is not the current high-water state");
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
  const machO = await auditMachOObjects(
    appPath,
    policy.minimumSystemVersion,
  );
  return {
    appPath,
    bundleIdentifier: codesign.identifier,
    teamIdentifier: codesign.teamIdentifier,
    runtimeVersion: codesign.runtimeVersion,
    minimumSystemVersion: policy.minimumSystemVersion,
    fuses,
    machO,
  };
};

const modulePath = fileURLToPath(import.meta.url);
const invokedPath =
  process.argv[1] === undefined ? "" : path.resolve(process.argv[1]);
if (invokedPath === modulePath) {
  const requestedPath = process.argv[2];
  if (requestedPath === undefined || process.argv.length !== 3) {
    console.error("usage: bun scripts/audit-packaged-app.ts /path/to/Vellum Command.app");
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
