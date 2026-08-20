import { describe, expect, it } from "vitest";
import { Result } from "effect";
import { decodeCanvasDoc, type CanvasDoc, type CanvasNode } from "../src/shared/canvas";
import { FlowCycleError, isTaskFlowPair } from "../src/shared/flow-graph";
import { friendlyCycleMessage } from "../src/renderer/components/edges/WireSheet";

// Pure helpers behind the flow edge config sheet: the task-sink pair gate that
// swaps in the task-flow section, and the readable cycle-rejection line (the
// `^` receipt for the inline "friendly message" requirement).

const node = (id: string, kind: string, name = id): CanvasNode =>
  ({
    id,
    type: "text",
    text: name,
    x: 0,
    y: 0,
    width: 200,
    height: 80,
    ether: { entity: { kind, name } },
  }) as CanvasNode;

const sink = (id: string, name = id): CanvasNode => node(id, "task", name);

const doc = (nodes: CanvasNode[]): CanvasDoc =>
  Result.getOrThrow(decodeCanvasDoc({ nodes, edges: [] }));

describe("isTaskFlowPair", () => {
  it("is true when both endpoints are task sinks", () => {
    expect(isTaskFlowPair(sink("review"), sink("done"))).toBe(true);
  });

  it("is false for a sink kind that cannot project a forwarded task", () => {
    for (const kind of ["pad", "board", "page", "artifacts", "requests", "terminal"]) {
      expect(isTaskFlowPair(sink("review"), node("other", kind))).toBe(false);
      expect(isTaskFlowPair(node("other", kind), sink("review"))).toBe(false);
    }
  });

  it("is false when either endpoint is an actor", () => {
    expect(isTaskFlowPair(node("seat-a", "agent"), sink("review"))).toBe(false);
    expect(isTaskFlowPair(sink("review"), node("seat-a", "agent"))).toBe(false);
  });

  it("is false for a missing endpoint (reads as geography, never sink)", () => {
    expect(isTaskFlowPair(undefined, sink("review"))).toBe(false);
    expect(isTaskFlowPair(sink("review"), undefined)).toBe(false);
  });

  it("is false for a group carrying a task kind — a region is never a station", () => {
    const region = {
      id: "region",
      type: "group",
      label: "Law",
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      ether: { entity: { kind: "task", name: "Law" } },
    } as unknown as CanvasNode;
    expect(isTaskFlowPair(region, sink("review"))).toBe(false);
  });
});

describe("friendlyCycleMessage", () => {
  it("names every station on the cycle by title, closing the loop", () => {
    const d = doc([sink("s1", "Review"), sink("s2", "QA"), sink("s3", "Ship")]);
    const error = new FlowCycleError({
      cycle: ["s1", "s2", "s3"],
      message: "task flow must stay a DAG; cycle: s1 -> s2 -> s3 -> s1",
    });
    const message = friendlyCycleMessage(error, d);
    expect(message).toContain("Review → QA → Ship → Review");
    expect(message).not.toContain("s1");
  });

  it("falls back to a placeholder for a station id no longer on the canvas", () => {
    const d = doc([sink("s1", "Review")]);
    const error = new FlowCycleError({
      cycle: ["s1", "gone"],
      message: "task flow must stay a DAG; cycle: s1 -> gone -> s1",
    });
    expect(friendlyCycleMessage(error, d)).toContain("Review → that station → Review");
  });
});
