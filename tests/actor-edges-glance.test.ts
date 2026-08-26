import { describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasEdge, TextNode } from "../src/shared/canvas";
import {
  actorEdgePhaseLabel,
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

const edge = (id: string, from: string, to: string): CanvasEdge => ({
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
    const doc = docOf([tasks("t"), note("n", "hi")], [edge("e", "t", "n")]);
    expect(actorEdgeRows(doc, "t")).toEqual([]);
    expect(actorEdgeRows(doc, "missing")).toEqual([]);
  });

  it("lists directed incident edges with peer kind + reach ports — no soft nature", () => {
    const doc = docOf(
      [agent("worker", "Grok"), tasks("tasks"), board("board"), note("memo", "note")],
      [
        edge("e-tasks", "tasks", "worker"),
        edge("e-board", "worker", "board"),
        edge("e-note", "worker", "memo"),
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
    expect(tasksRow.peerKind).toBe("task");
    expect(actorEdgePhaseLabel(tasksRow)).toBeNull();
    expect(tasksRow.ports.some((p) => p.startsWith("tasks."))).toBe(true);

    const boardRow = rows.find((r) => r.edgeId === "e-board")!;
    expect(boardRow.direction).toBe("out");
    expect(boardRow.boardNotify).toBe("on");
    expect(boardRow.ports.some((p) => p.startsWith("board."))).toBe(true);

    const noteRow = rows.find((r) => r.edgeId === "e-note")!;
    expect(noteRow.boardNotify).toBeNull();
    expect(noteRow.ports).toEqual([]);
  });

  it("reads the quiet board verb as wake off", () => {
    const doc = docOf(
      [agent("worker", "Grok"), board("board")],
      [
        {
          id: "e-board",
          fromNode: "worker",
          toNode: "board",
          ether: { verb: "messages" },
        },
      ],
    );
    const rows = actorEdgeRows(doc, "worker");
    expect(rows.find((r) => r.edgeId === "e-board")?.boardNotify).toBe("off");
  });

  it("overlays live phase when provided — only blocks is labeled", () => {
    const doc = docOf(
      [agent("worker", "Grok"), tasks("tasks")],
      [edge("e-tasks", "tasks", "worker")],
    );
    const phaseMap = new Map<string, "blocks" | "relates">([
      ["e-tasks", "blocks"],
    ]);
    const rows = actorEdgeRows(doc, "worker", phaseMap);
    expect(rows[0]?.livePhase).toBe("blocks");
    expect(actorEdgePhaseLabel(rows[0]!)).toBe("blocks");
  });
});

