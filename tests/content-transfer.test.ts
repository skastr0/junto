import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseContentHelperArgs,
  contentHelperArgv,
} from "../src/main/junto/content/helper-contract";
import {
  contentObjectPath,
  contentPartialPath,
  contentStoreRoot,
} from "../src/main/junto/content/paths";
import {
  contentRefForTransfer,
  contentTransferPartialId,
  receiveContentTransfer,
  sendContentTransfer,
  statContentForTransfer,
  parseContentHelperStatus,
  encodeContentHelperStatus,
} from "../src/main/junto/content/transfer-local";
import {
  ContentStoreError,
  ingestContentBytes,
} from "../src/main/junto/content/store";
import { lstatSync, existsSync } from "node:fs";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

const tempRoot = async (prefix: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
};

const sha256Hex = (bytes: Buffer | string): string =>
  createHash("sha256").update(bytes).digest("hex");

const makePayload = (size: number, seed = 7): Buffer => {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) {
    buf[i] = (i * seed + 13) & 0xff;
  }
  return buf;
};

describe("content helper contract", () => {
  it("admits only closed receive/send/stat argv", () => {
    const sha = "a".repeat(64);
    expect(
      parseContentHelperArgs(["receive", sha, "1024", "0"]),
    ).toMatchObject({ mode: "receive", sha256: sha, byteLength: 1024, offset: 0 });
    expect(
      parseContentHelperArgs(["send", sha, "10", "3"]),
    ).toMatchObject({ mode: "send", offset: 3 });
    expect(parseContentHelperArgs(["stat", sha, "10"])).toMatchObject({
      mode: "stat",
    });
    expect(parseContentHelperArgs(["rm", "-rf", "/"])).toMatchObject({
      ok: false,
      exitCode: 64,
    });
    expect(parseContentHelperArgs(["receive", "../x", "1"])).toMatchObject({
      ok: false,
    });
    expect(
      contentHelperArgv({
        mode: "receive",
        sha256: sha,
        byteLength: 4,
        offset: 1,
      }),
    ).toEqual(["receive", sha, "4", "1"]);
  });

  it("parses helper status lines and rejects garbage", () => {
    const ok = encodeContentHelperStatus({
      ok: true,
      state: "verified",
      sha256: "b".repeat(64),
      byteLength: 1,
      verifiedAt: "2026-01-01T00:00:00.000Z",
    });
    const parsed = parseContentHelperStatus(ok);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.state).toBe("verified");
    expect(parseContentHelperStatus("not-json").ok).toBe(false);
  });
});

describe("content transfer local plane", () => {
  it("publishes only after full digest+length verification", async () => {
    const home = await tempRoot("junto-xfer-publish-");
    const root = contentStoreRoot(home);
    const bytes = makePayload(64 * 1024 + 17);
    const ref = contentRefForTransfer({
      sha256: sha256Hex(bytes),
      byteLength: bytes.length,
      mediaType: "application/octet-stream",
    });

    const result = await receiveContentTransfer({
      root,
      ref,
      source: bytes,
      expectedOffset: 0,
    });
    expect(result.state).toBe("verified");
    if (result.state !== "verified") return;
    expect(result.created).toBe(true);
    expect(existsSync(result.path)).toBe(true);
    expect(lstatSync(result.path).size).toBe(bytes.length);
    const onDisk = await readFile(result.path);
    expect(sha256Hex(onDisk)).toBe(ref.sha256);
    // No partial left after publish.
    expect(
      existsSync(
        contentPartialPath(root, contentTransferPartialId(ref.sha256)),
      ),
    ).toBe(false);
  });

  it("resumes a partial transfer without restarting from zero", async () => {
    const home = await tempRoot("junto-xfer-resume-");
    const root = contentStoreRoot(home);
    const bytes = makePayload(50_000);
    const ref = contentRefForTransfer({
      sha256: sha256Hex(bytes),
      byteLength: bytes.length,
    });
    const firstHalf = bytes.subarray(0, 20_000);
    const secondHalf = bytes.subarray(20_000);

    const partial = await receiveContentTransfer({
      root,
      ref,
      source: firstHalf,
      expectedOffset: 0,
    });
    expect(partial.state).toBe("partial");
    if (partial.state !== "partial") return;
    expect(partial.receivedBytes).toBe(20_000);

    const stat = statContentForTransfer(root, ref);
    expect(stat.state).toBe("partial");
    if (stat.state !== "partial") return;
    expect(stat.partialBytes).toBe(20_000);

    const done = await receiveContentTransfer({
      root,
      ref,
      source: secondHalf,
      expectedOffset: 20_000,
    });
    expect(done.state).toBe("verified");
    if (done.state !== "verified") return;
    expect(sha256Hex(await readFile(done.path))).toBe(ref.sha256);
  });

  it("rejects a resume offset that does not match the partial", async () => {
    const home = await tempRoot("junto-xfer-offset-");
    const root = contentStoreRoot(home);
    const bytes = makePayload(1000);
    const ref = contentRefForTransfer({
      sha256: sha256Hex(bytes),
      byteLength: bytes.length,
    });
    await receiveContentTransfer({
      root,
      ref,
      source: bytes.subarray(0, 100),
      expectedOffset: 0,
    });
    await expect(
      receiveContentTransfer({
        root,
        ref,
        source: bytes.subarray(100),
        expectedOffset: 50,
      }),
    ).rejects.toBeInstanceOf(ContentStoreError);
  });

  it("never reports verified for a corrupt stream", async () => {
    const home = await tempRoot("junto-xfer-corrupt-");
    const root = contentStoreRoot(home);
    const good = makePayload(2048);
    const bad = makePayload(2048, 99);
    const ref = contentRefForTransfer({
      sha256: sha256Hex(good),
      byteLength: good.length,
    });
    await expect(
      receiveContentTransfer({
        root,
        ref,
        source: bad,
        expectedOffset: 0,
      }),
    ).rejects.toMatchObject({ code: "corrupt" });
    // Object must not be published under the claimed digest.
    expect(existsSync(contentObjectPath(root, ref.sha256))).toBe(false);
    const availability = statContentForTransfer(root, ref);
    expect(availability.state === "verified").toBe(false);
  });

  it("is idempotent when the digest is already verified", async () => {
    const home = await tempRoot("junto-xfer-idem-");
    const root = contentStoreRoot(home);
    const bytes = Buffer.from("station-content-transfer-idempotent");
    const first = await ingestContentBytes({
      root,
      source: bytes,
      mediaType: "text/plain",
    });
    const again = await receiveContentTransfer({
      root,
      ref: first.ref,
      source: bytes,
      expectedOffset: 0,
    });
    expect(again.state).toBe("verified");
    if (again.state !== "verified") return;
    expect(again.created).toBe(false);
    expect(again.path).toBe(first.path);
  });

  it("sends remaining bytes from an offset for pull", async () => {
    const home = await tempRoot("junto-xfer-send-");
    const root = contentStoreRoot(home);
    const bytes = makePayload(4096);
    const ingested = await ingestContentBytes({
      root,
      source: bytes,
      mediaType: "application/octet-stream",
    });
    const chunks: Buffer[] = [];
    for await (const chunk of sendContentTransfer({
      root,
      ref: ingested.ref,
      offset: 1000,
    })) {
      chunks.push(chunk);
    }
    const rebuilt = Buffer.concat(chunks);
    expect(rebuilt.length).toBe(bytes.length - 1000);
    expect(Buffer.compare(rebuilt, bytes.subarray(1000))).toBe(0);
  });

  it("simulates push→receive across two local stores (CC and Remote)", async () => {
    const ccHome = await tempRoot("junto-xfer-cc-");
    const remoteHome = await tempRoot("junto-xfer-remote-");
    const ccRoot = contentStoreRoot(ccHome);
    const remoteRoot = contentStoreRoot(remoteHome);
    const bytes = makePayload(32_000, 3);
    const ingested = await ingestContentBytes({
      root: ccRoot,
      source: bytes,
      mediaType: "video/mp4",
      displayName: "clip.mp4",
    });

    // Interrupted first wave to remote.
    const wave1 = await receiveContentTransfer({
      root: remoteRoot,
      ref: ingested.ref,
      source: bytes.subarray(0, 10_000),
      expectedOffset: 0,
    });
    expect(wave1.state).toBe("partial");

    // Resume remainder (as CC would after remote stat).
    const remoteStat = statContentForTransfer(remoteRoot, ingested.ref);
    expect(remoteStat.state).toBe("partial");
    if (remoteStat.state !== "partial") return;

    const remaining: Buffer[] = [];
    for await (const chunk of sendContentTransfer({
      root: ccRoot,
      ref: ingested.ref,
      offset: remoteStat.partialBytes,
    })) {
      remaining.push(chunk);
    }

    const wave2 = await receiveContentTransfer({
      root: remoteRoot,
      ref: ingested.ref,
      source: (async function* () {
        for (const c of remaining) yield c;
      })(),
      expectedOffset: remoteStat.partialBytes,
    });
    expect(wave2.state).toBe("verified");
    if (wave2.state !== "verified") return;
    expect(sha256Hex(await readFile(wave2.path))).toBe(ingested.ref.sha256);

    // Duplicate delivery is idempotent.
    const dup = await receiveContentTransfer({
      root: remoteRoot,
      ref: ingested.ref,
      source: bytes,
      expectedOffset: 0,
    });
    expect(dup.state).toBe("verified");
    if (dup.state !== "verified") return;
    expect(dup.created).toBe(false);
  });
});
