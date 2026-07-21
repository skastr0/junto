import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import { mergeLocalCanvasWithWorkWrite } from "../src/shared/work-canvas-merge";
import { a2aTask } from "./helpers/a2a-fixtures";

const base = (): CanvasDoc => ({
  nodes: [
    {
      id: "tasks",
      type: "text",
      text: "tasks",
      x: 10,
      y: 20,
      width: 240,
      height: 120,
      ether: { entity: { kind: "task" }, tasks: { items: [] } },
    },
    {
      id: "note",
      type: "text",
      text: "free note",
      x: 100,
      y: 200,
      width: 200,
      height: 80,
    },
  ],
  edges: [{ id: "e1", fromNode: "tasks", toNode: "note" }],
});

describe("mergeLocalCanvasWithWorkWrite", () => {
  it("keeps freeform geometry and edges; overlays A2A stores and mirrored text", () => {
    // Operator dragged the tasks card and edited the free note.
    const local: CanvasDoc = {
      ...base(),
      nodes: base().nodes.map((n) =>
        n.id === "tasks" && n.type === "text"
          ? { ...n, x: 50, y: 60 }
          : n.id === "note" && n.type === "text"
            ? { ...n, text: "edited note", x: 110 }
            : n,
      ),
    };

    const work: CanvasDoc = {
      nodes: [
        {
          id: "tasks",
          type: "text",
          text: "ship it",
          x: 0,
          y: 0,
          width: 240,
          height: 120,
          ether: {
            entity: { kind: "task" },
            tasks: { items: [a2aTask("t1", "ship it", "working")] },
          },
        },
        {
          id: "note",
          type: "text",
          text: "free note",
          x: 100,
          y: 200,
          width: 200,
          height: 80,
        },
      ],
      edges: [], // work path never authors edges
    };

    const merged = mergeLocalCanvasWithWorkWrite(local, work);
    const tasks = merged.nodes.find((n) => n.id === "tasks");
    const note = merged.nodes.find((n) => n.id === "note");
    expect(tasks?.type === "text" && tasks.x).toBe(50);
    expect(tasks?.type === "text" && tasks.y).toBe(60);
    expect(tasks?.type === "text" && tasks.text).toBe("ship it");
    expect(tasks?.ether?.tasks?.items[0]?.id).toBe("t1");
    expect(note?.type === "text" && note.text).toBe("edited note");
    expect(note?.type === "text" && note.x).toBe(110);
    expect(merged.edges).toEqual([{ id: "e1", fromNode: "tasks", toNode: "note" }]);
  });

  it("keeps local-only nodes (unsaved freeform adds)", () => {
    const local: CanvasDoc = {
      ...base(),
      nodes: [
        ...base().nodes,
        { id: "new", type: "text", text: "brand new", x: 0, y: 0, width: 100, height: 50 },
      ],
    };
    const work = base();
    const merged = mergeLocalCanvasWithWorkWrite(local, work);
    expect(merged.nodes.some((n) => n.id === "new")).toBe(true);
  });
});
