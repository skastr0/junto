import { describe, expect, it } from "vitest";
import { makePostOps } from "../src/renderer/lib/post-op";
import { makeLocalSubjectThreads } from "../src/renderer/lib/subject-threads-source";
import { asNodeId } from "../src/shared/model";

const counter = () => {
  let n = 0;
  return () => `op${(n += 1)}`;
};

describe("one op id per post", () => {
  it("keeps the id for a resend after a lost answer, so main posts it once", async () => {
    const source = makeLocalSubjectThreads();
    const subject = { kind: "artifact", nodeId: asNodeId("artifacts-a"), artifactId: "art-1" } as never;
    const ops = makePostOps(counter());
    const post = { text: "looks right", anchor: { kind: "whole" } };
    // The first answer is lost on the way back: nothing settles.
    await source.post("c", subject, { text: post.text, opId: ops.opFor(post) });
    const again = await source.post("c", subject, { text: post.text, opId: ops.opFor(post) });
    ops.settle();
    expect(again.ok).toBe(true);
    const threads = await source.threads("c", subject);
    expect(threads.flatMap((thread) => thread.posts)).toHaveLength(1);
  });

  it("gives a different post, a reply in another thread, or the next post a fresh id", () => {
    const ops = makePostOps(counter());
    const first = ops.opFor({ text: "a" });
    expect(ops.opFor({ text: "a" })).toBe(first);
    expect(ops.opFor({ text: "a", threadId: "t1" })).not.toBe(first);
    const placed = ops.opFor({ text: "a", anchor: { kind: "lines", from: 1, to: 2 } });
    expect(ops.opFor({ text: "a", anchor: { kind: "lines", from: 1, to: 3 } })).not.toBe(placed);
    ops.settle();
    expect(ops.opFor({ text: "a", anchor: { kind: "lines", from: 1, to: 3 } })).toBe("op5");
  });
});
