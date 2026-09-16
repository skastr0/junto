import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseLinuxDesktopReleaseArgs,
  prepareLinuxDesktopRelease,
  runLinuxDesktopRelease,
  signLinuxDesktopReleaseFile,
  verifyLinuxDesktopReleaseFile,
} from "../scripts/linux-desktop-release";
import { linuxDesktopArchiveName, canonicalLinuxDesktopReleaseDescriptor } from "../src/shared/linux-desktop-release";
import { loadEmbeddedLinuxDesktopReleaseTrust, type LinuxDesktopReleaseTrust } from "../src/shared/linux-desktop-release-crypto";
import { fingerprintLinuxDesktopFile, readLinuxDesktopReleaseJson, verifyLinuxDesktopReleaseFiles } from "../src/shared/linux-desktop-release-files";
import { releaseKeyringSha256, releasePublicKeyFingerprint } from "../scripts/linux-release-bundle";

const stdin = (...chunks: (string | Uint8Array)[]): AsyncIterable<string | Uint8Array> => ({
  async *[Symbol.asyncIterator]() { yield* chunks; },
});
const roots: string[] = [];
const temporary = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), "junto-desktop-release-test-"));
  roots.push(directory);
  return directory;
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const fixture = async () => {
  const root = await temporary();
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const fingerprintSha256 = releasePublicKeyFingerprint(publicKeyPem);
  const embedded = loadEmbeddedLinuxDesktopReleaseTrust();
  const keyring = {
    ...embedded.keyring,
    revision: 1,
    keys: [{
      keyId: "synthetic-desktop-key",
      algorithm: "ed25519" as const,
      publicKeyPem,
      fingerprintSha256,
      status: "active" as const,
      validFrom: "2026-01-01T00:00:00.000Z",
    }],
  };
  const trust: LinuxDesktopReleaseTrust = {
    keyring,
    policy: {
      ...embedded.policy,
      trustedKeyringRevision: 1,
      trustedKeyringSha256: releaseKeyringSha256(keyring),
      trustedKeyId: "synthetic-desktop-key",
      trustedKeyFingerprintSha256: fingerprintSha256,
    },
  };
  const now = "2026-09-10T01:00:00.000Z";
  const version = "0.2.1";
  const sourceRevision = "a".repeat(40);
  const archive = path.join(root, linuxDesktopArchiveName(version));
  await writeFile(archive, "synthetic packaged desktop archive");
  const descriptorPath = path.join(root, "descriptor.json");
  const releasePath = path.join(root, "release.json");
  const prepare = {
    archive,
    version,
    sourceRevision,
    createdAt: "2026-09-10T00:00:00.000Z",
    output: descriptorPath,
  };
  return { root, trust, now, pem, archive, descriptorPath, releasePath, prepare };
};

describe("Linux desktop local release CLI", () => {
  it("requires explicit bounded commands and paired local verification inputs", () => {
    expect(parseLinuxDesktopReleaseArgs(["--help"])).toEqual({ command: "help" });
    expect(parseLinuxDesktopReleaseArgs(["sign", "--help"])).toEqual({ command: "help" });
    expect(parseLinuxDesktopReleaseArgs(["verify", "--release", "release.json", "--current-version", "0.2.0", "--require-newer"]))
      .toEqual({ command: "verify", release: "release.json", currentVersion: "0.2.0", requireNewer: true });
    for (const argv of [
      [],
      ["publish"],
      ["sign", "--descriptor", "descriptor.json", "--private-key", "key.pem"],
      ["verify", "--release", "release.json", "--trust", "other-key.pem"],
      ["verify", "--release", "release.json", "--release", "other.json"],
      ["verify", "--release", "--help"],
      ["verify", "--release", "release.json", "extra"],
      ["verify", "--release", "release.json", "--sources", "sources.json"],
      ["verify", "--release", "release.json", "--require-newer"],
    ]) expect(() => parseLinuxDesktopReleaseArgs(argv)).toThrow();
  });

  it("hashes exact regular file bytes and refuses symlinks and empty inputs", async () => {
    const root = await temporary();
    const archive = path.join(root, "archive.tar.gz");
    const bytes = Buffer.from([0, 255, 128, 42]);
    await writeFile(archive, bytes);
    expect(await fingerprintLinuxDesktopFile(archive)).toEqual({
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    const alias = path.join(root, "alias.tar.gz");
    await symlink(archive, alias);
    await expect(fingerprintLinuxDesktopFile(alias)).rejects.toThrow(/regular file/);
    const empty = path.join(root, "empty.tar.gz");
    await writeFile(empty, "");
    await expect(fingerprintLinuxDesktopFile(empty)).rejects.toThrow(/regular file/);
    await expect(fingerprintLinuxDesktopFile(root)).rejects.toThrow(/regular file/);
    expect(await readFile(archive)).toEqual(bytes);
    await truncate(empty, 300_000_001);
    await expect(fingerprintLinuxDesktopFile(empty)).rejects.toThrow(/size limit/);
  });

  it("prepares, signs, and verifies an exact release using synthetic trust", async () => {
    const input = await fixture();
    const options = { trust: input.trust, now: input.now, stdin: stdin(input.pem) };
    const prepared = await runLinuxDesktopRelease([
      "prepare", "--archive", input.archive,
      "--version", input.prepare.version, "--source-revision", input.prepare.sourceRevision,
      "--created-at", input.prepare.createdAt,
      "--output", input.descriptorPath,
    ], options);
    expect(JSON.parse(prepared)).toEqual({ ok: true, command: "prepare", version: "0.2.1" });
    const descriptorText = await readFile(input.descriptorPath, "utf8");
    expect(descriptorText).toBe(canonicalLinuxDesktopReleaseDescriptor(JSON.parse(descriptorText)));
    const signed = await runLinuxDesktopRelease([
      "sign", "--descriptor", input.descriptorPath,
      "--output", input.releasePath,
    ], options);
    expect(JSON.parse(signed)).toEqual({ ok: true, command: "sign", version: "0.2.1" });
    const verified = await runLinuxDesktopRelease([
      "verify", "--release", input.releasePath, "--archive", input.archive,
      "--current-version", "0.2.0", "--require-newer", "--now", input.now,
    ], options);
    expect(JSON.parse(verified)).toEqual({ ok: true, command: "verify", version: "0.2.1" });
    expect(prepared + signed + verified).not.toContain(input.pem);
    expect(await verifyLinuxDesktopReleaseFiles({
      releasePath: input.releasePath, archivePath: input.archive,
      trust: input.trust, now: input.now,
    })).toEqual(JSON.parse(descriptorText));
  });

  it("never overwrites existing descriptor, signed release, or symlink outputs", async () => {
    const input = await fixture();
    const options = { trust: input.trust, now: input.now, stdin: stdin(input.pem) };
    await writeFile(input.descriptorPath, "keep this descriptor");
    await expect(prepareLinuxDesktopRelease(input.prepare, options)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(input.descriptorPath, "utf8")).toBe("keep this descriptor");
    await rm(input.descriptorPath);
    await prepareLinuxDesktopRelease(input.prepare, options);
    await symlink(input.archive, input.releasePath);
    await expect(signLinuxDesktopReleaseFile({ descriptor: input.descriptorPath, output: input.releasePath }, options))
      .rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(input.archive, "utf8")).toBe("synthetic packaged desktop archive");
    await rm(input.releasePath);
    await writeFile(input.releasePath, "keep this release");
    await expect(signLinuxDesktopReleaseFile({ descriptor: input.descriptorPath, output: input.releasePath }, options))
      .rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(input.releasePath, "utf8")).toBe("keep this release");
    expect((await readdir(input.root)).some((name) => name.startsWith("linux-desktop-release-stage-"))).toBe(false);
  });

  it("rejects noncanonical archive names before preparing", async () => {
    const input = await fixture();
    const options = { trust: input.trust };
    await expect(prepareLinuxDesktopRelease({ ...input.prepare, archive: path.join(input.root, "renamed.tar.gz") }, options))
      .rejects.toThrow(/canonical/);
    await expect(readFile(input.descriptorPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses empty, oversized, invalid, and untrusted key stdin without signed output", async () => {
    const input = await fixture();
    const options = { trust: input.trust, now: input.now };
    await prepareLinuxDesktopRelease(input.prepare, options);
    const sign = { descriptor: input.descriptorPath, output: input.releasePath };
    await expect(signLinuxDesktopReleaseFile(sign, { ...options, stdin: stdin() })).rejects.toThrow(/empty/);
    await expect(signLinuxDesktopReleaseFile(sign, { ...options, stdin: stdin("x".repeat(65_536), "x") })).rejects.toThrow(/size limit/);
    await expect(signLinuxDesktopReleaseFile(sign, { ...options, stdin: stdin(Buffer.from([0xff])) })).rejects.toThrow(/UTF-8/);
    await expect(signLinuxDesktopReleaseFile(sign, { ...options, stdin: stdin("sensitive-invalid-key-material") }))
      .rejects.toThrow("private key could not sign this release descriptor");
    const wrongKey = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    await expect(signLinuxDesktopReleaseFile(sign, { ...options, stdin: stdin(wrongKey) })).rejects.toThrow(/signature/);
    await expect(readFile(input.releasePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects inactive or unauthorized signing trust before reading stdin", async () => {
    const input = await fixture();
    await prepareLinuxDesktopRelease(input.prepare, { trust: input.trust });
    let reads = 0;
    const keyInput: AsyncIterable<string> = { async *[Symbol.asyncIterator]() { reads++; yield input.pem; } };
    const sign = { descriptor: input.descriptorPath, output: input.releasePath };
    for (const key of [
      { ...input.trust.keyring.keys[0]!, status: "retired" as const, signingEndsAt: "2026-09-11T00:00:00.000Z" },
      { ...input.trust.keyring.keys[0]!, validFrom: "2026-09-11T00:00:00.000Z" },
      { ...input.trust.keyring.keys[0]!, signingEndsAt: "2026-09-09T00:00:00.000Z" },
    ]) {
      const keyring = { ...input.trust.keyring, keys: [key] };
      const trust = { keyring, policy: { ...input.trust.policy, trustedKeyringSha256: releaseKeyringSha256(keyring) } };
      await expect(signLinuxDesktopReleaseFile(sign, { trust, now: input.now, stdin: keyInput })).rejects.toThrow(/authorization window/);
    }
    expect(reads).toBe(0);
    await expect(readFile(input.releasePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts permanent releases while rejecting non-newer, tampered metadata and changed local bytes", async () => {
    const input = await fixture();
    const options = { trust: input.trust, now: input.now, stdin: stdin(input.pem) };
    await prepareLinuxDesktopRelease(input.prepare, options);
    await signLinuxDesktopReleaseFile({ descriptor: input.descriptorPath, output: input.releasePath }, options);
    const verify = { release: input.releasePath, requireNewer: true, currentVersion: "0.2.0", archive: input.archive };
    await expect(verifyLinuxDesktopReleaseFile({ ...verify, now: "2036-10-01T00:00:00.000Z" }, options)).resolves.toMatchObject({ version: "0.2.1" });
    await expect(verifyLinuxDesktopReleaseFile({ ...verify, currentVersion: "0.2.1" }, options)).rejects.toThrow();
    const validText = await readFile(input.releasePath, "utf8");
    const tampered = JSON.parse(validText);
    tampered.descriptor.sourceRevision = "f".repeat(40);
    await writeFile(input.releasePath, JSON.stringify(tampered));
    await expect(verifyLinuxDesktopReleaseFile(verify, options)).rejects.toThrow();
    await writeFile(input.releasePath, validText);
    await writeFile(input.archive, "changed archive bytes");
    await expect(verifyLinuxDesktopReleaseFile(verify, options)).rejects.toThrow(/local release bytes/);
  });

  it("bounds metadata reads and refuses symlinked metadata", async () => {
    const input = await fixture();
    await prepareLinuxDesktopRelease(input.prepare, { trust: input.trust });
    const alias = path.join(input.root, "metadata-alias.json");
    await symlink(input.descriptorPath, alias);
    await expect(readLinuxDesktopReleaseJson(alias)).rejects.toThrow(/regular file/);
    await truncate(input.descriptorPath, 65_537);
    await expect(readLinuxDesktopReleaseJson(input.descriptorPath)).rejects.toThrow(/size limit/);
  });

});
