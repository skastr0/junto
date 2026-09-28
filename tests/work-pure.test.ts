import { describe, expect, it } from "vitest";
import { workMessageAppend } from "../src/shared/work";
import type { CanvasDoc } from "../src/shared/canvas";

const agentNode = (
  id = "agent",
  hostId = "local",
  at: { readonly x: number; readonly y: number } = { x: 0, y: 0 },
): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: "profile-13",
  x: at.x,
  y: at.y,
  width: 200,
  height: 100,
  ether: {
    entity: { kind: "agent", name: `${hostId}:${id}` },
    terminal: {
      bindingId: `binding-${id}`,
      launch: { kind: "harness", argv: ["claude"] },
      harness: "claude",
    },
    host: hostId,
  },
});

describe("work pure transforms", () => {
  it("appends mail to an agent inbox, keyed to the canvas", () => {
    const doc: CanvasDoc = { nodes: [agentNode()], edges: [] };
    const onAgent = workMessageAppend(doc, "c", "agent", null, {
      messageId: "manual-2",
      role: "user",
      parts: [{ kind: "text", text: "ping" }],
    });
    const messages = onAgent.doc.nodes.find((n) => n.id === "agent")?.ether?.messages?.items;
    expect(messages?.some((m) => m.messageId === "manual-2")).toBe(true);
    expect(messages?.[0]?.contextId).toBe("c");
  });

  it("uses region label as contextId when the agent is inside a group", () => {
    const doc: CanvasDoc = {
      nodes: [
        {
          id: "reg",
          type: "group",
          label: "forge-lane",
          x: 0,
          y: 0,
          width: 400,
          height: 300,
        },
        { ...agentNode("agent", "local", { x: 40, y: 40 }), width: 120, height: 80 },
      ],
      edges: [],
    };
    const appended = workMessageAppend(doc, "canvas-name", "agent", null, {
      messageId: "inside-1",
      role: "user",
      parts: [{ kind: "text", text: "inside" }],
    });
    expect(appended.message.contextId).toBe("forge-lane");
  });
});
