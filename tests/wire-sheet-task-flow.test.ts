import { describe, expect, it } from "vitest";
import { Result } from "effect";
import { decodeCanvasDoc, type CanvasDoc, type CanvasNode } from "../src/shared/canvas";
import { FlowCycleError } from "../src/shared/flow-graph";
import {
  friendlyCycleMessage,
  isSinkToSinkEdge,
} from "../src/renderer/components/edges/WireSheet";

// Pure helpers behind the flow edge config sheet: sink↔sink detection (the
// gate that swaps in the task-flow section) and the readable cycle-rejection
// line (the `^` receipt for the inline "friendly message" requirement).

const sink = (id: string, name = id): CanvasNode =>
  ({
    id,
    type: "text",
    text: name,
    x: 0,
    y: 0,
    width: 200,
    height: 80,
    ether: { entity: { kind: "task", name } },
  }) as CanvasNode;

const agent = (id: string): CanvasNode =>
  ({
    id,
    type: "text",
    text: id,
    x: 0,
    y: 0,
    width: 200,
    height: 80,
    ether: { entity: { kind: "agent", name: id } },
  }) as CanvasNode;

const doc = (nodes: CanvasNode[]): CanvasDoc =>
  Result.getOrThrow(decodeCanvasDoc({ nodes, edges: [] }));

describe("isSinkToSinkEdge", () => {
  it("is true when both endpoints are sinks (task stations)", () => {
    expect(isSinkToSinkEdge(sink("review"), sink("done"))).toBe(true);
  });

  it("is false when either endpoint is an actor", () => {
    expect(isSinkToSinkEdge(agent("worker"), sink("review"))).toBe(false);
    expect(isSinkToSinkEdge(sink("review"), agent("worker"))).toBe(false);
  });

  it("is false for a missing endpoint (reads as geography, never sink)", () => {
    expect(isSinkToSinkEdge(undefined, sink("review"))).toBe(false);
    expect(isSinkToSinkEdge(sink("review"), undefined)).toBe(false);
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
