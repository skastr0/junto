/**
 * `content.get`: the phone reads an attachment's bytes, in chunks, only when
 * a current Needs you feed names its digest. Membership is decided before
 * the store is asked, so an unknown digest and one outside every feed read
 * the same. The store side is a confined ranged read.
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { feedContentRefs, handleCompanionRequest, makeCompanionGates, outcomeFail, outcomeOk, type CompanionBackend } from "../src/shared/companion-core";
import { demoRequest, makeDemoHost } from "../src/shared/companion-demo";
import {
  COMPANION_CONTENT_CHUNK_MAX,
  COMPANION_MAX_OUTBOUND_BYTES,
  decodeCompanionRequestLine,
  type CompanionRequestFrame,
} from "../src/shared/companion-protocol";
import { DEMO_CONTENT, DEMO_CONTENT_AFTER, DEMO_CONTENT_BEFORE, DEMO_CONTENT_NOTES } from "../src/shared/wire/companion-demo-fixture";
import type { ContentRef } from "../src/shared/wire/content-ref";
import { contentObjectPath } from "../src/main/junto/content/paths";
import { ingestContentBytes, readContentObjectRange } from "../src/main/junto/content/store";
import { THIS_MACHINE } from "./support/machines";

const frame = (args: object, id = "c1"): CompanionRequestFrame => {
  const decoded = decodeCompanionRequestLine(demoRequest(id, "content.get", args));
  if (Result.isFailure(decoded)) throw new Error(`did not decode: ${JSON.stringify(decoded.failure)}`);
  return decoded.success;
};

const demo = () => makeDemoHost({ appVersion: "test", machineName: THIS_MACHINE });

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

describe("the demo's stored files", () => {
  it("are the bytes their refs name", () => {
    for (const content of DEMO_CONTENT) {
      const bytes = new TextEncoder().encode(content.text);
      expect(sha(bytes), content.ref.displayName).toBe(content.ref.sha256);
      expect(bytes.byteLength).toBe(content.ref.byteLength);
    }
  });
});

describe("content.get against the demo", () => {
  it("serves a file attachment and both texts of a compare, whole and verifiable", async () => {
    const host = demo();
    for (const content of [DEMO_CONTENT_NOTES, DEMO_CONTENT_BEFORE, DEMO_CONTENT_AFTER]) {
      const response = await host.call(frame({ sha256: content.ref.sha256, offset: 0, length: COMPANION_CONTENT_CHUNK_MAX }));
      expect(response).toMatchObject({ ok: true, result: { sha256: content.ref.sha256, offset: 0, length: content.ref.byteLength, byteLength: content.ref.byteLength } });
      const data = Buffer.from((response as { result: { data: string } }).result.data, "base64");
      expect(sha(data)).toBe(content.ref.sha256);
    }
  });

  it("chunks: a later range returns exactly its bytes, shorter only at the end", async () => {
    const host = demo();
    const { ref, text } = DEMO_CONTENT_NOTES;
    const whole = new TextEncoder().encode(text);
    const parts: Buffer[] = [];
    for (let offset = 0; offset < ref.byteLength; offset += 40) {
      const response = await host.call(frame({ sha256: ref.sha256, offset, length: 40 }));
      const result = (response as { result: { length: number; data: string } }).result;
      expect(result.length).toBe(Math.min(40, ref.byteLength - offset));
      parts.push(Buffer.from(result.data, "base64"));
    }
    expect(Buffer.concat(parts).equals(Buffer.from(whole))).toBe(true);
  });

  it("refuses a digest in no feed with the same answer as one the store never held", async () => {
    const host = demo();
    const unknown = await host.call(frame({ sha256: "0".repeat(64), offset: 0, length: 16 }));
    expect(unknown).toMatchObject({ ok: false, error: { code: "not-found", message: "That file is no longer in your feed." } });
  });

  it("refuses a range past the end, and malformed or open arguments", async () => {
    const host = demo();
    const past = await host.call(frame({ sha256: DEMO_CONTENT_NOTES.ref.sha256, offset: DEMO_CONTENT_NOTES.ref.byteLength, length: 1 }));
    expect(past).toMatchObject({ ok: false, error: { code: "invalid" } });
    for (const args of [
      { sha256: "ABC", offset: 0, length: 1 },
      { sha256: DEMO_CONTENT_NOTES.ref.sha256, offset: -1, length: 1 },
      { sha256: DEMO_CONTENT_NOTES.ref.sha256, offset: 0, length: COMPANION_CONTENT_CHUNK_MAX + 1 },
      { sha256: DEMO_CONTENT_NOTES.ref.sha256, offset: 0, length: 1, path: "/etc/passwd" },
    ]) {
      const decoded = decodeCompanionRequestLine(demoRequest("bad", "content.get", args));
      expect(Result.isFailure(decoded), JSON.stringify(args)).toBe(true);
    }
  });
});

describe("content.get through the request core", () => {
  const ref = { sha256: "a".repeat(64), byteLength: COMPANION_CONTENT_CHUNK_MAX * 2, mediaType: "application/octet-stream" } as ContentRef;
  const feedWith = (refs: ReadonlyArray<ContentRef>) =>
    [{ version: 3, canvasName: "c", generatedAt: 0, count: 1, sections: [{ region: { regionId: null, label: "", path: [] }, worstUrgency: 1,
      items: [{ itemId: "i", kind: "feedback", urgency: 1, canvasName: "c", seat: { nodeId: "n", name: "N", portraitIdentity: "n" },
        region: { regionId: null, label: "", path: [] }, text: "t", attachments: refs.map((r) => ({ ref: r })) }] }] }] as never;
  const backendOf = (over: Partial<CompanionBackend>): CompanionBackend => ({
    now: () => 0,
    pairComplete: async () => outcomeFail("invalid"),
    canvases: async () => outcomeOk([]),
    feeds: async () => outcomeOk(feedWith([ref])),
    seats: async () => outcomeOk([]),
    seatDetail: async () => outcomeFail("not-found"),
    answerSignal: async () => outcomeFail("not-found"),
    dismissSignal: async () => outcomeFail("not-found"),
    mailList: async () => outcomeOk([]),
    mailSend: async () => outcomeFail("not-found"),
    quickReplies: async () => outcomeOk({ replies: [] }),
    stagePiece: async () => outcomeFail("invalid"),
    admitStage: async () => outcomeOk(undefined),
    dropStaged: async () => undefined,
    portrait: async () => outcomeOk({ svg: "" }),
    contentRange: async (_ref, _offset, length) => outcomeOk(new Uint8Array(length)),
    machines: async () => outcomeOk([]),
    machine: async () => outcomeFail("not-found"),
    tailnetPeers: async () => outcomeOk({ available: false, peers: [] }),
    threads: async () => outcomeOk({ threads: [], cut: false }),
    thread: async () => outcomeFail("not-found"),
    canvasScene: async () => outcomeFail("not-found"),
    ...over,
  });
  const call = (backend: CompanionBackend, args: object, gates = makeCompanionGates()) =>
    handleCompanionRequest(frame(args), { backend, device: { deviceId: "dev", state: "paired" }, allowWrite: () => true, gates });

  it("never asks the store for a digest outside the feed", async () => {
    let asked = 0;
    const backend = backendOf({ feeds: async () => outcomeOk(feedWith([])), contentRange: async () => { asked += 1; return outcomeOk(new Uint8Array(1)); } });
    expect(await call(backend, { sha256: ref.sha256, offset: 0, length: 1 })).toMatchObject({ ok: false, error: { code: "not-found" } });
    expect(asked).toBe(0);
  });

  it("checks membership on every request: a ref that leaves the feed mid-download is refused on its next chunk", async () => {
    let refs: ReadonlyArray<ContentRef> = [ref];
    const backend = backendOf({ feeds: async () => outcomeOk(feedWith(refs)) });
    expect(await call(backend, { sha256: ref.sha256, offset: 0, length: 16 })).toMatchObject({ ok: true });
    refs = [];
    expect(await call(backend, { sha256: ref.sha256, offset: 16, length: 16 })).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("says unavailable when the feed names the ref but the store cannot give its bytes", async () => {
    const backend = backendOf({ contentRange: async () => outcomeFail("unavailable") });
    expect(await call(backend, { sha256: ref.sha256, offset: 0, length: 16 })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    const short = backendOf({ contentRange: async () => outcomeOk(new Uint8Array(3)) });
    expect(await call(short, { sha256: ref.sha256, offset: 0, length: 16 })).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });

  it("keeps a full chunk under the outbound frame", async () => {
    const response = await call(backendOf({}), { sha256: ref.sha256, offset: 0, length: COMPANION_CONTENT_CHUNK_MAX });
    expect(new TextEncoder().encode(`${JSON.stringify(response)}\n`).byteLength).toBeLessThan(COMPANION_MAX_OUTBOUND_BYTES);
  });

  it("holds a phone to four unanswered requests, and frees a slot when one answers", async () => {
    const gate = makeCompanionGates();
    const waits: Array<() => void> = [];
    const backend = backendOf({ contentRange: (_r, _o, length) => new Promise((resolve) => waits.push(() => resolve(outcomeOk(new Uint8Array(length))))) });
    const pending = [0, 1, 2, 3].map(() => call(backend, { sha256: ref.sha256, offset: 0, length: 1 }, gate));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await call(backend, { sha256: ref.sha256, offset: 0, length: 1 }, gate)).toMatchObject({ ok: false, error: { code: "rate-limited" } });
    waits.shift()!();
    await pending[0];
    const fifth = call(backend, { sha256: ref.sha256, offset: 0, length: 1 }, gate);
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const wake of waits) wake();
    expect(await fifth).toMatchObject({ ok: true });
    await Promise.all(pending);
  });

  it("lists file refs and both sides of a compare, and nothing for commits or links", () => {
    const other = { ...ref, sha256: "b".repeat(64) } as ContentRef;
    const feeds = feedWith([]) as unknown as Parameters<typeof feedContentRefs>[0];
    (feeds[0]!.sections[0]!.items[0] as { attachments: unknown }).attachments = [
      { ref }, { kind: "compare", before: other, after: ref }, { kind: "commit", sha: "c".repeat(40) },
    ];
    expect([...feedContentRefs(feeds).keys()].sort()).toEqual([ref.sha256, other.sha256].sort());
  });
});

describe("the store's confined ranged read", () => {
  const roots: string[] = [];
  afterEach(async () => {
    while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
  });
  const stored = async () => {
    const root = await mkdtemp(join(tmpdir(), "junto-content-range-"));
    roots.push(root);
    const bytes = new TextEncoder().encode("0123456789abcdef");
    const ingested = await ingestContentBytes({ root, source: bytes, mediaType: "text/plain" });
    return { root, ref: { sha256: ingested.ref.sha256, byteLength: ingested.ref.byteLength } };
  };

  it("reads exactly the asked range", async () => {
    const { root, ref } = await stored();
    expect(new TextDecoder().decode(readContentObjectRange(root, ref, 4, 6))).toBe("456789");
  });

  it("refuses an object of another size than its ref", async () => {
    const { root, ref } = await stored();
    expect(readContentObjectRange(root, { ...ref, byteLength: (ref.byteLength + 1) as ContentRef["byteLength"] }, 0, 4)).toBeUndefined();
  });

  it("never follows a symlink planted at the object's path", async () => {
    const { root, ref } = await stored();
    const outside = join(roots[0]!, "outside.txt");
    await writeFile(outside, "0123456789abcdef");
    const path = contentObjectPath(root, ref.sha256);
    await unlink(path);
    await symlink(outside, path);
    expect(readContentObjectRange(root, ref, 0, 4)).toBeUndefined();
  });
});
