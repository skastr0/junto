import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  type ContentAvailabilityReason,
  ContentRef,
} from "../src/shared/content";
import {
  CONTENT_PROTOCOL_SCHEME,
  CONTENT_REASON_HEADER,
  CONTENT_STATE_HEADER,
  contentMediaKind,
  contentObjectUrl,
  parseContentObjectUrl,
} from "../src/shared/content-url";
import { createContentProtocolHandler } from "../src/main/vellum/content/protocol";
import { parseByteRangeHeader } from "../src/main/vellum/content/range";
import { contentObjectPath, contentStoreRoot } from "../src/main/vellum/content/paths";
import { ensureContentLayout } from "../src/main/vellum/content/store";

const sha256Of = (bytes: Buffer | string): string =>
  createHash("sha256").update(bytes).digest("hex");

const makeRef = (bytes: Buffer, mediaType: string) =>
  Schema.decodeUnknownSync(ContentRef)({
    sha256: sha256Of(bytes),
    byteLength: bytes.byteLength,
    mediaType,
  });

describe("content URL contract", () => {
  it("round-trips ContentRef through the app-owned URL", () => {
    const ref = makeRef(Buffer.from("hello-media"), "image/png");
    const url = contentObjectUrl(ref);
    expect(url.startsWith(`${CONTENT_PROTOCOL_SCHEME}://object/`)).toBe(true);
    expect(url.includes("byteLength=")).toBe(true);
    expect(url.includes("mediaType=")).toBe(true);
    expect(parseContentObjectUrl(url)).toEqual(ref);
  });

  it("rejects path injection and missing identity fields", () => {
    expect(parseContentObjectUrl("vellum-content://object/../etc/passwd")).toBeUndefined();
    expect(
      parseContentObjectUrl(
        `vellum-content://object/${"a".repeat(64)}?mediaType=image/png`,
      ),
    ).toBeUndefined();
    expect(
      parseContentObjectUrl(
        `vellum-content://object/${"a".repeat(64)}?byteLength=1&mediaType=image/png&path=/etc/passwd`,
      ),
    ).toBeUndefined();
  });

  it("classifies media kinds for element selection", () => {
    expect(contentMediaKind("image/png")).toBe("image");
    expect(contentMediaKind("audio/mpeg; codecs=mp3")).toBe("audio");
    expect(contentMediaKind("video/mp4")).toBe("video");
    expect(contentMediaKind("application/pdf")).toBe("binary");
  });
});

describe("byte range parsing", () => {
  it("returns full when Range is absent", () => {
    expect(parseByteRangeHeader(null, 100)).toEqual({ kind: "full" });
  });

  it("parses single ranges for seeking", () => {
    expect(parseByteRangeHeader("bytes=0-9", 100)).toEqual({
      kind: "partial",
      start: 0,
      end: 9,
      length: 10,
    });
    expect(parseByteRangeHeader("bytes=10-", 100)).toEqual({
      kind: "partial",
      start: 10,
      end: 99,
      length: 90,
    });
    expect(parseByteRangeHeader("bytes=-5", 100)).toEqual({
      kind: "partial",
      start: 95,
      end: 99,
      length: 5,
    });
  });

  it("rejects multi-range and out-of-bounds", () => {
    expect(parseByteRangeHeader("bytes=0-1,2-3", 100).kind).toBe("unsatisfiable");
    expect(parseByteRangeHeader("bytes=100-110", 100).kind).toBe("unsatisfiable");
    expect(parseByteRangeHeader("bytes=abc-def", 100).kind).toBe("unsatisfiable");
  });
});

describe("content protocol handler", () => {
  let home = "";
  let root = "";
  let bytes = Buffer.alloc(0);
  let ref: ReturnType<typeof makeRef>;
  let path = "";

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "vellum-content-protocol-"));
    root = contentStoreRoot(home);
    ensureContentLayout(root);
    bytes = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz");
    ref = makeRef(bytes, "video/mp4");
    path = contentObjectPath(root, ref.sha256);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, bytes);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("streams full object without buffering identity into status body", async () => {
    const handler = createContentProtocolHandler(async (requestRef) => {
      expect(requestRef.sha256).toBe(ref.sha256);
      return {
        state: "verified",
        path,
        byteLength: ref.byteLength,
        mediaType: ref.mediaType,
      };
    });

    const response = await handler(new Request(contentObjectUrl(ref)));
    expect(response.status).toBe(200);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get(CONTENT_STATE_HEADER)).toBe("verified");
    expect(response.headers.get("content-length")).toBe(String(bytes.byteLength));
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.equals(bytes)).toBe(true);
  });

  it("serves range requests for seeking", async () => {
    const handler = createContentProtocolHandler(async () => ({
      state: "verified",
      path,
      byteLength: ref.byteLength,
      mediaType: ref.mediaType,
    }));

    const response = await handler(
      new Request(contentObjectUrl(ref), {
        headers: { Range: "bytes=10-19" },
      }),
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(
      `bytes 10-19/${bytes.byteLength}`,
    );
    expect(response.headers.get("content-length")).toBe("10");
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.equals(bytes.subarray(10, 20))).toBe(true);
  });

  it("returns explicit missing and corrupt states", async () => {
    const missingHandler = createContentProtocolHandler(async () => ({
      ref,
      state: "missing",
      reason: "content object is not in the local manifest" as ContentAvailabilityReason,
    }));
    const missing = await missingHandler(new Request(contentObjectUrl(ref)));
    expect(missing.status).toBe(404);
    expect(missing.headers.get(CONTENT_STATE_HEADER)).toBe("missing");
    expect(missing.headers.get(CONTENT_REASON_HEADER)).toMatch(/manifest/i);

    const corruptHandler = createContentProtocolHandler(async () => ({
      ref,
      state: "corrupt",
      reason: "content object size does not match ContentRef" as ContentAvailabilityReason,
    }));
    const corrupt = await corruptHandler(new Request(contentObjectUrl(ref)));
    expect(corrupt.status).toBe(409);
    expect(corrupt.headers.get(CONTENT_STATE_HEADER)).toBe("corrupt");
  });

  it("HEAD reports length without a body", async () => {
    const handler = createContentProtocolHandler(async () => ({
      state: "verified",
      path,
      byteLength: ref.byteLength,
      mediaType: ref.mediaType,
    }));
    const head = await handler(
      new Request(contentObjectUrl(ref), { method: "HEAD" }),
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(bytes.byteLength));
    expect(await head.text()).toBe("");
  });
});
