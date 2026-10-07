/**
 * flowEdgesFromModel builds React Flow edges from the model's wires: which
 * sockets a wire uses, what its verb paints, and what the kernel says of it.
 */
import { describe, expect, it } from "vitest";
import { asCanvasName, type Node, type Wire } from "../src/shared/model";
import { canvasFromOpened, type Canvas } from "../src/shared/model/canvas";
import { VERB_COLOR_TOKEN } from "../src/shared/physics";
import { flowEdgesFromModel, type ModelFlowEdgeCache, type WirePhases } from "../src/renderer/lib/flow-edges";

const name = asCanvasName("factory");
const seat = (id: string, x: number, y: number): Node =>
  ({
    kind: "agent", id, x, y, width: 216, height: 96, z: 0, agentKey: `local:${id}`, label: id, host: "local",
    overseer: false, bindingId: `binding-${id}`, harness: "claude", onRemove: "detach",
  }) as unknown as Node;
const wire = (id: string, from: string, to: string, over: Record<string, unknown> = {}): Wire =>
  ({ id, from, to, verb: "messages", ...over }) as unknown as Wire;
const canvasOf = (nodes: Node[], wires: Wire[]): Canvas => canvasFromOpened({ canvas: name, seq: 0, nodes, wires });

const quiet: WirePhases = { phaseOf: () => "relates", detailOf: () => "", rippling: () => false };

describe("React Flow edges from the model", () => {
  it("draws a wire between its ends with its verb's colour", () => {
    const canvas = canvasOf([seat("a", 0, 0), seat("b", 600, 0)], [wire("w", "a", "b", { verb: "reviews" })]);
    const [edge] = flowEdgesFromModel(canvas, quiet);
    expect(edge).toMatchObject({
      id: "w", source: "a", target: "b", type: "ether", zIndex: 16,
      data: { verb: "reviews", colorToken: VERB_COLOR_TOKEN.reviews, phase: "relates", detail: "", rippling: false, fromKind: "agent", toKind: "agent" },
    });
  });

  it("picks the sockets that face each other, and follows a card that moves", () => {
    const side = (canvas: Canvas) => {
      const [edge] = flowEdgesFromModel(canvas, quiet);
      return [edge?.sourceHandle, edge?.targetHandle];
    };
    expect(side(canvasOf([seat("a", 0, 0), seat("b", 600, 0)], [wire("w", "a", "b")]))).toEqual(["s-right", "t-left"]);
    expect(side(canvasOf([seat("a", 0, 0), seat("b", 0, 600)], [wire("w", "a", "b")]))).toEqual(["s-bottom", "t-top"]);
  });

  it("falls back to the sides the wire holds when an end is missing", () => {
    const canvas = canvasOf([seat("a", 0, 0)], [wire("w", "a", "gone", { fromSide: "top", toSide: "bottom" })]);
    const [edge] = flowEdgesFromModel(canvas, quiet);
    expect([edge?.sourceHandle, edge?.targetHandle]).toEqual(["s-top", "t-bottom"]);
    expect(edge?.data?.toKind).toBeUndefined();
  });

  it("says what the kernel says of the wire", () => {
    const canvas = canvasOf([seat("a", 0, 0), seat("b", 600, 0)], [wire("w", "a", "b")]);
    const [edge] = flowEdgesFromModel(canvas, {
      phaseOf: () => "blocks", detailOf: () => "waiting on input", rippling: () => true,
    });
    expect(edge?.data).toMatchObject({ phase: "blocks", detail: "waiting on input", rippling: true });
  });

  it("keeps an edge that did not change, remints one whose card moved, and forgets one removed", () => {
    const cache: ModelFlowEdgeCache = new Map();
    const a = seat("a", 0, 0);
    const b = seat("b", 600, 0);
    const c = seat("c", 0, 600);
    const ab = wire("ab", "a", "b");
    const ac = wire("ac", "a", "c");
    const before = flowEdgesFromModel(canvasOf([a, b, c], [ab, ac]), quiet, cache);
    const again = flowEdgesFromModel(canvasOf([a, b, c], [ab, ac]), quiet, cache);
    expect(again[0]).toBe(before[0]);
    expect(again[1]).toBe(before[1]);
    // b moves under a: its wire changes sockets, the other is untouched.
    const moved = flowEdgesFromModel(canvasOf([a, { ...b, x: 0, y: -600 }, c], [ab, ac]), quiet, cache);
    expect(moved[0]).not.toBe(before[0]);
    expect(moved[1]).toBe(before[1]);
    flowEdgesFromModel(canvasOf([a, c], [ac]), quiet, cache);
    expect(cache.has("ab")).toBe(false);
  });
});
