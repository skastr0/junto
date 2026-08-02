import { describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasEdge, TextNode } from "../src/shared/canvas";
import {
  actorEdgeNatureLabel,
  actorEdgeRows,
} from "../src/renderer/lib/actor-edges";

const agent = (id: string, label: string): TextNode => ({
  id,
  type: "text",
  text: label,
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  ether: {
    entity: { kind: "agent", name: `local:${id}` },
    terminal: { bindingId: `local:${id}`, harness: "codex" },
  },
});

const tasks = (id: string): TextNode => ({
  id,
  type: "text",
  text: "tasks",
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  ether: { entity: { kind: "task" }, tasks: { items: [] } },
});

const board = (id: string): TextNode => ({
  id,
  type: "text",
  text: "board",
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  ether: { entity: { kind: "board" } },
});

const note = (id: string, text: string): TextNode => ({
  id,
  type: "text",
  text,
  x: 0,
  y: 0,
  width: 160,
  height: 60,
});

const tasksEdge = (id: string, from: string, to: string): CanvasEdge => ({
  id,
  fromNode: from,
  toNode: to,
  ether: { criteria: { mode: "tasks" } },
});

const soft = (id: string, from: string, to: string): CanvasEdge => ({
  id,
  fromNode: from,
  toNode: to,
});

const docOf = (
  nodes: TextNode[],
  edges: CanvasEdge[],
): CanvasDoc => ({ nodes, edges });

describe("actorEdgeRows", () => {
  it("returns empty for non-actor nodes", () => {
    const doc = docOf([tasks("t"), note("n", "hi")], [soft("e", "t", "n")]);
    expect(actorEdgeRows(doc, "t")).toEqual([]);
    expect(actorEdgeRows(doc, "missing")).toEqual([]);
  });

  it("lists directed incident edges with nature + reach ports", () => {
    const doc = docOf(
      [agent("worker", "Grok"), tasks("tasks"), board("board"), note("memo", "note")],
      [
        tasksEdge("e-tasks", "tasks", "worker"),
        soft("e-board", "worker", "board"),
        soft("e-note", "worker", "memo"),
      ],
    );
    const rows = actorEdgeRows(doc, "worker");
    expect(rows.map((r) => r.edgeId).sort()).toEqual([
      "e-board",
      "e-note",
      "e-tasks",
    ]);

    const tasksRow = rows.find((r) => r.edgeId === "e-tasks")!;
    expect(tasksRow.direction).toBe("in");
    expect(tasksRow.nature).toBe("tasks");
    expect(tasksRow.peerKind).toBe("task");
    expect(tasksRow.ports.some((p) => p.startsWith("tasks."))).toBe(true);

    const boardRow = rows.find((r) => r.edgeId === "e-board")!;
    expect(boardRow.direction).toBe("out");
    expect(boardRow.nature).toBe("soft");
    expect(boardRow.boardNotify).toBe("on");
    expect(boardRow.ports.some((p) => p.startsWith("board."))).toBe(true);

    const noteRow = rows.find((r) => r.edgeId === "e-note")!;
    expect(noteRow.nature).toBe("soft");
    expect(noteRow.boardNotify).toBeNull();
    expect(noteRow.ports).toEqual([]);
  });

  it("honors explicit board notify off and relay state", () => {
    const other = agent("peer", "Peer");
    const doc = docOf(
      [agent("worker", "Grok"), board("board"), other],
      [
        {
          id: "e-board",
          fromNode: "worker",
          toNode: "board",
          ether: { notify: false },
        },
        {
          id: "e-relay",
          fromNode: "worker",
          toNode: "peer",
          ether: { relayState: true },
        },
      ],
    );
    const rows = actorEdgeRows(doc, "worker");
    expect(rows.find((r) => r.edgeId === "e-board")?.boardNotify).toBe("off");
    expect(rows.find((r) => r.edgeId === "e-relay")?.relayState).toBe(true);
  });

  it("overlays live phase when provided", () => {
    const doc = docOf(
      [agent("worker", "Grok"), tasks("tasks")],
      [tasksEdge("e-tasks", "tasks", "worker")],
    );
    const phaseMap = new Map<string, "blocks" | "relates">([
      ["e-tasks", "blocks"],
    ]);
    const rows = actorEdgeRows(doc, "worker", phaseMap);
    expect(rows[0]?.livePhase).toBe("blocks");
    expect(actorEdgeNatureLabel(rows[0]!)).toBe("blocks");
  });
});

