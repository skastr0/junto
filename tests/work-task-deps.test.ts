import { describe, expect, it } from "vitest";
import { workTaskClaim, workTaskCreate, WorkError } from "../src/shared/work";
import type { CanvasDoc } from "../src/shared/canvas";
import { taskIsClaimReady, taskIndexById } from "../src/shared/task-deps";

const seat = `seat_${"c".repeat(64)}`;

const ids = (() => {
  let n = 0;
  return {
    id: () => `t${++n}`,
    messageId: () => `m${++n}`,
  };
})();

const baseDoc = (): CanvasDoc => ({
  nodes: [
    {
      id: "tasks",
      type: "text",
      text: "tasks",
      x: 0,
      y: 0,
      width: 120,
      height: 80,
      ether: { entity: { kind: "task" }, tasks: { items: [] } },
    },
  ],
  edges: [],
});

describe("workTaskCreate/claim dependsOn", () => {
  it("creates free tasks and chains claim readiness", () => {
    let doc = baseDoc();
    const a = workTaskCreate(doc, "c", "tasks", "spine start", { details: "spine start" }, ids);
    doc = a.doc;
    const b = workTaskCreate(doc, "c", "tasks", "spine next", { details: "spine next" }, ids, undefined, undefined, [a.task.id] );
    doc = b.doc;
    const items = doc.nodes[0]!.ether!.tasks!.items;
    const byId = taskIndexById(items);
    expect(taskIsClaimReady(a.task, byId)).toBe(true);
    expect(taskIsClaimReady(b.task, byId)).toBe(false);

    expect(() =>
      workTaskClaim(doc, "c", "tasks", b.task.id, {
        seatId: seat as never,
        canvasName: "c",
        nodeId: "agent",
      }, ids)
    ).toThrow(WorkError);

    // complete a via transition isn't needed — claim a, then mark completed
    const claimed = workTaskClaim(
      doc,
      "c",
      "tasks",
      a.task.id,
      { seatId: seat as never, canvasName: "c", nodeId: "agent" },
      ids
    );
    doc = claimed.doc;
    const completedItems = doc.nodes[0]!.ether!.tasks!.items.map((t) =>
      t.id === a.task.id ? { ...t, state: "completed" as const, claimedBy: undefined } : t
    );
    // manually patch completed (policy tests state machine separately)
    doc = {
      ...doc,
      nodes: doc.nodes.map((n) =>
        n.id === "tasks"
          ? {
              ...n,
              ether: {
                ...n.ether!,
                tasks: { items: completedItems },
              },
            }
          : n
      ),
    };
    const byId2 = taskIndexById(doc.nodes[0]!.ether!.tasks!.items);
    expect(taskIsClaimReady(byId2.get(b.task.id)!, byId2)).toBe(true);
    const claimedB = workTaskClaim(
      doc,
      "c",
      "tasks",
      b.task.id,
      { seatId: seat as never, canvasName: "c", nodeId: "agent" },
      ids
    );
    expect(claimedB.task.state).toBe("working");
    expect(claimedB.task.dependsOn).toEqual([a.task.id]);
  });

  it("rejects missing dependsOn at create", () => {
    const doc = baseDoc();
    expect(() =>
      workTaskCreate(doc, "c", "tasks", "orphan", { details: "orphan" }, ids, undefined, undefined, ["nope"] )
    ).toThrow(/missing/);
  });
});
