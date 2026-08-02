import { describe, expect, it } from "vitest";
import {
  canTransitionTaskState,
  isArchivedTaskState,
  isTerminalTaskState,
} from "../src/shared/task";
import { workTaskCreate, workTaskTransition } from "../src/shared/work";
import type { CanvasDoc } from "../src/shared/canvas";

const ids = (() => {
  let n = 0;
  return {
    id: () => `id-${++n}`,
    messageId: () => `msg-${++n}`,
  };
})();

const emptyTaskNode = (id = "tasks"): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: "tasks",
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  ether: { entity: { kind: "task" } },
});

describe("task archived soft-delete", () => {
  it("is terminal and reachable from every non-archived state", () => {
    expect(isTerminalTaskState("archived")).toBe(true);
    expect(isArchivedTaskState("archived")).toBe(true);
    for (const from of [
      "submitted",
      "working",
      "input-required",
      "auth-required",
      "completed",
      "canceled",
      "failed",
      "rejected",
    ] as const) {
      expect(canTransitionTaskState(from, "archived")).toBe(true);
    }
    expect(canTransitionTaskState("archived", "submitted")).toBe(false);
    expect(canTransitionTaskState("archived", "archived")).toBe(false);
  });

  it("archives a submitted task via workTaskTransition", () => {
    const doc: CanvasDoc = {
      nodes: [emptyTaskNode()],
      edges: [],
    };
    const created = workTaskCreate(
      doc,
      "alpha",
      "tasks",
      "noise",
      { title: "Noise", details: "clear me off the board" },
      ids,
    );
    const archived = workTaskTransition(
      created.doc,
      "alpha",
      "tasks",
      created.task.id,
      "archived",
      "operator soft-delete",
      ids,
    );
    expect(archived.task.state).toBe("archived");
    expect(
      archived.doc.nodes[0]?.ether?.tasks?.items.find(
        (task) => task.id === created.task.id,
      )?.state,
    ).toBe("archived");
  });

  it("archives completed and canceled tasks", () => {
    const doc: CanvasDoc = {
      nodes: [emptyTaskNode()],
      edges: [],
    };
    const created = workTaskCreate(
      doc,
      "alpha",
      "tasks",
      "done later",
      { title: "Done", details: "archive after complete" },
      ids,
    );
    const completed = workTaskTransition(
      created.doc,
      "alpha",
      "tasks",
      created.task.id,
      "completed",
      undefined,
      ids,
    );
    const fromCompleted = workTaskTransition(
      completed.doc,
      "alpha",
      "tasks",
      created.task.id,
      "archived",
      undefined,
      ids,
    );
    expect(fromCompleted.task.state).toBe("archived");

    const canceled = workTaskTransition(
      created.doc,
      "alpha",
      "tasks",
      created.task.id,
      "canceled",
      undefined,
      ids,
    );
    const fromCanceled = workTaskTransition(
      canceled.doc,
      "alpha",
      "tasks",
      created.task.id,
      "archived",
      undefined,
      ids,
    );
    expect(fromCanceled.task.state).toBe("archived");
  });
});
