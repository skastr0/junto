import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export const LINUX_RELEASE_MANIFEST = "release-manifest.json";
export const LINUX_RELEASE_SIGNATURE = "release-manifest.sig";
export const LINUX_RELEASE_CHECKSUMS = "SHA256SUMS";
export const LINUX_RELEASE_KEYRING = "release-keyring.json";
export const LINUX_RELEASE_MAX_VALIDITY_MS = 31 * 24 * 60 * 60 * 1_000;
export const LINUX_RELEASE_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export const LINUX_RELEASE_TARGET = Object.freeze({
  os: "linux",
  distribution: "ubuntu",
  distributionVersion: "24.04",
  architecture: "x64",
  machine: "x86_64",
  debArchitecture: "amd64",
  libc: {
    family: "glibc",
    minimumVersion: "2.39",
  },
  packageKind: "deb",
} as const);

export const LINUX_RELEASE_PROTOCOLS = Object.freeze({
  stationBrowser: 1,
  workControl: "vellum-work/v1",
} as const);

export const LINUX_RELEASE_UNSUPPORTED = Object.freeze([
  "linux-arm64",
  "musl-alpine",
  "appimage",
  "rpm",
  "snap",
  "flatpak",
  "container-only",
] as const);

export type LinuxReleaseFileKind =
  | "package"
  | "build-receipt"
  | "test-receipt"
  | "package-audit"
  | "runtime-receipt"
  | "dependency-license-inventory"
  | "sbom"
  | "changelog"
  | "source-revision"
  | "operator-runbook"
  | "offline-verifier";

export interface LinuxReleaseFile {
  readonly kind: LinuxReleaseFileKind;
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface LinuxReleaseManifest {
  readonly schema: "vellum/linux-release-manifest/v1";
  readonly release: {
    readonly product: "Vellum Command";
    readonly version: string;
    readonly channel: "stable";
    readonly createdAt: string;
    readonly expiresAt: string;
    readonly downloadLocator: string;
  };
  readonly source: {
    readonly revision: string;
    readonly revisionFile: "source-revision.json";
  };
  readonly target: typeof LINUX_RELEASE_TARGET;
  readonly package: {
    readonly name: "vellum";
    readonly kind: "deb";
    readonly file: string;
    readonly bytes: number;
    readonly sha256: string;
  };
  readonly protocols: {
    readonly stationBrowser: 1;
    readonly workControl: "vellum-work/v1";
    readonly minimumPeerVersion: string;
  };
  readonly downgrade:
    | {
      readonly policy: "forbid";
      readonly minimumVersion: string;
    }
    | {
      readonly policy: "explicit-rollback";
      readonly minimumVersion: string;
    };
  readonly trust: {
    readonly algorithm: "ed25519";
    readonly keyId: string;
    readonly minimumKeyringRevision: number;
  };
  readonly files: ReadonlyArray<LinuxReleaseFile>;
  readonly unsupported: typeof LINUX_RELEASE_UNSUPPORTED;
}

export interface LinuxReleaseSignature {
  readonly schema: "vellum/linux-release-signatures/v1";
  readonly algorithm: "ed25519";
  readonly keyId: string;
  readonly signedAt: string;
  readonly manifest: {
    readonly file: typeof LINUX_RELEASE_MANIFEST;
    readonly sha256: string;
    readonly signature: string;
  };
  readonly checksums: {
    readonly file: typeof LINUX_RELEASE_CHECKSUMS;
    readonly sha256: string;
    readonly signature: string;
  };
}

export interface LinuxReleaseKey {
  readonly keyId: string;
  readonly algorithm: "ed25519";
  readonly publicKeyPem: string;
  readonly fingerprintSha256: string;
  readonly status: "active" | "retired" | "revoked";
  readonly validFrom: string;
  readonly signingEndsAt?: string;
  readonly revokedAt?: string;
  readonly supersededBy?: string;
}

export interface LinuxReleaseKeyring {
  readonly schema: "vellum/linux-release-keyring/v1";
  readonly revision: number;
  readonly keys: ReadonlyArray<LinuxReleaseKey>;
}

export interface LinuxReleaseHostFacts {
  readonly platform: string;
  readonly architecture: string;
  readonly machine: string;
  readonly distribution: string;
  readonly distributionVersion: string;
  readonly libcFamily: string;
  readonly libcVersion: string;
}

export interface LinuxReleasePackageIdentity {
  readonly packageName: string;
  readonly version: string;
  readonly architecture: string;
}

export interface LinuxReleaseVerificationInput {
  readonly bundleDirectory: string;
  readonly host: LinuxReleaseHostFacts;
  readonly packageIdentity: LinuxReleasePackageIdentity;
  readonly peerVersion: string;
  readonly stationBrowserProtocol: number;
  readonly workControlProtocol: string;
  readonly installedVersion?: string;
  readonly allowExplicitRollback?: boolean;
  readonly now?: number;
}

export interface LinuxReleaseVerificationReceipt {
  readonly schema: "vellum/linux-release-verification-receipt/v1";
  readonly ok: true;
  readonly version: string;
  readonly sourceRevision: string;
  readonly target: typeof LINUX_RELEASE_TARGET;
  readonly keyId: string;
  readonly keyringRevision: number;
  readonly signedAt: string;
  readonly expiresAt: string;
  readonly filesVerified: number;
  readonly packageSha256: string;
}

const FILE_KINDS = new Set<LinuxReleaseFileKind>([
  "package",
  "build-receipt",
  "test-receipt",
  "package-audit",
  "runtime-receipt",
  "dependency-license-inventory",
  "sbom",
  "changelog",
  "source-revision",
  "operator-runbook",
  "offline-verifier",
]);

const REQUIRED_FIXED_FILES = Object.freeze([
  ["build-receipt", "build-receipt.json"],
  ["test-receipt", "test-receipt.json"],
  ["package-audit", "package-audit.json"],
  ["runtime-receipt", "packaged-pty-smoke.json"],
  ["runtime-receipt", "packaged-runtime-smoke.json"],
  ["dependency-license-inventory", "dependency-license-inventory.json"],
  ["sbom", "sbom.cdx.json"],
  ["changelog", "CHANGELOG.md"],
  ["source-revision", "source-revision.json"],
  ["operator-runbook", "OPERATIONS.md"],
  ["offline-verifier", "vellum-linux-verify-x64"],
] as const satisfies ReadonlyArray<readonly [LinuxReleaseFileKind, string]>);

const METADATA_FILES = new Set([
  LINUX_RELEASE_MANIFEST,
  LINUX_RELEASE_SIGNATURE,
  LINUX_RELEASE_CHECKSUMS,
  LINUX_RELEASE_KEYRING,
]);

const SHA256 = /^[0-9a-f]{64}$/u;
const SOURCE_REVISION = /^[0-9a-f]{40}$/u;
const KEY_ID = /^[a-z0-9][a-z0-9._-]{7,63}$/u;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const BASE64URL_SIGNATURE = /^[A-Za-z0-9_-]{86}$/u;
const MAX_METADATA_BYTES = 512 * 1024;
const MAX_TEXT_EVIDENCE_BYTES = 32 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_VERIFIER_BYTES = 256 * 1024 * 1024;

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`malformed ${label}`);
  }
  return value as Record<string, unknown>;
};

const exactKeys = (
  value: Record<string, unknown>,
  keys: ReadonlyArray<string>,
  label: string,
): void => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`unexpected fields in ${label}`);
  }
};

const requiredString = (
  value: unknown,
  label: string,
  maximum = 512,
): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximum ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error(`invalid ${label}`);
  }
  return value;
};

const requireSafeFileName = (value: unknown, label: string): string => {
  const file = requiredString(value, label, 180);
  if (
    file === "." ||
    file === ".." ||
    /[\/\\\u0000-\u001f\u007f]/u.test(file) ||
    path.basename(file) !== file
  ) {
    throw new Error(`unsafe ${label}`);
  }
  return file;
};

const requireSha256 = (value: unknown, label: string): string => {
  const digest = requiredString(value, label, 64);
  if (!SHA256.test(digest)) throw new Error(`invalid ${label}`);
  return digest;
};

const requireSourceRevision = (value: unknown): string => {
  const revision = requiredString(value, "source revision", 40);
  if (!SOURCE_REVISION.test(revision)) {
    throw new Error("source revision must be a full lowercase Git SHA");
  }
  return revision;
};

const requireKeyId = (value: unknown): string => {
  const keyId = requiredString(value, "release key id", 64);
  if (!KEY_ID.test(keyId)) throw new Error("invalid release key id");
  return keyId;
};

const requireSemver = (value: unknown, label: string): string => {
  const version = requiredString(value, label, 64);
  if (!SEMVER.test(version)) throw new Error(`invalid ${label}`);
  return version;
};

const semverParts = (value: string): readonly [number, number, number] => {
  const match = value.match(SEMVER);
  if (match === null) throw new Error("invalid semantic version");
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

export const compareReleaseVersions = (left: string, right: string): number => {
  const a = semverParts(requireSemver(left, "version"));
  const b = semverParts(requireSemver(right, "version"));
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
};

const requireInteger = (
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number => {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`invalid ${label}`);
  }
  return value;
};

const requireIsoTimestamp = (value: unknown, label: string): string => {
  const timestamp = requiredString(value, label, 64);
  const epoch = Date.parse(timestamp);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== timestamp) {
    throw new Error(`invalid ${label}`);
  }
  return timestamp;
};

const requireDownloadLocator = (
  value: unknown,
  version: string,
): string => {
  const locator = requiredString(value, "download locator", 2_048);
  let parsed: URL;
  try {
    parsed = new URL(locator);
  } catch {
    throw new Error("invalid download locator");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    parsed.hostname.length === 0 ||
    !parsed.pathname.endsWith(
      `/vellum-${version}-ubuntu-24.04-x64-release.tar.gz`,
    )
  ) {
    throw new Error("download locator must name the exact HTTPS release bundle");
  }
  return parsed.toString();
};

const canonicalJson = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;

const parseCanonicalJson = <T>(
  input: Buffer,
  label: string,
): { readonly value: T; readonly text: string } => {
  if (input.length === 0 || input.length > MAX_METADATA_BYTES) {
    throw new Error(`invalid ${label} size`);
  }
  const text = input.toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`malformed ${label}`);
  }
  if (canonicalJson(value) !== text) {
    throw new Error(`${label} is not canonical JSON`);
  }
  return { value: value as T, text };
};

const sha256Bytes = (input: Uint8Array | string): string =>
  createHash("sha256").update(input).digest("hex");

const sha256File = async (file: string): Promise<string> =>
  sha256Bytes(await readFile(file));

const requireRegularFile = async (
  directory: string,
  name: string,
  maximumBytes: number,
): Promise<{ readonly file: string; readonly bytes: number }> => {
  const safeName = requireSafeFileName(name, "release file");
  const file = path.join(directory, safeName);
  const metadata = await lstat(file);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size <= 0 ||
    metadata.size > maximumBytes
  ) {
    throw new Error(`invalid release file: ${safeName}`);
  }
  return { file, bytes: metadata.size };
};

const publicKeyFingerprint = (key: KeyObject): string => {
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
    throw new Error("release key must be an Ed25519 public key");
  }
  return sha256Bytes(key.export({ format: "der", type: "spki" }));
};

const decodeReleaseKey = (value: unknown): LinuxReleaseKey => {
  const key = record(value, "release key");
  const optional = ["signingEndsAt", "revokedAt", "supersededBy"].filter(
    (field) => key[field] !== undefined,
  );
  exactKeys(
    key,
    [
      "keyId",
      "algorithm",
      "publicKeyPem",
      "fingerprintSha256",
      "status",
      "validFrom",
      ...optional,
    ],
    "release key",
  );
  const keyId = requireKeyId(key.keyId);
  if (key.algorithm !== "ed25519") {
    throw new Error("unsupported release key algorithm");
  }
  const publicKeyPem =
    typeof key.publicKeyPem === "string" &&
    Buffer.byteLength(key.publicKeyPem, "utf8") <= 8_192
      ? key.publicKeyPem
      : (() => {
        throw new Error("invalid release public key");
      })();
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey(publicKeyPem);
  } catch {
    throw new Error("invalid release public key");
  }
  const fingerprintSha256 = requireSha256(
    key.fingerprintSha256,
    "release key fingerprint",
  );
  if (publicKeyFingerprint(publicKey) !== fingerprintSha256) {
    throw new Error("release key fingerprint mismatch");
  }
  if (
    key.status !== "active" &&
    key.status !== "retired" &&
    key.status !== "revoked"
  ) {
    throw new Error("invalid release key status");
  }
  const validFrom = requireIsoTimestamp(key.validFrom, "key valid-from time");
  const signingEndsAt =
    key.signingEndsAt === undefined
      ? undefined
      : requireIsoTimestamp(key.signingEndsAt, "key signing-end time");
  const revokedAt =
    key.revokedAt === undefined
      ? undefined
      : requireIsoTimestamp(key.revokedAt, "key revocation time");
  const supersededBy =
    key.supersededBy === undefined
      ? undefined
      : requireKeyId(key.supersededBy);
  if (
    (key.status === "retired" && signingEndsAt === undefined) ||
    (key.status === "revoked" && revokedAt === undefined) ||
    (signingEndsAt !== undefined &&
      Date.parse(signingEndsAt) <= Date.parse(validFrom)) ||
    (revokedAt !== undefined && Date.parse(revokedAt) <= Date.parse(validFrom))
  ) {
    throw new Error("incoherent release key lifecycle");
  }
  return {
    keyId,
    algorithm: "ed25519",
    publicKeyPem,
    fingerprintSha256,
    status: key.status,
    validFrom,
    ...(signingEndsAt === undefined ? {} : { signingEndsAt }),
    ...(revokedAt === undefined ? {} : { revokedAt }),
    ...(supersededBy === undefined ? {} : { supersededBy }),
  };
};

export const decodeLinuxReleaseKeyring = (
  value: unknown,
  options: { readonly allowEmpty?: boolean } = {},
): LinuxReleaseKeyring => {
  const keyring = record(value, "Linux release keyring");
  exactKeys(keyring, ["schema", "revision", "keys"], "Linux release keyring");
  if (keyring.schema !== "vellum/linux-release-keyring/v1") {
    throw new Error("unsupported Linux release keyring");
  }
  const revision = requireInteger(
    keyring.revision,
    "keyring revision",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  if (!Array.isArray(keyring.keys)) {
    throw new Error("malformed Linux release keyring");
  }
  const keys = keyring.keys.map(decodeReleaseKey);
  if (keys.length === 0 && options.allowEmpty !== true) {
    throw new Error("Linux release keyring has no trusted keys");
  }
  const ids = new Set<string>();
  for (const key of keys) {
    if (ids.has(key.keyId)) throw new Error("duplicate Linux release key id");
    ids.add(key.keyId);
  }
  for (const key of keys) {
    if (
      key.supersededBy !== undefined &&
      (!ids.has(key.supersededBy) || key.supersededBy === key.keyId)
    ) {
      throw new Error("release key rotation target is not in the keyring");
    }
  }
  return {
    schema: "vellum/linux-release-keyring/v1",
    revision,
    keys,
  };
};

const decodeReleaseFile = (value: unknown): LinuxReleaseFile => {
  const entry = record(value, "release file entry");
  exactKeys(entry, ["kind", "file", "bytes", "sha256"], "release file entry");
  if (
    typeof entry.kind !== "string" ||
    !FILE_KINDS.has(entry.kind as LinuxReleaseFileKind)
  ) {
    throw new Error("invalid release file kind");
  }
  return {
    kind: entry.kind as LinuxReleaseFileKind,
    file: requireSafeFileName(entry.file, "release file name"),
    bytes: requireInteger(
      entry.bytes,
      "release file byte count",
      1,
      entry.kind === "package"
        ? MAX_PACKAGE_BYTES
        : entry.kind === "offline-verifier"
          ? MAX_VERIFIER_BYTES
          : MAX_TEXT_EVIDENCE_BYTES,
    ),
    sha256: requireSha256(entry.sha256, "release file SHA-256"),
  };
};

const validateExactPayloadInventory = (
  version: string,
  files: ReadonlyArray<LinuxReleaseFile>,
): void => {
  const expectedPackage = `Vellum Command-${version}-x64-linux.deb`;
  const expected = new Map<string, LinuxReleaseFileKind>([
    [expectedPackage, "package"],
    ...REQUIRED_FIXED_FILES.map(([kind, file]) => [file, kind] as const),
  ]);
  if (files.length !== expected.size) {
    throw new Error("Linux release bundle has an incomplete payload inventory");
  }
  const seen = new Set<string>();
  for (const entry of files) {
    if (seen.has(entry.file)) throw new Error("duplicate release file entry");
    seen.add(entry.file);
    if (expected.get(entry.file) !== entry.kind) {
      throw new Error(`unexpected Linux release payload: ${entry.file}`);
    }
  }
};

export const decodeLinuxReleaseManifest = (
  value: unknown,
): LinuxReleaseManifest => {
  const manifest = record(value, "Linux release manifest");
  exactKeys(
    manifest,
    [
      "schema",
      "release",
      "source",
      "target",
      "package",
      "protocols",
      "downgrade",
      "trust",
      "files",
      "unsupported",
    ],
    "Linux release manifest",
  );
  if (manifest.schema !== "vellum/linux-release-manifest/v1") {
    throw new Error("unsupported Linux release manifest");
  }

  const release = record(manifest.release, "release identity");
  exactKeys(
    release,
    [
      "product",
      "version",
      "channel",
      "createdAt",
      "expiresAt",
      "downloadLocator",
    ],
    "release identity",
  );
  if (release.product !== "Vellum Command" || release.channel !== "stable") {
    throw new Error("unsupported Linux release product or channel");
  }
  const version = requireSemver(release.version, "release version");
  const createdAt = requireIsoTimestamp(release.createdAt, "release creation time");
  const expiresAt = requireIsoTimestamp(release.expiresAt, "release expiry time");
  const validity = Date.parse(expiresAt) - Date.parse(createdAt);
  if (validity <= 0 || validity > LINUX_RELEASE_MAX_VALIDITY_MS) {
    throw new Error("Linux release validity window is outside policy");
  }
  const downloadLocator = requireDownloadLocator(
    release.downloadLocator,
    version,
  );

  const source = record(manifest.source, "release source");
  exactKeys(source, ["revision", "revisionFile"], "release source");
  const revision = requireSourceRevision(source.revision);
  if (source.revisionFile !== "source-revision.json") {
    throw new Error("Linux release source revision file mismatch");
  }

  if (JSON.stringify(manifest.target) !== JSON.stringify(LINUX_RELEASE_TARGET)) {
    throw new Error("Linux release target mismatch");
  }

  const packageEntry = record(manifest.package, "Linux release package");
  exactKeys(
    packageEntry,
    ["name", "kind", "file", "bytes", "sha256"],
    "Linux release package",
  );
  const expectedPackage = `Vellum Command-${version}-x64-linux.deb`;
  if (
    packageEntry.name !== "vellum" ||
    packageEntry.kind !== "deb" ||
    packageEntry.file !== expectedPackage
  ) {
    throw new Error("Linux release package identity mismatch");
  }
  const packageBytes = requireInteger(
    packageEntry.bytes,
    "package byte count",
    1,
    MAX_PACKAGE_BYTES,
  );
  const packageSha256 = requireSha256(
    packageEntry.sha256,
    "package SHA-256",
  );

  const protocols = record(manifest.protocols, "release protocols");
  exactKeys(
    protocols,
    ["stationBrowser", "workControl", "minimumPeerVersion"],
    "release protocols",
  );
  if (
    protocols.stationBrowser !== LINUX_RELEASE_PROTOCOLS.stationBrowser ||
    protocols.workControl !== LINUX_RELEASE_PROTOCOLS.workControl
  ) {
    throw new Error("Linux release protocol identity mismatch");
  }
  const minimumPeerVersion = requireSemver(
    protocols.minimumPeerVersion,
    "minimum peer version",
  );

  const downgrade = record(manifest.downgrade, "downgrade policy");
  exactKeys(downgrade, ["policy", "minimumVersion"], "downgrade policy");
  if (
    downgrade.policy !== "forbid" &&
    downgrade.policy !== "explicit-rollback"
  ) {
    throw new Error("unsupported downgrade policy");
  }
  const minimumVersion = requireSemver(
    downgrade.minimumVersion,
    "minimum downgrade version",
  );
  if (compareReleaseVersions(version, minimumVersion) < 0) {
    throw new Error("release version is below its downgrade floor");
  }

  const trust = record(manifest.trust, "release trust policy");
  exactKeys(
    trust,
    ["algorithm", "keyId", "minimumKeyringRevision"],
    "release trust policy",
  );
  if (trust.algorithm !== "ed25519") {
    throw new Error("unsupported release signature algorithm");
  }
  const keyId = requireKeyId(trust.keyId);
  const minimumKeyringRevision = requireInteger(
    trust.minimumKeyringRevision,
    "minimum keyring revision",
    1,
    Number.MAX_SAFE_INTEGER,
  );

  if (!Array.isArray(manifest.files)) {
    throw new Error("malformed Linux release file inventory");
  }
  const files = manifest.files.map(decodeReleaseFile);
  validateExactPayloadInventory(version, files);
  const packageReceipt = files.find((entry) => entry.kind === "package");
  if (
    packageReceipt === undefined ||
    packageReceipt.file !== expectedPackage ||
    packageReceipt.bytes !== packageBytes ||
    packageReceipt.sha256 !== packageSha256
  ) {
    throw new Error("Linux release package receipt mismatch");
  }
  if (
    JSON.stringify(manifest.unsupported) !==
    JSON.stringify(LINUX_RELEASE_UNSUPPORTED)
  ) {
    throw new Error("Linux release support exclusions mismatch");
  }

  return {
    schema: "vellum/linux-release-manifest/v1",
    release: {
      product: "Vellum Command",
      version,
      channel: "stable",
      createdAt,
      expiresAt,
      downloadLocator,
    },
    source: {
      revision,
      revisionFile: "source-revision.json",
    },
    target: LINUX_RELEASE_TARGET,
    package: {
      name: "vellum",
      kind: "deb",
      file: expectedPackage,
      bytes: packageBytes,
      sha256: packageSha256,
    },
    protocols: {
      stationBrowser: 1,
      workControl: "vellum-work/v1",
      minimumPeerVersion,
    },
    downgrade: {
      policy: downgrade.policy,
      minimumVersion,
    },
    trust: {
      algorithm: "ed25519",
      keyId,
      minimumKeyringRevision,
    },
    files,
    unsupported: LINUX_RELEASE_UNSUPPORTED,
  };
};

const decodeSignedPart = (
  value: unknown,
  expectedFile: string,
  label: string,
): { readonly file: string; readonly sha256: string; readonly signature: string } => {
  const part = record(value, label);
  exactKeys(part, ["file", "sha256", "signature"], label);
  if (part.file !== expectedFile) throw new Error(`${label} file mismatch`);
  const signature = requiredString(part.signature, `${label} signature`, 128);
  if (
    !BASE64URL_SIGNATURE.test(signature) ||
    Buffer.from(signature, "base64url").length !== 64
  ) {
    throw new Error(`invalid ${label} signature`);
  }
  return {
    file: expectedFile,
    sha256: requireSha256(part.sha256, `${label} SHA-256`),
    signature,
  };
};

export const decodeLinuxReleaseSignature = (
  value: unknown,
): LinuxReleaseSignature => {
  const signature = record(value, "Linux release signature");
  exactKeys(
    signature,
    [
      "schema",
      "algorithm",
      "keyId",
      "signedAt",
      "manifest",
      "checksums",
    ],
    "Linux release signature",
  );
  if (
    signature.schema !== "vellum/linux-release-signatures/v1" ||
    signature.algorithm !== "ed25519"
  ) {
    throw new Error("unsupported Linux release signature");
  }
  return {
    schema: "vellum/linux-release-signatures/v1",
    algorithm: "ed25519",
    keyId: requireKeyId(signature.keyId),
    signedAt: requireIsoTimestamp(signature.signedAt, "release signing time"),
    manifest: decodeSignedPart(
      signature.manifest,
      LINUX_RELEASE_MANIFEST,
      "manifest signature",
    ) as LinuxReleaseSignature["manifest"],
    checksums: decodeSignedPart(
      signature.checksums,
      LINUX_RELEASE_CHECKSUMS,
      "checksum signature",
    ) as LinuxReleaseSignature["checksums"],
  };
};

const checksumText = (files: ReadonlyArray<LinuxReleaseFile>): string =>
  `${files
    .map((entry) => `${entry.sha256}  ${entry.file}`)
    .sort()
    .join("\n")}\n`;

const requireExactDirectoryInventory = async (
  directory: string,
  payloadFiles: ReadonlyArray<string>,
  phase: "unsigned" | "signed",
): Promise<void> => {
  const expected = new Set([
    LINUX_RELEASE_KEYRING,
    ...payloadFiles,
    ...(phase === "unsigned"
      ? []
      : [
        LINUX_RELEASE_MANIFEST,
        LINUX_RELEASE_CHECKSUMS,
        LINUX_RELEASE_SIGNATURE,
      ]),
  ]);
  const entries = await readdir(directory, { withFileTypes: true });
  const actual = new Set<string>();
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Linux release bundle contains a non-file: ${entry.name}`);
    }
    actual.add(entry.name);
  }
  if (
    actual.size !== expected.size ||
    [...actual].some((name) => !expected.has(name))
  ) {
    throw new Error("Linux release bundle contains missing or extra files");
  }
};

const readCanonicalFile = async <T>(
  directory: string,
  name: string,
  label: string,
): Promise<{ readonly value: T; readonly bytes: Buffer }> => {
  const admitted = await requireRegularFile(
    directory,
    name,
    MAX_METADATA_BYTES,
  );
  const bytes = await readFile(admitted.file);
  return {
    value: parseCanonicalJson<T>(bytes, label).value,
    bytes,
  };
};

const readKeyring = async (
  directory: string,
  options: { readonly allowEmpty?: boolean } = {},
): Promise<LinuxReleaseKeyring> => {
  const parsed = await readCanonicalFile<unknown>(
    directory,
    LINUX_RELEASE_KEYRING,
    "Linux release keyring",
  );
  return decodeLinuxReleaseKeyring(parsed.value, options);
};

const safeEvidenceText = (text: string, label: string): void => {
  const forbidden = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
    /\b(?:github_pat_|gh[pousr]_|sk-)[A-Za-z0-9_-]{20,}\b/u,
    /\bAuthorization:\s*(?:Bearer|Basic)\s+\S+/iu,
    /\/home\/[^/<>\s]+/u,
    /\/Users\/[^/<>\s]+/u,
    /\bfile:(?:\/\/|\/|\.\.)/iu,
  ];
  if (forbidden.some((pattern) => pattern.test(text))) {
    throw new Error(`${label} contains a secret or developer-local path`);
  }
};

const validateSourceRevisionReceipt = (
  input: string,
  expectedRevision: string,
): void => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error("malformed source revision receipt");
  }
  const receipt = record(parsed, "source revision receipt");
  exactKeys(receipt, ["schema", "revision"], "source revision receipt");
  if (
    receipt.schema !== "vellum/source-revision/v1" ||
    receipt.revision !== expectedRevision ||
    canonicalJson(receipt) !== input
  ) {
    throw new Error("source revision receipt mismatch");
  }
};

const validatePayloads = async (
  directory: string,
  manifest: LinuxReleaseManifest,
): Promise<void> => {
  for (const entry of manifest.files) {
    const maximum =
      entry.kind === "package"
        ? MAX_PACKAGE_BYTES
        : entry.kind === "offline-verifier"
          ? MAX_VERIFIER_BYTES
          : MAX_TEXT_EVIDENCE_BYTES;
    const admitted = await requireRegularFile(directory, entry.file, maximum);
    if (
      admitted.bytes !== entry.bytes ||
      (await sha256File(admitted.file)) !== entry.sha256
    ) {
      throw new Error(`Linux release payload hash mismatch: ${entry.file}`);
    }
    if (entry.kind !== "package" && entry.kind !== "offline-verifier") {
      const text = await readFile(admitted.file, "utf8");
      safeEvidenceText(text, entry.file);
      if (entry.kind === "source-revision") {
        validateSourceRevisionReceipt(text, manifest.source.revision);
      }
      if (
        entry.kind === "changelog" &&
        /(?:NOT AUTHORIZED FOR PUBLICATION|RELEASE CANDIDATE TEMPLATE)/iu.test(text)
      ) {
        throw new Error("release changelog is still an unauthorized template");
      }
    }
  }
};

const validateHost = (host: LinuxReleaseHostFacts): void => {
  if (
    host.platform !== "linux" ||
    host.architecture !== "x64" ||
    host.machine !== "x86_64" ||
    host.distribution !== "ubuntu" ||
    host.distributionVersion !== "24.04" ||
    host.libcFamily !== "glibc" ||
    !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(host.libcVersion) ||
    compareDottedVersion(
      host.libcVersion,
      LINUX_RELEASE_TARGET.libc.minimumVersion,
    ) < 0
  ) {
    throw new Error("release bundle does not support this target host");
  }
};

const compareDottedVersion = (left: string, right: string): number => {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const currentA = a[index] ?? 0;
    const currentB = b[index] ?? 0;
    if (currentA !== currentB) return currentA < currentB ? -1 : 1;
  }
  return 0;
};

const validateCompatibility = (
  manifest: LinuxReleaseManifest,
  input: LinuxReleaseVerificationInput,
): void => {
  validateHost(input.host);
  if (
    input.packageIdentity.packageName !== manifest.package.name ||
    input.packageIdentity.version !== manifest.release.version ||
    input.packageIdentity.architecture !==
      LINUX_RELEASE_TARGET.debArchitecture
  ) {
    throw new Error("deb metadata does not match the signed release manifest");
  }
  const peerVersion = requireSemver(input.peerVersion, "peer version");
  if (
    compareReleaseVersions(
      peerVersion,
      manifest.protocols.minimumPeerVersion,
    ) < 0 ||
    input.stationBrowserProtocol !==
      manifest.protocols.stationBrowser ||
    input.workControlProtocol !== manifest.protocols.workControl
  ) {
    throw new Error("release protocol is incompatible with the selected peer");
  }
  if (input.installedVersion !== undefined) {
    const installed = requireSemver(
      input.installedVersion,
      "installed version",
    );
    const comparison = compareReleaseVersions(
      manifest.release.version,
      installed,
    );
    if (
      comparison < 0 &&
      (manifest.downgrade.policy === "forbid" ||
        input.allowExplicitRollback !== true)
    ) {
      throw new Error("release downgrade is outside signed policy");
    }
    if (
      comparison < 0 &&
      compareReleaseVersions(
        manifest.release.version,
        manifest.downgrade.minimumVersion,
      ) < 0
    ) {
      throw new Error("release downgrade is below the signed floor");
    }
  }
};

const selectTrustedKey = (
  keyring: LinuxReleaseKeyring,
  signature: LinuxReleaseSignature,
  manifest: LinuxReleaseManifest,
): LinuxReleaseKey => {
  if (
    keyring.revision < manifest.trust.minimumKeyringRevision ||
    signature.keyId !== manifest.trust.keyId
  ) {
    throw new Error("release keyring or signature key does not match policy");
  }
  const key = keyring.keys.find((candidate) =>
    candidate.keyId === signature.keyId
  );
  if (key === undefined) throw new Error("release signature key is not trusted");
  if (key.status === "revoked") {
    throw new Error("release signature key is revoked");
  }
  const signedAt = Date.parse(signature.signedAt);
  if (
    signedAt < Date.parse(key.validFrom) ||
    (key.signingEndsAt !== undefined &&
      signedAt > Date.parse(key.signingEndsAt))
  ) {
    throw new Error("release was signed outside the key authorization window");
  }
  return key;
};

const verifyMetadataSignatures = (
  key: LinuxReleaseKey,
  signature: LinuxReleaseSignature,
  manifestBytes: Buffer,
  checksumBytes: Buffer,
): void => {
  if (
    sha256Bytes(manifestBytes) !== signature.manifest.sha256 ||
    sha256Bytes(checksumBytes) !== signature.checksums.sha256
  ) {
    throw new Error("signed Linux release metadata digest mismatch");
  }
  const publicKey = createPublicKey(key.publicKeyPem);
  if (
    !verify(
      null,
      manifestBytes,
      publicKey,
      Buffer.from(signature.manifest.signature, "base64url"),
    ) ||
    !verify(
      null,
      checksumBytes,
      publicKey,
      Buffer.from(signature.checksums.signature, "base64url"),
    )
  ) {
    throw new Error("Linux release metadata signature is invalid");
  }
};

export const verifyLinuxReleaseBundle = async (
  input: LinuxReleaseVerificationInput,
): Promise<LinuxReleaseVerificationReceipt> => {
  const directory = path.resolve(input.bundleDirectory);
  const [manifestRaw, signatureRaw, checksumFile, keyring] = await Promise.all([
    readCanonicalFile<unknown>(
      directory,
      LINUX_RELEASE_MANIFEST,
      "Linux release manifest",
    ),
    readCanonicalFile<unknown>(
      directory,
      LINUX_RELEASE_SIGNATURE,
      "Linux release signature",
    ),
    requireRegularFile(
      directory,
      LINUX_RELEASE_CHECKSUMS,
      MAX_METADATA_BYTES,
    ),
    readKeyring(directory),
  ]);
  const checksumBytes = await readFile(checksumFile.file);
  const manifest = decodeLinuxReleaseManifest(manifestRaw.value);
  const signature = decodeLinuxReleaseSignature(signatureRaw.value);
  const expectedChecksums = checksumText(manifest.files);
  if (checksumBytes.toString("utf8") !== expectedChecksums) {
    throw new Error("Linux release checksum inventory mismatch");
  }
  const key = selectTrustedKey(keyring, signature, manifest);
  verifyMetadataSignatures(
    key,
    signature,
    manifestRaw.bytes,
    checksumBytes,
  );

  const now = input.now ?? Date.now();
  if (
    Date.parse(manifest.release.createdAt) > now + LINUX_RELEASE_CLOCK_SKEW_MS ||
    Date.parse(signature.signedAt) > now + LINUX_RELEASE_CLOCK_SKEW_MS ||
    Date.parse(signature.signedAt) <
      Date.parse(manifest.release.createdAt) - LINUX_RELEASE_CLOCK_SKEW_MS ||
    Date.parse(signature.signedAt) > Date.parse(manifest.release.expiresAt) ||
    Date.parse(manifest.release.expiresAt) < now
  ) {
    throw new Error("Linux release metadata is not currently valid");
  }

  await requireExactDirectoryInventory(
    directory,
    manifest.files.map((entry) => entry.file),
    "signed",
  );
  await validatePayloads(directory, manifest);
  validateCompatibility(manifest, input);

  return {
    schema: "vellum/linux-release-verification-receipt/v1",
    ok: true,
    version: manifest.release.version,
    sourceRevision: manifest.source.revision,
    target: LINUX_RELEASE_TARGET,
    keyId: key.keyId,
    keyringRevision: keyring.revision,
    signedAt: signature.signedAt,
    expiresAt: manifest.release.expiresAt,
    filesVerified: manifest.files.length,
    packageSha256: manifest.package.sha256,
  };
};

export const createLinuxReleaseManifest = async (input: {
  readonly bundleDirectory: string;
  readonly version: string;
  readonly sourceRevision: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly downloadLocator: string;
  readonly minimumPeerVersion: string;
  readonly keyId: string;
  readonly downgradePolicy: "forbid" | "explicit-rollback";
  readonly minimumDowngradeVersion: string;
}): Promise<LinuxReleaseManifest> => {
  const directory = path.resolve(input.bundleDirectory);
  const version = requireSemver(input.version, "release version");
  const sourceRevision = requireSourceRevision(input.sourceRevision);
  const createdAt = requireIsoTimestamp(input.createdAt, "release creation time");
  const expiresAt = requireIsoTimestamp(input.expiresAt, "release expiry time");
  if (
    Date.parse(expiresAt) <= Date.parse(createdAt) ||
    Date.parse(expiresAt) - Date.parse(createdAt) >
      LINUX_RELEASE_MAX_VALIDITY_MS
  ) {
    throw new Error("Linux release validity window is outside policy");
  }
  const keyId = requireKeyId(input.keyId);
  const keyring = await readKeyring(directory);
  const key = keyring.keys.find((candidate) => candidate.keyId === keyId);
  if (key === undefined || key.status !== "active") {
    throw new Error("manifest creation requires an active release key");
  }
  const packageName = `Vellum Command-${version}-x64-linux.deb`;
  const expected = [
    { kind: "package" as const, file: packageName },
    ...REQUIRED_FIXED_FILES.map(([kind, file]) => ({ kind, file })),
  ];
  await requireExactDirectoryInventory(
    directory,
    expected.map((entry) => entry.file),
    "unsigned",
  );

  const files = await Promise.all(expected.map(async (entry) => {
    const maximum =
      entry.kind === "package"
        ? MAX_PACKAGE_BYTES
        : entry.kind === "offline-verifier"
          ? MAX_VERIFIER_BYTES
          : MAX_TEXT_EVIDENCE_BYTES;
    const admitted = await requireRegularFile(directory, entry.file, maximum);
    return {
      kind: entry.kind,
      file: entry.file,
      bytes: admitted.bytes,
      sha256: await sha256File(admitted.file),
    };
  }));
  files.sort((left, right) => left.file.localeCompare(right.file));
  const packageReceipt = files.find((entry) => entry.kind === "package");
  if (packageReceipt === undefined) {
    throw new Error("Linux release bundle is missing its deb");
  }
  const minimumPeerVersion = requireSemver(
    input.minimumPeerVersion,
    "minimum peer version",
  );
  const minimumDowngradeVersion = requireSemver(
    input.minimumDowngradeVersion,
    "minimum downgrade version",
  );
  const manifest: LinuxReleaseManifest = {
    schema: "vellum/linux-release-manifest/v1",
    release: {
      product: "Vellum Command",
      version,
      channel: "stable",
      createdAt,
      expiresAt,
      downloadLocator: requireDownloadLocator(input.downloadLocator, version),
    },
    source: {
      revision: sourceRevision,
      revisionFile: "source-revision.json",
    },
    target: LINUX_RELEASE_TARGET,
    package: {
      name: "vellum",
      kind: "deb",
      file: packageReceipt.file,
      bytes: packageReceipt.bytes,
      sha256: packageReceipt.sha256,
    },
    protocols: {
      stationBrowser: LINUX_RELEASE_PROTOCOLS.stationBrowser,
      workControl: LINUX_RELEASE_PROTOCOLS.workControl,
      minimumPeerVersion,
    },
    downgrade: {
      policy: input.downgradePolicy,
      minimumVersion: minimumDowngradeVersion,
    },
    trust: {
      algorithm: "ed25519",
      keyId,
      minimumKeyringRevision: keyring.revision,
    },
    files,
    unsupported: LINUX_RELEASE_UNSUPPORTED,
  };
  decodeLinuxReleaseManifest(manifest);
  await validatePayloads(directory, manifest);
  await Promise.all([
    writeFile(
      path.join(directory, LINUX_RELEASE_MANIFEST),
      canonicalJson(manifest),
      { encoding: "utf8", flag: "wx", mode: 0o644 },
    ),
    writeFile(
      path.join(directory, LINUX_RELEASE_CHECKSUMS),
      checksumText(files),
      { encoding: "utf8", flag: "wx", mode: 0o644 },
    ),
  ]);
  return manifest;
};

export const signLinuxReleaseMetadata = async (input: {
  readonly bundleDirectory: string;
  readonly keyId: string;
  readonly privateKeyPem: string;
  readonly signedAt: string;
}): Promise<LinuxReleaseSignature> => {
  const directory = path.resolve(input.bundleDirectory);
  const [manifestRaw, checksumFile, keyring] = await Promise.all([
    readCanonicalFile<unknown>(
      directory,
      LINUX_RELEASE_MANIFEST,
      "Linux release manifest",
    ),
    requireRegularFile(
      directory,
      LINUX_RELEASE_CHECKSUMS,
      MAX_METADATA_BYTES,
    ),
    readKeyring(directory),
  ]);
  const checksumBytes = await readFile(checksumFile.file);
  const manifest = decodeLinuxReleaseManifest(manifestRaw.value);
  const keyId = requireKeyId(input.keyId);
  const signedAt = requireIsoTimestamp(input.signedAt, "release signing time");
  if (
    keyId !== manifest.trust.keyId ||
    checksumBytes.toString("utf8") !== checksumText(manifest.files) ||
    Date.parse(signedAt) <
      Date.parse(manifest.release.createdAt) - LINUX_RELEASE_CLOCK_SKEW_MS ||
    Date.parse(signedAt) > Date.parse(manifest.release.expiresAt)
  ) {
    throw new Error("release metadata is outside its signing policy");
  }
  const key = keyring.keys.find((candidate) => candidate.keyId === keyId);
  if (
    key === undefined ||
    key.status !== "active" ||
    Date.parse(signedAt) < Date.parse(key.validFrom) ||
    (key.signingEndsAt !== undefined &&
      Date.parse(signedAt) > Date.parse(key.signingEndsAt))
  ) {
    throw new Error("release key is not authorized to sign this metadata");
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(input.privateKeyPem);
  } catch {
    throw new Error("invalid release private key");
  }
  if (
    privateKey.type !== "private" ||
    privateKey.asymmetricKeyType !== "ed25519" ||
    publicKeyFingerprint(createPublicKey(privateKey)) !==
      key.fingerprintSha256
  ) {
    throw new Error("release private key does not match the pinned keyring");
  }
  const signature: LinuxReleaseSignature = {
    schema: "vellum/linux-release-signatures/v1",
    algorithm: "ed25519",
    keyId,
    signedAt,
    manifest: {
      file: LINUX_RELEASE_MANIFEST,
      sha256: sha256Bytes(manifestRaw.bytes),
      signature: sign(null, manifestRaw.bytes, privateKey).toString("base64url"),
    },
    checksums: {
      file: LINUX_RELEASE_CHECKSUMS,
      sha256: sha256Bytes(checksumBytes),
      signature: sign(null, checksumBytes, privateKey).toString("base64url"),
    },
  };
  decodeLinuxReleaseSignature(signature);
  await writeFile(
    path.join(directory, LINUX_RELEASE_SIGNATURE),
    canonicalJson(signature),
    { encoding: "utf8", flag: "wx", mode: 0o644 },
  );
  return signature;
};

export const writeEmptyLinuxReleaseKeyring = async (
  target: string,
): Promise<void> => {
  const keyring: LinuxReleaseKeyring = {
    schema: "vellum/linux-release-keyring/v1",
    revision: 1,
    keys: [],
  };
  decodeLinuxReleaseKeyring(keyring, { allowEmpty: true });
  await mkdir(path.dirname(path.resolve(target)), {
    recursive: true,
    mode: 0o755,
  });
  await writeFile(path.resolve(target), canonicalJson(keyring), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o644,
  });
};

export const releasePublicKeyFingerprint = (publicKeyPem: string): string =>
  publicKeyFingerprint(createPublicKey(publicKeyPem));

export const linuxReleasePayloadFileNames = (
  version: string,
): ReadonlyArray<string> => [
  `Vellum Command-${requireSemver(version, "release version")}-x64-linux.deb`,
  ...REQUIRED_FIXED_FILES.map(([, file]) => file),
];

export const linuxReleaseMetadataFileNames = (): ReadonlyArray<string> => [
  ...METADATA_FILES,
];
