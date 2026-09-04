import { describe, expect, it } from "vitest";
import { Result } from "effect";
import { decodeCanvasDoc, type CanvasDoc, type CanvasNode } from "../src/shared/canvas";
import { FlowCycleError, isTaskPathPair } from "../src/shared/flow-graph";
import { friendlyCycleMessage } from "../src/renderer/lib/edge-mutations";

// Pure helpers behind the `feeds` hop: the task-sink pair gate that decides
// whether a task path hop is even possible, and the readable cycle-rejection
// line the connect refusal speaks.

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

describe("isTaskPathPair", () => {
  it("is true when both endpoints are task sinks", () => {
    expect(isTaskPathPair(sink("review"), sink("done"))).toBe(true);
  });

  it("is false for a node kind that cannot receive a sent-on task", () => {
    for (const kind of ["pad", "board", "page", "artifacts", "requests", "terminal"]) {
      expect(isTaskPathPair(sink("review"), node("other", kind))).toBe(false);
      expect(isTaskPathPair(node("other", kind), sink("review"))).toBe(false);
    }
  });

  it("is false when either endpoint is an actor", () => {
    expect(isTaskPathPair(node("seat-a", "agent"), sink("review"))).toBe(false);
    expect(isTaskPathPair(sink("review"), node("seat-a", "agent"))).toBe(false);
  });

  it("is false for a missing endpoint (reads as geography, never sink)", () => {
    expect(isTaskPathPair(undefined, sink("review"))).toBe(false);
    expect(isTaskPathPair(sink("review"), undefined)).toBe(false);
  });

  it("is false for a group carrying a task kind — a region is never a Tasks board", () => {
    const region = {
      id: "region",
      type: "group",
      label: "Region",
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      ether: { entity: { kind: "task", name: "Region" } },
    } as unknown as CanvasNode;
    expect(isTaskPathPair(region, sink("review"))).toBe(false);
  });
});

describe("friendlyCycleMessage", () => {
  it("names every board on the cycle by title, closing the loop", () => {
    const d = doc([sink("s1", "Review"), sink("s2", "QA"), sink("s3", "Ship")]);
    const error = new FlowCycleError({
      cycle: ["s1", "s2", "s3"],
      message: "task path must stay a DAG; cycle: s1 -> s2 -> s3 -> s1",
    });
    const message = friendlyCycleMessage(error, d);
    expect(message).toContain("Review → QA → Ship → Review");
    expect(message).not.toContain("s1");
  });

  it("falls back to a placeholder for a board id no longer on the canvas", () => {
    const d = doc([sink("s1", "Review")]);
    const error = new FlowCycleError({
      cycle: ["s1", "gone"],
      message: "task path must stay a DAG; cycle: s1 -> gone -> s1",
    });
    expect(friendlyCycleMessage(error, d)).toContain("Review → that board → Review");
  });
});
