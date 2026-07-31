/**
 * Linux release feed (Cloudflare Worker / R2) → local Command Center cache.
 *
 * Deploy Remote admits an owner-controlled directory under
 * ~/.vellum/releases/linux-x64-glibc/current. That directory is a *cache*, not
 * the product source of truth. This module pulls stable channel metadata and
 * the versioned archive from the same Worker that serves Mac updates, then
 * seats the extracted signed bundle at the fixed path.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolveVellumHome } from "@shared/vellum-home";
import { join } from "node:path";

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
  readonly publishedAt: string;
};

export type LinuxReleaseCacheSource =
  | "stable-feed"
  | "verified-cache"
  | "qualification-candidate";

const SHA256 = /^[0-9a-f]{64}$/u;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;

export const decodeLinuxStableChannel = (
  value: unknown,
): LinuxStableChannel => {
  if (value === null || typeof value !== "object") {
    throw new Error("Linux stable channel is not an object");
  }
  const row = value as Record<string, unknown>;
  if (row.schema !== "vellum/linux-release-channel/v1") {
    throw new Error("Linux stable channel schema is unrecognized");
  }
  if (row.channel !== "stable") {
    throw new Error("Linux stable channel name is invalid");
  }
  if (typeof row.version !== "string" || !SEMVER.test(row.version)) {
    throw new Error("Linux stable channel version is invalid");
  }
  if (typeof row.sourceRevision !== "string" || row.sourceRevision.length < 7) {
    throw new Error("Linux stable channel sourceRevision is invalid");
  }
  if (
    typeof row.downloadLocator !== "string" ||
    !/^https:\/\//u.test(row.downloadLocator)
  ) {
    throw new Error("Linux stable channel downloadLocator is invalid");
  }
  if (
    typeof row.archiveBytes !== "number" ||
    !Number.isSafeInteger(row.archiveBytes) ||
    row.archiveBytes <= 0
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
    row.packageBytes <= 0
  ) {
    throw new Error("Linux stable channel packageBytes is invalid");
  }
  if (
    typeof row.packageSha256 !== "string" ||
    !SHA256.test(row.packageSha256)
  ) {
    throw new Error("Linux stable channel packageSha256 is invalid");
  }
  if (typeof row.publishedAt !== "string" || row.publishedAt.length < 10) {
    throw new Error("Linux stable channel publishedAt is invalid");
  }
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
    publishedAt: row.publishedAt,
  });
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
  return decodeLinuxStableChannel(await response.json());
};

const sha256Buffer = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

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
  const response = await fetch(channel.downloadLocator, {
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(
      `Linux release archive HTTP ${String(response.status)} from ${channel.downloadLocator}`,
    );
  }
  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.byteLength !== channel.archiveBytes) {
    throw new Error(
      `Linux release archive size mismatch: got ${String(archive.byteLength)}, expected ${String(channel.archiveBytes)}`,
    );
  }
  if (sha256Buffer(archive) !== channel.archiveSha256) {
    throw new Error("Linux release archive sha256 mismatch");
  }

  const releasesRoot = join(home, ".vellum", "releases", "linux-x64-glibc");
  mkdirSync(releasesRoot, { recursive: true, mode: 0o700 });
  chmodSync(releasesRoot, 0o700);

  const stagingRoot = join(
    releasesRoot,
    `.seat-${channel.version}-${Date.now().toString(36)}`,
  );
  mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
  chmodSync(stagingRoot, 0o700);

  try {
    extractTarGz(archive, stagingRoot);
    const bundleSource = resolveBundleRoot(stagingRoot);
    const target = linuxRemoteArtifactBundleRoot(home);
    const previous = `${target}.prev`;
    if (existsSync(previous)) {
      rmSync(previous, { recursive: true, force: true });
    }
    if (existsSync(target)) {
      renameSync(target, previous);
    }
    renameSync(bundleSource, target);
    chmodSync(target, 0o700);
    if (existsSync(previous)) {
      rmSync(previous, { recursive: true, force: true });
    }
    rmSync(stagingRoot, { recursive: true, force: true });
    return { bundleRoot: target, channel };
  } catch (error) {
    try {
      rmSync(stagingRoot, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    throw error;
  }
};

const resolveBundleRoot = (stagingRoot: string): string => {
  if (existsSync(join(stagingRoot, "release-manifest.json"))) {
    return stagingRoot;
  }
  const entries = readdirSync(stagingRoot).filter(
    (name) => !name.startsWith("."),
  );
  for (const name of entries) {
    const child = join(stagingRoot, name);
    try {
      if (
        statSync(child).isDirectory() &&
        existsSync(join(child, "release-manifest.json"))
      ) {
        return child;
      }
    } catch {
      // continue
    }
  }
  throw new Error(
    "Linux release archive does not contain release-manifest.json at the expected root",
  );
};

const extractTarGz = (archive: Buffer, destination: string): void => {
  const tmp = join(destination, ".archive.tgz");
  writeFileSync(tmp, archive, { mode: 0o600 });
  try {
    const result = spawnSync(
      "/usr/bin/tar",
      ["-xzf", tmp, "-C", destination],
      { encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(
        `tar extract failed: ${(result.stderr || result.stdout || "no output").trim()}`,
      );
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore
    }
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
