import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  ContentAvailability,
  ContentByteLength,
  ContentCorrupt,
  ContentLocalPathProjection,
  ContentMissing,
  ContentPart,
  ContentReceipt,
  ContentRef,
  ContentUnavailable,
  decodeContentRef,
} from "../src/shared/content";

const sha256 = "a".repeat(64);
const ref = {
  sha256,
  byteLength: 1_073_741_824,
  mediaType: "video/mp4",
  displayName: "demo.mp4",
} as const;

describe("content object contract", () => {
  it("identifies bytes without a path and accepts large JSON-safe lengths", () => {
    const decoded = Schema.decodeUnknownSync(ContentRef)(ref);
    expect(decoded).toEqual(ref);
    expect("path" in decoded).toBe(false);
    expect(Result.isSuccess(decodeContentRef(ref))).toBe(true);
    expect(
      Result.isFailure(
        decodeContentRef({ ...ref, path: "/Users/operator/video.mp4" }),
      ),
    ).toBe(true);
  });

  it("rejects non-canonical digests and unsafe byte lengths", () => {
    expect(() =>
      Schema.decodeUnknownSync(ContentRef)({ ...ref, sha256: "A".repeat(64) }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ContentRef)({
        ...ref,
        byteLength: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow();
  });

  it("keeps local paths in a tagged projection, never in the portable ref", () => {
    expect(
      Schema.decodeUnknownSync(ContentLocalPathProjection)({
        kind: "local-path",
        ref,
        path: "/Users/operator/.junto/content/aa/bb/object",
      }),
    ).toEqual({
      kind: "local-path",
      ref,
      path: "/Users/operator/.junto/content/aa/bb/object",
    });
  });

  it("requires matching identity on verified receipts", () => {
    const verified = {
      ref,
      state: "verified" as const,
      verifiedSha256: sha256,
      verifiedByteLength: ref.byteLength,
      verifiedAt: "2026-07-31T12:00:00.000Z",
    };
    expect(Schema.decodeUnknownSync(ContentReceipt)(verified)).toEqual(verified);
    expect(() =>
      Schema.decodeUnknownSync(ContentReceipt)({
        ...verified,
        verifiedByteLength: 2,
      }),
    ).toThrow(/verified receipt/);
  });

  it("makes missing, corrupt, and unavailable states explicit", () => {
    const missing = {
      ref,
      state: "missing" as const,
      reason: "not transferred",
    };
    const corrupt = {
      ref,
      state: "corrupt" as const,
      reason: "digest mismatch",
      observedSha256: "b".repeat(64),
      observedByteLength: ref.byteLength,
    };
    const unavailable = {
      ref,
      state: "unavailable" as const,
      reason: "station offline",
    };
    expect(Schema.decodeUnknownSync(ContentMissing)(missing)).toEqual(missing);
    expect(Schema.decodeUnknownSync(ContentCorrupt)(corrupt)).toEqual(corrupt);
    expect(Schema.decodeUnknownSync(ContentUnavailable)(unavailable)).toEqual(unavailable);
    expect(Schema.decodeUnknownSync(ContentAvailability)(missing)).toEqual(missing);
    expect(Schema.decodeUnknownSync(ContentAvailability)(corrupt)).toEqual(corrupt);
    expect(Schema.decodeUnknownSync(ContentAvailability)(unavailable)).toEqual(unavailable);
  });

  it("decodes a ContentPart with a ContentRef", () => {
    expect(
      Schema.decodeUnknownSync(ContentPart)({ kind: "content", ref }),
    ).toEqual({ kind: "content", ref });
  });

  it("does not cap content at the old media attachment size", () => {
    expect(Schema.decodeUnknownSync(ContentByteLength)(1_073_741_824)).toBe(
      1_073_741_824,
    );
  });
});
