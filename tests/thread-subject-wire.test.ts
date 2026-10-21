/**
 * The subject shapes live in the wire module, so the phone reads the same
 * ones (wire/thread-subject.ts). Its ids carry the app's own brands and
 * checks: a subject's node id is a NodeId and its task or artifact id an
 * ItemId, by type and by decode.
 */
import { Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { NodeId } from "../src/shared/physics/schema";
import * as shared from "../src/shared/thread-subject";
import * as wire from "../src/shared/wire/thread-subject";
import type { ItemId } from "../src/shared/work-ids";

describe("the wire's thread subject", () => {
  it("is the one the app reads: same schemas, same brands", () => {
    expect(shared.ResourceSubject).toBe(wire.ResourceSubject);
    expect(shared.Anchor).toBe(wire.Anchor);
    type Task = Extract<wire.ResourceSubject, { kind: "task" }>;
    type Artifact = Extract<wire.ResourceSubject, { kind: "artifact" }>;
    expectTypeOf<Task["nodeId"]>().toEqualTypeOf<NodeId>();
    expectTypeOf<Task["taskId"]>().toEqualTypeOf<ItemId>();
    expectTypeOf<Artifact["artifactId"]>().toEqualTypeOf<ItemId>();
  });

  it("decodes ids as the app's schemas do", () => {
    const is = Schema.is(wire.ResourceSubject);
    expect(is({ kind: "task", nodeId: "board", taskId: "01M5ESKX20QX0HA3Y6SHEPXBCX" })).toBe(true);
    expect(is({ kind: "task", nodeId: "", taskId: "01M5ESKX20QX0HA3Y6SHEPXBCX" })).toBe(false);
    expect(is({ kind: "task", nodeId: "x".repeat(257), taskId: "01M5ESKX20QX0HA3Y6SHEPXBCX" })).toBe(false);
    expect(is({ kind: "task", nodeId: "board", taskId: "t1" })).toBe(false);
  });
});
