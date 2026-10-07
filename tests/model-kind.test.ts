/**
 * What a kind means to the card around it. The glance and the blocked rule
 * are held to what the document versions say for the same node, so moving the
 * shell onto the model changes nothing the operator sees.
 */
import { describe, expect, it } from "vitest";
import { attentionOf } from "../src/shared/attention";
import type { CanvasNode } from "../src/shared/canvas";
import { isBlockableNode, type ExecutionGraph } from "../src/shared/execution-graph";
import { asCanvasName, NODE_KINDS, type Node } from "../src/shared/model";
import { nodeFromDocument } from "../src/shared/model/from-document";
import {
  holdsWork,
  kindMayBeBlocked,
  kindWord,
  nodeAttention,
  physicsKind,
  roleOfKind,
  type SinkCounts,
} from "../src/renderer/lib/model-kind";
import { canvasOfState } from "../src/renderer/lib/model-store";

const rect = { x: 0, y: 0, width: 240, height: 120 };
const text = (id: string, ether?: unknown): CanvasNode => ({ id, type: "text", text: id, ...rect, ...(ether ? { ether } : {}) }) as CanvasNode;
const item = (state: string) => ({ id: `t-${state}`, state, history: [] });

const graph = (blocked: ReadonlyArray<string>): ExecutionGraph =>
  ({
    phaseByEdgeId: new Map(), detailByEdgeId: new Map(), edgeEvalById: new Map(),
    blocked: new Set(blocked), blockedEdgeIds: new Set(), reasonsByNodeId: new Map(),
  }) as unknown as ExecutionGraph;

/** The glance the work store would hold for these items. */
const NOTHING: SinkCounts = { count: 0, needsHuman: false, allTerminal: true };

const glanceOf = (states: ReadonlyArray<string>): SinkCounts => ({
  count: states.length,
  needsHuman: states.some((state) => state === "input-required" || state === "auth-required"),
  allTerminal: states.every((state) => ["completed", "canceled", "failed", "rejected"].includes(state)),
});

describe("a card's glance", () => {
  const queues: ReadonlyArray<ReadonlyArray<string>> = [
    [], ["submitted"], ["working", "input-required"], ["auth-required"], ["completed"], ["completed", "canceled"], ["completed", "working"],
  ];

  it.each(queues)("a task board holding %j reads as the document version does", (...states) => {
    const doc = text("n", { entity: { kind: "task" }, tasks: { items: states.map(item) } });
    expect(nodeAttention("task", glanceOf(states), false)).toBe(attentionOf(doc, graph([])));
  });

  it.each(queues)("requests holding %j read as the document version does", (...states) => {
    const doc = text("n", { entity: { kind: "requests" }, requests: { items: states.map(item) } });
    expect(nodeAttention("requests", glanceOf(states), false)).toBe(attentionOf(doc, graph([])));
  });

  it("artifacts are empty or idle by count", () => {
    expect(nodeAttention("artifacts", glanceOf([]), false)).toBe("empty");
    expect(nodeAttention("artifacts", { count: 2, needsHuman: false, allTerminal: false }, false)).toBe("idle");
  });

  it("everything else reads as the document version does, blocked or not", () => {
    const docs: CanvasNode[] = [
      text("seat", { entity: { kind: "agent", name: "local:claude" }, terminal: { bindingId: "b", harness: "claude" } }),
      text("term", { entity: { kind: "terminal" }, terminal: { bindingId: "t" } }),
      text("cron", { entity: { kind: "cron" }, timer: { expression: "*/5 * * * *" } }),
      text("relay", { entity: { kind: "relay" } }),
      text("board", { entity: { kind: "board" } }),
      text("pad", { entity: { kind: "pad" } }),
      text("note"),
      text("label", { entity: { kind: "label" } }),
      { id: "region", type: "group", label: "r", ...rect } as CanvasNode,
    ];
    for (const doc of docs) {
      const node: Node = nodeFromDocument("factory", doc, 0);
      for (const blocked of [false, true]) {
        expect([doc.id, blocked, nodeAttention(node.kind, NOTHING, blocked)]).toEqual([
          doc.id, blocked, attentionOf(doc, graph(blocked ? [doc.id] : [])),
        ]);
      }
      expect([doc.id, kindMayBeBlocked(node.kind)]).toEqual([doc.id, isBlockableNode(doc)]);
    }
  });
});

describe("kind words", () => {
  it("keeps the words the stylesheet was written with", () => {
    expect(kindWord("note")).toBe("text");
    expect(kindWord("region")).toBe("group");
    expect(kindWord("agent")).toBe("agent");
    expect(kindWord("file")).toBe("file");
  });

  it("gives the verb tables nothing for a card that only sits there", () => {
    for (const kind of ["note", "file", "link", "region"] as const) expect(physicsKind(kind)).toBeUndefined();
    expect(physicsKind("agent")).toBe("agent");
    expect(roleOfKind("agent")).toBe("actor");
    expect(roleOfKind("region")).toBe("geography");
  });

  it("reads work for the three kinds that hold it", () => {
    expect(NODE_KINDS.filter(holdsWork)).toEqual(["task", "requests", "artifacts"]);
    expect(holdsWork(undefined)).toBe(false);
  });
});

describe("the canvas the window holds, as shared logic reads it", () => {
  it("has the nodes and wires by id, and the seq", () => {
    const node = nodeFromDocument("factory", text("note"), 3);
    const canvas = canvasOfState("factory", { seq: 9, nodes: { note: node }, wires: {} });
    expect(canvas.name).toBe(asCanvasName("factory"));
    expect(canvas.seq).toBe(9);
    expect(canvas.nodes.get(node.id)).toBe(node);
    expect(canvas.wires.size).toBe(0);
  });
});
