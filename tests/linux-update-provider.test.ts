import { createHash, generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeLinuxUpdateProvider, type LinuxUpdateDependencies } from "../src/main/junto/update/linux";
import type { UpdateProvider, UpdateProviderEvent } from "../src/main/junto/update/provider";
import { LINUX_DESKTOP_TARGET, linuxDesktopArchiveName, type LinuxDesktopReleaseDescriptor } from "../src/shared/linux-desktop-release";
import { signLinuxDesktopRelease, verifyLinuxDesktopRelease, type LinuxDesktopReleaseTrust } from "../src/shared/linux-desktop-release-crypto";

const pair = generateKeyPairSync("ed25519");
const hash = (body: string | Buffer): string => createHash("sha256").update(body).digest("hex");
const fingerprint = hash(pair.publicKey.export({ format: "der", type: "spki" }));
const keyring = { schema: "junto/linux-release-keyring/v1" as const, revision: 1, keys: [{
  keyId: "synthetic-updater-test", algorithm: "ed25519" as const,
  publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
  fingerprintSha256: fingerprint, status: "active" as const, validFrom: "2026-09-01T00:00:00.000Z",
}] };
const trust: LinuxDesktopReleaseTrust = { keyring, policy: {
  schema: "junto/linux-release-trust-policy/v1", state: "configured", trustedKeyringRevision: 1,
  trustedKeyringSha256: hash(`${JSON.stringify(keyring, null, 2)}\n`),
  trustedKeyId: keyring.keys[0]!.keyId, trustedKeyFingerprintSha256: fingerprint,
} };
const target = { platform: "linux", architecture: "x64", osRelease: 'ID=ubuntu\nVERSION_ID="24.04"\n', glibcVersion: "2.39", uid: 501, euid: 501 };
const archive = Buffer.from("synthetic archive download bytes");
const descriptor = (version = "0.2.1"): LinuxDesktopReleaseDescriptor => ({
  schema: "junto/linux-desktop-release/v1", product: "Junto", channel: "alpha", version,
  sourceRevision: "a".repeat(40), createdAt: "2026-09-10T00:00:00.000Z", target: LINUX_DESKTOP_TARGET,
  archive: { file: linuxDesktopArchiveName(version), path: `/linux/x64/${linuxDesktopArchiveName(version)}`, bytes: archive.length, sha256: hash(archive) },
  trust: { algorithm: "ed25519", keyId: keyring.keys[0]!.keyId, keyringRevision: 1 },
});
const providers: UpdateProvider[] = [];
afterEach(() => { for (const provider of providers.splice(0)) provider.stop(); });
const harness = (input: { version?: string; packaged?: boolean; archive?: Buffer; metadata?: unknown; target?: typeof target; now?: string; managed?: boolean } = {}) => {
  const release = signLinuxDesktopRelease(descriptor(input.version), pair.privateKey);
  const calls: { url: string; options: RequestInit | undefined }[] = [];
  const fetch: LinuxUpdateDependencies["fetch"] = vi.fn(async (url, options) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1) return new Response(JSON.stringify(input.metadata ?? release));
    return new Response(Uint8Array.from(input.archive ?? archive));
  });
  const provider = makeLinuxUpdateProvider({ isPackaged: input.packaged ?? true, currentVersion: "0.2.0" }, {
    fetch, inspectTarget: async () => input.target ?? target,
    assertManagedIncumbent: async () => { if (input.managed === false) throw new Error("running app is not the managed desktop installation"); },
    verifyRelease: (envelope, currentVersion, requireNewer) => verifyLinuxDesktopRelease(envelope, {
      trust, currentVersion, requireNewer, now: input.now ?? "2026-09-10T12:00:00.000Z",
    }),
  });
  providers.push(provider);
  const events: UpdateProviderEvent[] = [];
  provider.start((event) => events.push(event));
  return { provider, events, calls, fetch };
};

describe("Linux desktop update provider", () => {
  it("verifies and streams exact bytes from fixed feed paths without installing", async () => {
    const { provider, events, calls } = harness();
    await provider.check();
    expect(events.map((event) => event._tag)).toEqual(["checking", "available", "progress", "downloaded"]);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/linux/x64/alpha.json", "/linux/x64/junto-runtime-0.2.1-linux-x64.tar.gz"]);
    expect(calls.every((call) => new URL(call.url).protocol === "https:" && call.options?.redirect === "error")).toBe(true);
    const downloaded = events.find((event) => event._tag === "downloaded");
    expect(downloaded?._tag).toBe("downloaded");
    if (downloaded?._tag === "downloaded") expect(await readFile(downloaded.downloadedFile)).toEqual(archive);
    expect(() => provider.quitAndInstall()).toThrow(/admitted installation transaction/);
  });
  it("coalesces concurrent checks", async () => {
    const { provider, calls } = harness();
    await Promise.all([provider.check(), provider.check()]);
    expect(calls).toHaveLength(2);
  });
  it.each(["0.2.0", "0.1.9"])("does not download same or older release %s", async (version) => {
    const { provider, events, calls } = harness({ version });
    await provider.check();
    expect(events.at(-1)).toEqual({ _tag: "not-available" });
    expect(calls).toHaveLength(1);
  });
  it("refuses an unmanaged app before making network requests", async () => {
    const { provider, events, calls } = harness({ managed: false });
    await provider.check();
    expect(calls).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ _tag: "error", message: expect.stringContaining("not the managed") });
  });
  it("does not make network requests in source builds", async () => {
    const { provider, events, calls } = harness({ packaged: false });
    await provider.check();
    expect(calls).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ _tag: "error", code: "not-packaged" });
  });
  it("reports a target refusal separately from a download failure", async () => {
    const { provider, events, calls } = harness({ target: { ...target, architecture: "arm64" } });
    await provider.check();
    expect(calls).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ _tag: "error", code: "platform-unsupported" });
  });
  it("rejects unauthenticated metadata before downloading any artifact", async () => {
    const release = signLinuxDesktopRelease(descriptor(), pair.privateKey);
    const { provider, events, calls } = harness({ metadata: { ...release, signature: "a".repeat(86) } });
    await provider.check();
    expect(calls).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ _tag: "error", code: "check-failed" });
  });
  it("rejects future-dated signed metadata", async () => {
    const { provider, events, calls } = harness({ now: "2026-09-09T00:00:00.000Z" });
    await provider.check();
    expect(calls).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ _tag: "error", message: expect.stringContaining("future") });
  });
  it.each([Buffer.from("wrong archive"), Buffer.alloc(archive.length + 1), Buffer.alloc(archive.length)])("rejects short, long, or corrupt artifact bytes", async (body) => {
    const { provider, events } = harness({ archive: body });
    await provider.check();
    expect(events.some((event) => event._tag === "downloaded")).toBe(false);
    expect(events.at(-1)).toMatchObject({ _tag: "error", code: "download-failed" });
  });
  it("refuses a path that was not downloaded by the provider", async () => {
    const { provider } = harness();
    await expect(provider.stageDownloaded!("/unowned/archive.tar.gz", { version: "0.2.1" })).rejects.toThrow(/not downloaded by this provider/);
  });
  it("bounds metadata before parsing it", async () => {
    const { provider, events, calls } = harness({ metadata: "x".repeat(65_536) });
    await provider.check();
    expect(calls).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ _tag: "error", message: expect.stringContaining("byte limit") });
  });
});
