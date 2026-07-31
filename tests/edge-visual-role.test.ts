import { describe, expect, it } from "vitest";
import type { CanvasEdge, CanvasNode } from "../src/shared/canvas";
import { edgeVisualRole } from "../src/renderer/lib/convert";

const node = (id: string, kind: string): CanvasNode => ({
  id,
  type: "text",
  text: kind,
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  ether: { entity: { kind } },
});

const edge = (fromNode: string, toNode: string): CanvasEdge => ({
  id: `${fromNode}-${toNode}`,
  fromNode,
  toNode,
});

describe("edgeVisualRole", () => {
  it("projects endpoint pairs without changing canvas semantics", () => {
    const actor = node("actor", "agent");
    expect(edgeVisualRole(edge("tasks", "actor"), node("tasks", "task"), actor)).toBe("task-flow");
    expect(edgeVisualRole(edge("actor", "requests"), actor, node("requests", "requests"))).toBe("request-flow");
    expect(edgeVisualRole(edge("actor", "artifacts"), actor, node("artifacts", "artifacts"))).toBe("artifact-flow");
    expect(edgeVisualRole(edge("actor", "note"), actor, node("note", "note"))).toBe("soft-relation");
  });

  it("keeps pair styling stable when authored direction is reversed", () => {
    const actor = node("actor", "agent");
    const tasks = node("tasks", "task");
    const requests = node("requests", "requests");
    const artifacts = node("artifacts", "artifacts");

    expect(edgeVisualRole(edge("actor", "tasks"), actor, tasks)).toBe("task-flow");
    expect(edgeVisualRole(edge("requests", "actor"), requests, actor)).toBe("request-flow");
    expect(edgeVisualRole(edge("artifacts", "actor"), artifacts, actor)).toBe("artifact-flow");
  });
});
