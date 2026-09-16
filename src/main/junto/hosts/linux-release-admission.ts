import { createHash } from "node:crypto";
import { constants as fsConstants, type ReadStream } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import embeddedReleaseKeyring from "../../../../build/linux/release-keyring.json";
import embeddedReleaseTrustPolicy from "../../../../build/linux/release-trust-policy.json";
import { CURRENT_STATION_PROTOCOL_SUPPORT } from "../../../shared/station-protocol";
import {
  LINUX_RELEASE_MANIFEST,
  LINUX_RELEASE_TARGET,
  decodeLinuxReleaseKeyring,
  decodeLinuxReleaseManifest,
  decodeLinuxQualificationCandidateManifest,
  compareReleaseVersions,
  releaseKeyringSha256,
  verifyLinuxQualificationCandidateBundle,
  verifyLinuxReleaseBundle,
  type LinuxQualificationCandidateVerificationReceipt,
  type LinuxReleaseKeyring,
  type LinuxReleaseVerificationReceipt,
} from "../../../../scripts/linux-release-bundle";

const MAX_RELEASE_MANIFEST_BYTES = 512 * 1024;
const KEY_ID = /^[a-z0-9][a-z0-9._-]{7,63}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const LIBC_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const productionCandidateBrand: unique symbol = Symbol(
  "ProductionLinuxDeployBundleCandidate",
);
const productionAdmissionBrand: unique symbol = Symbol(
  "ProductionLinuxDeployBundleAdmission",
);

export interface ProductionLinuxDeployBundleInput {
  readonly bundleDirectory: string;
  readonly now?: number;
}

export interface ProductionLinuxDeployBundleCandidate {
  readonly [productionCandidateBrand]: true;
  readonly bytes: number;
  readonly sha256: string;
  readonly version: string;
  readonly receipt: LinuxDeployVerificationReceipt;
}

export interface ProductionLinuxDeployBundleAdmission {
  readonly [productionAdmissionBrand]: true;
  readonly bytes: number;
  readonly sha256: string;
  readonly version: string;
  readonly remoteDebInspection: "required-before-mutation";
  readonly receipt: LinuxDeployVerificationReceipt;
}

export interface ProductionLinuxDeployAuthorizationInput {
  readonly installedVersion?: string;
  readonly remoteTarget: {
    readonly distribution: "ubuntu";
    readonly distributionVersion: "24.04";
    readonly architecture: "x86_64";
    readonly libcFamily: "glibc";
    readonly libcVersion: string;
  };
}

export interface OpenVerifiedProductionLinuxDeployPackage {
  readonly handle: FileHandle;
  readonly stream: ReadStream;
}

export interface OpenVerifiedProductionLinuxDeployBundleEntry {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
  /**
   * Consume this stream before requesting the next entry from the iterator.
   * The iterator owns and closes the underlying descriptor.
   */
  readonly stream: ReadStream;
}

interface EmbeddedProductionLinuxReleaseTrust {
  readonly keyring: LinuxReleaseKeyring;
  readonly trustedKeyringRevision: number;
  readonly trustedKeyringSha256: string;
  readonly trustedKeyId: string;
  readonly trustedKeyFingerprintSha256: string;
}

type LinuxDeployVerificationReceipt =
  | LinuxReleaseVerificationReceipt
  | LinuxQualificationCandidateVerificationReceipt;

interface ProductionLinuxDeployBundleState {
  readonly bundleDirectory: string;
  readonly bundleFiles: LinuxDeployVerificationReceipt["bundleFiles"];
  readonly packageFile: string;
}

const candidateBundleStates = new WeakMap<
  ProductionLinuxDeployBundleCandidate,
  ProductionLinuxDeployBundleState
>();
const admittedBundleStates = new WeakMap<
  ProductionLinuxDeployBundleAdmission,
  ProductionLinuxDeployBundleState
>();

const compareDottedVersion = (left: string, right: string): number => {
  const leftMatch = LIBC_VERSION.exec(left);
  const rightMatch = LIBC_VERSION.exec(right);
  if (leftMatch === null || rightMatch === null) {
    throw new Error("Linux deploy Remote glibc version is malformed");
  }
  for (let index = 1; index <= 2; index += 1) {
    const difference = Number(leftMatch[index]) - Number(rightMatch[index]);
    if (difference !== 0) return difference;
  }
  return 0;
};

const embeddedProductionLinuxReleaseTrust =
  (): EmbeddedProductionLinuxReleaseTrust => {
    const policy = embeddedReleaseTrustPolicy as {
      readonly schema?: unknown;
      readonly state?: unknown;
      readonly trustedKeyringRevision?: unknown;
      readonly trustedKeyringSha256?: unknown;
      readonly trustedKeyId?: unknown;
      readonly trustedKeyFingerprintSha256?: unknown;
    };
    if (
      policy.schema !== "junto/linux-release-trust-policy/v1" ||
      Object.keys(policy).sort().join("\0") !==
        [
          "schema",
          "state",
          "trustedKeyringRevision",
          "trustedKeyringSha256",
          "trustedKeyFingerprintSha256",
          "trustedKeyId",
        ].sort().join("\0")
    ) {
      throw new Error("embedded Linux release trust policy is malformed");
    }
    if (policy.state === "unconfigured") {
      if (
        policy.trustedKeyringRevision !== null ||
        policy.trustedKeyringSha256 !== null ||
        policy.trustedKeyId !== null ||
        policy.trustedKeyFingerprintSha256 !== null
      ) {
        throw new Error("unconfigured Linux release trust has unexpected pins");
      }
      throw new Error(
        "production Linux release trust is not configured by release authority",
      );
    }
    if (
      policy.state !== "configured" ||
      typeof policy.trustedKeyringRevision !== "number" ||
      !Number.isSafeInteger(policy.trustedKeyringRevision) ||
      policy.trustedKeyringRevision < 1 ||
      typeof policy.trustedKeyringSha256 !== "string" ||
      !SHA256.test(policy.trustedKeyringSha256) ||
      typeof policy.trustedKeyId !== "string" ||
      !KEY_ID.test(policy.trustedKeyId) ||
      typeof policy.trustedKeyFingerprintSha256 !== "string" ||
      !SHA256.test(policy.trustedKeyFingerprintSha256)
    ) {
      throw new Error("embedded Linux release trust pins are malformed");
    }
    const keyring = decodeLinuxReleaseKeyring(
      embeddedReleaseKeyring as unknown,
    );
    const trustedKey = keyring.keys.find((key) =>
      key.keyId === policy.trustedKeyId
    );
    if (
      trustedKey === undefined ||
      trustedKey.fingerprintSha256 !==
        policy.trustedKeyFingerprintSha256 ||
      keyring.revision !== policy.trustedKeyringRevision ||
      releaseKeyringSha256(keyring) !== policy.trustedKeyringSha256
    ) {
      throw new Error("embedded Linux release trust pins do not match keyring");
    }
    return Object.freeze({
      keyring,
      trustedKeyringRevision: policy.trustedKeyringRevision,
      trustedKeyringSha256: policy.trustedKeyringSha256,
      trustedKeyId: policy.trustedKeyId,
      trustedKeyFingerprintSha256:
        policy.trustedKeyFingerprintSha256,
    });
  };

const readCandidateManifestIdentity = async (
  bundleDirectory: string,
  purpose: "stable-release" | "qualification-candidate",
): Promise<{
  readonly packageName: string;
  readonly version: string;
  readonly architecture: string;
}> => {
  const manifestPath = path.join(bundleDirectory, LINUX_RELEASE_MANIFEST);
  const handle = await open(
    manifestPath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size <= 0 ||
      metadata.size > MAX_RELEASE_MANIFEST_BYTES
    ) {
      throw new Error("Linux deploy release manifest is not a bounded file");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(await handle.readFile({ encoding: "utf8" }));
    } catch {
      throw new Error("Linux deploy release manifest is not valid JSON");
    }
    const manifest = purpose === "qualification-candidate"
      ? decodeLinuxQualificationCandidateManifest(decoded)
      : decodeLinuxReleaseManifest(decoded);
    return {
      packageName: manifest.package.name,
      version: manifest.release.version,
      architecture: manifest.target.architecture,
    };
  } finally {
    await handle.close();
  }
};

/**
 * Admits one signed public Linux bundle for the production Remote deployer.
 *
 * Trust is compiled into the independently installed application and cannot
 * be supplied by the mutable release candidate. The candidate supplies no
 * trusted version, hash, or package path. The small pre-read only derives the
 * package identity needed by the general verifier; all returned authority comes
 * from the subsequently verified signed manifest.
 *
 * The opaque result must be opened through
 * openVerifiedProductionLinuxDeployPackage. Remote deployment then enforces the
 * transmitted size/SHA-256 against the owner-home userland runtime archive.
 */
const verifyLinuxDeployBundle = async (
  input: ProductionLinuxDeployBundleInput,
  purpose: "stable-release" | "qualification-candidate",
): Promise<ProductionLinuxDeployBundleCandidate> => {
  const requestedBundleDirectory = path.resolve(input.bundleDirectory);
  const requestedMetadata = await lstat(requestedBundleDirectory);
  if (
    !requestedMetadata.isDirectory() ||
    requestedMetadata.isSymbolicLink()
  ) {
    throw new Error("Linux deploy release bundle is not a regular directory");
  }
  const bundleDirectory = await realpath(requestedBundleDirectory);
  const canonicalMetadata = await lstat(bundleDirectory);
  if (
    !canonicalMetadata.isDirectory() ||
    canonicalMetadata.isSymbolicLink()
  ) {
    throw new Error("Linux deploy release bundle is not a regular directory");
  }
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("Linux deploy verification time is invalid");
  }
  const trust = embeddedProductionLinuxReleaseTrust();
  const packageIdentity = await readCandidateManifestIdentity(
    bundleDirectory,
    purpose,
  );
  const verificationInput = {
    bundleDirectory,
    host: {
      platform: LINUX_RELEASE_TARGET.os,
      architecture: LINUX_RELEASE_TARGET.architecture,
      machine: LINUX_RELEASE_TARGET.machine,
      distribution: LINUX_RELEASE_TARGET.distribution,
      distributionVersion: LINUX_RELEASE_TARGET.distributionVersion,
      libcFamily: LINUX_RELEASE_TARGET.libc.family,
      libcVersion: LINUX_RELEASE_TARGET.libc.minimumVersion,
    },
    packageIdentity,
    peerStationProtocol: CURRENT_STATION_PROTOCOL_SUPPORT,
    trustedKeyring: trust.keyring,
    trustedKeyringRevision: trust.trustedKeyringRevision,
    trustedKeyringSha256: trust.trustedKeyringSha256,
    trustedKeyId: trust.trustedKeyId,
    trustedKeyFingerprintSha256:
      trust.trustedKeyFingerprintSha256,
    now,
  };
  const receipt = purpose === "qualification-candidate"
    ? await verifyLinuxQualificationCandidateBundle(verificationInput)
    : await verifyLinuxReleaseBundle(verificationInput);
  const candidate: ProductionLinuxDeployBundleCandidate = Object.freeze({
    [productionCandidateBrand]: true as const,
    bytes: receipt.packageBytes,
    sha256: receipt.packageSha256,
    version: receipt.version,
    receipt,
  });
  candidateBundleStates.set(candidate, Object.freeze({
    bundleDirectory,
    bundleFiles: Object.freeze(
      receipt.bundleFiles.map((entry) => Object.freeze({ ...entry })),
    ),
    packageFile: receipt.packageFile,
  }));
  return candidate;
};

export const verifyProductionLinuxDeployBundle = (
  input: ProductionLinuxDeployBundleInput,
): Promise<ProductionLinuxDeployBundleCandidate> =>
  verifyLinuxDeployBundle(input, "stable-release");

export const verifyQualificationLinuxDeployBundle = (
  input: ProductionLinuxDeployBundleInput,
): Promise<ProductionLinuxDeployBundleCandidate> =>
  verifyLinuxDeployBundle(input, "qualification-candidate");

/**
 * Converts a signed candidate into transfer authority only after the caller
 * supplies its read-only Remote preflight. Automatic deployment never carries
 * explicit rollback authority: an older candidate is always rejected.
 */
export const authorizeProductionLinuxDeployBundle = (
  candidate: ProductionLinuxDeployBundleCandidate,
  input: ProductionLinuxDeployAuthorizationInput,
): ProductionLinuxDeployBundleAdmission => {
  const bundleState = candidateBundleStates.get(candidate);
  if (bundleState === undefined) {
    throw new Error("Linux deploy candidate was not minted here");
  }
  if (
    input.remoteTarget.distribution !== "ubuntu" ||
    input.remoteTarget.distributionVersion !== "24.04" ||
    input.remoteTarget.architecture !== "x86_64" ||
    input.remoteTarget.libcFamily !== "glibc" ||
    !LIBC_VERSION.test(input.remoteTarget.libcVersion) ||
    compareDottedVersion(input.remoteTarget.libcVersion, "2.39") < 0
  ) {
    throw new Error("Linux deploy Remote preflight target is unsupported");
  }
  if (
    input.installedVersion !== undefined &&
    (!SEMVER.test(input.installedVersion) ||
      compareReleaseVersions(candidate.version, input.installedVersion) < 0)
  ) {
    throw new Error(
      "Linux deployment refuses a downgrade; forward repair requires a newer signed release",
    );
  }
  const admission: ProductionLinuxDeployBundleAdmission = Object.freeze({
    [productionAdmissionBrand]: true as const,
    bytes: candidate.bytes,
    sha256: candidate.sha256,
    version: candidate.version,
    remoteDebInspection: "required-before-mutation",
    receipt: candidate.receipt,
  });
  admittedBundleStates.set(admission, bundleState);
  return admission;
};

const openVerifiedBundleEntry = async (
  state: ProductionLinuxDeployBundleState,
  expected: ProductionLinuxDeployBundleState["bundleFiles"][number],
): Promise<{
  readonly handle: FileHandle;
  readonly stream: ReadStream;
}> => {
  if (
    path.basename(expected.file) !== expected.file ||
    expected.bytes <= 0 ||
    !Number.isSafeInteger(expected.bytes) ||
    !SHA256.test(expected.sha256)
  ) {
    throw new Error("signed Linux deploy bundle inventory is malformed");
  }
  const handle = await open(
    path.join(state.bundleDirectory, expected.file),
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size !== expected.bytes) {
      throw new Error("signed Linux deploy bundle changed after verification");
    }
    const hash = createHash("sha256");
    for await (
      const chunk of handle.createReadStream({
        autoClose: false,
        start: 0,
        end: expected.bytes - 1,
      })
    ) {
      hash.update(chunk);
    }
    if (hash.digest("hex") !== expected.sha256) {
      throw new Error("signed Linux deploy bundle changed after verification");
    }
    return {
      handle,
      stream: handle.createReadStream({
        autoClose: false,
        start: 0,
        end: expected.bytes - 1,
      }),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
};

/**
 * Opens every file from the exact verified bundle inventory, in lexical order,
 * without exposing a candidate-controlled path. The consumer must fully drain
 * each stream before advancing the iterator. A privileged receiver must still
 * write into a root-only spool and independently verify the complete bundle
 * with its own embedded trust before package inspection or mutation.
 */
export const openVerifiedProductionLinuxDeployBundle = (
  admission: ProductionLinuxDeployBundleAdmission,
): AsyncIterable<OpenVerifiedProductionLinuxDeployBundleEntry> => {
  const state = admittedBundleStates.get(admission);
  if (state === undefined) {
    throw new Error("Linux deploy bundle admission was not minted here");
  }
  return {
    async *[Symbol.asyncIterator]() {
      for (const expected of state.bundleFiles) {
        const opened = await openVerifiedBundleEntry(state, expected);
        try {
          yield Object.freeze({
            name: expected.file,
            bytes: expected.bytes,
            sha256: expected.sha256,
            stream: opened.stream,
          });
        } finally {
          opened.stream.destroy();
          await opened.handle.close();
        }
      }
    },
  };
};

/**
 * Reopens the exact admitted inode without following a symlink and rehashes it
 * before exposing a stream. Callers must close the returned handle.
 */
export const openVerifiedProductionLinuxDeployPackage = async (
  admission: ProductionLinuxDeployBundleAdmission,
): Promise<OpenVerifiedProductionLinuxDeployPackage> => {
  const state = admittedBundleStates.get(admission);
  if (state === undefined) {
    throw new Error("Linux deploy package admission was not minted here");
  }
  const expected = state.bundleFiles.find(
    (entry) => entry.file === state.packageFile,
  );
  if (
    expected === undefined ||
    expected.bytes !== admission.bytes ||
    expected.sha256 !== admission.sha256
  ) {
    throw new Error("signed Linux deploy package inventory is inconsistent");
  }
  return openVerifiedBundleEntry(state, expected);
};
