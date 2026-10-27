/**
 * A file comment resent after a lost answer is one post (0.11 F7): the op id
 * is kept for the same text, place and thread, and a fresh one follows any
 * answer that arrived (product-shell's post-op rule).
 */
import { describe, expect, it } from "vitest";
import { asNodeId } from "../src/shared/physics/schema";
import { makePostOps } from "../src/renderer/lib/post-op";

const nodeId = asNodeId("files-1");
const subject = { kind: "file" as const, nodeId, path: "src/big.ts" };
const post = { text: "the row id", anchor: { kind: "lines" as const, file: "src/big.ts", from: 10, to: 10 } };

describe("a file comment's op id", () => {
  it("is the same for a resend of the same post, and new after an answer or for another post", () => {
    const ops = makePostOps(() => "op-1");
    expect(ops.opFor(post)).toBe("op-1");
    // The answer was lost: nothing settled, so the resend is the same write.
    expect(ops.opFor(post)).toBe("op-1");
    ops.settle();
    expect(ops.opFor(post)).toBe("op-1");
    expect(ops.opFor({ ...post, text: "another" })).toBe("op-1");
    expect(subject.path).toBe("src/big.ts");
  });

  it("takes a fresh id from the minter for a different post while one is pending", () => {
    const minted = ["op-1", "op-2"];
    const ops = makePostOps(() => minted.shift() ?? "op-3");
    expect(ops.opFor(post)).toBe("op-1");
    expect(ops.opFor({ ...post, threadId: "t-1" })).toBe("op-2");
  });
});
