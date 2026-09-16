import { constants, type Stats } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  decodeLinuxReleaseFence,
  encodeLinuxReleaseFence,
  LINUX_RELEASE_FENCE_DIRECTORY,
  LINUX_RELEASE_FENCE_MAX_BYTES,
  LINUX_RELEASE_FENCE_PATH,
  LINUX_RELEASE_FENCE_PROTOCOL,
  type LinuxReleaseFence,
} from "../src/shared/linux-release-fence";
import {
  linuxReleaseFenceActive,
  observeLinuxReleaseFence,
  type LinuxReleaseFenceIo,
} from "../src/main/junto/term/release-fence";

const fence = (
  overrides: Partial<LinuxReleaseFence> = {},
): LinuxReleaseFence => ({
  schema: LINUX_RELEASE_FENCE_PROTOCOL,
  fenceId: "a".repeat(32),
  transactionId: "b".repeat(32),
  operation: "install",
  targetUid: process.getuid?.() ?? 1_000,
  targetGid: process.getgid?.() ?? 1_000,
  stationId: "station-01",
  machineIdSha256: "c".repeat(64),
  bootId: "01234567-89ab-cdef-0123-456789abcdef",
  candidateDigest: "d".repeat(64),
  ...overrides,
});

const metadata = (bytes: number, overrides: Partial<Stats> = {}): Stats => ({
  dev: 1,
  ino: 2,
  mode: 0o444,
  nlink: 1,
  uid: 0,
  gid: 0,
  rdev: 0,
  size: bytes,
  blksize: 4_096,
  blocks: 1,
  atimeMs: 0,
  mtimeMs: 10,
  ctimeMs: 10,
  birthtimeMs: 0,
  atime: new Date(0),
  mtime: new Date(10),
  ctime: new Date(10),
  birthtime: new Date(0),
  isBlockDevice: () => false,
  isCharacterDevice: () => false,
  isDirectory: () => false,
  isFIFO: () => false,
  isFile: () => true,
  isSocket: () => false,
  isSymbolicLink: () => false,
  ...overrides,
});

const memoryIo = (
  raw: string,
  options: {
    readonly first?: Stats;
    readonly second?: Stats;
    readonly openError?: Error;
  } = {},
): { readonly io: LinuxReleaseFenceIo; readonly opened: number[] } => {
  const bytes = Buffer.from(raw);
  const first = options.first ?? metadata(bytes.length);
  const second = options.second ?? first;
  const opened: number[] = [];
  let cursor = 0;
  let observations = 0;
  return {
    opened,
    io: {
      open(path, flags) {
        expect(path).toBe(LINUX_RELEASE_FENCE_PATH);
        opened.push(flags);
        if (options.openError !== undefined) throw options.openError;
        return 17;
      },
      stat(descriptor) {
        expect(descriptor).toBe(17);
        return observations++ === 0 ? first : second;
      },
      read(descriptor, buffer, offset, length, position) {
        expect(descriptor).toBe(17);
        expect(position).toBeNull();
        const count = Math.min(length, bytes.length - cursor);
        if (count <= 0) return 0;
        bytes.copy(buffer, offset, cursor, cursor + count);
        cursor += count;
        return count;
      },
      close(descriptor) {
        expect(descriptor).toBe(17);
      },
    },
  };
};

describe("Linux release fence contract", () => {
  it("uses one fixed persistent root namespace", () => {
    expect(LINUX_RELEASE_FENCE_DIRECTORY).toBe(
      "/var/lib/junto-release-fence",
    );
    expect(LINUX_RELEASE_FENCE_PATH).toBe(
      "/var/lib/junto-release-fence/active",
    );
    expect(LINUX_RELEASE_FENCE_PATH.startsWith("/run/")).toBe(false);
    expect(LINUX_RELEASE_FENCE_PATH.includes(".junto")).toBe(false);
  });

  it("round-trips one strict canonical root marker", () => {
    const value = fence();
    const encoded = encodeLinuxReleaseFence(value);
    expect(encoded).toBe(`${JSON.stringify(value)}\n`);
    expect(decodeLinuxReleaseFence(JSON.parse(encoded))).toEqual(value);
    expect(
      decodeLinuxReleaseFence({ ...value, callerSuppliedPath: "/tmp/fence" }),
    ).toBeUndefined();
    expect(decodeLinuxReleaseFence({ ...value, targetUid: 0 })).toBeUndefined();
  });

  it("observes a canonical root-owned regular file through no-follow IO", () => {
    const value = fence();
    const fixture = memoryIo(encodeLinuxReleaseFence(value));
    expect(observeLinuxReleaseFence("linux", fixture.io)).toEqual({
      state: "active",
      fence: value,
    });
    expect(fixture.opened).toHaveLength(1);
    expect(fixture.opened[0]! & constants.O_NOFOLLOW).toBe(
      constants.O_NOFOLLOW,
    );
    expect(fixture.opened[0]! & constants.O_NONBLOCK).toBe(
      constants.O_NONBLOCK,
    );
  });

  it("fails closed on unsafe, changed, oversized, and non-canonical records", () => {
    const encoded = encodeLinuxReleaseFence(fence());
    expect(
      observeLinuxReleaseFence(
        "linux",
        memoryIo(encoded, {
          first: metadata(Buffer.byteLength(encoded), { uid: 1_000 }),
        }).io,
      ),
    ).toEqual({ state: "blocked", reason: "unsafe-metadata" });
    expect(
      observeLinuxReleaseFence(
        "linux",
        memoryIo(encoded, {
          second: metadata(Buffer.byteLength(encoded), { mtimeMs: 11 }),
        }).io,
      ),
    ).toEqual({ state: "blocked", reason: "changed" });
    expect(
      observeLinuxReleaseFence(
        "linux",
        memoryIo("x", {
          first: metadata(LINUX_RELEASE_FENCE_MAX_BYTES + 1),
        }).io,
      ),
    ).toEqual({ state: "blocked", reason: "unsafe-metadata" });
    expect(
      observeLinuxReleaseFence(
        "linux",
        memoryIo(`${JSON.stringify(fence())} \n`).io,
      ),
    ).toEqual({ state: "blocked", reason: "malformed" });
  });

  it("is inactive off Linux without touching host state", () => {
    const observe = (): never => {
      throw new Error("must not observe");
    };
    expect(linuxReleaseFenceActive("darwin", observe)).toBe(false);
    expect(linuxReleaseFenceActive("win32", observe)).toBe(false);
  });

  it("closes on every occupied or unreadable Linux path", () => {
    expect(
      linuxReleaseFenceActive("linux", () => ({
        state: "active",
        fence: fence(),
      })),
    ).toBe(true);
    expect(
      linuxReleaseFenceActive("linux", () => {
        throw new Error("permission denied");
      }),
    ).toBe(true);
    expect(
      linuxReleaseFenceActive("linux", () => ({
        state: "blocked",
        reason: "malformed",
      })),
    ).toBe(true);
  });

  it("opens only when the fixed Linux path is absent", () => {
    expect(
      linuxReleaseFenceActive("linux", () => ({ state: "inactive" })),
    ).toBe(false);
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    expect(
      observeLinuxReleaseFence(
        "linux",
        memoryIo("", { openError: missing }).io,
      ),
    ).toEqual({ state: "inactive" });
  });
});
