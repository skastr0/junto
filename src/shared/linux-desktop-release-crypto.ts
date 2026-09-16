/** Node-only verification shared by publisher tooling and Electron main. */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign,
  verify,
} from "node:crypto";
import embeddedKeyring from "../../build/linux/release-keyring.json";
import embeddedPolicy from "../../build/linux/release-trust-policy.json";
import {
  canonicalLinuxDesktopReleaseDescriptor,
  compareLinuxDesktopVersions,
  decodeLinuxDesktopReleaseDescriptor,
  decodeLinuxDesktopSignedRelease,
  LINUX_DESKTOP_CLOCK_SKEW_MS,
  LINUX_DESKTOP_SIGNATURE_DOMAIN,
  type LinuxDesktopReleaseDescriptor,
  type LinuxDesktopSignedRelease,
} from "./linux-desktop-release";

export interface LinuxDesktopReleaseKey {
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
export interface LinuxDesktopReleaseKeyring {
  readonly schema: "junto/linux-release-keyring/v1";
  readonly revision: number;
  readonly keys: readonly LinuxDesktopReleaseKey[];
}
export interface LinuxDesktopReleaseTrustPolicy {
  readonly schema: "junto/linux-release-trust-policy/v1";
  readonly state: "configured";
  readonly trustedKeyringRevision: number;
  readonly trustedKeyringSha256: string;
  readonly trustedKeyId: string;
  readonly trustedKeyFingerprintSha256: string;
}
export interface LinuxDesktopReleaseTrust {
  readonly keyring: LinuxDesktopReleaseKeyring;
  readonly policy: LinuxDesktopReleaseTrustPolicy;
}

declare const verifiedRelease: unique symbol;
export type VerifiedLinuxDesktopRelease = LinuxDesktopReleaseDescriptor & {
  readonly [verifiedRelease]: true;
};
const verifiedReleases = new WeakSet<LinuxDesktopReleaseDescriptor>();
export const assertVerifiedLinuxDesktopRelease: (
  value: unknown,
) => asserts value is VerifiedLinuxDesktopRelease = (value) => {
  if (
    typeof value !== "object" || value === null ||
    !verifiedReleases.has(value as LinuxDesktopReleaseDescriptor)
  ) {
    throw new Error(
      "Linux desktop installation requires an authenticated release descriptor",
    );
  }
};

const exact = (
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> => {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error(`invalid ${label} fields`);
  }
  return value as Record<string, unknown>;
};
const timestamp = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) throw new Error("invalid release key timestamp");
  return value;
};
const digest = (value: unknown): string => {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("invalid release trust SHA256");
  }
  return value;
};
const keyId = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
  ) throw new Error("invalid release key id");
  return value;
};
const revision = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("invalid release keyring revision");
  }
  return value;
};
const fingerprint = (key: KeyObject): string => {
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
    throw new Error("release key must be an Ed25519 public key");
  }
  return createHash("sha256").update(
    key.export({ format: "der", type: "spki" }),
  ).digest("hex");
};

const decodeKey = (input: unknown): LinuxDesktopReleaseKey => {
  if (typeof input !== "object" || input === null) {
    throw new Error("invalid release key");
  }
  const optionals = ["signingEndsAt", "revokedAt", "supersededBy"].filter((
    field,
  ) => Object.hasOwn(input, field));
  const value = exact(input, [
    "keyId",
    "algorithm",
    "publicKeyPem",
    "fingerprintSha256",
    "status",
    "validFrom",
    ...optionals,
  ], "release key");
  if (
    value.algorithm !== "ed25519" || typeof value.publicKeyPem !== "string" ||
    Buffer.byteLength(value.publicKeyPem) > 8_192
  ) throw new Error("invalid release public key");
  const fingerprintSha256 = digest(value.fingerprintSha256);
  if (fingerprint(createPublicKey(value.publicKeyPem)) !== fingerprintSha256) {
    throw new Error("release key fingerprint mismatch");
  }
  if (
    value.status !== "active" && value.status !== "retired" &&
    value.status !== "revoked"
  ) throw new Error("invalid release key status");
  const validFrom = timestamp(value.validFrom);
  const signingEndsAt = optionals.includes("signingEndsAt")
    ? timestamp(value.signingEndsAt)
    : undefined;
  const revokedAt = optionals.includes("revokedAt")
    ? timestamp(value.revokedAt)
    : undefined;
  const supersededBy = optionals.includes("supersededBy")
    ? keyId(value.supersededBy)
    : undefined;
  if (
    (value.status === "retired" && signingEndsAt === undefined) ||
    (value.status === "revoked" && revokedAt === undefined) ||
    (signingEndsAt !== undefined &&
      Date.parse(signingEndsAt) <= Date.parse(validFrom)) ||
    (revokedAt !== undefined && Date.parse(revokedAt) <= Date.parse(validFrom))
  ) throw new Error("incoherent release key lifecycle");
  return Object.freeze({
    keyId: keyId(value.keyId),
    algorithm: "ed25519",
    publicKeyPem: value.publicKeyPem,
    fingerprintSha256,
    status: value.status,
    validFrom,
    ...(signingEndsAt === undefined ? {} : { signingEndsAt }),
    ...(revokedAt === undefined ? {} : { revokedAt }),
    ...(supersededBy === undefined ? {} : { supersededBy }),
  });
};

/** The canonical keyring bytes intentionally match the existing public trust pin. */
export const decodeLinuxDesktopReleaseTrust = (
  input: unknown,
): LinuxDesktopReleaseTrust => {
  const value = exact(
    input,
    ["keyring", "policy"],
    "Linux desktop release trust",
  );
  const rawKeyring = exact(
    value.keyring,
    ["schema", "revision", "keys"],
    "release keyring",
  );
  if (
    rawKeyring.schema !== "junto/linux-release-keyring/v1" ||
    !Array.isArray(rawKeyring.keys) || rawKeyring.keys.length < 1 ||
    rawKeyring.keys.length > 128
  ) throw new Error("unsupported release keyring");
  const keys = rawKeyring.keys.map(decodeKey);
  const ids = new Set(keys.map((key) => key.keyId));
  if (
    ids.size !== keys.length ||
    keys.some((key) =>
      key.supersededBy !== undefined &&
      (!ids.has(key.supersededBy) || key.supersededBy === key.keyId)
    )
  ) throw new Error("invalid release key rotation");
  const keyring = Object.freeze({
    schema: "junto/linux-release-keyring/v1" as const,
    revision: revision(rawKeyring.revision),
    keys: Object.freeze(keys),
  });
  const rawPolicy = exact(value.policy, [
    "schema",
    "state",
    "trustedKeyringRevision",
    "trustedKeyringSha256",
    "trustedKeyId",
    "trustedKeyFingerprintSha256",
  ], "release trust policy");
  if (
    rawPolicy.schema !== "junto/linux-release-trust-policy/v1" ||
    rawPolicy.state !== "configured"
  ) throw new Error("Linux desktop release trust is not configured");
  const policy = Object.freeze({
    schema: "junto/linux-release-trust-policy/v1" as const,
    state: "configured" as const,
    trustedKeyringRevision: revision(rawPolicy.trustedKeyringRevision),
    trustedKeyringSha256: digest(rawPolicy.trustedKeyringSha256),
    trustedKeyId: keyId(rawPolicy.trustedKeyId),
    trustedKeyFingerprintSha256: digest(rawPolicy.trustedKeyFingerprintSha256),
  });
  if (
    keyring.revision !== policy.trustedKeyringRevision ||
    createHash("sha256").update(`${JSON.stringify(keyring, null, 2)}\n`).digest(
        "hex",
      ) !== policy.trustedKeyringSha256
  ) {
    throw new Error(
      "release keyring does not match independently pinned trust",
    );
  }
  const selected = keys.find((key) => key.keyId === policy.trustedKeyId);
  if (
    selected === undefined ||
    selected.fingerprintSha256 !== policy.trustedKeyFingerprintSha256
  ) throw new Error("release key does not match independently pinned trust");
  return Object.freeze({ keyring, policy });
};

export const loadEmbeddedLinuxDesktopReleaseTrust =
  (): LinuxDesktopReleaseTrust =>
    decodeLinuxDesktopReleaseTrust({
      keyring: embeddedKeyring,
      policy: embeddedPolicy,
    });

const signingMessage = (descriptor: LinuxDesktopReleaseDescriptor): Buffer =>
  Buffer.from(
    LINUX_DESKTOP_SIGNATURE_DOMAIN +
      canonicalLinuxDesktopReleaseDescriptor(descriptor),
    "utf8",
  );

export const signLinuxDesktopRelease = (
  input: LinuxDesktopReleaseDescriptor,
  privateKey: string | KeyObject,
): LinuxDesktopSignedRelease => {
  const descriptor = decodeLinuxDesktopReleaseDescriptor(input);
  const key = typeof privateKey === "string"
    ? createPrivateKey(privateKey)
    : privateKey;
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
    throw new Error("release signing requires an Ed25519 private key");
  }
  return decodeLinuxDesktopSignedRelease({
    descriptor,
    signature: sign(null, signingMessage(descriptor), key).toString(
      "base64url",
    ),
  });
};

export interface VerifyLinuxDesktopReleaseOptions {
  readonly trust?: LinuxDesktopReleaseTrust;
  readonly now?: Date | string;
  readonly currentVersion?: string;
  readonly requireNewer?: boolean;
}
export const verifyLinuxDesktopRelease = (
  input: unknown,
  options: VerifyLinuxDesktopReleaseOptions = {},
): VerifiedLinuxDesktopRelease => {
  const envelope = decodeLinuxDesktopSignedRelease(input);
  const descriptor = envelope.descriptor;
  const { keyring, policy } = options.trust === undefined
    ? loadEmbeddedLinuxDesktopReleaseTrust()
    : decodeLinuxDesktopReleaseTrust(options.trust);
  if (
    descriptor.trust.keyId !== policy.trustedKeyId ||
    descriptor.trust.keyringRevision !== keyring.revision
  ) {
    throw new Error(
      "Linux desktop descriptor does not match pinned signing trust",
    );
  }
  const key = keyring.keys.find((candidate) =>
    candidate.keyId === descriptor.trust.keyId
  )!;
  if (key.status === "revoked" || key.revokedAt !== undefined) {
    throw new Error("Linux desktop signing key is revoked");
  }
  const created = Date.parse(descriptor.createdAt);
  if (
    created < Date.parse(key.validFrom) ||
    (key.signingEndsAt !== undefined && created > Date.parse(key.signingEndsAt))
  ) {
    throw new Error(
      "Linux desktop release was signed outside the key authorization window",
    );
  }
  if (
    !verify(
      null,
      signingMessage(descriptor),
      createPublicKey(key.publicKeyPem),
      Buffer.from(envelope.signature, "base64url"),
    )
  ) throw new Error("Linux desktop release signature verification failed");
  const now = options.now instanceof Date
    ? options.now.getTime()
    : options.now === undefined
    ? Date.now()
    : Date.parse(options.now);
  if (!Number.isFinite(now)) {
    throw new Error("invalid Linux desktop verification time");
  }
  if (created > now + LINUX_DESKTOP_CLOCK_SKEW_MS) {
    throw new Error("Linux desktop release creation is in the future");
  }
  if (options.requireNewer === true && options.currentVersion === undefined) {
    throw new Error(
      "current version is required for Linux desktop update admission",
    );
  }
  if (options.currentVersion !== undefined) {
    const ordering = compareLinuxDesktopVersions(
      descriptor.version,
      options.currentVersion,
    );
    if (options.requireNewer === true && ordering <= 0) {
      throw new Error(
        "Linux desktop update must be strictly newer than the installed version",
      );
    }
  }
  verifiedReleases.add(descriptor);
  return descriptor as VerifiedLinuxDesktopRelease;
};
