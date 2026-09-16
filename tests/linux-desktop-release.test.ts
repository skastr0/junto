import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalLinuxDesktopReleaseDescriptor,
  compareLinuxDesktopVersions,
  decodeLinuxDesktopReleaseDescriptor,
  decodeLinuxDesktopSignedRelease,
  LINUX_DESKTOP_CLOCK_SKEW_MS,
  LINUX_DESKTOP_INSTALL_RESERVE_BYTES,
  LINUX_DESKTOP_MAX_ARCHIVE_BYTES,
  LINUX_DESKTOP_MAX_EXPANDED_BYTES,
  LINUX_DESKTOP_MAX_SOURCE_INDEX_BYTES,
  LINUX_DESKTOP_RELEASE_SCHEMA,
  LINUX_DESKTOP_TARGET,
  LINUX_DESKTOP_UPDATE_FEED_PATH,
  linuxDesktopArchiveName,
  type LinuxDesktopReleaseDescriptor,
  linuxDesktopReleasePath,
  linuxDesktopSourcesPath,
} from "../src/shared/linux-desktop-release";
import {
  assertVerifiedLinuxDesktopRelease,
  decodeLinuxDesktopReleaseTrust,
  type LinuxDesktopReleaseKey,
  type LinuxDesktopReleaseTrust,
  loadEmbeddedLinuxDesktopReleaseTrust,
  signLinuxDesktopRelease,
  verifyLinuxDesktopRelease,
} from "../src/shared/linux-desktop-release-crypto";

const pair = generateKeyPairSync("ed25519");
const NOW = "2026-09-10T12:00:00.000Z";
const KEY_ID = "synthetic-desktop-test";
const hash = (bytes: string | Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");
const makeTrust = (
  override: Partial<LinuxDesktopReleaseKey> = {},
): LinuxDesktopReleaseTrust => {
  const key: LinuxDesktopReleaseKey = {
    keyId: KEY_ID,
    algorithm: "ed25519",
    publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" })
      .toString(),
    fingerprintSha256: hash(
      pair.publicKey.export({ format: "der", type: "spki" }),
    ),
    status: "active",
    validFrom: "2026-09-01T00:00:00.000Z",
    ...override,
  };
  const keyring = {
    schema: "junto/linux-release-keyring/v1" as const,
    revision: 1,
    keys: [key],
  };
  return {
    keyring,
    policy: {
      schema: "junto/linux-release-trust-policy/v1",
      state: "configured",
      trustedKeyringRevision: 1,
      trustedKeyringSha256: hash(`${JSON.stringify(keyring, null, 2)}\n`),
      trustedKeyId: KEY_ID,
      trustedKeyFingerprintSha256: key.fingerprintSha256,
    },
  };
};
const trust = makeTrust();
const descriptor = (version = "0.2.1"): LinuxDesktopReleaseDescriptor =>
  decodeLinuxDesktopReleaseDescriptor({
    schema: LINUX_DESKTOP_RELEASE_SCHEMA,
    product: "Junto",
    channel: "alpha",
    version,
    sourceRevision: "a".repeat(40),
    createdAt: NOW,
    target: LINUX_DESKTOP_TARGET,
    archive: {
      file: linuxDesktopArchiveName(version),
      path: `/linux/x64/${linuxDesktopArchiveName(version)}`,
      bytes: 240_000_000,
      sha256: "b".repeat(64),
    },
    sources: {
      path: linuxDesktopSourcesPath(version),
      bytes: 70_000,
      sha256: "c".repeat(64),
    },
    trust: { algorithm: "ed25519", keyId: KEY_ID, keyringRevision: 1 },
  });
const envelope = () => signLinuxDesktopRelease(descriptor(), pair.privateKey);
const admission = {
  trust,
  now: NOW,
  currentVersion: "0.2.0",
  requireNewer: true,
} as const;

describe("Linux desktop release wire contract", () => {
  it("has one fixed alpha lane and exact immutable version paths", () => {
    expect(LINUX_DESKTOP_UPDATE_FEED_PATH).toBe("/linux/x64/alpha.json");
    expect(linuxDesktopReleasePath("0.2.1")).toBe(
      "/linux/x64/0.2.1/release.json",
    );
    expect(linuxDesktopSourcesPath("0.2.1")).toBe(
      "/linux/x64/sources/0.2.1/sources.json",
    );
    expect(linuxDesktopArchiveName("0.2.1")).toBe(
      "junto-runtime-0.2.1-linux-x64.tar.gz",
    );
    expect(() => linuxDesktopReleasePath("../0.2.1")).toThrow(/version/);
  });

  it("canonicalizes object order and preserves every authenticated field", () => {
    const value = descriptor();
    const reordered = Object.fromEntries(
      Object.entries(value).reverse(),
    ) as unknown as LinuxDesktopReleaseDescriptor;
    expect(canonicalLinuxDesktopReleaseDescriptor(reordered)).toBe(
      canonicalLinuxDesktopReleaseDescriptor(value),
    );
    expect(JSON.parse(canonicalLinuxDesktopReleaseDescriptor(value))).toEqual(
      value,
    );
    expect(canonicalLinuxDesktopReleaseDescriptor(value).endsWith("\n")).toBe(
      true,
    );
  });

  it.each([
    "1.2",
    "v1.2.3",
    "01.2.3",
    "1.2.3-alpha",
    "1.2.3+build",
    "1.2.3/../../x",
    "1000000000.1.2",
    "-1.2.3",
  ])("rejects unsafe or noncanonical version %s", (version) => {
    expect(() => descriptor(version)).toThrow(/version/);
  });

  it.each([
    ["schema", "junto/linux-release-bundle/v7"],
    ["product", "Other Command"],
    ["channel", "stable"],
    ["sourceRevision", "A".repeat(40)],
    ["createdAt", "2026-09-10T12:00:00Z"],
    ["createdAt", "2026-02-30T12:00:00.000Z"],
  ])("rejects invalid %s", (field, value) => {
    expect(() =>
      decodeLinuxDesktopReleaseDescriptor({ ...descriptor(), [field]: value })
    ).toThrow();
  });

  it("rejects unknown fields throughout the contract", () => {
    const value = descriptor();
    expect(() => decodeLinuxDesktopReleaseDescriptor({ ...value, extra: true }))
      .toThrow(/fields/);
    for (const field of ["target", "archive", "sources", "trust"] as const) {
      expect(() =>
        decodeLinuxDesktopReleaseDescriptor({
          ...value,
          [field]: { ...value[field], extra: true },
        })
      ).toThrow(/fields/);
    }
    expect(() =>
      decodeLinuxDesktopSignedRelease({ ...envelope(), extra: true })
    ).toThrow(/fields/);
  });

  it("refuses unsupported targets and arbitrary archive/source locators", () => {
    const value = descriptor();
    expect(() =>
      decodeLinuxDesktopReleaseDescriptor({
        ...value,
        target: { ...value.target, arch: "arm64" },
      })
    ).toThrow(/target/);
    for (
      const malicious of [
        "/linux/x64/../secrets",
        "https://example.com/archive.tar.gz",
        `${value.archive.path}?token=x`,
        value.archive.path.replace("0.2.1", "0.2.0"),
      ]
    ) {
      expect(() =>
        decodeLinuxDesktopReleaseDescriptor({
          ...value,
          archive: { ...value.archive, path: malicious },
        })
      ).toThrow(/path/);
    }
    expect(() =>
      decodeLinuxDesktopReleaseDescriptor({
        ...value,
        sources: {
          ...value.sources,
          path: "/linux/x64/sources/0.2.0/sources.json",
        },
      })
    ).toThrow(/path/);
  });

  it("bounds positive archive and source index sizes", () => {
    const value = descriptor();
    for (
      const invalid of [
        0,
        -1,
        1.5,
        Number.POSITIVE_INFINITY,
        LINUX_DESKTOP_MAX_ARCHIVE_BYTES + 1,
      ]
    ) {
      expect(() =>
        decodeLinuxDesktopReleaseDescriptor({
          ...value,
          archive: { ...value.archive, bytes: invalid },
        })
      ).toThrow(/bytes/);
    }
    expect(() =>
      decodeLinuxDesktopReleaseDescriptor({
        ...value,
        sources: {
          ...value.sources,
          bytes: LINUX_DESKTOP_MAX_SOURCE_INDEX_BYTES + 1,
        },
      })
    ).toThrow(/bytes/);
    expect(
      decodeLinuxDesktopReleaseDescriptor({
        ...value,
        archive: { ...value.archive, bytes: LINUX_DESKTOP_MAX_ARCHIVE_BYTES },
      }).archive.bytes,
    ).toBe(LINUX_DESKTOP_MAX_ARCHIVE_BYTES);
    expect(LINUX_DESKTOP_MAX_EXPANDED_BYTES).toBe(4_000_000_000);
    expect(LINUX_DESKTOP_INSTALL_RESERVE_BYTES).toBe(1_073_741_824);
  });

  it("orders numeric versions and rejects malformed installed versions", () => {
    expect(compareLinuxDesktopVersions("0.10.0", "0.9.99")).toBe(1);
    expect(compareLinuxDesktopVersions("0.2.1", "0.2.1")).toBe(0);
    expect(compareLinuxDesktopVersions("1.0.0", "2.0.0")).toBe(-1);
    expect(() => compareLinuxDesktopVersions("1.0.0", "latest")).toThrow(
      /version/,
    );
  });
});

describe("Linux desktop release authentication", () => {
  it("loads the real existing embedded public trust pin without filesystem lookup", () => {
    const pinned = loadEmbeddedLinuxDesktopReleaseTrust();
    expect(pinned.policy.trustedKeyringSha256).toBe(
      "d57438aa4b63ad5c0d1f1f58975fe1de18324f32d4776c53357dd4419c2f330c",
    );
    expect(pinned.keyring.keys[0]!.fingerprintSha256).toBe(
      pinned.policy.trustedKeyFingerprintSha256,
    );
  });

  it("admits a valid newer release and seals its immutable provenance", () => {
    const verified = verifyLinuxDesktopRelease(envelope(), admission);
    expect(verified).toEqual(descriptor());
    expect(() => assertVerifiedLinuxDesktopRelease(verified)).not.toThrow();
    expect(() => assertVerifiedLinuxDesktopRelease(descriptor())).toThrow(
      /authenticated/,
    );
    expect(() => assertVerifiedLinuxDesktopRelease(structuredClone(verified)))
      .toThrow(/authenticated/);
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.isFrozen(verified.archive)).toBe(true);
    expect(Object.isFrozen(verified.target)).toBe(true);
    expect(Object.isFrozen(verified.trust)).toBe(true);
  });

  it("authenticates changed hashes, sizes, source revision, dates and release version", () => {
    const original = envelope();
    const value = original.descriptor;
    const changes = [
      { ...value, archive: { ...value.archive, sha256: "d".repeat(64) } },
      {
        ...value,
        archive: { ...value.archive, bytes: value.archive.bytes + 1 },
      },
      { ...value, sources: { ...value.sources, sha256: "e".repeat(64) } },
      {
        ...value,
        sources: { ...value.sources, bytes: value.sources.bytes + 1 },
      },
      { ...value, sourceRevision: "f".repeat(40) },
      { ...value, createdAt: "2026-09-10T11:59:00.000Z" },
      descriptor("0.2.2"),
    ];
    for (const changed of changes) {
      expect(() =>
        verifyLinuxDesktopRelease(
          { ...original, descriptor: changed },
          admission,
        )
      ).toThrow(/signature/);
    }
  });

  it("refuses signatures made in another domain or over bare JSON", () => {
    const value = descriptor();
    for (const prefix of ["", "junto/linux-release-bundle/v7\n"]) {
      const signature = sign(
        null,
        Buffer.from(prefix + canonicalLinuxDesktopReleaseDescriptor(value)),
        pair.privateKey,
      ).toString("base64url");
      expect(() =>
        verifyLinuxDesktopRelease({ descriptor: value, signature }, admission)
      ).toThrow(/signature/);
    }
  });

  it("requires canonical base64url and the signing key's exact type", () => {
    const valid = envelope();
    expect(() =>
      decodeLinuxDesktopSignedRelease({
        ...valid,
        signature: `${valid.signature}==`,
      })
    ).toThrow(/canonical/);
    const noncanonical = valid.signature.slice(0, -1) + "B";
    expect(() =>
      decodeLinuxDesktopSignedRelease({ ...valid, signature: noncanonical })
    ).toThrow(/canonical/);
    expect(() => signLinuxDesktopRelease(descriptor(), pair.publicKey)).toThrow(
      /private key/,
    );
  });

  it("rejects keyring, key id and public key substitution despite structurally valid input", () => {
    const valid = envelope();
    expect(() =>
      verifyLinuxDesktopRelease(valid, {
        ...admission,
        trust: { ...trust, keyring: { ...trust.keyring, revision: 2 } },
      })
    ).toThrow(/pinned/);
    expect(() =>
      verifyLinuxDesktopRelease(valid, {
        ...admission,
        trust: {
          ...trust,
          policy: {
            ...trust.policy,
            trustedKeyFingerprintSha256: "0".repeat(64),
          },
        },
      })
    ).toThrow(/pinned/);
    expect(() =>
      verifyLinuxDesktopRelease({
        ...valid,
        descriptor: {
          ...valid.descriptor,
          trust: { ...valid.descriptor.trust, keyId: "another-key" },
        },
      }, admission)
    ).toThrow(/pinned/);
    expect(() =>
      verifyLinuxDesktopRelease({
        ...valid,
        descriptor: {
          ...valid.descriptor,
          trust: { ...valid.descriptor.trust, keyringRevision: 2 },
        },
      }, admission)
    ).toThrow(/pinned/);
    const other = generateKeyPairSync("ed25519");
    const forged = signLinuxDesktopRelease(descriptor(), other.privateKey);
    expect(() => verifyLinuxDesktopRelease(forged, admission)).toThrow(
      /signature/,
    );
  });

  it("refuses revoked keys and signatures outside an authorized key window", () => {
    const valid = envelope();
    expect(() =>
      verifyLinuxDesktopRelease(valid, {
        ...admission,
        trust: makeTrust({
          status: "revoked",
          revokedAt: "2026-09-09T00:00:00.000Z",
        }),
      })
    ).toThrow(/revoked/);
    expect(() =>
      verifyLinuxDesktopRelease(valid, {
        ...admission,
        trust: makeTrust({ validFrom: "2026-09-11T00:00:00.000Z" }),
      })
    ).toThrow(/authorization window/);
    expect(() =>
      verifyLinuxDesktopRelease(valid, {
        ...admission,
        trust: makeTrust({
          status: "retired",
          signingEndsAt: "2026-09-09T00:00:00.000Z",
        }),
      })
    ).toThrow(/authorization window/);
    expect(() =>
      verifyLinuxDesktopRelease(valid, {
        ...admission,
        trust: makeTrust({
          status: "retired",
          signingEndsAt: "2026-09-11T00:00:00.000Z",
        }),
      })
    ).not.toThrow();
    expect(() =>
      decodeLinuxDesktopReleaseTrust(makeTrust({ status: "retired" }))
    ).toThrow(/lifecycle/);
  });

  it("enforces future clock skew without expiring immutable releases", () => {
    const valid = envelope();
    expect(() =>
      verifyLinuxDesktopRelease(valid, {
        ...admission,
        now: "2036-09-10T12:00:00.000Z",
      })
    ).not.toThrow();
    expect(() =>
      verifyLinuxDesktopRelease(valid, {
        ...admission,
        now: new Date(Date.parse(NOW) - LINUX_DESKTOP_CLOCK_SKEW_MS - 1),
      })
    ).toThrow(/future/);
    expect(() =>
      verifyLinuxDesktopRelease(valid, {
        ...admission,
        now: new Date(Date.parse(NOW) - LINUX_DESKTOP_CLOCK_SKEW_MS),
      })
    ).not.toThrow();
    expect(() =>
      verifyLinuxDesktopRelease(valid, { ...admission, now: "invalid" })
    ).toThrow(/verification time/);
    expect(() =>
      decodeLinuxDesktopReleaseDescriptor({ ...descriptor(), expiresAt: NOW })
    ).toThrow(/fields/);
  });

  it("enforces strictly newer update admission independently of signature validity", () => {
    for (const currentVersion of ["0.2.1", "0.2.2", "1.0.0"]) {
      expect(() =>
        verifyLinuxDesktopRelease(envelope(), { ...admission, currentVersion })
      ).toThrow(/strictly newer/);
    }
    expect(() =>
      verifyLinuxDesktopRelease(envelope(), {
        trust,
        now: NOW,
        requireNewer: true,
      })
    ).toThrow(/current version/);
    expect(() => verifyLinuxDesktopRelease(envelope(), { trust, now: NOW })).not
      .toThrow();
  });
});
