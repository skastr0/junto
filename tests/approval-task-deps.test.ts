import { describe, expect, it } from "vitest";
import { taskAdmissionState } from "../src/shared/rules";
import type { CanvasDoc } from "../src/shared/canvas";
import { dependencyScopeIndex } from "../src/shared/task-dep-scope";
import {
  taskDepStatus,
  taskIsClaimReady,
} from "../src/shared/task-deps";
import type { ActorRef } from "../src/shared/work-reference";
import type { Task } from "../src/shared/work-model";
import {
  workTaskCreate,
  workTaskTransition,
} from "../src/shared/work";

const planner: ActorRef = {
  seatId: `seat_${"a".repeat(64)}` as ActorRef["seatId"],
  canvasName: "factory",
  nodeId: "operator",
};

const baseDoc = (): CanvasDoc => ({
  nodes: [
    {
      id: "tasks",
      type: "text",
      text: "tasks",
      x: 0,
      y: 0,
      width: 240,
      height: 120,
      ether: { entity: { kind: "task" }, tasks: { items: [] } },
    },
  ],
  edges: [],
});

const makeIds = () => {
  const taskIds = ["task-a", "task-b", "task-c"];
  let taskIndex = 0;
  let messageIndex = 0;
  return {
    id: () => taskIds[taskIndex++] ?? `task-${taskIndex}`,
    messageId: () => `message-${++messageIndex}`,
  };
};

type TestIds = ReturnType<typeof makeIds>;

const createPlanningTask = (
  doc: CanvasDoc,
  ids: TestIds,
  brief: string,
  dependsOn?: ReadonlyArray<string>,
) =>
  workTaskCreate(
    doc,
    "factory",
    "tasks",
    brief,
    { details: `${brief} details` },
    ids,
    undefined,
    undefined,
    dependsOn,
    undefined,
    undefined,
    {
      admissionOmitted: "approval",
      raisedBy: planner,
    },
  );

const taskAt = (doc: CanvasDoc, taskId: string): Task => {
  const task = doc.nodes[0]?.ether?.tasks?.items.find(
    (candidate) => candidate.id === taskId,
  );
  if (task === undefined) throw new Error(`task "${taskId}" not found`);
  return task;
};

const planningChain = () => {
  const ids = makeIds();
  const a = createPlanningTask(baseDoc(), ids, "Plan A");
  const b = createPlanningTask(a.doc, ids, "Plan B", [a.task.id]);
  return { ids, doc: b.doc, a: a.task, b: b.task };
};

describe("approval Task dependencies", () => {
  it("persists stable Task ids and the real dependency before approval", () => {
    const { doc, a, b } = planningChain();

    expect(doc.nodes[0]?.ether?.tasks?.items.map((task) => task.id)).toEqual([
      a.id,
      b.id,
    ]);
    expect(taskAt(doc, b.id).dependsOn).toEqual([a.id]);
    expect(taskAt(doc, a.id).admission).toBe("approval");
    expect(taskAt(doc, b.id).admission).toBe("approval");
    expect(taskAdmissionState(taskAt(doc, a.id), undefined, 0)).toBe(
      "approval",
    );
    expect(taskAdmissionState(taskAt(doc, b.id), undefined, 0)).toBe(
      "approval",
    );
    expect(
      taskDepStatus(
        taskAt(doc, b.id),
        dependencyScopeIndex(doc, "tasks"),
      ),
    ).toEqual({
      kind: "waiting",
      frontier: [a.id],
    });
  });

  it("derives a rejected prerequisite as a broken root without cascading state", () => {
    const chain = planningChain();
    const bBefore = taskAt(chain.doc, chain.b.id);
    const rejectedA = workTaskTransition(
      chain.doc,
      "factory",
      "tasks",
      chain.a.id,
      "rejected",
      "operator rejected the prerequisite",
      chain.ids,
    );
    const bAfter = taskAt(rejectedA.doc, chain.b.id);

    expect(rejectedA.task.id).toBe(chain.a.id);
    expect(rejectedA.task.state).toBe("rejected");
    expect(bAfter).toEqual(bBefore);
    expect(bAfter.state).toBe("submitted");
    expect(
      taskDepStatus(
        bAfter,
        dependencyScopeIndex(rejectedA.doc, "tasks"),
      ),
    ).toEqual({ kind: "blocked", roots: [chain.a.id] });
    expect(
      taskIsClaimReady(
        bAfter,
        dependencyScopeIndex(rejectedA.doc, "tasks"),
      ),
    ).toBe(false);
  });

  it("rejects duplicate and noncanonical authored dependencies instead of collapsing them", () => {
    const ids = makeIds();
    const a = createPlanningTask(baseDoc(), ids, "Plan A");

    expect(() =>
      createPlanningTask(a.doc, ids, "Plan B", [a.task.id, a.task.id]),
    ).toThrow(/duplicate task/);
    expect(() =>
      createPlanningTask(a.doc, ids, "Plan B", [a.task.id, ` ${a.task.id} `]),
    ).toThrow(/not canonical/);
  });
});
