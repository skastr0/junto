/**
 * flowNodesFromModel builds React Flow nodes from the model: where each card
 * sits, how large, how it stacks, and what it knows of its regions.
 */
import { describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasNode } from "../src/shared/canvas";
import { asCanvasName, type Node } from "../src/shared/model";
import { canvasFromOpened, inPaintOrder } from "../src/shared/model/canvas";
import { nodeFromDocument } from "../src/shared/model/from-document";
import { titleOf } from "../src/shared/model/title";
import { flowNodesFromModel, type ModelFlowCache } from "../src/renderer/lib/flow-nodes";

const at = (x: number, y: number, width = 216, height = 96) => ({ x, y, width, height });

const text = (id: string, body: string, rect: ReturnType<typeof at>, ether?: unknown): CanvasNode =>
  ({ id, type: "text", text: body, ...rect, ...(ether ? { ether } : {}) }) as CanvasNode;

const seat = (id: string, x: number, y: number): CanvasNode =>
  text(id, id, at(x, y), {
    entity: { kind: "agent", name: `local:${id}` },
    terminal: { bindingId: `binding-${id}`, harness: "claude" },
  });

const region = (id: string, label: string, rect: ReturnType<typeof at>): CanvasNode =>
  ({ id, type: "group", label, ...rect }) as CanvasNode;

const doc: CanvasDoc = {
  nodes: [
    region("outer", "canvas", at(0, 0, 2000, 1400)),
    region("inner", "window", at(100, 100, 900, 600)),
    region("empty", "", at(3000, 0, 400, 300)),
    seat("lead", 200, 220),
    seat("nodes", 520, 220),
    seat("alone", 2600, 900),
    text("term", "shell", at(1200, 300, 320, 200), {
      entity: { kind: "terminal", name: "term" },
      terminal: { bindingId: "binding-term" },
    }),
    text("note", "# Plan\nsecond line", at(1200, 700, 220, 84)),
    text("label", "North", at(60, 40, 120, 30), { entity: { kind: "label", name: "label" } }),
    text("git", "repo", at(1500, 900, 300, 200), { entity: { kind: "git", name: "git" }, git: { cwd: "/repo" } }),
    { id: "file", type: "file", file: "docs/readme.md", ...at(2600, 100, 300, 200) } as CanvasNode,
    { id: "link", type: "link", url: "https://example.com/a", ...at(2600, 400, 300, 200) } as CanvasNode,
  ],
  edges: [],
};

const model = (source: CanvasDoc) => {
  const nodes: Node[] = source.nodes.map((node, z) => nodeFromDocument("factory", node, z));
  const canvas = canvasFromOpened({ canvas: asCanvasName("factory"), seq: 0, nodes, wires: [] });
  return { canvas, nodes: inPaintOrder(canvas) };
};

describe("React Flow nodes from the model", () => {
  it("places, sizes and stacks each kind", () => {
    const { canvas, nodes } = model(doc);
    const flow = new Map(flowNodesFromModel(canvas, nodes, new Set(["nodes"])).map((node) => [node.id, node]));
    expect([...flow.keys()]).toEqual(doc.nodes.map((node) => node.id));
    // A region: behind the wires at its nesting depth, never selected or dragged by React Flow.
    expect(flow.get("outer")).toMatchObject({
      type: "group", position: { x: 0, y: 0 }, zIndex: 0, selectable: false, draggable: false, connectable: false,
      style: { width: 2000, height: 1400, pointerEvents: "none" },
    });
    expect(flow.get("inner")).toMatchObject({ zIndex: 1, data: { regionDepth: 1, parentRegion: "outer" } });
    expect(flow.get("empty")?.data.regionDepth).toBe(0);
    // A seat: drawn at the seat size whatever it stores, above the wires, with its ring room.
    expect(flow.get("lead")).toMatchObject({
      type: "text", position: { x: 200, y: 220 }, zIndex: 32, selectable: true, draggable: true, connectable: true,
      data: { blocked: false, seatRegion: "inner" },
    });
    expect(flow.get("lead")?.style).toMatchObject({ width: 216, height: 56 });
    expect(flow.get("lead")?.data.ringCap).toBeGreaterThan(0);
    expect(flow.get("nodes")?.data.blocked).toBe(true);
    expect(flow.get("alone")?.data.seatRegion).toBe("");
    // An instrument: the instrument size. A note: the size it stores.
    expect(flow.get("term")?.style).toMatchObject({ width: 176, height: 44 });
    expect(flow.get("note")?.style).toEqual({ width: 220, height: 84 });
    // A bare label and a git card take no wire.
    expect(flow.get("label")?.connectable).toBe(false);
    expect(flow.get("git")?.connectable).toBe(false);
    expect(flow.get("file")?.type).toBe("file");
    expect(flow.get("link")?.type).toBe("link");
  });

  it("names each node as the model names it", () => {
    const { canvas, nodes } = model(doc);
    const names = new Map(flowNodesFromModel(canvas, nodes, new Set()).map((node) => [node.id, node.ariaLabel]));
    for (const node of nodes) expect(names.get(node.id)).toBe(titleOf(node));
    expect(names.get("lead")).toBe("lead");
    expect(names.get("outer")).toBe("canvas");
  });

  it("carries the canvas, id and kind, and no node", () => {
    const { canvas, nodes } = model(doc);
    const lead = flowNodesFromModel(canvas, nodes, new Set()).find((node) => node.id === "lead")!;
    expect(lead.data).toMatchObject({ canvas: "factory", id: "lead", kind: "agent", seatRegion: "inner" });
    expect("node" in lead.data).toBe(false);
  });

  it("keeps a flow node across a change that is not its own", () => {
    const cache: ModelFlowCache = new Map();
    const first = model(doc);
    const before = flowNodesFromModel(first.canvas, first.nodes, new Set(), cache);
    // The far seat moves and a note is recoloured: every other card is the same object.
    const moved: CanvasDoc = {
      ...doc,
      nodes: doc.nodes.map((node) =>
        node.id === "alone" ? { ...node, x: 2700 } : node.id === "note" ? { ...node, color: "3" } : node,
      ),
    };
    const second = model(moved);
    const after = flowNodesFromModel(second.canvas, second.nodes, new Set(), cache);
    const same = after.filter((node, index) => node === before[index]).map((node) => node.id);
    expect(same).toEqual(doc.nodes.map((node) => node.id).filter((id) => id !== "alone"));
    expect(after.find((node) => node.id === "alone")!.position.x).toBe(2700);
  });

  it("drops a removed node from its cache", () => {
    const cache: ModelFlowCache = new Map();
    const first = model(doc);
    flowNodesFromModel(first.canvas, first.nodes, new Set(), cache);
    const second = model({ ...doc, nodes: doc.nodes.filter((node) => node.id !== "note") });
    flowNodesFromModel(second.canvas, second.nodes, new Set(), cache);
    expect(cache.has("note")).toBe(false);
  });
});
