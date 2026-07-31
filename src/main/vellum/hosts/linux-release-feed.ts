/**
 * Linux release feed (Cloudflare Worker / R2) → local Command Center cache.
 *
 * Deploy Remote admits an owner-controlled directory under
 * ~/.vellum/releases/linux-x64-glibc/current. That directory is a *cache*, not
 * the product source of truth. This module pulls stable channel metadata and
 * the versioned archive from the same Worker that serves Mac updates, then
 * seats the extracted signed bundle at the fixed path.
 */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmodSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { resolveVellumHome } from "@shared/vellum-home";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  LINUX_RELEASE_CHECKSUMS,
  LINUX_RELEASE_MANIFEST,
  LINUX_RELEASE_SIGNATURE,
  linuxUserlandRuntimeArchiveName,
} from "../../../../scripts/linux-release-bundle";
import {
  inspectLinuxReleaseArchive,
  type InspectedLinuxReleaseArchive,
  type LinuxReleaseArchiveExpectedFile,
} from "../../../../scripts/linux-release-archive";
import {
  verifyProductionLinuxDeployBundle,
  type ProductionLinuxDeployBundleCandidate,
} from "./linux-release-admission";

/** Same Worker host as Mac arm64 feed; Linux channel lives under /linux/. */
export const LINUX_RELEASE_FEED_BASE =
  "https://vellumreleasedistribution-rele2p3h3apcupwjim2zajqqmhyd.skastr052.workers.dev" as const;

export const linuxRemoteArtifactBundleRoot = (home = resolveVellumHome()): string =>
  join(home, ".vellum", "releases", "linux-x64-glibc", "current");

export const linuxQualificationCandidateBundleRoot = (
  home = resolveVellumHome(),
): string =>
  join(
    home,
    ".vellum",
    "releases",
    "linux-x64-glibc",
    "qualification",
    "current",
  );

export const linuxStableChannelUrl = (
  base: string = LINUX_RELEASE_FEED_BASE,
): string => `${base.replace(/\/+$/u, "")}/linux/channels/stable.json`;

export type LinuxStableChannel = {
  readonly schema: "vellum/linux-release-channel/v1";
  readonly channel: "stable";
  readonly version: string;
  readonly sourceRevision: string;
  readonly downloadLocator: string;
  readonly archiveBytes: number;
  readonly archiveSha256: string;
  readonly manifestSha256: string;
  readonly packageBytes: number;
  readonly packageSha256: string;
  readonly bundleFiles: ReadonlyArray<LinuxReleaseArchiveExpectedFile>;
  readonly publishedAt: string;
};

export type LinuxReleaseCacheSource =
  | "stable-feed"
  | "verified-cache"
  | "qualification-candidate";

const SHA256 = /^[0-9a-f]{64}$/u;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const SOURCE_REVISION = /^[0-9a-f]{40}$/u;
const SAFE_ARCHIVE_FILE =
  /^[\u0020-\u002e\u0030-\u005b\u005d-\u007e]+$/u;
const MAX_LINUX_STABLE_CHANNEL_BYTES = 256 * 1024;
const MAX_LINUX_RELEASE_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_LINUX_RELEASE_ARCHIVE_BYTES = 3 * 1024 * 1024 * 1024;
const MAX_LINUX_RELEASE_BUNDLE_BYTES = 3 * 1024 * 1024 * 1024;
const MAX_LINUX_RELEASE_BUNDLE_FILES = 64;
const LINUX_STABLE_CHANNEL_KEYS = Object.freeze([
  "schema",
  "channel",
  "version",
  "sourceRevision",
  "downloadLocator",
  "archiveBytes",
  "archiveSha256",
  "manifestSha256",
  "packageBytes",
  "packageSha256",
  "bundleFiles",
  "publishedAt",
]);
const REQUIRED_RELEASE_METADATA = Object.freeze([
  LINUX_RELEASE_CHECKSUMS,
  LINUX_RELEASE_MANIFEST,
  LINUX_RELEASE_SIGNATURE,
]);

const decodeBundleFiles = (
  value: unknown,
  version: string,
  packageBytes: number,
  packageSha256: string,
): ReadonlyArray<LinuxReleaseArchiveExpectedFile> => {
  if (
    !Array.isArray(value) ||
    value.length < 4 ||
    value.length > MAX_LINUX_RELEASE_BUNDLE_FILES
  ) {
    throw new Error("Linux stable channel bundleFiles is invalid");
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  const decoded = value.map((entry): LinuxReleaseArchiveExpectedFile => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Linux stable channel bundleFiles is invalid");
    }
    const row = entry as Record<string, unknown>;
    if (
      Object.keys(row).sort().join("\0") !==
        ["bytes", "file", "sha256"].sort().join("\0") ||
      typeof row.file !== "string" ||
      row.file === "." ||
      row.file === ".." ||
      !SAFE_ARCHIVE_FILE.test(row.file) ||
      seen.has(row.file) ||
      typeof row.bytes !== "number" ||
      !Number.isSafeInteger(row.bytes) ||
      row.bytes < 1 ||
      row.bytes > MAX_LINUX_RELEASE_PACKAGE_BYTES ||
      typeof row.sha256 !== "string" ||
      !SHA256.test(row.sha256)
    ) {
      throw new Error("Linux stable channel bundleFiles is invalid");
    }
    seen.add(row.file);
    totalBytes += row.bytes;
    if (
      !Number.isSafeInteger(totalBytes) ||
      totalBytes > MAX_LINUX_RELEASE_BUNDLE_BYTES
    ) {
      throw new Error("Linux stable channel bundleFiles is too large");
    }
    return Object.freeze({
      file: row.file,
      bytes: row.bytes,
      sha256: row.sha256,
    });
  });
  const packageFile = linuxUserlandRuntimeArchiveName(version);
  const packageEntries = decoded.filter(({ file }) => file === packageFile);
  if (
    packageEntries.length !== 1 ||
    packageEntries[0]?.bytes !== packageBytes ||
    packageEntries[0]?.sha256 !== packageSha256 ||
    REQUIRED_RELEASE_METADATA.some(
      (file) => decoded.filter((entry) => entry.file === file).length !== 1,
    )
  ) {
    throw new Error("Linux stable channel bundleFiles binding is invalid");
  }
  return Object.freeze(decoded);
};

export const decodeLinuxStableChannel = (
  value: unknown,
): LinuxStableChannel => {
  if (value === null || typeof value !== "object") {
    throw new Error("Linux stable channel is not an object");
  }
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).sort().join("\0") !==
      [...LINUX_STABLE_CHANNEL_KEYS].sort().join("\0")
  ) {
    throw new Error("Linux stable channel fields are invalid");
  }
  if (row.schema !== "vellum/linux-release-channel/v1") {
    throw new Error("Linux stable channel schema is unrecognized");
  }
  if (row.channel !== "stable") {
    throw new Error("Linux stable channel name is invalid");
  }
  if (typeof row.version !== "string" || !SEMVER.test(row.version)) {
    throw new Error("Linux stable channel version is invalid");
  }
  if (
    typeof row.sourceRevision !== "string" ||
    !SOURCE_REVISION.test(row.sourceRevision)
  ) {
    throw new Error("Linux stable channel sourceRevision is invalid");
  }
  if (
    typeof row.downloadLocator !== "string" ||
    row.downloadLocator.length > 2_048
  ) {
    throw new Error("Linux stable channel downloadLocator is invalid");
  }
  try {
    const locator = new URL(row.downloadLocator);
    if (
      locator.protocol !== "https:" ||
      locator.username !== "" ||
      locator.password !== ""
    ) {
      throw new Error("invalid");
    }
  } catch {
    throw new Error("Linux stable channel downloadLocator is invalid");
  }
  if (
    typeof row.archiveBytes !== "number" ||
    !Number.isSafeInteger(row.archiveBytes) ||
    row.archiveBytes <= 0 ||
    row.archiveBytes > MAX_LINUX_RELEASE_ARCHIVE_BYTES
  ) {
    throw new Error("Linux stable channel archiveBytes is invalid");
  }
  if (
    typeof row.archiveSha256 !== "string" ||
    !SHA256.test(row.archiveSha256)
  ) {
    throw new Error("Linux stable channel archiveSha256 is invalid");
  }
  if (
    typeof row.manifestSha256 !== "string" ||
    !SHA256.test(row.manifestSha256)
  ) {
    throw new Error("Linux stable channel manifestSha256 is invalid");
  }
  if (
    typeof row.packageBytes !== "number" ||
    !Number.isSafeInteger(row.packageBytes) ||
    row.packageBytes <= 0 ||
    row.packageBytes > MAX_LINUX_RELEASE_PACKAGE_BYTES
  ) {
    throw new Error("Linux stable channel packageBytes is invalid");
  }
  if (
    typeof row.packageSha256 !== "string" ||
    !SHA256.test(row.packageSha256)
  ) {
    throw new Error("Linux stable channel packageSha256 is invalid");
  }
  if (
    typeof row.publishedAt !== "string" ||
    !Number.isFinite(Date.parse(row.publishedAt)) ||
    new Date(Date.parse(row.publishedAt)).toISOString() !== row.publishedAt
  ) {
    throw new Error("Linux stable channel publishedAt is invalid");
  }
  const bundleFiles = decodeBundleFiles(
    row.bundleFiles,
    row.version,
    row.packageBytes,
    row.packageSha256,
  );
  return Object.freeze({
    schema: "vellum/linux-release-channel/v1",
    channel: "stable",
    version: row.version,
    sourceRevision: row.sourceRevision,
    downloadLocator: row.downloadLocator,
    archiveBytes: row.archiveBytes,
    archiveSha256: row.archiveSha256,
    manifestSha256: row.manifestSha256,
    packageBytes: row.packageBytes,
    packageSha256: row.packageSha256,
    bundleFiles,
    publishedAt: row.publishedAt,
  });
};

const parseContentLength = (
  response: Response,
  maximumBytes: number,
  label: string,
): number | undefined => {
  const value = response.headers.get("content-length");
  if (value === null) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`${label} Content-Length is malformed`);
  }
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes > maximumBytes) {
    throw new Error(`${label} exceeds its byte limit`);
  }
  return bytes;
};

const readBoundedResponse = async (
  response: Response,
  maximumBytes: number,
  label: string,
): Promise<Buffer> => {
  parseContentLength(response, maximumBytes, label);
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new Error(`${label} response body is absent`);
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      totalBytes += chunk.length;
      if (totalBytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${label} exceeds its byte limit`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
};

export const fetchLinuxStableChannel = async (
  base: string = LINUX_RELEASE_FEED_BASE,
): Promise<LinuxStableChannel> => {
  const url = linuxStableChannelUrl(base);
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(
      `Linux stable channel HTTP ${String(response.status)} from ${url}`,
    );
  }
  const body = await readBoundedResponse(
    response,
    MAX_LINUX_STABLE_CHANNEL_BYTES,
    "Linux stable channel",
  );
  try {
    const channel = decodeLinuxStableChannel(
      JSON.parse(body.toString("utf8")),
    );
    const expectedLocator =
      `${base.replace(/\/+$/u, "")}/linux/releases/${
        linuxUserlandRuntimeArchiveName(channel.version)
      }`;
    if (channel.downloadLocator !== expectedLocator) {
      throw new Error(
        "Linux stable channel downloadLocator does not match its feed",
      );
    }
    return channel;
  } catch (cause) {
    if (
      cause instanceof Error &&
      cause.message.startsWith("Linux stable channel")
    ) {
      throw cause;
    }
    throw new Error("Linux stable channel is not valid JSON", { cause });
  }
};

const streamResponseToFile = async (input: {
  readonly response: Response;
  readonly destination: string;
  readonly expectedBytes: number;
  readonly expectedSha256: string;
}): Promise<void> => {
  const contentLength = parseContentLength(
    input.response,
    MAX_LINUX_RELEASE_ARCHIVE_BYTES,
    "Linux release archive",
  );
  if (
    contentLength !== undefined &&
    contentLength !== input.expectedBytes
  ) {
    throw new Error("Linux release archive Content-Length differs");
  }
  const reader = input.response.body?.getReader();
  if (reader === undefined) {
    throw new Error("Linux release archive response body is absent");
  }
  const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  let handle: FileHandle | undefined;
  const digest = createHash("sha256");
  let totalBytes = 0;
  try {
    handle = await open(
      input.destination,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        noFollow,
      0o600,
    );
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      totalBytes += chunk.length;
      if (
        totalBytes > input.expectedBytes ||
        totalBytes > MAX_LINUX_RELEASE_ARCHIVE_BYTES
      ) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Linux release archive exceeds its declared byte count");
      }
      digest.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const write = await handle.write(
          chunk,
          offset,
          chunk.length - offset,
        );
        if (write.bytesWritten < 1) {
          throw new Error("Linux release archive write was short");
        }
        offset += write.bytesWritten;
      }
    }
    if (totalBytes !== input.expectedBytes) {
      throw new Error(
        `Linux release archive size mismatch: got ${String(totalBytes)}, expected ${String(input.expectedBytes)}`,
      );
    }
    if (digest.digest("hex") !== input.expectedSha256) {
      throw new Error("Linux release archive sha256 mismatch");
    }
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size !== totalBytes) {
      throw new Error("Linux release archive file changed while downloading");
    }
    await handle.sync();
    await handle.chmod(0o400);
  } finally {
    reader.releaseLock();
    await handle?.close().catch(() => undefined);
  }
};

const assertChannelBindsVerifiedCandidate = (
  channel: LinuxStableChannel,
  inspected: Pick<
    InspectedLinuxReleaseArchive,
    "archiveBytes" | "archiveSha256"
  >,
  candidate: ProductionLinuxDeployBundleCandidate,
): void => {
  const manifestEntries = candidate.receipt.bundleFiles.filter(
    ({ file }) => file === LINUX_RELEASE_MANIFEST,
  );
  if (
    inspected.archiveBytes !== channel.archiveBytes ||
    inspected.archiveSha256 !== channel.archiveSha256 ||
    candidate.version !== channel.version ||
    candidate.receipt.version !== channel.version ||
    candidate.receipt.sourceRevision !== channel.sourceRevision ||
    candidate.bytes !== channel.packageBytes ||
    candidate.sha256 !== channel.packageSha256 ||
    candidate.receipt.packageBytes !== channel.packageBytes ||
    candidate.receipt.packageSha256 !== channel.packageSha256 ||
    manifestEntries.length !== 1 ||
    manifestEntries[0]?.sha256 !== channel.manifestSha256 ||
    !isDeepStrictEqual(candidate.receipt.bundleFiles, channel.bundleFiles)
  ) {
    throw new Error(
      "Linux stable channel does not match the signed release bundle",
    );
  }
};

const promotionFlights = new Map<string, Promise<void>>();
const PROMOTION_LOCK_NAME = ".feed-seat.lock";

const hasErrnoCode = (cause: unknown, code: string): boolean =>
  cause instanceof Error &&
  "code" in cause &&
  (cause as NodeJS.ErrnoException).code === code;

const acquirePromotionLock = async (
  releasesRoot: string,
): Promise<() => Promise<void>> => {
  const lockPath = join(releasesRoot, PROMOTION_LOCK_NAME);
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (cause) {
    if (hasErrnoCode(cause, "EEXIST")) {
      throw new Error(
        "Linux release cache promotion is already in progress",
        { cause },
      );
    }
    throw cause;
  }
  try {
    const metadata = await lstat(lockPath);
    const currentUid = typeof process.getuid === "function"
      ? process.getuid()
      : undefined;
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o077) !== 0 ||
      (currentUid !== undefined && metadata.uid !== currentUid)
    ) {
      throw new Error("Linux release cache promotion lock is not owner-private");
    }
  } catch (cause) {
    await rmdir(lockPath).catch(() => undefined);
    throw cause;
  }
  let released = false;
  return async () => {
    if (released) return;
    await rmdir(lockPath);
    released = true;
  };
};

const removeVerifiedFlatBundle = async (
  bundleDirectory: string,
): Promise<void> => {
  await chmod(bundleDirectory, 0o700);
  const entries = await readdir(bundleDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(
        "verified Linux release cache cleanup found a non-file entry",
      );
    }
    await unlink(join(bundleDirectory, entry.name));
  }
  await rmdir(bundleDirectory);
};

const serializePromotion = async (
  target: string,
  operation: () => Promise<void>,
): Promise<void> => {
  const prior = promotionFlights.get(target) ?? Promise.resolve();
  const flight = prior.catch(() => undefined).then(operation);
  promotionFlights.set(target, flight);
  try {
    await flight;
  } finally {
    if (promotionFlights.get(target) === flight) {
      promotionFlights.delete(target);
    }
  }
};

const promoteVerifiedBundle = async (input: {
  readonly releasesRoot: string;
  readonly candidateDirectory: string;
  readonly target: string;
  readonly verifyPromoted: (target: string) => Promise<void>;
}): Promise<void> => {
  const backupRoot = await mkdtemp(join(input.releasesRoot, ".previous-"));
  const backup = join(backupRoot, "current");
  let incumbentMoved = false;
  let candidateMoved = false;
  try {
    if (existsSync(input.target)) {
      await rename(input.target, backup);
      incumbentMoved = true;
    }
    try {
      await rename(input.candidateDirectory, input.target);
      candidateMoved = true;
      await input.verifyPromoted(input.target);
    } catch (cause) {
      const rollbackFailures: Error[] = [];
      if (candidateMoved) {
        try {
          await rename(input.target, input.candidateDirectory);
          candidateMoved = false;
        } catch (rollbackCause) {
          rollbackFailures.push(
            rollbackCause instanceof Error
              ? rollbackCause
              : new Error(String(rollbackCause)),
          );
        }
      }
      if (incumbentMoved) {
        try {
          await rename(backup, input.target);
          incumbentMoved = false;
        } catch (rollbackCause) {
          rollbackFailures.push(
            rollbackCause instanceof Error
              ? rollbackCause
              : new Error(String(rollbackCause)),
          );
        }
      }
      if (rollbackFailures.length > 0) {
        throw new Error(
          `Linux release cache promotion failed and incumbent recovery requires attention at ${backup}`,
          {
            cause: new AggregateError(
              [cause, ...rollbackFailures],
              "Linux release cache promotion rollback failed",
            ),
          },
        );
      }
      throw cause;
    }
    if (incumbentMoved) {
      await removeVerifiedFlatBundle(backup).catch(() => undefined);
      incumbentMoved = false;
    }
  } finally {
    if (!incumbentMoved) {
      await rmdir(backupRoot).catch(() => undefined);
    }
  }
};

/**
 * Download the stable archive, verify size+sha256, extract into the fixed
 * owner-controlled cache directory used by Deploy Remote.
 */
export const seatLinuxReleaseCacheFromFeed = async (input?: {
  readonly home?: string;
  readonly feedBase?: string;
}): Promise<{
  readonly bundleRoot: string;
  readonly channel: LinuxStableChannel;
}> => {
  const home = input?.home ?? resolveVellumHome();
  const feedBase = input?.feedBase ?? LINUX_RELEASE_FEED_BASE;
  const channel = await fetchLinuxStableChannel(feedBase);
  const releasesRoot = join(home, ".vellum", "releases", "linux-x64-glibc");
  mkdirSync(releasesRoot, { recursive: true, mode: 0o700 });
  const releasesMetadata = await lstat(releasesRoot);
  const currentUid = typeof process.getuid === "function"
    ? process.getuid()
    : undefined;
  if (
    !releasesMetadata.isDirectory() ||
    releasesMetadata.isSymbolicLink() ||
    (currentUid !== undefined && releasesMetadata.uid !== currentUid)
  ) {
    throw new Error("Linux release cache root is not owner controlled");
  }
  chmodSync(releasesRoot, 0o700);
  const stagingRoot = await mkdtemp(
    join(releasesRoot, `.seat-${channel.version}-`),
  );
  await chmod(stagingRoot, 0o700);
  const archivePath = join(stagingRoot, "release.tar.gz");
  let inspected: InspectedLinuxReleaseArchive | undefined;
  try {
    const response = await fetch(channel.downloadLocator, {
      redirect: "error",
    });
    if (!response.ok) {
      throw new Error(
        `Linux release archive HTTP ${String(response.status)} from ${channel.downloadLocator}`,
      );
    }
    await streamResponseToFile({
      response,
      destination: archivePath,
      expectedBytes: channel.archiveBytes,
      expectedSha256: channel.archiveSha256,
    });
    inspected = await inspectLinuxReleaseArchive({
      archivePath,
      expectedFiles: channel.bundleFiles,
      temporaryParent: stagingRoot,
    });
    const verified = await verifyProductionLinuxDeployBundle({
      bundleDirectory: inspected.extractedDirectory,
    });
    assertChannelBindsVerifiedCandidate(channel, inspected, verified);

    const target = linuxRemoteArtifactBundleRoot(home);
    await chmod(dirname(inspected.extractedDirectory), 0o700);
    await chmod(inspected.extractedDirectory, 0o700);
    await serializePromotion(target, async () => {
      const releaseLock = await acquirePromotionLock(releasesRoot);
      try {
        await promoteVerifiedBundle({
          releasesRoot,
          candidateDirectory: inspected!.extractedDirectory,
          target,
          verifyPromoted: async (promotedRoot) => {
            const promoted = await verifyProductionLinuxDeployBundle({
              bundleDirectory: promotedRoot,
            });
            assertChannelBindsVerifiedCandidate(channel, inspected!, promoted);
          },
        });
      } finally {
        await releaseLock();
      }
    });
    return { bundleRoot: target, channel };
  } finally {
    await inspected?.cleanup().catch(() => undefined);
    await chmod(stagingRoot, 0o700).catch(() => undefined);
    await unlink(archivePath).catch((cause) => {
      if (!hasErrnoCode(cause, "ENOENT")) throw cause;
    });
    await rmdir(stagingRoot).catch(() => undefined);
  }
};

/**
 * Ensure the fixed local cache exists.
 *
 * Production defaults to the stable feed and fails closed when that exact
 * release cannot be fetched. Qualification may explicitly select
 * `verified-cache` for the final v5 cache or `qualification-candidate` for the
 * purpose-separated, non-publishable candidate root. Neither contacts the
 * feed, and both fail closed when their exact fixed path is absent.
 * The production artifact authority still performs owner, signature, and hash
 * verification after this source selection.
 */
export const ensureLinuxReleaseCache = async (input?: {
  readonly home?: string;
  readonly feedBase?: string;
  readonly source?: LinuxReleaseCacheSource;
}): Promise<{
  readonly bundleRoot: string;
  readonly source: "feed" | "local";
  readonly channel?: LinuxStableChannel;
}> => {
  const home = input?.home ?? resolveVellumHome();
  const bundleRoot = linuxRemoteArtifactBundleRoot(home);
  const source: unknown = input?.source ?? "stable-feed";
  if (source === "qualification-candidate") {
    const qualificationRoot = linuxQualificationCandidateBundleRoot(home);
    if (!existsSync(qualificationRoot)) {
      throw new Error(
        "Linux qualification candidate is absent from the fixed qualification path",
      );
    }
    return { bundleRoot: qualificationRoot, source: "local" };
  }
  if (source === "verified-cache") {
    if (!existsSync(bundleRoot)) {
      throw new Error(
        "verified Linux release cache is absent from the fixed cache path",
      );
    }
    return { bundleRoot, source: "local" };
  }
  if (source !== "stable-feed") {
    throw new Error("Linux release cache source is unrecognized");
  }
  const seated = await seatLinuxReleaseCacheFromFeed({
    home,
    feedBase: input?.feedBase,
  });
  return {
    bundleRoot: seated.bundleRoot,
    source: "feed",
    channel: seated.channel,
  };
};
