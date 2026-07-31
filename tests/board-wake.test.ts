import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  composeBoardInjectEnvelope,
  edgeNotifyOn,
  resolveBoardWakeSet,
} from "../src/shared/board-wake";

const doc = (partial: Partial<CanvasDoc> & Pick<CanvasDoc, "nodes" | "edges">): CanvasDoc => ({
  nodes: partial.nodes,
  edges: partial.edges,
});

describe("board wake set", () => {
  it("includes connected agents by default; explicit notify:false opts out", () => {
    const canvas = doc({
      nodes: [
        {
          id: "board-1",
          type: "text",
          text: "board",
          x: 0,
          y: 0,
          width: 100,
          height: 80,
          ether: { entity: { kind: "board" } },
        },
        {
          id: "agent-a",
          type: "text",
          text: "a",
          x: 0,
          y: 0,
          width: 100,
          height: 80,
          ether: {
            entity: { kind: "agent", name: "local:a" },
            terminal: { bindingId: "bind-a", harness: "claude" },
          },
        },
        {
          id: "agent-b",
          type: "text",
          text: "b",
          x: 0,
          y: 0,
          width: 100,
          height: 80,
          ether: {
            entity: { kind: "agent", name: "local:b" },
            terminal: { bindingId: "bind-b", harness: "claude" },
          },
        },
        {
          id: "agent-c",
          type: "text",
          text: "c",
          x: 0,
          y: 0,
          width: 100,
          height: 80,
          ether: {
            entity: { kind: "agent", name: "local:c" },
            terminal: { bindingId: "bind-c", harness: "claude" },
          },
        },
      ],
      edges: [
        {
          id: "e1",
          fromNode: "agent-a",
          toNode: "board-1",
          // notify absent = ON (default)
        },
        {
          id: "e2",
          fromNode: "agent-b",
          toNode: "board-1",
          ether: { notify: false },
        },
        {
          id: "e3",
          fromNode: "agent-c",
          toNode: "board-1",
          ether: { notify: true },
        },
      ],
    });

    expect(edgeNotifyOn(canvas, "board-1", "agent-a")).toBe(true);
    expect(edgeNotifyOn(canvas, "board-1", "agent-b")).toBe(false);
    expect(edgeNotifyOn(canvas, "board-1", "agent-c")).toBe(true);
    const seats = resolveBoardWakeSet(canvas, "board-1");
    expect(seats.map((s) => s.nodeId).sort()).toEqual(["agent-a", "agent-c"]);
    expect(seats.find((s) => s.nodeId === "agent-a")?.target.bindingId).toBe(
      "bind-a",
    );
  });

  it("composes optional non-compulsion envelope", () => {
    const line = composeBoardInjectEnvelope({
      wakeEventId: "w1",
      canvasName: "main",
      boardNodeId: "board-1",
      kind: "operator.topic.notify",
      topicTitle: "deploy window",
      excerptSource: "hold prod",
      createdAt: 1,
    });
    expect(line).toContain("[board · deploy window]");
    expect(line).toContain("mark_read or post optional");
    expect(line).not.toMatch(/must reply|required/i);
  });
});
