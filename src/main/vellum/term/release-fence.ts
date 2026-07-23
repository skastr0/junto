import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  type Stats,
} from "node:fs";
import {
  decodeLinuxReleaseFence,
  encodeLinuxReleaseFence,
  LINUX_RELEASE_FENCE_MAX_BYTES,
  LINUX_RELEASE_FENCE_PATH,
  type LinuxReleaseFence,
} from "@shared/linux-release-fence";

const isMissing = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { readonly code?: unknown }).code === "ENOENT";

export type LinuxReleaseFenceObservation =
  | { readonly state: "inactive" }
  | {
      readonly state: "active";
      readonly fence: LinuxReleaseFence;
    }
  | {
      readonly state: "blocked";
      readonly reason:
        "unreadable" | "unsafe-metadata" | "malformed" | "changed";
    };

export interface LinuxReleaseFenceIo {
  readonly open: (path: string, flags: number) => number;
  readonly stat: (descriptor: number) => Stats;
  readonly read: (
    descriptor: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
  ) => number;
  readonly close: (descriptor: number) => void;
}

const productionIo: LinuxReleaseFenceIo = {
  open: openSync,
  stat: fstatSync,
  read: readSync,
  close: closeSync,
};

const modeOf = (metadata: Stats): number => metadata.mode & 0o7777;

const sameIdentity = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;

const safeMetadata = (metadata: Stats): boolean =>
  metadata.isFile() &&
  metadata.uid === 0 &&
  metadata.gid === 0 &&
  metadata.nlink === 1 &&
  modeOf(metadata) === 0o444 &&
  metadata.size > 0 &&
  metadata.size <= LINUX_RELEASE_FENCE_MAX_BYTES;

/**
 * Inspect the one fixed release fence through a no-follow descriptor.
 *
 * Only an absent path is inactive. An unreadable path, a non-root inode, a
 * non-canonical record, or a record changed during inspection is a durable
 * admission cut that only root repair can clear.
 */
export const observeLinuxReleaseFence = (
  platform: NodeJS.Platform = process.platform,
  io: LinuxReleaseFenceIo = productionIo,
): LinuxReleaseFenceObservation => {
  if (platform !== "linux") return { state: "inactive" };

  let descriptor: number;
  try {
    descriptor = io.open(
      LINUX_RELEASE_FENCE_PATH,
      constants.O_RDONLY |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
    );
  } catch (error) {
    return isMissing(error)
      ? { state: "inactive" }
      : { state: "blocked", reason: "unreadable" };
  }

  try {
    const before = io.stat(descriptor);
    if (!safeMetadata(before)) {
      return { state: "blocked", reason: "unsafe-metadata" };
    }

    const buffer = Buffer.alloc(LINUX_RELEASE_FENCE_MAX_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = io.read(
        descriptor,
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        null,
      );
      if (count === 0) break;
      bytesRead += count;
    }
    const after = io.stat(descriptor);
    if (
      bytesRead !== before.size ||
      bytesRead > LINUX_RELEASE_FENCE_MAX_BYTES ||
      !safeMetadata(after) ||
      !sameIdentity(before, after)
    ) {
      return { state: "blocked", reason: "changed" };
    }

    const raw = buffer.subarray(0, bytesRead).toString("utf8");
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return { state: "blocked", reason: "malformed" };
    }
    const fence = decodeLinuxReleaseFence(value);
    if (fence === undefined || encodeLinuxReleaseFence(fence) !== raw) {
      return { state: "blocked", reason: "malformed" };
    }
    return { state: "active", fence };
  } catch {
    return { state: "blocked", reason: "unreadable" };
  } finally {
    try {
      io.close(descriptor);
    } catch {
      // A failed descriptor close cannot make an occupied fence inactive.
    }
  }
};

/**
 * Read-only fail-closed projection of the root-owned Linux release fence.
 *
 * Metadata validation is intentionally not an "inactive" escape hatch. Any
 * occupied, unreadable, replaced, or malformed fixed path closes admission;
 * only root repair may make the path absent again.
 */
export const linuxReleaseFenceActive = (
  platform: NodeJS.Platform = process.platform,
  observe: (
    platform: NodeJS.Platform,
  ) => LinuxReleaseFenceObservation = observeLinuxReleaseFence,
): boolean => {
  try {
    return observe(platform).state !== "inactive";
  } catch {
    return platform === "linux";
  }
};
