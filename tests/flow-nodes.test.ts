/**
 * flowNodesFromModel builds React Flow nodes from the model. Until Canvas
 * draws from it, it has to say what toFlow says for the same canvas: where
 * each card sits, how large, how it stacks, and what it knows of its regions.
 */
import { describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasNode } from "../src/shared/canvas";
import { asCanvasName, type Node } from "../src/shared/model";
import { canvasFromOpened, inPaintOrder } from "../src/shared/model/canvas";
import { nodeFromDocument } from "../src/shared/model/from-document";
import { toFlow } from "../src/renderer/lib/convert";
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

const context = { canvasName: "factory", actorRefs: [] } as unknown as Parameters<typeof toFlow>[1];

describe("React Flow nodes from the model", () => {
  it("places, sizes and stacks every node as the document projection does", () => {
    const old = toFlow(doc, context, { phaseByEdgeId: {}, detailByEdgeId: {}, blocked: ["nodes"], blockedEdgeIds: [] }).nodes;
    const { canvas, nodes } = model(doc);
    const next = flowNodesFromModel(canvas, nodes, new Set(["nodes"]));

    expect(next.map((node) => node.id)).toEqual(old.map((node) => node.id));
    for (const [index, was] of old.entries()) {
      const now = next[index]!;
      expect({
        id: now.id, type: now.type, position: now.position, style: now.style, zIndex: now.zIndex,
        connectable: now.connectable, selectable: now.selectable, draggable: now.draggable,
        focusable: now.focusable, ariaLabel: now.ariaLabel,
      }).toEqual({
        id: was.id, type: was.type, position: was.position, style: was.style, zIndex: was.zIndex,
        connectable: was.connectable, selectable: was.selectable, draggable: was.draggable,
        focusable: was.focusable, ariaLabel: was.ariaLabel,
      });
      expect({
        blocked: now.data.blocked, regionDepth: now.data.regionDepth, nameSlot: now.data.nameSlot,
        ringCap: now.data.ringCap, seatRegion: now.data.seatRegion, parentRegion: now.data.parentRegion,
      }).toEqual({
        blocked: was.data.blocked, regionDepth: was.data.regionDepth, nameSlot: was.data.nameSlot,
        ringCap: was.data.ringCap, seatRegion: was.data.seatRegion, parentRegion: was.data.parentRegion,
      });
    }
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
