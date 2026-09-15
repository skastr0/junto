import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import type { CanvasDoc, CanvasNode } from "../src/shared/canvas";
import type { Task, TasksContract } from "../src/shared/work-model";
import { TASK_APPROVED_METADATA_KEY } from "../src/shared/rules";
import {
  WorkError,
  workTaskClaim,
  workTaskCreate,
  workTaskTransition,
} from "../src/shared/work";
import { ActorRef } from "../src/shared/work-protocol";

// Sent-on, sent-back, and admission mechanics that work-pure does not cover:
// fork next selection, per-task wait overrides, outgoing+incoming check
// results, epoch-scoped approval markers, what travels on a re-home, fork
// waivers, rule accounting across defects, defect target validation, closed
// visit rows, and Me-admission boards.

const NOW = Date.parse("2026-08-20T12:00:00.000Z");

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

const boardNode = (id: string, contract?: TasksContract): CanvasNode => ({
  id,
  type: "text",
  text: "tasks",
  x: 2000,
  y: 2000,
  width: 100,
  height: 60,
  ether: {
    entity: { kind: "task" },
    tasks: {
      items: [],
      ...(contract !== undefined ? { contract } : {}),
    },
  },
});

const flowEdge = (id: string, source: string, destination: string) => ({
  id,
  fromNode: source,
  toNode: destination,
  ether: { verb: "feeds" as const },
});

const docWith = (
  nodes: ReadonlyArray<CanvasNode>,
  edges: CanvasDoc["edges"] = [],
): CanvasDoc => ({ nodes: [...nodes], edges: [...edges] });

const createTask = (doc: CanvasDoc, nodeId: string, brief = "ship it") =>
  workTaskCreate(doc, "alpha", nodeId, brief, { details: brief }, ids);

const itemsAt = (doc: CanvasDoc, nodeId: string): ReadonlyArray<Task> =>
  doc.nodes.find((node) => node.id === nodeId)?.ether?.tasks?.items ?? [];

describe("send on", () => {
  it("requires an explicit next when the board has several destinations", () => {
    const doc = docWith(
      [boardNode("s1"), boardNode("s2"), boardNode("s3")],
      [flowEdge("e1", "s1", "s2"), flowEdge("e2", "s1", "s3")],
    );
    const created = createTask(doc, "s1");
    expect(() =>
      workTaskTransition(
        created.doc,
        "alpha",
        "s1",
        created.task.id,
        "completed",
        undefined,
        ids,
        { artifacts: [] },
      ),
    ).toThrow(/pick next from \[s2, s3\]/);
    expect(() =>
      workTaskTransition(
        created.doc,
        "alpha",
        "s1",
        created.task.id,
        "completed",
        undefined,
        ids,
        { artifacts: [] },
        { next: "elsewhere" },
      ),
    ).toThrow(/not a live Next/);
    const result = workTaskTransition(
      created.doc,
      "alpha",
      "s1",
      created.task.id,
      "completed",
      undefined,
      ids,
      { artifacts: [] },
      { next: "s3", nowMs: NOW },
    );
    expect(result.sentOn?.nodeId).toBe("s3");
  });

  it("prefers the per-task waitFor stamp over the destination board's default waitMs", () => {
    const doc = docWith(
      [
        boardNode("s1"),
        boardNode("s2", { incoming: { waitMs: 60_000 } }),
      ],
      [flowEdge("e1", "s1", "s2")],
    );
    const created = createTask(doc, "s1");
    const stamped = workTaskTransition(
      created.doc,
      "alpha",
      "s1",
      created.task.id,
      "completed",
      undefined,
      ids,
      { artifacts: [] },
      { nowMs: NOW, waitForMs: 5 * 60_000 },
    );
    expect(itemsAt(stamped.doc, "s2")[0]?.waitUntil).toBe(
      "2026-08-20T12:05:00.000Z",
    );
    // Without the per-task stamp the board default applies.
    const plain = workTaskTransition(
      created.doc,
      "alpha",
      "s1",
      created.task.id,
      "completed",
      undefined,
      ids,
      { artifacts: [] },
      { nowMs: NOW },
    );
    expect(itemsAt(plain.doc, "s2")[0]?.waitUntil).toBe(
      "2026-08-20T12:01:00.000Z",
    );
  });

  it("demands green current-epoch check results for outgoing and incoming checks", () => {
    const doc = docWith(
      [
        boardNode("s1", {
          outgoing: {
            checks: [{ id: "out-1", label: "build", command: "bun run build" }],
          },
        }),
        boardNode("s2", {
          incoming: {
            checks: [{ id: "in-1", label: "lint", command: "bun run lint" }],
          },
        }),
      ],
      [flowEdge("e1", "s1", "s2")],
    );
    const created = createTask(doc, "s1");
    expect(() =>
      workTaskTransition(
        created.doc,
        "alpha",
        "s1",
        created.task.id,
        "completed",
        undefined,
        ids,
        { artifacts: [] },
      ),
    ).toThrow(/completion gate unsatisfied \[checks\]/);

    const result = workTaskTransition(
      {
        ...created.doc,
        nodes: created.doc.nodes.map((node) =>
          node.id === "s1"
            ? {
                ...node,
                ether: {
                  ...node.ether,
                  tasks: {
                    ...node.ether!.tasks!,
                    items: node.ether!.tasks!.items.map((item) => ({
                      ...item,
                      checkResults: [
                        {
                          checkId: "out-1",
                          side: "outgoing",
                          command: "bun run build",
                          exitCode: 0,
                          outputTail: "",
                          at: "2026-08-20T11:59:00.000Z",
                          epoch: 0,
                        },
                        {
                          checkId: "in-1",
                          side: "incoming",
                          command: "bun run lint",
                          exitCode: 0,
                          outputTail: "",
                          at: "2026-08-20T11:59:00.000Z",
                          epoch: 0,
                        },
                      ],
                    })),
                  },
                },
              } as CanvasNode
            : node,
        ),
      },
      "alpha",
      "s1",
      created.task.id,
      "completed",
      undefined,
      ids,
      { artifacts: [] },
      { nowMs: NOW },
    );
    expect(result.sentOn?.nodeId).toBe("s2");
  });

  it("the approval marker is epoch-scoped and is not sent on", () => {
    const doc = docWith(
      [
        boardNode("s1", { incoming: { admission: "approval" } }),
        boardNode("s2", { incoming: { admission: "approval" } }),
      ],
      [flowEdge("e1", "s1", "s2")],
    );
    const created = createTask(doc, "s1");
    // The operator approved this task at s1. Approval is epoch-scoped, so
    // the marker must not be sent on to s2.
    const approved: CanvasDoc = {
      ...created.doc,
      nodes: created.doc.nodes.map((node) =>
        node.id === "s1"
          ? {
              ...node,
              ether: {
                ...node.ether,
                tasks: {
                  ...node.ether!.tasks!,
                  items: node.ether!.tasks!.items.map((item) => ({
                    ...item,
                    metadata: {
                      ...(item.metadata ?? {}),
                      [TASK_APPROVED_METADATA_KEY]: 0,
                    },
                  })),
                },
              },
            } as CanvasNode
          : node,
      ),
    };
    const result = workTaskTransition(
      approved,
      "alpha",
      "s1",
      created.task.id,
      "completed",
      undefined,
      ids,
      { artifacts: [] },
      { nowMs: NOW },
    );
    const successor = itemsAt(result.doc, "s2")[0]!;
    expect(successor.metadata?.[TASK_APPROVED_METADATA_KEY]).toBeUndefined();
    // Only the marker is stripped — the rest of the bag travels.
    expect(successor.metadata?.details).toBe("ship it");
    // The gate is the point: no seat inherits s1's approval at s2.
    expect(() =>
      workTaskClaim(
        result.doc,
        "alpha",
        "s2",
        created.task.id,
        actorRef("1", "worker-1"),
        ids,
      ),
    ).toThrow(/awaits operator approval/);
  });

  it("leaves dependsOn and the admission overlay behind, carrying id, epoch, and task rules", () => {
    const doc = docWith(
      [boardNode("s1"), boardNode("s2")],
      [flowEdge("e1", "s1", "s2")],
    );
    const prereq = createTask(doc, "s1", "land the migration");
    const created = workTaskCreate(
      prereq.doc,
      "alpha",
      "s1",
      "ship it",
      { details: "ship it" },
      ids,
      undefined,
      undefined,
      [prereq.task.id],
      undefined,
      [{ id: "c-s2", text: "notes are filed", board: "s2" }],
      { admission: "operator" },
    );
    expect(created.task.dependsOn).toEqual([prereq.task.id]);
    expect(created.task.admission).toBe("operator");

    const result = workTaskTransition(
      created.doc,
      "alpha",
      "s1",
      created.task.id,
      "completed",
      undefined,
      ids,
      { artifacts: [] },
      { nowMs: NOW },
    );
    const successor = itemsAt(result.doc, "s2")[0]!;
    // Prereqs gate the first claim at the origin and the overlay is the
    // origin operator's call — neither speaks for the next board.
    expect(successor.dependsOn).toBeUndefined();
    expect(successor.admission).toBeUndefined();
    // Identity, epoch, and the authored board-addressed rules do travel.
    expect(successor.id).toBe(created.task.id);
    expect(successor.epoch).toBe(0);
    expect(successor.rules).toEqual([
      { id: "c-s2", text: "notes are filed", board: "s2" },
    ]);
  });

  it("requires a fork waiver for a task rule off the chosen branch", () => {
    const doc = docWith(
      [boardNode("s1"), boardNode("s2"), boardNode("s3")],
      [flowEdge("e1", "s1", "s2"), flowEdge("e2", "s1", "s3")],
    );
    const created = workTaskCreate(
      doc,
      "alpha",
      "s1",
      "audit trail",
      { details: "audit trail" },
      ids,
      undefined,
      undefined,
      undefined,
      undefined,
      [{ id: "c-s3", text: "s3 sign-off", board: "s3" }],
    );
    expect(() =>
      workTaskTransition(
        created.doc,
        "alpha",
        "s1",
        created.task.id,
        "completed",
        undefined,
        ids,
        { artifacts: [] },
        { next: "s2" },
      ),
    ).toThrow(/completion gate unsatisfied \[waivers\]/);
    const waivedResult = workTaskTransition(
      created.doc,
      "alpha",
      "s1",
      created.task.id,
      "completed",
      undefined,
      ids,
      {
        artifacts: [],
        waivers: [{ ruleId: "c-s3", reason: "s3 branch dropped" }],
      },
      { next: "s2", nowMs: NOW },
    );
    expect(waivedResult.sentOn?.nodeId).toBe("s2");
  });
});

describe("epoch accounting across defects", () => {
  it("rules answered before a defect must be answered again in the new epoch", () => {
    const doc = docWith(
      [boardNode("s1"), boardNode("s2"), boardNode("s3")],
      [flowEdge("e1", "s1", "s2"), flowEdge("e2", "s2", "s3")],
    );
    const created = workTaskCreate(
      doc,
      "alpha",
      "s1",
      "answered work",
      { details: "answered work" },
      ids,
      undefined,
      undefined,
      undefined,
      undefined,
      [{ id: "rule-s2", text: "wiring verified", board: "s2" }],
    );
    // s1 -> s2: the s2-addressed rule is not in force at s1, so no claim yet.
    const atS2 = workTaskTransition(
      created.doc,
      "alpha",
      "s1",
      created.task.id,
      "completed",
      undefined,
      ids,
      { artifacts: [] },
      { nowMs: NOW },
    );
    // s2 -> s3: the rule is in force at s2; claim it in epoch 0.
    const atS3 = workTaskTransition(
      atS2.doc,
      "alpha",
      "s2",
      created.task.id,
      "completed",
      "wiring verified",
      ids,
      {
        artifacts: [],
        claims: [{ ruleId: "rule-s2", text: "verified at s2" }],
      },
      { nowMs: NOW + 1_000 },
    );
    // s3 sends back to s1: epoch 1, and the epoch-0 claim is shadowed.
    const defected = workTaskTransition(
      atS3.doc,
      "alpha",
      "s3",
      created.task.id,
      "rejected",
      undefined,
      ids,
      undefined,
      {
        defect: { summary: "the wiring plan changed", target: "s1" },
        nowMs: NOW + 60_000,
      },
    );
    // s1 -> s2 again in epoch 1: still no claim needed at s1.
    const backAtS2 = workTaskTransition(
      defected.doc,
      "alpha",
      "s1",
      created.task.id,
      "completed",
      undefined,
      ids,
      { artifacts: [] },
      { nowMs: NOW + 120_000 },
    );
    // s2 -> s3 in epoch 1 without re-answering: the shadowed epoch-0 claim
    // does not satisfy the rule in the new epoch.
    expect(() =>
      workTaskTransition(
        backAtS2.doc,
        "alpha",
        "s2",
        created.task.id,
        "completed",
        undefined,
        ids,
        { artifacts: [] },
        { nowMs: NOW + 121_000 },
      ),
    ).toThrow(/completion gate unsatisfied \[claims\]/);
    const reAnswered = workTaskTransition(
      backAtS2.doc,
      "alpha",
      "s2",
      created.task.id,
      "completed",
      "re-verified",
      ids,
      {
        artifacts: [],
        claims: [{ ruleId: "rule-s2", text: "re-verified after rework" }],
      },
      { nowMs: NOW + 121_000 },
    );
    expect(reAnswered.task.state).toBe("completed");
    // Terminal close at s3: the epoch-1 claim is live, so the task closes.
    const closed = workTaskTransition(
      reAnswered.doc,
      "alpha",
      "s3",
      created.task.id,
      "completed",
      "done",
      ids,
      { artifacts: [] },
      { nowMs: NOW + 122_000 },
    );
    expect(closed.task.visits?.at(-1)?.exit).toBe("completed");
  });
});

describe("send-back target validation", () => {
  const line = () =>
    docWith(
      [boardNode("s1"), boardNode("s2"), boardNode("s3")],
      [flowEdge("e1", "s1", "s2"), flowEdge("e2", "s2", "s3")],
    );

  const travelToS3 = () => {
    const doc = line();
    const created = createTask(doc, "s1");
    const atS2 = workTaskTransition(
      created.doc,
      "alpha",
      "s1",
      created.task.id,
      "completed",
      "explored",
      ids,
      { artifacts: [] },
      { nowMs: NOW },
    );
    const atS3 = workTaskTransition(
      atS2.doc,
      "alpha",
      "s2",
      created.task.id,
      "completed",
      "implemented",
      ids,
      { artifacts: [] },
      { nowMs: NOW + 1_000 },
    );
    return { doc: atS3.doc, taskId: created.task.id };
  };

  it("re-homes in place at the origin board (no prior visit)", () => {
    const doc = docWith(
      [boardNode("s1"), boardNode("s2")],
      [flowEdge("e1", "s1", "s2")],
    );
    const created = createTask(doc, "s1");
    const rejected = workTaskTransition(
      created.doc,
      "alpha",
      "s1",
      created.task.id,
      "rejected",
      undefined,
      ids,
      undefined,
      { defect: { summary: "not viable" } },
    );
    // Source row closes rejected; the successor re-homes on the same board:
    // epoch bump, defect logged, claims released, evidence stripped.
    expect(rejected.task.state).toBe("rejected");
    expect(rejected.sentBack?.nodeId).toBe("s1");
    const row = rejected.sentBack?.task;
    expect(row?.state).toBe("submitted");
    expect(row?.epoch).toBe(1);
    expect(row?.defects).toEqual([
      { epoch: 1, target: "s1", at: expect.any(String) },
    ]);
    expect(row?.claimedBy).toBeUndefined();
    expect(row?.completionEvidence).toBeUndefined();
    expect(row?.visits?.at(-2)).toMatchObject({
      board: "s1",
      exit: "sent-back",
      next: "s1",
    });
  });

  it("refuses a target the task never visited, naming the visited boards", () => {
    const { doc, taskId } = travelToS3();
    expect(() =>
      workTaskTransition(
        doc,
        "alpha",
        "s3",
        taskId,
        "rejected",
        undefined,
        ids,
        undefined,
        { defect: { summary: "bad", target: "s9" }, nowMs: NOW + 60_000 },
      ),
    ).toThrow(/not a board this task has visited.*s1.*s2/);
  });

  it("refuses the current board as a target", () => {
    const { doc, taskId } = travelToS3();
    expect(() =>
      workTaskTransition(
        doc,
        "alpha",
        "s3",
        taskId,
        "rejected",
        undefined,
        ids,
        undefined,
        { defect: { summary: "bad", target: "s3" }, nowMs: NOW + 60_000 },
      ),
    ).toThrow(/is this board/);
  });
});

describe("closed visit rows stay closed", () => {
  it("refuses to re-open a sent-on row via the generic QA requeue", () => {
    const doc = docWith(
      [boardNode("s1"), boardNode("s2")],
      [flowEdge("e1", "s1", "s2")],
    );
    const created = createTask(doc, "s1");
    const sentOn = workTaskTransition(
      created.doc,
      "alpha",
      "s1",
      created.task.id,
      "completed",
      "first pass done",
      ids,
      { artifacts: [] },
      { nowMs: NOW },
    );
    expect(() =>
      workTaskTransition(
        sentOn.doc,
        "alpha",
        "s1",
        created.task.id,
        "submitted",
        "requeue anyway",
        ids,
      ),
    ).toThrow(/closed visit record/);
    // The live successor at s2 stays untouched — no second live row minted.
    expect(itemsAt(sentOn.doc, "s2")[0]?.state).toBe("submitted");
  });

  it("refuses to re-open a send-back source row via a plain rejected -> submitted transition", () => {
    const doc = docWith(
      [boardNode("s1"), boardNode("s2")],
      [flowEdge("e1", "s1", "s2")],
    );
    const created = createTask(doc, "s1");
    const sentOn = workTaskTransition(
      created.doc,
      "alpha",
      "s1",
      created.task.id,
      "completed",
      "first pass done",
      ids,
      { artifacts: [] },
      { nowMs: NOW },
    );
    const rejected = workTaskTransition(
      sentOn.doc,
      "alpha",
      "s2",
      created.task.id,
      "rejected",
      undefined,
      ids,
      undefined,
      { defect: { summary: "misses the edge case" }, nowMs: NOW + 60_000 },
    );
    expect(rejected.task.visits?.at(-1)?.exit).toBe("sent-back");
    // Whether blocked by the closed-row guard or by the transition table, the
    // source row must never re-open into a second live copy of the task.
    expect(() =>
      workTaskTransition(
        rejected.doc,
        "alpha",
        "s2",
        created.task.id,
        "submitted",
        undefined,
        ids,
      ),
    ).toThrow(WorkError);
    // The live successor at s1 (re-homed by the defect) stays untouched.
    expect(itemsAt(rejected.doc, "s1")[0]?.state).toBe("submitted");
  });
});

describe("claim admission", () => {
  const worker = actorRef("1", "worker-1");

  it("rejects seat claims at a Me board with a claim conflict", () => {
    const doc = docWith([
      boardNode("s1", { incoming: { admission: "operator" } }),
    ]);
    const created = createTask(doc, "s1");
    expect(() =>
      workTaskClaim(created.doc, "alpha", "s1", created.task.id, worker, ids),
    ).toThrow(WorkError);
    try {
      workTaskClaim(created.doc, "alpha", "s1", created.task.id, worker, ids);
    } catch (error) {
      expect((error as WorkError).code).toBe("claim_contention");
      expect((error as WorkError).message).toContain("set to Me");
    }
  });
});
