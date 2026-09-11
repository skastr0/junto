import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import { mergeLocalCanvasWithWorkWrite } from "../src/shared/work-canvas-merge";
import { taskItem } from "./helpers/task-fixtures";

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
  it("keeps freeform geometry and edges; overlays stores and mirrored text", () => {
    // Operator dragged the tasks card and edited the free note.
    const local: CanvasDoc = {
      ...base(),
      nodes: base().nodes.map((n) =>
        n.id === "tasks" && n.type === "text"
          ? {
              ...n,
              x: 50,
              y: 60,
              ether: {
                ...n.ether,
                tasks: {
                  items: [],
                  name: "Local intake",
                  contract: { instructions: "Use local contract" },
                },
              },
            }
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
            tasks: {
              items: [taskItem("t1", "ship it", "working")],
              name: "Stale intake",
              contract: { instructions: "Stale contract" },
            },
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
    expect(tasks?.ether?.tasks?.name).toBe("Local intake");
    expect(tasks?.ether?.tasks?.contract?.instructions).toBe("Use local contract");
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

  it("does not re-append work-only nodes (local membership authority)", () => {
    const local: CanvasDoc = {
      nodes: [
        {
          id: "note",
          type: "text",
          text: "only local",
          x: 0,
          y: 0,
          width: 100,
          height: 40,
        },
      ],
      edges: [],
    };
    const work: CanvasDoc = {
      nodes: [
        {
          id: "tasks",
          type: "text",
          text: "ghost",
          x: 0,
          y: 0,
          width: 100,
          height: 40,
          ether: { entity: { kind: "task" }, tasks: { items: [] } },
        },
        ...local.nodes,
      ],
      edges: [],
    };
    const merged = mergeLocalCanvasWithWorkWrite(local, work);
    expect(merged.nodes.map((n) => n.id)).toEqual(["note"]);
  });

  it("keeps the operator's board title when work carries a stale glance", () => {
    // The operator renamed the board; the work snapshot still projects the
    // old glance text. The local first line is authorial and must win.
    const local: CanvasDoc = {
      nodes: [
        {
          id: "board-1",
          type: "text",
          text: "Fleet announcements\n- Renamed after sync",
          x: 0,
          y: 0,
          width: 240,
          height: 120,
          ether: { entity: { kind: "board" } },
        },
      ],
      edges: [],
    };
    const work: CanvasDoc = {
      nodes: [
        {
          id: "board-1",
          type: "text",
          text: "board\n- Stale glance topic",
          x: 0,
          y: 0,
          width: 240,
          height: 120,
          ether: { entity: { kind: "board" } },
        },
      ],
      edges: [],
    };
    const merged = mergeLocalCanvasWithWorkWrite(local, work);
    const board = merged.nodes.find((n) => n.id === "board-1");
    expect(board?.type === "text" && board.text).toBe(
      "Fleet announcements\n- Stale glance topic",
    );
  });

  it("keeps a local requests rename across a work write and regenerates the mirror", () => {
    const local: CanvasDoc = {
      nodes: [
        {
          id: "req",
          type: "text",
          // Node text mirror is stale the instant a rename happens.
          text: "Vendor keys\n1 pending\napprove the deploy?",
          x: 0,
          y: 0,
          width: 200,
          height: 100,
          ether: {
            entity: { kind: "requests" },
            requests: {
              name: "Vendor keys",
              items: [{ id: "q1", state: "input-required", history: [] }],
            },
          },
        },
      ],
      edges: [],
    };
    const work: CanvasDoc = {
      nodes: [
        {
          id: "req",
          type: "text",
          // Work write's mirror does not know the local rename.
          text: "2 pending",
          x: 0,
          y: 0,
          width: 200,
          height: 100,
          ether: {
            entity: { kind: "requests" },
            requests: {
              items: [
                { id: "q1", state: "completed", history: [] },
                { id: "q2", state: "input-required", history: [] },
              ],
            },
          },
        },
      ],
      edges: [],
    };
    const merged = mergeLocalCanvasWithWorkWrite(local, work);
    const node = merged.nodes[0];
    expect(node?.type === "text" && node.ether?.requests?.name).toBe("Vendor keys");
    expect(node?.type === "text" && node.ether?.requests?.items.map((i) => i.id)).toEqual([
      "q1",
      "q2",
    ]);
    // Mirror regenerated from the merged store: authored identity + attention
    // count + briefs — not the work write's count-only text.
    expect(node?.type === "text" && node.text).toBe(
      "Vendor keys\n1 pending\nq1\nq2",
    );
  });
});
