import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import type { Message } from "../src/shared/work-model";
import { mergeLocalCanvasWithWorkWrite } from "../src/shared/work-canvas-merge";

const mail = (messageId: string, text: string): Message => ({
  messageId,
  role: "user",
  parts: [{ kind: "text", text }],
});

const base = (): CanvasDoc => ({
  nodes: [
    {
      id: "agent",
      type: "text",
      text: "Planner",
      x: 10,
      y: 20,
      width: 240,
      height: 120,
      ether: {
        entity: { kind: "agent", name: "local:planner" },
        messages: { items: [] },
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
  edges: [{ id: "e1", fromNode: "agent", toNode: "note" }],
});

describe("mergeLocalCanvasWithWorkWrite", () => {
  it("keeps freeform geometry, text and edges; overlays the seat's mailbox", () => {
    // Operator dragged the seat, renamed it, and edited the free note.
    const local: CanvasDoc = {
      ...base(),
      nodes: base().nodes.map((n) =>
        n.id === "agent" && n.type === "text"
          ? { ...n, text: "Local planner", x: 50, y: 60 }
          : n.id === "note" && n.type === "text"
            ? { ...n, text: "edited note", x: 110 }
            : n,
      ),
    };

    const work: CanvasDoc = {
      nodes: [
        {
          id: "agent",
          type: "text",
          text: "Planner",
          x: 0,
          y: 0,
          width: 240,
          height: 120,
          ether: {
            entity: { kind: "agent", name: "local:planner" },
            messages: { items: [mail("m1", "ship it")] },
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
    const agent = merged.nodes.find((n) => n.id === "agent");
    const note = merged.nodes.find((n) => n.id === "note");
    expect(agent?.type === "text" && agent.x).toBe(50);
    expect(agent?.type === "text" && agent.y).toBe(60);
    expect(agent?.type === "text" && agent.text).toBe("Local planner");
    expect(agent?.ether?.messages?.items.map((m) => m.messageId)).toEqual(["m1"]);
    expect(agent?.ether?.entity).toEqual({ kind: "agent", name: "local:planner" });
    expect(note?.type === "text" && note.text).toBe("edited note");
    expect(note?.type === "text" && note.x).toBe(110);
    expect(merged.edges).toEqual([{ id: "e1", fromNode: "agent", toNode: "note" }]);
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
          id: "agent",
          type: "text",
          text: "ghost",
          x: 0,
          y: 0,
          width: 100,
          height: 40,
          ether: {
            entity: { kind: "agent", name: "local:ghost" },
            messages: { items: [mail("m1", "hello")] },
          },
        },
        ...local.nodes,
      ],
      edges: [],
    };
    const merged = mergeLocalCanvasWithWorkWrite(local, work);
    expect(merged.nodes.map((n) => n.id)).toEqual(["note"]);
  });
});
