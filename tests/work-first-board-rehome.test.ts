import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  workTaskClaim,
  workTaskCreate,
  workTaskTransition,
  WorkError,
} from "../src/shared/work";
import type { CanvasDoc } from "../src/shared/canvas";
import { ActorRef } from "../src/shared/work-protocol";

// First-board blocking review: a defect on a task with no prior board
// re-homes the task in place (epoch bump + defect log + claims released +
// submitted successor on the same board) instead of dying rejected with
// live claims. Explicitly naming this board as target stays refused.

const ids = (() => {
  let n = 0;
  return {
    id: () => `id-${++n}`,
    messageId: () => `msg-${++n}`,
  };
})();

const actorRef = (digit: string, nodeId: string, canvasName = "alpha") =>
  Schema.decodeUnknownSync(ActorRef)({
    seatId: `seat_${digit.repeat(64)}`,
    canvasName,
    nodeId,
  });

const emptyTaskNode = (id = "s1"): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: "tasks",
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  ether: { entity: { kind: "task" } },
});

const itemsOf = (doc: CanvasDoc, nodeId: string) =>
  doc.nodes.find((n) => n.id === nodeId)?.ether?.tasks?.items ?? [];

describe("first-board defect re-homes in place", () => {
  const setup = () => {
    const nowMs = Date.parse("2026-09-10T12:00:00.000Z");
    const board: CanvasDoc = { nodes: [emptyTaskNode("s1")], edges: [] };
    const created = workTaskCreate(board, "alpha", "s1", "paint fence", { details: "paint the fence" }, ids);
    const claimed = workTaskClaim(
      created.doc,
      "alpha",
      "s1",
      created.task.id,
      actorRef("1", "worker-1"),
      ids,
    );
    const working = workTaskTransition(
      claimed.doc,
      "alpha",
      "s1",
      created.task.id,
      "working",
      undefined,
      ids,
      {
        artifacts: [{ artifactId: "plan-1", nodeId: "s1" }],
        git: { commits: ["SHA-ABC"] },
      },
      { nowMs },
    );
    return { nowMs, taskId: created.task.id, working };
  };

  it("same board gets a submitted successor with epoch + 1 and the defect entry", () => {
    const { nowMs, taskId, working } = setup();
    const defected = workTaskTransition(
      working.doc,
      "alpha",
      "s1",
      taskId,
      "rejected",
      undefined,
      ids,
      undefined,
      { nowMs, defect: { summary: "review: wrong fence", refs: ["sha-abc"] } },
    );

    expect(defected.task.state).toBe("rejected");
    expect(defected.sentBack?.nodeId).toBe("s1");

    // In place: one live row on the source board, the submitted successor.
    const rows = itemsOf(defected.doc, "s1");
    expect(rows).toHaveLength(1);
    const successor = rows[0]!;
    expect(successor.state).toBe("submitted");
    expect(successor.epoch).toBe(1);
    expect(successor.defects).toEqual([
      { epoch: 1, target: "s1", at: "2026-09-10T12:00:00.000Z" },
    ]);
    // Claims released, staged evidence gone: nothing pre-bump survives.
    expect(successor.claimedBy).toBeUndefined();
    expect(successor.completionEvidence).toBeUndefined();
    // The closed visit carries the sent-back exit back to this board.
    expect(successor.visits?.at(-2)).toMatchObject({
      board: "s1",
      exit: "sent-back",
      next: "s1",
    });
    expect(successor.visits?.at(-1)).toMatchObject({ board: "s1", epoch: 1 });
  });

  it("explicitly naming this board as defect target stays refused", () => {
    const { nowMs, taskId, working } = setup();
    expect(() =>
      workTaskTransition(
        working.doc,
        "alpha",
        "s1",
        taskId,
        "rejected",
        undefined,
        ids,
        undefined,
        { nowMs, defect: { summary: "x", target: "s1" } },
      ),
    ).toThrowError(WorkError);
  });
});

describe("staged evidence on working updates", () => {
  const setup = () => {
    const nowMs = Date.parse("2026-09-10T12:00:00.000Z");
    const board: CanvasDoc = { nodes: [emptyTaskNode("s1")], edges: [] };
    const created = workTaskCreate(board, "alpha", "s1", "paint fence", { details: "paint the fence" }, ids);
    const claimed = workTaskClaim(
      created.doc,
      "alpha",
      "s1",
      created.task.id,
      actorRef("1", "worker-1"),
      ids,
    );
    return { nowMs, taskId: created.task.id, claimed };
  };

  it("a working update with evidence attaches it (review can start pre-complete)", () => {
    const { nowMs, taskId, claimed } = setup();
    const staged = workTaskTransition(
      claimed.doc,
      "alpha",
      "s1",
      taskId,
      "working",
      undefined,
      ids,
      { artifacts: [], git: { commits: ["sha-1"] } },
      { nowMs },
    );
    expect(staged.task.state).toBe("working");
    expect(staged.task.completionEvidence?.git?.commits).toEqual(["sha-1"]);
  });

  it("a working update without evidence preserves the staged evidence", () => {
    const { nowMs, taskId, claimed } = setup();
    const staged = workTaskTransition(
      claimed.doc,
      "alpha",
      "s1",
      taskId,
      "working",
      undefined,
      ids,
      { artifacts: [], git: { commits: ["sha-1"] } },
      { nowMs },
    );
    const stillWorking = workTaskTransition(
      staged.doc,
      "alpha",
      "s1",
      taskId,
      "working",
      "progress note",
      ids,
      undefined,
      { nowMs },
    );
    expect(stillWorking.task.completionEvidence?.git?.commits).toEqual([
      "sha-1",
    ]);
  });
});
