import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import productMetadata from "../../../../package.json";
import {
  LINUX_RELEASE_MANIFEST,
  LINUX_RELEASE_PROTOCOLS,
  LINUX_RELEASE_TARGET,
  decodeLinuxReleaseManifest,
  verifyLinuxReleaseBundle,
  type LinuxReleaseKeyring,
  type LinuxReleaseVerificationReceipt,
} from "../../../../scripts/linux-release-bundle";

const MAX_RELEASE_MANIFEST_BYTES = 512 * 1024;

export interface ProductionLinuxDeployBundleInput {
  readonly bundleDirectory: string;
  /**
   * This trust source must ship independently of bundleDirectory. A keyring
   * copied out of the candidate bundle is not a trust anchor.
   */
  readonly trustedKeyring: LinuxReleaseKeyring;
  readonly trustedKeyId: string;
  readonly trustedKeyFingerprintSha256: string;
  readonly now?: number;
}

export interface ProductionLinuxDeployBundleAdmission {
  readonly packagePath: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly version: string;
  readonly receipt: LinuxReleaseVerificationReceipt;
}

const readCandidateManifestIdentity = async (
  bundleDirectory: string,
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
    const manifest = decodeLinuxReleaseManifest(decoded);
    return {
      packageName: manifest.package.name,
      version: manifest.release.version,
      architecture: manifest.target.debArchitecture,
    };
  } finally {
    await handle.close();
  }
};

/**
 * Admits one signed public Linux bundle for the production Remote deployer.
 *
 * The candidate supplies no trusted version, hash, or package path. The small
 * pre-read only derives the deb identity needed by the general verifier; all
 * returned authority comes from the subsequently verified signed manifest.
 * Remote deployment must still inspect the deb with dpkg-deb before mutation.
 */
export const verifyProductionLinuxDeployBundle = async (
  input: ProductionLinuxDeployBundleInput,
): Promise<ProductionLinuxDeployBundleAdmission> => {
  const bundleDirectory = path.resolve(input.bundleDirectory);
  const packageIdentity = await readCandidateManifestIdentity(bundleDirectory);
  const receipt = await verifyLinuxReleaseBundle({
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
    peerVersion: productMetadata.version,
    stationBrowserProtocol: LINUX_RELEASE_PROTOCOLS.stationBrowser,
    workControlProtocol: LINUX_RELEASE_PROTOCOLS.workControl,
    trustedKeyring: input.trustedKeyring,
    trustedKeyId: input.trustedKeyId,
    trustedKeyFingerprintSha256: input.trustedKeyFingerprintSha256,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  const packagePath = path.join(bundleDirectory, receipt.packageFile);
  const metadata = await lstat(packagePath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size !== receipt.packageBytes
  ) {
    throw new Error("signed Linux deploy package changed after verification");
  }
  return Object.freeze({
    packagePath,
    bytes: receipt.packageBytes,
    sha256: receipt.packageSha256,
    version: receipt.version,
    receipt,
  });
};
