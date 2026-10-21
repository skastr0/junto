import { Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import { formatNodeRef, parseNodeRef } from "../src/shared/node-ref";
import {
  resolveTarget,
  type ResolvedTarget,
  type TargetResolution,
  type TypedTarget,
  typedTargetOf,
} from "../src/shared/target-resolution";
import {
  queueFullError,
  staleError,
  TargetCandidate,
  WorkErrorBody,
  type WorkErrorType,
} from "../src/shared/work-control";
import type { NodeKind } from "../src/shared/model/kinds";
import { asNodeId, type NodeId } from "../src/shared/physics/schema";
import { ItemId, OpId, TaskNumber } from "../src/shared/work-ids";

const ITEM = ItemId.make("01M5ETQQJ52BDNMD202ZEFH9N4");
const OP = OpId.make("01M5ETS2DB39ZAAA72D04GCG0F");

const seat: TargetCandidate = { kind: "agent", nodeId: asNodeId("agent-1"), name: "Product-Feed" };
const task: TargetCandidate = {
  kind: "task",
  nodeId: asNodeId("task-1"),
  itemId: ITEM,
  name: "fix tabs",
  number: TaskNumber.make(42),
};
const kinds = new Map<string, NodeKind>([
  ["agent-1", "agent"],
  ["task-1", "task"],
  ["page-1", "page"],
]);
const resolve = (typed: string, candidates: ReadonlyArray<TargetCandidate> = [seat, task]) =>
  resolveTarget({ typed, candidates, kindOf: (id) => kinds.get(id) });

describe("typed targets", () => {
  it("reads #n or a bare n as a task number, only from 1", () => {
    for (const number of ["#42", "42", " #42 ", "#042"]) {
      expect(typedTargetOf(number)).toEqual({ ok: true, typed: { kind: "number", number: 42 } });
    }
    for (const word of ["#0", "0", "#-1", "#4.2", "#", "T-42", "4 2"]) {
      expect(typedTargetOf(word)).toEqual({ ok: true, typed: { kind: "word", text: word } });
    }
  });

  it("never reads a junto:// text that does not parse as a name", () => {
    for (const bad of [
      "junto://canvas/factory",
      "junto://canvas/factory?node=agent-1&item=nope",
      "junto://canvas/factory?item=01M5ETQQJ52BDNMD202ZEFH9N4&node=agent-1",
      "junto://canvas/factory?node=agent-1&item=01M5ETQQJ52BDNMD202ZEFH9N4&x=1",
    ]) {
      const typed = typedTargetOf(bad);
      expect(typed.ok).toBe(false);
      expect(resolve(bad)).toMatchObject({ ok: false, reason: "malformed" });
    }
  });

  it("round-trips a ref with an item, and keys on node and item, not the canvas", () => {
    const href = formatNodeRef({ canvasName: "factory", nodeId: "task-1", itemId: ITEM });
    expect(parseNodeRef(href)).toMatchObject({ ok: true, value: { nodeId: "task-1", itemId: ITEM } });
    const renamed = formatNodeRef({ canvasName: "renamed", nodeId: "task-1", itemId: ITEM });
    expect(resolve(href)).toEqual(resolve(renamed));
    expect(resolve(href)).toEqual({ ok: true, target: { nodeId: "task-1", itemId: ITEM } });
  });

  it("refuses to format an item id that is not a ULID", () => {
    expect(() => formatNodeRef({ canvasName: "factory", nodeId: "task-1", itemId: "nope" as ItemId })).toThrow();
  });
});

describe("resolution", () => {
  it("refuses an item on a node that holds none, as mention.ts does", () => {
    for (const nodeId of ["agent-1", "page-1"]) {
      const href = formatNodeRef({ canvasName: "factory", nodeId, itemId: ITEM });
      expect(resolve(href)).toMatchObject({ ok: false, reason: "malformed" });
    }
    expect(resolve(formatNodeRef({ canvasName: "factory", nodeId: "page-1" }))).toEqual({
      ok: true,
      target: { nodeId: "page-1" },
    });
    expect(resolve(formatNodeRef({ canvasName: "factory", nodeId: "gone-1" }))).toMatchObject({ ok: false, reason: "none" });
  });

  it("lists every candidate when nothing matches, and only the matches when a name is shared", () => {
    expect(resolve("nobody")).toEqual({ ok: false, reason: "none", typed: { kind: "word", text: "nobody" }, candidates: [seat, task] });
    const twin: TargetCandidate = { kind: "agent", nodeId: asNodeId("agent-2"), name: "product-feed" };
    expect(resolve("PRODUCT-FEED", [seat, twin, task])).toMatchObject({ ok: false, reason: "ambiguous", candidates: [seat, twin] });
  });

  it("matches a name against nodes only, never an item's title", () => {
    expect(resolve("fix tabs")).toMatchObject({ ok: false, reason: "none" });
  });

  it("resolves a task number to its node and item", () => {
    expect(resolve("#42")).toEqual({ ok: true, target: { nodeId: "task-1", itemId: ITEM } });
    expect(resolve("#43")).toMatchObject({ ok: false, reason: "none" });
  });

  it("refuses a blank target instead of matching an empty name", () => {
    expect(resolve("   ")).toMatchObject({ ok: false, reason: "none" });
  });
});

describe("Stale and the candidate list on the wire", () => {
  it("builds a retryable Stale with the head, and a retryable queue_full with the op", () => {
    const stale = staleError({ message: "old base", expected: 7, opId: OP });
    expect(stale).toEqual({ type: "Stale", message: "old base", details: { expected: 7, retryable: true, opId: OP } });
    expect(Schema.is(WorkErrorBody)(stale)).toBe(true);
    const full = queueFullError(OP);
    expect(full.details).toMatchObject({ reason: "queue_full", retryable: true, opId: OP });
    expect(Schema.is(WorkErrorBody)(full)).toBe(true);
  });

  it("decodes candidates closed: a known node kind, a ULID item, a number from 1", () => {
    const is = Schema.is(TargetCandidate);
    expect(is(task)).toBe(true);
    expect(is({ ...seat, kind: "banana" })).toBe(false);
    expect(is({ ...task, itemId: "nope" })).toBe(false);
    expect(is({ ...task, number: 0 })).toBe(false);
  });
});

describe("types", () => {
  it("makes a caller handle every refusal reason", () => {
    type Refusal = Extract<TargetResolution, { ok: false }>;
    expectTypeOf<Refusal["reason"]>().toEqualTypeOf<"none" | "ambiguous" | "malformed">();
    expectTypeOf<TypedTarget["kind"]>().toEqualTypeOf<"ref" | "number" | "word">();
    const say = (resolution: TargetResolution): string => {
      if (resolution.ok) return resolution.target.nodeId;
      switch (resolution.reason) {
        case "none":
        case "ambiguous":
          return String(resolution.candidates.length);
        case "malformed":
          return resolution.message;
        default: {
          const never: never = resolution;
          return never;
        }
      }
    };
    void say;
  });

  it("carries branded ids, never bare strings or numbers", () => {
    expectTypeOf<ResolvedTarget["nodeId"]>().toEqualTypeOf<NodeId>();
    expectTypeOf<Extract<TypedTarget, { kind: "ref" }>["nodeId"]>().toEqualTypeOf<NodeId>();
    expectTypeOf<TargetCandidate["nodeId"]>().toEqualTypeOf<NodeId>();
    expectTypeOf<ResolvedTarget["itemId"]>().toEqualTypeOf<ItemId | undefined>();
    expectTypeOf<Extract<TypedTarget, { kind: "number" }>["number"]>().toEqualTypeOf<TaskNumber>();
    // @ts-expect-error: a bare string is not an item id.
    const target: ResolvedTarget = { nodeId: asNodeId("task-1"), itemId: "01M5ETQQJ52BDNMD202ZEFH9N4" };
    // @ts-expect-error: a bare string is not a node id.
    const node: ResolvedTarget = { nodeId: "task-1" };
    // @ts-expect-error: a bare number is not a task number.
    const typed: TypedTarget = { kind: "number", number: 42 };
    // @ts-expect-error: a candidate's kind is a node kind.
    const candidate: TargetCandidate = { kind: "banana", nodeId: asNodeId("x"), name: "x" };
    void [target, node, typed, candidate];
  });

  it("names Stale as an error type", () => {
    expectTypeOf<"Stale">().toExtend<WorkErrorType>();
    // @ts-expect-error: the error type is closed.
    const unknown: WorkErrorType = "stale";
    void unknown;
  });
});
