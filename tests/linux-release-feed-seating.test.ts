import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  LINUX_RELEASE_CHECKSUMS,
  LINUX_RELEASE_MANIFEST,
  LINUX_RELEASE_SIGNATURE,
  LINUX_RELEASE_TARGET,
  type LinuxReleaseVerificationReceipt,
} from "../scripts/linux-release-bundle";
import { createLinuxReleaseArchive } from "../scripts/linux-release-archive";
import type { ProductionLinuxDeployBundleCandidate } from "../src/main/vellum/hosts/linux-release-admission";

const admission = vi.hoisted(() => ({
  verify: vi.fn(),
}));
const filesystemControl = vi.hoisted(() => ({
  failCandidatePromotion: false,
}));

vi.mock("../src/main/vellum/hosts/linux-release-admission", () => ({
  verifyProductionLinuxDeployBundle: admission.verify,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (source: string, destination: string): Promise<void> => {
      if (
        filesystemControl.failCandidatePromotion &&
        source.includes("vellum-linux-release-archive-") &&
        destination.endsWith("/current")
      ) {
        filesystemControl.failCandidatePromotion = false;
        throw new Error("injected candidate promotion failure");
      }
      await actual.rename(source, destination);
    },
  };
});

import {
  decodeLinuxStableChannel,
  linuxRemoteArtifactBundleRoot,
  seatLinuxReleaseCacheFromFeed,
  type LinuxStableChannel,
} from "../src/main/vellum/hosts/linux-release-feed";

const VERSION = "0.1.5";
const REVISION = "a".repeat(40);
const PACKAGE = `vellum-runtime-${VERSION}-linux-x64.tar.gz`;
const FEED_BASE = "https://feed.example";
const DOWNLOAD_LOCATOR = `${FEED_BASE}/linux/releases/${PACKAGE}`;
const roots: string[] = [];

interface TarEntry {
  readonly name: string;
  readonly body?: Buffer;
  readonly type?: "0" | "1" | "2" | "5";
  readonly linkName?: string;
}

interface FeedFixture {
  readonly home: string;
  readonly archive: Buffer;
  readonly channel: LinuxStableChannel;
  readonly candidate: ProductionLinuxDeployBundleCandidate;
}

const sha256 = (input: Uint8Array): string =>
  createHash("sha256").update(input).digest("hex");

const canonical = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;

const putString = (
  header: Buffer,
  offset: number,
  length: number,
  value: string,
): void => {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) throw new Error("tar field is too long");
  bytes.copy(header, offset);
};

const putOctal = (
  header: Buffer,
  offset: number,
  length: number,
  value: number,
): void => {
  putString(
    header,
    offset,
    length,
    `${value.toString(8).padStart(length - 1, "0")}\0`,
  );
};

const tarHeader = (entry: TarEntry): Buffer => {
  const body = entry.body ?? Buffer.alloc(0);
  const type = entry.type ?? "0";
  const header = Buffer.alloc(512);
  putString(header, 0, 100, entry.name);
  putOctal(header, 100, 8, type === "5" ? 0o755 : 0o644);
  putOctal(header, 108, 8, 0);
  putOctal(header, 116, 8, 0);
  putOctal(header, 124, 12, type === "0" ? body.length : 0);
  putOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  putString(header, 156, 1, type);
  if (entry.linkName !== undefined) {
    putString(header, 157, 100, entry.linkName);
  }
  putString(header, 257, 6, "ustar\0");
  putString(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  putString(
    header,
    148,
    8,
    `${checksum.toString(8).padStart(6, "0")}\0 `,
  );
  return header;
};

const tarGz = (entries: ReadonlyArray<TarEntry>): Buffer => {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const body = entry.type === undefined || entry.type === "0"
      ? entry.body ?? Buffer.alloc(0)
      : Buffer.alloc(0);
    parts.push(tarHeader(entry), body);
    const padding = (512 - (body.length % 512)) % 512;
    if (padding > 0) parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
};

const bundleFiles = (
  bodies: Readonly<Record<string, Buffer>>,
): LinuxReleaseVerificationReceipt["bundleFiles"] =>
  Object.entries(bodies)
    .map(([file, body]) => ({
      file,
      bytes: body.length,
      sha256: sha256(body),
    }))
    .sort((left, right) => left.file.localeCompare(right.file));

const fixture = async (): Promise<FeedFixture> => {
  const root = await mkdtemp(path.join(tmpdir(), "vellum-feed-seat-test-"));
  roots.push(root);
  const home = path.join(root, "home");
  const bundleDirectory = path.join(root, "bundle");
  const outputDirectory = path.join(root, "output");
  await Promise.all([
    mkdir(home),
    mkdir(bundleDirectory),
    mkdir(outputDirectory),
  ]);
  const bodies = {
    [PACKAGE]: Buffer.from("verified runtime package"),
    [LINUX_RELEASE_MANIFEST]: Buffer.from('{"schema":"fixture"}\n'),
    [LINUX_RELEASE_SIGNATURE]: Buffer.from('{"signature":"fixture"}\n'),
    [LINUX_RELEASE_CHECKSUMS]: Buffer.from("fixture checksums\n"),
  };
  await Promise.all(
    Object.entries(bodies).map(([file, body]) =>
      writeFile(path.join(bundleDirectory, file), body)
    ),
  );
  const inventory = bundleFiles(bodies);
  const packageEntry = inventory.find(({ file }) => file === PACKAGE);
  const manifestEntry = inventory.find(
    ({ file }) => file === LINUX_RELEASE_MANIFEST,
  );
  if (packageEntry === undefined || manifestEntry === undefined) {
    throw new Error("fixture inventory is incomplete");
  }
  const receipt: LinuxReleaseVerificationReceipt = {
    schema: "vellum/linux-release-verification-receipt/v1",
    ok: true,
    version: VERSION,
    sourceRevision: REVISION,
    target: LINUX_RELEASE_TARGET,
    keyId: "vellum-linux-2026a",
    keyringRevision: 1,
    signedAt: "2026-07-31T12:00:00.000Z",
    expiresAt: "2026-08-01T12:00:00.000Z",
    filesVerified: 1,
    bundleFiles: inventory,
    packageFile: PACKAGE,
    packageBytes: packageEntry.bytes,
    packageSha256: packageEntry.sha256,
  };
  const receiptPath = path.join(root, "verification-receipt.json");
  const archivePath = path.join(outputDirectory, PACKAGE);
  await writeFile(receiptPath, canonical(receipt));
  const created = await createLinuxReleaseArchive({
    bundleDirectory,
    verificationReceiptPath: receiptPath,
    archivePath,
  });
  const archive = await readFile(archivePath);
  const channel: LinuxStableChannel = {
    schema: "vellum/linux-release-channel/v1",
    channel: "stable",
    version: VERSION,
    sourceRevision: REVISION,
    downloadLocator: DOWNLOAD_LOCATOR,
    archiveBytes: created.archiveBytes,
    archiveSha256: created.archiveSha256,
    manifestSha256: manifestEntry.sha256,
    packageBytes: packageEntry.bytes,
    packageSha256: packageEntry.sha256,
    bundleFiles: inventory,
    publishedAt: "2026-07-31T12:30:00.000Z",
  };
  const candidate = {
    bytes: receipt.packageBytes,
    sha256: receipt.packageSha256,
    version: receipt.version,
    receipt,
  } as unknown as ProductionLinuxDeployBundleCandidate;
  return { home, archive, channel, candidate };
};

const feedFetch = (
  channel: LinuxStableChannel,
  archive: Buffer,
) =>
  vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/linux/channels/stable.json")) {
      return new Response(canonical(channel), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === channel.downloadLocator) {
      return new Response(new Uint8Array(archive), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

const seedIncumbent = async (home: string): Promise<string> => {
  const current = linuxRemoteArtifactBundleRoot(home);
  await mkdir(current, { recursive: true, mode: 0o700 });
  await writeFile(path.join(current, "incumbent"), "last-good");
  return current;
};

const expectIncumbent = async (current: string): Promise<void> => {
  await expect(readFile(path.join(current, "incumbent"), "utf8")).resolves
    .toBe("last-good");
};

const releaseResidue = async (home: string): Promise<ReadonlyArray<string>> => {
  const root = path.join(home, ".vellum", "releases", "linux-x64-glibc");
  return (await readdir(root)).filter(
    (name) =>
      name.startsWith(".seat-") ||
      name.startsWith(".previous-") ||
      name === ".feed-seat.lock",
  );
};

afterEach(async () => {
  filesystemControl.failCandidatePromotion = false;
  admission.verify.mockReset();
  vi.unstubAllGlobals();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Linux stable feed seating", () => {
  it("verifies the signed extracted bundle before replacing current", async () => {
    const feed = await fixture();
    const current = await seedIncumbent(feed.home);
    let verifications = 0;
    admission.verify.mockImplementation(
      async ({ bundleDirectory }: { readonly bundleDirectory: string }) => {
        if (verifications === 0) {
          await expectIncumbent(current);
          expect(bundleDirectory).not.toBe(current);
        } else {
          expect(bundleDirectory).toBe(current);
        }
        verifications += 1;
        return feed.candidate;
      },
    );
    vi.stubGlobal("fetch", feedFetch(feed.channel, feed.archive));

    await expect(
      seatLinuxReleaseCacheFromFeed({
        home: feed.home,
        feedBase: FEED_BASE,
      }),
    ).resolves.toMatchObject({
      bundleRoot: current,
      channel: feed.channel,
    });

    expect(verifications).toBe(2);
    await expect(readFile(path.join(current, PACKAGE))).resolves.toEqual(
      Buffer.from("verified runtime package"),
    );
    await expect(readFile(path.join(current, "incumbent"))).rejects.toThrow();
    await expect(releaseResidue(feed.home)).resolves.toEqual([]);
  });

  it("keeps the incumbent when signed admission fails", async () => {
    const feed = await fixture();
    const current = await seedIncumbent(feed.home);
    admission.verify.mockRejectedValue(new Error("signature rejected"));
    vi.stubGlobal("fetch", feedFetch(feed.channel, feed.archive));

    await expect(
      seatLinuxReleaseCacheFromFeed({
        home: feed.home,
        feedBase: FEED_BASE,
      }),
    ).rejects.toThrow("signature rejected");

    await expectIncumbent(current);
    await expect(releaseResidue(feed.home)).resolves.toEqual([]);
  });

  it("restores the incumbent when candidate promotion fails", async () => {
    const feed = await fixture();
    const current = await seedIncumbent(feed.home);
    admission.verify.mockResolvedValue(feed.candidate);
    filesystemControl.failCandidatePromotion = true;
    vi.stubGlobal("fetch", feedFetch(feed.channel, feed.archive));

    await expect(
      seatLinuxReleaseCacheFromFeed({
        home: feed.home,
        feedBase: FEED_BASE,
      }),
    ).rejects.toThrow("injected candidate promotion failure");

    await expectIncumbent(current);
    await expect(releaseResidue(feed.home)).resolves.toEqual([]);
  });

  it("rejects an oversized archive stream before extraction or mutation", async () => {
    const feed = await fixture();
    const current = await seedIncumbent(feed.home);
    const oversized = Buffer.concat([feed.archive, Buffer.from("extra")]);
    admission.verify.mockResolvedValue(feed.candidate);
    vi.stubGlobal("fetch", feedFetch(feed.channel, oversized));

    await expect(
      seatLinuxReleaseCacheFromFeed({
        home: feed.home,
        feedBase: FEED_BASE,
      }),
    ).rejects.toThrow(/byte count|Content-Length/u);

    expect(admission.verify).not.toHaveBeenCalled();
    await expectIncumbent(current);
    await expect(releaseResidue(feed.home)).resolves.toEqual([]);
  });

  it.each([
    {
      name: "traversal",
      entries: [{ name: "../escape", body: Buffer.from("escape") }],
      error: /unsafe.*path/u,
    },
    {
      name: "symlink",
      entries: [{
        name: LINUX_RELEASE_MANIFEST,
        type: "2" as const,
        linkName: "/etc/passwd",
      }],
      error: /unsupported.*type/u,
    },
    {
      name: "extra member",
      entries: [{ name: "surprise", body: Buffer.from("extra") }],
      error: /unexpected.*file/u,
    },
  ])("rejects $name archive authority before admission", async ({
    entries,
    error,
  }) => {
    const feed = await fixture();
    const current = await seedIncumbent(feed.home);
    const archive = tarGz(entries);
    const channel = {
      ...feed.channel,
      archiveBytes: archive.length,
      archiveSha256: sha256(archive),
    };
    admission.verify.mockResolvedValue(feed.candidate);
    vi.stubGlobal("fetch", feedFetch(channel, archive));

    await expect(
      seatLinuxReleaseCacheFromFeed({
        home: feed.home,
        feedBase: FEED_BASE,
      }),
    ).rejects.toThrow(error);

    expect(admission.verify).not.toHaveBeenCalled();
    await expectIncumbent(current);
    await expect(
      stat(path.join(feed.home, ".vellum", "releases", "escape")),
    ).rejects.toThrow();
  });

  it("rejects unsigned channel claims that differ from signed evidence", async () => {
    const feed = await fixture();
    const current = await seedIncumbent(feed.home);
    const mismatched = {
      ...feed.candidate,
      receipt: {
        ...feed.candidate.receipt,
        sourceRevision: "b".repeat(40),
      },
    } as unknown as ProductionLinuxDeployBundleCandidate;
    admission.verify.mockResolvedValue(mismatched);
    vi.stubGlobal("fetch", feedFetch(feed.channel, feed.archive));

    await expect(
      seatLinuxReleaseCacheFromFeed({
        home: feed.home,
        feedBase: FEED_BASE,
      }),
    ).rejects.toThrow(/does not match the signed release bundle/u);

    await expectIncumbent(current);
  });

  it("serializes concurrent seating without staging collisions", async () => {
    const feed = await fixture();
    admission.verify.mockResolvedValue(feed.candidate);
    vi.stubGlobal("fetch", feedFetch(feed.channel, feed.archive));

    await Promise.all([
      seatLinuxReleaseCacheFromFeed({
        home: feed.home,
        feedBase: FEED_BASE,
      }),
      seatLinuxReleaseCacheFromFeed({
        home: feed.home,
        feedBase: FEED_BASE,
      }),
    ]);

    const current = linuxRemoteArtifactBundleRoot(feed.home);
    await expect(readFile(path.join(current, PACKAGE))).resolves.toEqual(
      Buffer.from("verified runtime package"),
    );
    expect(admission.verify).toHaveBeenCalledTimes(4);
    await expect(releaseResidue(feed.home)).resolves.toEqual([]);
  });

  it("fails closed when another process holds the owner-local promotion lock", async () => {
    const feed = await fixture();
    const current = await seedIncumbent(feed.home);
    const releasesRoot = path.dirname(current);
    const lock = path.join(releasesRoot, ".feed-seat.lock");
    await mkdir(lock, { mode: 0o700 });
    admission.verify.mockResolvedValue(feed.candidate);
    vi.stubGlobal("fetch", feedFetch(feed.channel, feed.archive));
    try {
      await expect(
        seatLinuxReleaseCacheFromFeed({
          home: feed.home,
          feedBase: FEED_BASE,
        }),
      ).rejects.toThrow(/promotion is already in progress/u);
      await expectIncumbent(current);
      expect(admission.verify).toHaveBeenCalledOnce();
    } finally {
      await rmdir(lock);
    }
    await expect(releaseResidue(feed.home)).resolves.toEqual([]);
  });
});

describe("Linux stable channel bounds", () => {
  it("rejects duplicate inventory and hard archive limits", async () => {
    const feed = await fixture();
    const duplicate = {
      ...feed.channel,
      bundleFiles: [
        ...feed.channel.bundleFiles,
        feed.channel.bundleFiles[0]!,
      ],
    };
    expect(() => decodeLinuxStableChannel(duplicate)).toThrow(/bundleFiles/u);
    expect(() =>
      decodeLinuxStableChannel({
        ...feed.channel,
        archiveBytes: 3 * 1024 * 1024 * 1024 + 1,
      })
    ).toThrow(/archiveBytes/u);
  });

  it("rejects a channel whose locator is not the selected feed", async () => {
    const feed = await fixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(canonical({
          ...feed.channel,
          downloadLocator: `https://other.example/linux/releases/${PACKAGE}`,
        }))
      ),
    );

    await expect(
      seatLinuxReleaseCacheFromFeed({
        home: feed.home,
        feedBase: FEED_BASE,
      }),
    ).rejects.toThrow(/downloadLocator does not match its feed/u);
    expect(admission.verify).not.toHaveBeenCalled();
  });
});
