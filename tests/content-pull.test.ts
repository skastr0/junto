/**
 * Admission for a pulled body: the editing machine serves a piece only of an
 * object it holds verified, under a pullable owner on the asker's canvas, and
 * each refusal names what the asker does next.
 */
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  CONTENT_PULL_PIECE_BYTES,
  ContentPullPiece,
  ContentPullRefused,
  ContentPullRequest,
  admitContentPull,
  contentPullPieceLength,
  contentPullRefused,
  type ContentPullFacts,
} from "../src/shared/content-pull";
import { LINK_FRAME_MAX_BYTES } from "../src/shared/exchange-bounds";

const request = (over: Partial<ContentPullRequest> = {}): ContentPullRequest =>
  Schema.decodeUnknownSync(ContentPullRequest)({ canvasName: "factory", sha256: "a".repeat(64), byteLength: 1000, offset: 0, ...over });
const held: ContentPullFacts = { edits: true, peerLinked: true, heldVerified: true, owners: [{ kind: "artifact", canvasName: "factory" }] };

describe("admitting a pull", () => {
  it("serves an artifact body it holds verified to a machine linked for its canvas", () => {
    expect(admitContentPull(request(), held)).toBeUndefined();
    expect(admitContentPull(request({ offset: 999 }), held)).toBeUndefined();
  });

  it("sends the asker to the editing machine when it does not edit the canvas", () => {
    expect(admitContentPull(request(), { ...held, edits: false })).toBe("not-editor");
  });

  it("serves nothing it does not hold, under no pullable owner, on another canvas, or to a machine not linked for it", () => {
    for (const facts of [
      { ...held, heldVerified: false },
      { ...held, peerLinked: false },
      { ...held, owners: [] },
      { ...held, owners: [{ kind: "message", canvasName: "factory" }] },
      { ...held, owners: [{ kind: "other", canvasName: "factory" }] },
      { ...held, owners: [{ kind: "artifact", canvasName: "other-canvas" }] },
    ]) expect(admitContentPull(request(), facts)).toBe("not-held");
  });

  it("refuses a piece outside the object, and takes the one piece of an empty object", () => {
    expect(admitContentPull(request({ offset: 1000 }), held)).toBe("range");
    expect(admitContentPull(request({ offset: 1001 }), held)).toBe("range");
    expect(admitContentPull(request({ byteLength: 0, offset: 0 }), held)).toBeUndefined();
  });

  it("decides holdings before range, so a range answer says nothing of what it holds", () => {
    expect(admitContentPull(request({ offset: 5000 }), { ...held, heldVerified: false })).toBe("not-held");
  });

  it("refuses with the digest, the size and the reason only", () => {
    const refused = contentPullRefused("not-held", { sha256: "a".repeat(64), byteLength: 1000 });
    // As it crosses the link: the channel's failure schema encodes exactly these.
    expect(Object.keys(Schema.encodeSync(ContentPullRefused)(refused)).sort()).toEqual(["_tag", "byteLength", "message", "reason", "sha256"]);
    expect(refused.message).not.toMatch(/\//);
  });
});

describe("a piece", () => {
  it("is at most one piece long, and the last is what is left", () => {
    expect(contentPullPieceLength(3 * CONTENT_PULL_PIECE_BYTES, 0)).toBe(CONTENT_PULL_PIECE_BYTES);
    expect(contentPullPieceLength(CONTENT_PULL_PIECE_BYTES + 7, CONTENT_PULL_PIECE_BYTES)).toBe(7);
    expect(contentPullPieceLength(10, 10)).toBe(0);
  });

  it("fits one link frame as a response, with its envelope", () => {
    const piece = Schema.decodeUnknownSync(ContentPullPiece)({ offset: Number.MAX_SAFE_INTEGER, bytes: Buffer.alloc(CONTENT_PULL_PIECE_BYTES).toString("base64") });
    const frame = { type: "response", id: "x".repeat(64), op: "x".repeat(64), channel: "content", ok: true, payload: piece };
    expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThan(LINK_FRAME_MAX_BYTES);
  });

  it("refuses bytes that are not base64 or longer than a piece", () => {
    const decode = Schema.decodeUnknownResult(ContentPullPiece);
    expect(decode({ offset: 0, bytes: "not base64!" })._tag).toBe("Failure");
    expect(decode({ offset: 0, bytes: Buffer.alloc(CONTENT_PULL_PIECE_BYTES + 3).toString("base64") })._tag).toBe("Failure");
  });
});
