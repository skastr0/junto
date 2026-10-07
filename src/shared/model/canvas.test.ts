import { describe, expect, it } from "vitest";
import {
  asCanvasName,
  asNodeId,
  asWireId,
  canvasFromOpened,
  follow,
  nodeOf,
  regionMembers,
  regionStack,
  wireGrant,
  wireKinds,
  type Node,
  type Wire,
} from "./index";

const at = (id: string, x: number, y: number, width: number, height: number, z = 0) => ({
  id: asNodeId(id),
  x,
  y,
  width,
  height,
  z,
});

const seat = (id: string, x = 10, y = 10): Node => ({
  kind: "agent",
  ...at(id, x, y, 216, 96),
  agentKey: `local:${id}`,
  label: id,
  host: "local",
  overseer: false,
  bindingId: `b-${id}` as never,
  harness: "claude",
  onRemove: "detach",
});

const region = (id: string, x: number, y: number, width: number, height: number): Node => ({
  kind: "region",
  ...at(id, x, y, width, height),
  hold: false,
});

const wire = (id: string, from: string, to: string, more: Partial<Wire> = {}): Wire => ({
  id: asWireId(id),
  from: asNodeId(from),
  to: asNodeId(to),
  verb: "messages",
  ...more,
});

const factory = asCanvasName("factory");

const open = (nodes: ReadonlyArray<Node>, wires: ReadonlyArray<Wire> = []) =>
  canvasFromOpened({ canvas: factory, seq: 4, nodes, wires });

const changed = (seq: number, more: object = {}) => ({
  canvas: factory,
  seq,
  nodes: [],
  wires: [],
  removedNodes: [],
  removedWires: [],
  ...more,
});

describe("following a canvas", () => {
  it("applies the next change and nothing else", () => {
    const canvas = open([seat("a"), seat("b")], [wire("w", "a", "b")]);
    const moved = { ...seat("a"), x: 500 };
    const next = follow(
      canvas,
      changed(5, { nodes: [moved], removedNodes: [asNodeId("b")], removedWires: [asWireId("w")] }),
    );
    expect(next._tag).toBe("Applied");
    if (next._tag !== "Applied") return;
    expect(next.canvas.seq).toBe(5);
    expect(next.canvas.nodes.get(asNodeId("a"))?.x).toBe(500);
    expect(next.canvas.nodes.has(asNodeId("b"))).toBe(false);
    expect(next.canvas.wires.size).toBe(0);
    // The canvas it was given is untouched.
    expect(canvas.nodes.get(asNodeId("a"))?.x).toBe(10);
    expect(canvas.seq).toBe(4);
  });

  it("ignores a change it already has and reports a missed one", () => {
    const canvas = open([seat("a")]);
    expect(follow(canvas, changed(4))._tag).toBe("Stale");
    expect(follow(canvas, changed(3))._tag).toBe("Stale");
    expect(follow(canvas, changed(6))).toEqual({ _tag: "Gap", have: 4, got: 6 });
  });
});

describe("reading a canvas", () => {
  it("finds a node only as the kind it is", () => {
    const canvas = open([seat("a"), region("r", 0, 0, 1000, 1000)]);
    expect(nodeOf(canvas, asNodeId("a"), "agent")?.harness).toBe("claude");
    expect(nodeOf(canvas, asNodeId("a"), "region")).toBeUndefined();
    expect(nodeOf(canvas, asNodeId("missing"), "agent")).toBeUndefined();
  });

  it("grants what the verb gives the two kinds, less the mask", () => {
    const canvas = open(
      [seat("a"), seat("b"), region("r", 0, 0, 1000, 1000)],
      [
        wire("open", "a", "b"),
        wire("masked", "a", "b", { mask: ["msg.send"] }),
        wire("to-region", "a", "r"),
        wire("dangling", "a", "gone"),
      ],
    );
    const kinds = wireKinds(canvas.nodes.values());
    const grant = (id: string) => wireGrant(canvas.wires.get(asWireId(id))!, kinds);
    expect(grant("open")?.ports).toContain("msg.prompt");
    expect(grant("masked")?.ports).toEqual(["msg.send"]);
    expect(grant("to-region")).toBeUndefined();
    expect(grant("dangling")).toBeUndefined();
  });

  it("puts a node in every region that wholly contains it, outermost first", () => {
    const canvas = open([
      region("outer", 0, 0, 1000, 1000),
      region("inner", 0, 0, 400, 400),
      region("elsewhere", 2000, 0, 400, 400),
      seat("in", 10, 10),
      seat("straddling", 300, 10),
    ]);
    expect(regionStack(canvas, asNodeId("in")).map((r) => r.id)).toEqual(["outer", "inner"]);
    expect(regionStack(canvas, asNodeId("straddling")).map((r) => r.id)).toEqual(["outer"]);
    expect(regionStack(canvas, asNodeId("inner")).map((r) => r.id)).toEqual(["outer"]);
    const inner = nodeOf(canvas, asNodeId("inner"), "region")!;
    expect(regionMembers(canvas, inner).map((n) => n.id)).toEqual(["in"]);
  });
});
