import { describe, expect, it } from "vitest";
import type { CanvasEdge, CanvasNode } from "../src/shared/canvas";
import { edgeHasMsgSend, edgeVisualRole } from "../src/renderer/lib/convert";

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

const edge = (
  fromNode: string,
  toNode: string,
  ports?: ReadonlyArray<"msg.list" | "msg.send">,
): CanvasEdge => ({
  id: `${fromNode}-${toNode}`,
  fromNode,
  toNode,
  ...(ports ? { ether: { ports: [...ports] } } : {}),
});

describe("edgeVisualRole", () => {
  it("projects endpoint pairs without changing canvas semantics", () => {
    const actor = node("actor", "agent");
    expect(edgeVisualRole(edge("tasks", "actor"), node("tasks", "task"), actor)).toBe("task-flow");
    expect(edgeVisualRole(edge("actor", "requests"), actor, node("requests", "requests"))).toBe("request-flow");
    expect(edgeVisualRole(edge("actor", "artifacts"), actor, node("artifacts", "artifacts"))).toBe("artifact-flow");
    expect(edgeVisualRole(edge("actor", "page"), actor, node("page", "page"))).toBe("page-flow");
    expect(edgeVisualRole(edge("actor", "note"), actor, node("note", "note"))).toBe("soft-relation");
  });

  it("keeps pair styling stable when authored direction is reversed", () => {
    const actor = node("actor", "agent");
    const tasks = node("tasks", "task");
    const requests = node("requests", "requests");
    const artifacts = node("artifacts", "artifacts");
    const page = node("page", "page");

    expect(edgeVisualRole(edge("actor", "tasks"), actor, tasks)).toBe("task-flow");
    expect(edgeVisualRole(edge("requests", "actor"), requests, actor)).toBe("request-flow");
    expect(edgeVisualRole(edge("artifacts", "actor"), artifacts, actor)).toBe("artifact-flow");
    expect(edgeVisualRole(edge("page", "actor"), page, actor)).toBe("page-flow");
  });

  it("projects authored scheduler effects as scheduler flow", () => {
    const scheduler = node("cron", "cron");
    const target = node("tasks", "task");
    const effectEdge: CanvasEdge = {
      id: "cron-tasks",
      fromNode: "cron",
      toNode: "tasks",
      ether: { effect: { mode: "enqueue_task", brief: "scheduled review" } },
    };
    expect(edgeVisualRole(effectEdge, scheduler, target)).toBe("scheduler-flow");
  });

  it("agent↔agent defaults to msg.send; explicit masks can attenuate", () => {
    const a1 = node("a1", "agent");
    const a2 = node("a2", "agent");
    expect(edgeVisualRole(edge("a1", "a2"), a1, a2)).toBe("agent-msg");
    expect(edgeVisualRole(edge("a1", "a2", ["msg.list"]), a1, a2)).toBe("soft-relation");
    expect(edgeVisualRole(edge("a1", "a2", ["msg.send"]), a1, a2)).toBe("agent-msg");
    expect(edgeVisualRole(edge("a1", "a2", ["msg.list", "msg.send"]), a1, a2)).toBe(
      "agent-msg",
    );
    // Direction-stable
    expect(edgeVisualRole(edge("a2", "a1", ["msg.send"]), a2, a1)).toBe("agent-msg");
  });

  it("edgeHasMsgSend reads effective mask semantics", () => {
    expect(edgeHasMsgSend(edge("a", "b"))).toBe(true);
    expect(edgeHasMsgSend(edge("a", "b", ["msg.list"]))).toBe(false);
    expect(edgeHasMsgSend(edge("a", "b", ["msg.send"]))).toBe(true);
  });
});
