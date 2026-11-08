// FROZEN CONTRACT: src/shared/linux-desktop-release.ts
// Version: 1.0.0
// Last Updated: 2026-09-16
// Canonical End State: One signed alpha desktop descriptor, independent of Fleet.
// Change Process: Coordinate publisher and desktop updater changes together.
/**
 * Consumers: release tooling, release publisher, and the Linux desktop updater.
 * Paths are derived from the version, never supplied URLs. Signatures bind every
 * descriptor field. Decoding validates structure; cryptographic admission lives
 * in linux-desktop-release-crypto.ts and must precede installation.
 * Immutable releases do not expire. A stale feed can withhold a newer release;
 * signatures and strictly newer admission prevent substitution and downgrade.
 */
export const LINUX_DESKTOP_RELEASE_SCHEMA =
  "junto/linux-desktop-release/v1";
export const LINUX_DESKTOP_UPDATE_FEED_PATH = "/linux/x64/alpha.json";
export const LINUX_DESKTOP_MAX_ARCHIVE_BYTES = 300_000_000;
export const LINUX_DESKTOP_MAX_EXPANDED_BYTES = 4_000_000_000;
export const LINUX_DESKTOP_INSTALL_RESERVE_BYTES = 1_073_741_824;
export const LINUX_DESKTOP_MAX_METADATA_BYTES = 65_536;
export const LINUX_DESKTOP_CLOCK_SKEW_MS = 5 * 60 * 1_000;
export const LINUX_DESKTOP_SIGNATURE_DOMAIN =
  "Junto Linux desktop alpha release v1\n";

export const LINUX_DESKTOP_TARGET = Object.freeze(
  {
    os: "linux",
    arch: "x64",
    distribution: "ubuntu",
    distributionVersion: "24.04",
    libc: "glibc",
    libcVersion: "2.39",
  } as const,
);

export interface LinuxDesktopReleaseDescriptor {
  readonly schema: typeof LINUX_DESKTOP_RELEASE_SCHEMA;
  readonly product: "Junto";
  readonly channel: "alpha";
  readonly version: string;
  readonly sourceRevision: string;
  readonly createdAt: string;
  readonly target: typeof LINUX_DESKTOP_TARGET;
  readonly archive: {
    readonly file: string;
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
  };
  readonly trust: {
    readonly algorithm: "ed25519";
    readonly keyId: string;
    readonly keyringRevision: number;
  };
}

export interface LinuxDesktopSignedRelease {
  readonly descriptor: LinuxDesktopReleaseDescriptor;
  readonly signature: string;
}

const record = (
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`invalid ${label}`);
  }
  if (
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    throw new Error(`invalid ${label} object`);
  }
  if (
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error(`unexpected ${label} fields`);
  }
  return value as Record<string, unknown>;
};

const versionParts = (version: unknown): readonly number[] => {
  if (
    typeof version !== "string" ||
    !/^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/.test(
      version,
    )
  ) {
    throw new Error("invalid Linux desktop version; expected X.Y.Z");
  }
  return version.split(".").map(Number);
};

export const compareLinuxDesktopVersions = (
  left: string,
  right: string,
): -1 | 0 | 1 => {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index++) {
    if (a[index]! < b[index]!) return -1;
    if (a[index]! > b[index]!) return 1;
  }
  return 0;
};

export const linuxDesktopArchiveName = (version: string): string => {
  versionParts(version);
  return `junto-runtime-${version}-linux-x64.tar.gz`;
};
export const linuxDesktopReleasePath = (version: string): string => {
  versionParts(version);
  return `/linux/x64/${version}/release.json`;
};

const sha256 = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`invalid ${label} SHA256`);
  }
  return value;
};
const bytes = (value: unknown, maximum: number, label: string): number => {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 ||
    value > maximum
  ) {
    throw new Error(`invalid ${label} bytes`);
  }
  return value;
};
const iso = (value: unknown, label: string): string => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`invalid ${label} timestamp`);
  }
  return value;
};

export const decodeLinuxDesktopReleaseDescriptor = (
  value: unknown,
): LinuxDesktopReleaseDescriptor => {
  const descriptor = record(value, [
    "schema",
    "product",
    "channel",
    "version",
    "sourceRevision",
    "createdAt",
    "target",
    "archive",
    "trust",
  ], "Linux desktop descriptor");
  if (
    descriptor.schema !== LINUX_DESKTOP_RELEASE_SCHEMA ||
    descriptor.product !== "Junto" || descriptor.channel !== "alpha"
  ) {
    throw new Error("unsupported Linux desktop release identity");
  }
  versionParts(descriptor.version);
  const version = descriptor.version as string;
  if (
    typeof descriptor.sourceRevision !== "string" ||
    !/^[a-f0-9]{40}$/.test(descriptor.sourceRevision)
  ) {
    throw new Error("invalid Linux desktop source revision");
  }
  const createdAt = iso(descriptor.createdAt, "release creation");
  const target = record(
    descriptor.target,
    Object.keys(LINUX_DESKTOP_TARGET),
    "Linux desktop target",
  );
  for (const [key, expected] of Object.entries(LINUX_DESKTOP_TARGET)) {
    if (target[key] !== expected) {
      throw new Error("unsupported Linux desktop target");
    }
  }
  const archive = record(descriptor.archive, [
    "file",
    "path",
    "bytes",
    "sha256",
  ], "Linux desktop archive");
  const file = linuxDesktopArchiveName(version);
  if (archive.file !== file || archive.path !== `/linux/x64/${file}`) {
    throw new Error("Linux desktop archive path does not match version");
  }
  const trust = record(descriptor.trust, [
    "algorithm",
    "keyId",
    "keyringRevision",
  ], "Linux desktop trust");
  if (
    trust.algorithm !== "ed25519" || typeof trust.keyId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(trust.keyId)
  ) {
    throw new Error("invalid Linux desktop signing key");
  }
  return Object.freeze({
    schema: LINUX_DESKTOP_RELEASE_SCHEMA,
    product: "Junto",
    channel: "alpha",
    version,
    sourceRevision: descriptor.sourceRevision,
    createdAt,
    target: LINUX_DESKTOP_TARGET,
    archive: Object.freeze({
      file,
      path: archive.path,
      bytes: bytes(archive.bytes, LINUX_DESKTOP_MAX_ARCHIVE_BYTES, "archive"),
      sha256: sha256(archive.sha256, "archive"),
    }),
    trust: Object.freeze({
      algorithm: "ed25519",
      keyId: trust.keyId,
      keyringRevision: bytes(
        trust.keyringRevision,
        Number.MAX_SAFE_INTEGER,
        "keyring revision",
      ),
    }),
  });
};

/** Stable field order and a final newline are part of the signed wire contract. */
export const canonicalLinuxDesktopReleaseDescriptor = (
  descriptor: LinuxDesktopReleaseDescriptor,
): string =>
  `${
    JSON.stringify(decodeLinuxDesktopReleaseDescriptor(descriptor), null, 2)
  }\n`;

export const decodeLinuxDesktopSignedRelease = (
  value: unknown,
): LinuxDesktopSignedRelease => {
  const envelope = record(
    value,
    ["descriptor", "signature"],
    "Linux desktop signed release",
  );
  if (
    typeof envelope.signature !== "string" ||
    !/^[A-Za-z0-9_-]{85}[AQgw]$/.test(envelope.signature)
  ) {
    throw new Error("invalid canonical Ed25519 signature");
  }
  const descriptor = decodeLinuxDesktopReleaseDescriptor(envelope.descriptor);
  const result = Object.freeze({ descriptor, signature: envelope.signature });
  if (
    new TextEncoder().encode(JSON.stringify(result)).byteLength >
      LINUX_DESKTOP_MAX_METADATA_BYTES
  ) {
    throw new Error("Linux desktop release metadata is too large");
  }
  return result;
};
