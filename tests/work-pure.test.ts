import { describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import {
  isArtifactArchived,
  workArtifactArchive,
  workArtifactDelete,
  workArtifactPublish,
  workMessageAppend,
  workRequestCreate,
  workRequestResolve,
  workTaskClaim,
  workTaskCreate,
  workTaskDescribe,
  workTaskRespond,
  workTaskTransition,
  WorkError,
} from "../src/shared/work";
import type { Artifact, CanvasDoc, CanvasNode, Message } from "../src/shared/canvas";
import { canTransitionTaskState } from "../src/shared/task";
import { TASK_APPROVED_METADATA_KEY } from "../src/shared/rules";
import { ActorRef } from "../src/shared/work-protocol";

const ids = (() => {
  let n = 0;
  return {
    id: () => `id-${++n}`,
    messageId: () => `msg-${++n}`,
  };
})();

const actorRef = (
  digit: string,
  nodeId: string,
  canvasName = "alpha"
) =>
  Schema.decodeUnknownSync(ActorRef)({
    seatId: `seat_${digit.repeat(64)}`,
    canvasName,
    nodeId,
  });
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

const emptyRequestsNode = (id = "req"): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: "0 pending",
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  ether: { entity: { kind: "requests" } },
});

const agentNode = (
  id = "agent",
  hostId = "local"
): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: "profile-13",
  x: 0,
  y: 0,
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
  it("carries board-addressed rules at creation", () => {
    const rule = {
      id: "rule-1",
      text: "Ship notes filed",
      board: "tasks",
    };

    const created = workTaskCreate(
      { nodes: [emptyTaskNode()], edges: [] },
      "alpha",
      "tasks",
      "direct create",
      { details: "direct create" },
      ids,
      undefined,
      undefined,
      undefined,
      undefined,
      [rule],
    );
    expect(created.task.rules).toEqual([rule]);
  });

  it("validates board-addressed rules at creation: unique ids, Tasks targets, reachable boards", () => {
    const reachableBoard: CanvasDoc = {
      nodes: [emptyTaskNode("s1"), emptyTaskNode("s2")],
      edges: [{ id: "flow", fromNode: "s1", toNode: "s2", ether: { verb: "feeds" } }],
    };
    const forbiddenIds = {
      id: (): string => {
        throw new Error("invalid rules must be rejected before id allocation");
      },
      messageId: (): string => {
        throw new Error("invalid rules must be rejected before message allocation");
      },
    };

    // Duplicate rule ids are refused.
    expect(() =>
      workTaskCreate(
        reachableBoard,
        "alpha",
        "s1",
        "duplicate rules",
        { details: "duplicate rules" },
        forbiddenIds,
        undefined,
        undefined,
        undefined,
        undefined,
        [
          { id: "rule-x", text: "first", board: "s2" },
          { id: "rule-x", text: "second", board: "s2" },
        ],
      ),
    ).toThrow(/duplicated/);

    // Unknown board targets are refused.
    expect(() =>
      workTaskCreate(
        reachableBoard,
        "alpha",
        "s1",
        "ghost board",
        { details: "ghost board" },
        forbiddenIds,
        undefined,
        undefined,
        undefined,
        undefined,
        [{ id: "rule-g", text: "ghost", board: "nope" }],
      ),
    ).toThrow(/unknown board/);

    // A board that exists but is not a Tasks node is refused.
    const nonTasksBoard: CanvasDoc = {
      nodes: [emptyTaskNode("s1"), emptyRequestsNode("req")],
      edges: [{ id: "flow", fromNode: "s1", toNode: "req", ether: { verb: "feeds" } }],
    };
    expect(() =>
      workTaskCreate(
        nonTasksBoard,
        "alpha",
        "s1",
        "wrong kind",
        { details: "wrong kind" },
        forbiddenIds,
        undefined,
        undefined,
        undefined,
        undefined,
        [{ id: "rule-k", text: "kind", board: "req" }],
      ),
    ).toThrow(/expected task/);

    // A Tasks board that the current flow graph cannot reach is refused.
    const unreachable: CanvasDoc = {
      nodes: [emptyTaskNode("s1"), emptyTaskNode("s3")],
      edges: [],
    };
    expect(() =>
      workTaskCreate(
        unreachable,
        "alpha",
        "s1",
        "unreachable board",
        { details: "unreachable board" },
        forbiddenIds,
        undefined,
        undefined,
        undefined,
        undefined,
        [{ id: "rule-u", text: "unreachable", board: "s3" }],
      ),
    ).toThrow(/not reachable/);

    // A rule addressed to the origin board itself is reachable and accepted.
    const created = workTaskCreate(
      reachableBoard,
      "alpha",
      "s1",
      "local rule",
      { details: "local rule" },
      ids,
      undefined,
      undefined,
      undefined,
      undefined,
      [{ id: "rule-local", text: "answer here", board: "s1" }],
    );
    expect(created.task.rules).toEqual([
      { id: "rule-local", text: "answer here", board: "s1" },
    ]);
  });

  it("rejects create without a non-empty description", () => {
    const doc: CanvasDoc = { nodes: [emptyTaskNode()], edges: [] };
    expect(() =>
      workTaskCreate(doc, "alpha", "tasks", "title only", undefined, ids)
    ).toThrow(/description must be non-empty/);
    expect(() =>
      workTaskCreate(doc, "alpha", "tasks", "title only", { details: "   " }, ids)
    ).toThrow(/description must be non-empty/);
    const created = workTaskCreate(
      doc,
      "alpha",
      "tasks",
      "title only",
      { details: "  full context  " },
      ids
    );
    expect(created.task.metadata?.details).toBe("full context");
  });

  it("agent omit stamps approval; explicit auto is claimable; loosen is refused", () => {
    const worker = actorRef("1", "worker-1");
    const doc: CanvasDoc = { nodes: [emptyTaskNode()], edges: [] };
    const gated = workTaskCreate(
      doc,
      "alpha",
      "tasks",
      "gated create",
      { details: "gated create" },
      ids,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { admissionOmitted: "approval", raisedBy: worker },
    );
    expect(gated.task.admission).toBe("approval");
    expect(gated.task.raisedBy).toEqual(worker);
    expect(() =>
      workTaskClaim(gated.doc, "alpha", "tasks", gated.task.id, worker, ids),
    ).toThrow(/approval/);

    // The operator's approval marker makes the same task claimable.
    const approvedDoc: CanvasDoc = {
      ...gated.doc,
      nodes: gated.doc.nodes.map((node) =>
        node.id === "tasks"
          ? {
              ...node,
              ether: {
                ...node.ether,
                tasks: {
                  ...node.ether?.tasks,
                  items: (node.ether?.tasks?.items ?? []).map((item) =>
                    item.id === gated.task.id
                      ? {
                          ...item,
                          metadata: {
                            ...(item.metadata ?? {}),
                            [TASK_APPROVED_METADATA_KEY]: 0,
                          },
                        }
                      : item,
                  ),
                },
              },
            }
          : node,
      ),
    };
    const approvedClaim = workTaskClaim(
      approvedDoc,
      "alpha",
      "tasks",
      gated.task.id,
      worker,
      ids,
    );
    expect(approvedClaim.task.state).toBe("working");

    const auto = workTaskCreate(
      doc,
      "alpha",
      "tasks",
      "explicit auto",
      { details: "explicit auto" },
      ids,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { admission: "auto", admissionOmitted: "approval" },
    );
    expect(auto.task.admission).toBe("auto");
    const claimed = workTaskClaim(auto.doc, "alpha", "tasks", auto.task.id, worker, ids);
    expect(claimed.task.state).toBe("working");

    expect(() =>
      workTaskCreate(
        {
          nodes: [{
            ...emptyTaskNode(),
            ether: {
              entity: { kind: "task" },
              tasks: { items: [], contract: { incoming: { admission: "operator" } } },
            },
          }],
          edges: [],
        },
        "alpha",
        "tasks",
        "loosen",
        { details: "loosen" },
        ids,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { admission: "auto", admissionOmitted: "approval" },
      ),
    ).toThrow(/loosen/);
  });

  it("origin create stamps waitUntil from waitForMs", () => {
    const created = workTaskCreate(
      { nodes: [emptyTaskNode()], edges: [] },
      "alpha",
      "tasks",
      "delay me",
      { details: "delay me" },
      ids,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { waitForMs: 60_000, nowMs: Date.parse("2026-08-25T12:00:00.000Z") },
    );
    expect(created.task.waitUntil).toBe("2026-08-25T12:01:00.000Z");
    // Claim resolution reads the live clock: before the stamp passes, the
    // task is not claimable; after it, it is.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.parse("2026-08-25T12:00:30.000Z"));
      expect(() =>
        workTaskClaim(
          created.doc,
          "alpha",
          "tasks",
          created.task.id,
          actorRef("1", "worker-1"),
          ids,
        ),
      ).toThrow(/not claimable before/);
      vi.setSystemTime(Date.parse("2026-08-25T12:01:00.000Z"));
      const claimed = workTaskClaim(
        created.doc,
        "alpha",
        "tasks",
        created.task.id,
        actorRef("1", "worker-1"),
        ids,
      );
      expect(claimed.task.state).toBe("working");
    } finally {
      vi.useRealTimers();
    }
  });

  it("create → claim → transition, with contextId from canvas name", () => {
    let doc: CanvasDoc = { nodes: [emptyTaskNode()], edges: [] };
    const created = workTaskCreate(doc, "alpha", "tasks", "ship docs", { details: "ship docs" }, ids);
    doc = created.doc;
    expect(created.task.state).toBe("submitted");
    expect(created.task.history[0]?.parts[0]).toEqual({ kind: "text", text: "ship docs" });
    expect(created.task.history[0]?.contextId).toBe("alpha");
    expect((doc.nodes[0] as { text: string }).text).toBe("ship docs");

    const worker = actorRef("1", "worker-1");
    const claimed = workTaskClaim(doc, "alpha", "tasks", created.task.id, worker, ids);
    doc = claimed.doc;
    expect(claimed.task.state).toBe("working");
    expect(claimed.task.claimedBy).toBe(worker.seatId);
    expect(claimed.claimedBy).toEqual(worker);

    const historyLength = claimed.task.history.length;
    const alias = actorRef("1", "worker-alias", "beta");
    const replayed = workTaskClaim(
      doc,
      "alpha",
      "tasks",
      created.task.id,
      alias,
      ids
    );
    doc = replayed.doc;
    expect(replayed.task.history).toHaveLength(historyLength);
    expect(replayed.task.claimedBy).toBe(worker.seatId);
    expect(replayed.claimedBy).toEqual(alias);

    expect(() =>
      workTaskClaim(
        doc,
        "alpha",
        "tasks",
        created.task.id,
        actorRef("2", "other-agent"),
        ids
      )
    ).toThrow(WorkError);
    try {
      workTaskClaim(
        doc,
        "alpha",
        "tasks",
        created.task.id,
        actorRef("2", "other-agent"),
        ids
      );
    } catch (e) {
      expect(e).toBeInstanceOf(WorkError);
      expect((e as WorkError).code).toBe("claim_contention");
    }

    const done = workTaskTransition(
      doc,
      "alpha",
      "tasks",
      created.task.id,
      "completed",
      "shipped",
      ids
    );
    expect(done.task.state).toBe("completed");
    expect(done.task.history.at(-1)?.role).toBe("agent");
    expect(done.task.history.at(-1)?.parts[0]).toEqual({ kind: "text", text: "shipped" });
  });

  it("sends on completed work with visits, handoffNote, and a waitUntil at the next board", () => {
    const nowMs = Date.parse("2026-08-25T12:00:00.000Z");
    const board: CanvasDoc = {
      nodes: [emptyTaskNode("s1"), emptyTaskNode("s2")],
      edges: [{ id: "flow", fromNode: "s1", toNode: "s2", ether: { verb: "feeds" } }],
    };
    const created = workTaskCreate(board, "alpha", "s1", "move me", { details: "move me" }, ids);
    const claimed = workTaskClaim(
      created.doc,
      "alpha",
      "s1",
      created.task.id,
      actorRef("1", "worker-1"),
      ids,
    );
    const sentOn = workTaskTransition(
      claimed.doc,
      "alpha",
      "s1",
      created.task.id,
      "completed",
      "packaged",
      ids,
      undefined,
      {
        nowMs,
        handoffNote: "verified by the rerun suite",
        waitForMs: 60_000,
      },
    );

    // Origin row: closed visit with the canonical sent-on exit and handoffNote.
    expect(sentOn.task.state).toBe("completed");
    const originVisit = sentOn.task.visits?.at(-1);
    expect(originVisit).toMatchObject({
      board: "s1",
      exit: "sent-on",
      next: "s2",
      handoffNote: "verified by the rerun suite",
    });
    // Destination row: submitted, same epoch, waitUntil stamped from waitForMs.
    expect(sentOn.sentOn?.nodeId).toBe("s2");
    const successor = sentOn.sentOn?.task;
    expect(successor?.state).toBe("submitted");
    expect(successor?.claimedBy).toBeUndefined();
    expect(successor?.waitUntil).toBe("2026-08-25T12:01:00.000Z");
    expect(successor?.visits?.at(-1)).toMatchObject({ board: "s2" });
    expect(successor?.visits?.at(-1)?.exit).toBeUndefined();
    expect(successor?.visits?.at(-2)?.exit).toBe("sent-on");

    // Terminal close of a moved task stamps the completed exit.
    const closed = workTaskTransition(
      sentOn.doc,
      "alpha",
      "s2",
      created.task.id,
      "completed",
      "done at the end",
      ids,
      undefined,
      { nowMs },
    );
    expect(closed.task.visits?.at(-1)).toMatchObject({
      board: "s2",
      exit: "completed",
    });
  });

  it("send-back re-homes the task with a sent-back visit and a bumped epoch", () => {
    const nowMs = Date.parse("2026-08-25T12:00:00.000Z");
    const board: CanvasDoc = {
      nodes: [emptyTaskNode("s1"), emptyTaskNode("s2")],
      edges: [{ id: "flow", fromNode: "s1", toNode: "s2", ether: { verb: "feeds" } }],
    };
    const created = workTaskCreate(board, "alpha", "s1", "round trip", { details: "round trip" }, ids);
    const claimed = workTaskClaim(
      created.doc,
      "alpha",
      "s1",
      created.task.id,
      actorRef("1", "worker-1"),
      ids,
    );
    const sentOn = workTaskTransition(
      claimed.doc,
      "alpha",
      "s1",
      created.task.id,
      "completed",
      undefined,
      ids,
      undefined,
      { nowMs },
    );
    const defected = workTaskTransition(
      sentOn.doc,
      "alpha",
      "s2",
      created.task.id,
      "rejected",
      undefined,
      ids,
      undefined,
      {
        nowMs,
        defect: { summary: "misses the acceptance case", refs: ["sha-1"] },
      },
    );
    expect(defected.task.state).toBe("rejected");
    expect(defected.task.visits?.at(-1)).toMatchObject({
      board: "s2",
      exit: "sent-back",
      next: "s1",
    });
    expect(defected.sentBack?.nodeId).toBe("s1");
    const sentBack = defected.sentBack?.task;
    expect(sentBack?.state).toBe("submitted");
    expect(sentBack?.epoch).toBe(1);
    expect(sentBack?.visits?.at(-1)).toMatchObject({ board: "s1" });
    expect(sentBack?.defects).toEqual([
      { epoch: 1, target: "s1", at: "2026-08-25T12:00:00.000Z" },
    ]);
  });

  it("completion gate enforces rules in force and checks when sending on", () => {
    const board: CanvasDoc = {
      nodes: [
        emptyTaskNode("s1"),
        {
          ...emptyTaskNode("s2"),
          ether: {
            entity: { kind: "task" },
            tasks: {
              items: [],
              contract: {
                incoming: {
                  checks: [
                    { id: "check-in", label: "smoke", command: "bun run smoke" },
                  ],
                },
              },
            },
          },
        },
      ],
      edges: [{ id: "flow", fromNode: "s1", toNode: "s2", ether: { verb: "feeds" } }],
    };
    const created = workTaskCreate(
      board,
      "alpha",
      "s1",
      "gated move",
      { details: "gated move" },
      ids,
    );
    const claimed = workTaskClaim(
      created.doc,
      "alpha",
      "s1",
      created.task.id,
      actorRef("1", "worker-1"),
      ids,
    );

    // The incoming check of the next board has no result yet.
    expect(() =>
      workTaskTransition(
        claimed.doc,
        "alpha",
        "s1",
        created.task.id,
        "completed",
        undefined,
        ids,
        undefined,
        { next: "s2" },
      ),
    ).toThrow(/completion gate unsatisfied \[checks\]/);

    // A passing current-epoch result for the exact command satisfies the gate.
    const withResults: CanvasDoc = {
      ...claimed.doc,
      nodes: claimed.doc.nodes.map((node) =>
        node.id === "s1"
          ? {
              ...node,
              ether: {
                ...node.ether,
                tasks: {
                  ...node.ether?.tasks,
                  items: (node.ether?.tasks?.items ?? []).map((item) =>
                    item.id === created.task.id
                      ? {
                          ...item,
                          checkResults: [
                            {
                              checkId: "check-in",
                              side: "incoming",
                              command: "bun run smoke",
                              exitCode: 0,
                              outputTail: "",
                              at: "2026-08-25T12:00:00.000Z",
                              epoch: 0,
                            },
                          ],
                        }
                      : item,
                  ),
                },
              },
            }
          : node,
      ),
    };
    const sentOn = workTaskTransition(
      withResults,
      "alpha",
      "s1",
      created.task.id,
      "completed",
      undefined,
      ids,
      undefined,
      { next: "s2" },
    );
    expect(sentOn.task.state).toBe("completed");
    expect(sentOn.task.visits?.at(-1)?.exit).toBe("sent-on");

    // A board rule without a claim blocks terminal completion.
    const ruleBoard: CanvasDoc = {
      nodes: [
        {
          ...emptyTaskNode("s1"),
          ether: {
            entity: { kind: "task" },
            tasks: {
              items: [],
              contract: {
                rules: [{ id: "rule-b", text: "notes are filed" }],
              },
            },
          },
        },
      ],
      edges: [],
    };
    const withRule = workTaskCreate(
      ruleBoard,
      "alpha",
      "s1",
      "answered work",
      { details: "answered work" },
      ids,
    );
    const ruleClaimed = workTaskClaim(
      withRule.doc,
      "alpha",
      "s1",
      withRule.task.id,
      actorRef("1", "worker-1"),
      ids,
    );
    expect(() =>
      workTaskTransition(
        ruleClaimed.doc,
        "alpha",
        "s1",
        withRule.task.id,
        "completed",
        undefined,
        ids,
        undefined,
      ),
    ).toThrow(/completion gate unsatisfied \[claims\]/);
    const answered = workTaskTransition(
      ruleClaimed.doc,
      "alpha",
      "s1",
      withRule.task.id,
      "completed",
      "filed",
      ids,
      {
        artifacts: [],
        claims: [{ ruleId: "rule-b", text: "notes are filed and linked" }],
      },
    );
    expect(answered.task.state).toBe("completed");
  });

  it("generic transition cannot turn unclaimed submitted work into attention", () => {
    const doc: CanvasDoc = { nodes: [emptyTaskNode()], edges: [] };
    const created = workTaskCreate(doc, "c", "tasks", "needs answer", { details: "needs answer" }, ids);
    for (const state of ["input-required", "auth-required"] as const) {
      expect(() =>
        workTaskTransition(
          created.doc,
          "c",
          "tasks",
          created.task.id,
          state,
          undefined,
          ids
        )
      ).toThrowError(
        expect.objectContaining<Partial<WorkError>>({
          code: "illegal_transition",
        })
      );
    }
  });

  it("releases active work back to Queue and clears its claimant atomically", () => {
    const created = workTaskCreate({ nodes: [emptyTaskNode()], edges: [] }, "alpha", "tasks", "release me", { details: "release me" }, ids );
    const claimed = workTaskClaim(
      created.doc,
      "alpha",
      "tasks",
      created.task.id,
      actorRef("1", "worker-1"),
      ids
    );

    const released = workTaskTransition(
      claimed.doc,
      "alpha",
      "tasks",
      created.task.id,
      "submitted",
      undefined,
      ids
    );

    expect(released.task.state).toBe("submitted");
    expect(released.task.claimedBy).toBeUndefined();
    expect(released.task.history).toHaveLength(
      claimed.task.history.length + 1
    );
    expect(released.task.history.at(-1)).toMatchObject({
      role: "user",
      parts: [{ kind: "text", text: "Released to Queue by operator." }],
      metadata: {
        "vellum.taskRelease.actorSeatId": claimed.task.claimedBy,
      },
    });
  });

  it("rejects completed work with a QA comment, requeues it, and counts the rejection", () => {
    let doc: CanvasDoc = { nodes: [emptyTaskNode()], edges: [] };
    const created = workTaskCreate(doc, "alpha", "tasks", "prove the release", { details: "prove the release" }, ids );
    const claimed = workTaskClaim(
      created.doc,
      "alpha",
      "tasks",
      created.task.id,
      actorRef("1", "worker-1"),
      ids
    );
    const completed = workTaskTransition(
      claimed.doc,
      "alpha",
      "tasks",
      created.task.id,
      "completed",
      "shipped",
      ids
    );

    expect(() =>
      workTaskTransition(
        completed.doc,
        "alpha",
        "tasks",
        created.task.id,
        "submitted",
        undefined,
        ids
      )
    ).toThrow(/QA rejection comment is required/);

    const rejected = workTaskTransition(
      completed.doc,
      "alpha",
      "tasks",
      created.task.id,
      "submitted",
      "The proof does not include the release receipt.",
      ids
    );
    expect(rejected.task.state).toBe("submitted");
    expect(rejected.task.claimedBy).toBeUndefined();
    expect(rejected.task.metadata?.rejectedTimes).toBe(1);
    expect(rejected.task.completionEvidence).toBeUndefined();
    expect(rejected.task.history.at(-1)).toMatchObject({
      role: "user",
      parts: [{ kind: "text", text: "The proof does not include the release receipt." }],
      metadata: {
        "vellum.taskRelease.actorSeatId": claimed.task.claimedBy,
      },
    });

    const reclaimed = workTaskClaim(
      rejected.doc,
      "alpha",
      "tasks",
      created.task.id,
      actorRef("2", "worker-2"),
      ids
    );
    const completedAgain = workTaskTransition(
      reclaimed.doc,
      "alpha",
      "tasks",
      created.task.id,
      "completed",
      "updated proof",
      ids
    );
    const rejectedAgain = workTaskTransition(
      completedAgain.doc,
      "alpha",
      "tasks",
      created.task.id,
      "submitted",
      "The updated proof still omits the receipt.",
      ids
    );
    expect(rejectedAgain.task.metadata?.rejectedTimes).toBe(2);
  });

  it("respond atomically records one operator message and resolves attention", () => {
    let doc: CanvasDoc = { nodes: [emptyTaskNode()], edges: [] };
    const created = workTaskCreate(doc, "alpha", "tasks", "need direction", { details: "need direction" }, ids);
    const claimed = workTaskClaim(
      created.doc,
      "alpha",
      "tasks",
      created.task.id,
      actorRef("1", "worker-1"),
      ids
    );
    const waiting = workTaskTransition(
      claimed.doc,
      "alpha",
      "tasks",
      created.task.id,
      "input-required",
      "need the deployment region",
      ids
    );
    doc = waiting.doc;

    const responded = workTaskRespond(
      doc,
      "alpha",
      "tasks",
      created.task.id,
      "  Deploy to us-east-1.  ",
      "working",
      ids
    );

    expect(responded.task.state).toBe("working");
    expect(responded.task.history.at(-1)).toMatchObject({
      role: "user",
      taskId: created.task.id,
      parts: [{ kind: "text", text: "Deploy to us-east-1." }],
    });
    expect(() =>
      workTaskRespond(
        responded.doc,
        "alpha",
        "tasks",
        created.task.id,
        "another response",
        "working",
        ids
      )
    ).toThrowError(expect.objectContaining({ code: "illegal_transition" }));
    expect(
      (responded.doc.nodes[0]?.ether?.tasks?.items.find(
        (task) => task.id === created.task.id
      )?.history.length)
    ).toBe(responded.task.history.length);
  });

  it("describe re-authors the brief in place, keeps later notes, updates mirror text", () => {
    let doc: CanvasDoc = { nodes: [emptyTaskNode()], edges: [] };
    const created = workTaskCreate(doc, "alpha", "tasks", "ship docs", { details: "ship docs" }, ids);
    doc = created.doc;
    const noted = workTaskClaim(
      doc,
      "alpha",
      "tasks",
      created.task.id,
      actorRef("1", "worker-1"),
      ids
    );
    doc = noted.doc;

    const described = workTaskDescribe(doc, "alpha", "tasks", created.task.id, "ship the docs site", ids);
    doc = described.doc;
    expect(described.task.history[0]?.parts[0]).toEqual({ kind: "text", text: "ship the docs site" });
    expect(described.task.history[0]?.role).toBe("user");
    expect(described.task.history.at(-1)?.parts[0]).toEqual({
      kind: "text",
      text: `claimed by ${actorRef("1", "worker-1").seatId}`,
    });
    expect(described.task.state).toBe("working");
    expect((doc.nodes[0] as { text: string }).text).toBe("ship the docs site");
  });

  it("describe rejects empty briefs, terminal states, and unknown ids", () => {
    let doc: CanvasDoc = { nodes: [emptyTaskNode()], edges: [] };
    const created = workTaskCreate(doc, "c", "tasks", "x", { details: "x" }, ids);
    doc = created.doc;

    expect(() => workTaskDescribe(doc, "c", "tasks", created.task.id, "   ", ids)).toThrow(WorkError);
    expect(() => workTaskDescribe(doc, "c", "tasks", "nope", "y", ids)).toThrow(WorkError);

    const done = workTaskTransition(doc, "c", "tasks", created.task.id, "completed", undefined, ids);
    doc = done.doc;
    try {
      workTaskDescribe(doc, "c", "tasks", created.task.id, "rewrite history", ids);
      expect.unreachable("terminal task must not be re-described");
    } catch (e) {
      expect(e).toBeInstanceOf(WorkError);
      expect((e as WorkError).code).toBe("illegal_transition");
    }
  });

  it("rejects illegal transitions and unknown ids", () => {
    let doc: CanvasDoc = { nodes: [emptyTaskNode()], edges: [] };
    const created = workTaskCreate(doc, "c", "tasks", "x", { details: "x" }, ids);
    doc = created.doc;
    expect(() =>
      workTaskTransition(
        doc,
        "c",
        "tasks",
        created.task.id,
        "working",
        undefined,
        ids
      )
    ).toThrow(/cannot transition/);
    const completed = workTaskTransition(
      doc,
      "c",
      "tasks",
      created.task.id,
      "completed",
      undefined,
      ids
    );
    doc = completed.doc;
    expect(() =>
      workTaskTransition(doc, "c", "tasks", created.task.id, "working", undefined, ids)
    ).toThrow(/cannot transition/);
    expect(() => workTaskCreate(doc, "c", "missing", "x", { details: "x" }, ids)).toThrow(
      /not found/
    );
  });

  it("finish criteria gate blocks complete without evidence; skip when off-home", () => {
    const doc: CanvasDoc = { nodes: [emptyTaskNode()], edges: [] };
    const created = workTaskCreate(doc, "c", "tasks", "gated", { details: "gated" }, ids, undefined, undefined, undefined, { git: { minCommits: 1 } } );
    expect(created.task.finishCriteria?.git?.minCommits).toBe(1);
    expect(() =>
      workTaskTransition(
        created.doc,
        "c",
        "tasks",
        created.task.id,
        "completed",
        undefined,
        ids
      )
    ).toThrow(/finish criteria unsatisfied/);
    const skipped = workTaskTransition(
      created.doc,
      "c",
      "tasks",
      created.task.id,
      "completed",
      undefined,
      ids,
      undefined,
      { evaluateFinishCriteria: false }
    );
    expect(skipped.task.state).toBe("completed");
    const withEvidence = workTaskTransition(
      created.doc,
      "c",
      "tasks",
      created.task.id,
      "completed",
      undefined,
      ids,
      { artifacts: [], git: { commits: ["3f8a2c9d1b4e5f60718293a4b5c6d7e8f9012345"] } }
    );
    expect(withEvidence.task.completionEvidence?.git?.commits).toEqual(["3f8a2c9d1b4e5f60718293a4b5c6d7e8f9012345"]);
  });

  it("rejects the retired metadata claimant instead of tolerating a dual shape", () => {
    const doc: CanvasDoc = { nodes: [emptyTaskNode()], edges: [] };
    expect(() =>
      workTaskCreate(
        doc,
        "c",
        "tasks",
        "x",
        { claimedBy: actorRef("1", "worker-1", "c").seatId },
        ids
      )
    ).toThrow(/metadata\.claimedBy is retired/);
  });

  it("request raised by an actor is claimed by that actor at birth, with its reason", () => {
    const doc: CanvasDoc = { nodes: [emptyRequestsNode()], edges: [] };
    const raised = workRequestCreate(
      doc,
      "c",
      "req",
      "need a key",
      undefined,
      ids,
      actorRef("7", "actor-7", "c"),
      "signing is gated on the operator's key"
    );
    expect(raised.task.state).toBe("input-required");
    expect(raised.task.claimedBy).toBe(actorRef("7", "actor-7", "c").seatId);
    expect(raised.task.reason).toBe("signing is gated on the operator's key");
  });

  it("rejects title-only request create (no reason and no metadata.details)", () => {
    const doc: CanvasDoc = { nodes: [emptyRequestsNode()], edges: [] };
    expect(() =>
      workRequestCreate(
        doc,
        "c",
        "req",
        "title only is not enough",
        { class: "review" },
        ids,
        actorRef("7", "actor-7", "c"),
      ),
    ).toThrow(/request body required/);
    expect(() =>
      workRequestCreate(
        doc,
        "c",
        "req",
        "title only is not enough",
        undefined,
        ids,
        actorRef("7", "actor-7", "c"),
      ),
    ).toThrow(/request body required/);
    expect(() =>
      workRequestCreate(
        doc,
        "c",
        "req",
        "title only is not enough",
        { details: "   " },
        ids,
        actorRef("7", "actor-7", "c"),
        "   ",
      ),
    ).toThrow(/request body required/);
  });

  it("task create records its reason first-class", () => {
    const doc: CanvasDoc = { nodes: [emptyTaskNode()], edges: [] };
    const created = workTaskCreate(doc, "c", "tasks", "port the map", { details: "port the map" }, ids, "fleet epic");
    expect(created.task.reason).toBe("fleet epic");
    const bare = workTaskCreate(doc, "c", "tasks", "port the map", { details: "port the map" }, ids);
    expect(bare.task.reason).toBeUndefined();
  });

  it("task create attaches first-class media raw parts on the brief", () => {
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const doc: CanvasDoc = { nodes: [emptyTaskNode()], edges: [] };
    const created = workTaskCreate(
      doc,
      "c",
      "tasks",
      "fix the screenshot bug",
      { title: "screenshot bug", details: "see attached" },
      ids,
      undefined,
      [{ kind: "raw", bytesBase64: pngBase64, mediaType: "image/png" }]
    );
    expect(created.task.history[0]?.parts).toEqual([
      { kind: "text", text: "fix the screenshot bug" },
      { kind: "raw", bytesBase64: pngBase64, mediaType: "image/png" },
    ]);
    expect(() =>
      workTaskCreate(doc, "c", "tasks", "bad media", { details: "bad media" }, ids, undefined, [
        { kind: "raw", bytesBase64: pngBase64, mediaType: "application/pdf" },
      ])
    ).toThrow(/mediaType not allowed/);
    expect(() =>
      workTaskCreate(doc, "c", "tasks", "empty media", { details: "empty media" }, ids, undefined, [
        { kind: "raw", bytesBase64: "", mediaType: "image/png" },
      ])
    ).toThrow(/empty/);
  });

  it("request create + resolve appends user message and clears input-required", () => {
    let doc: CanvasDoc = { nodes: [emptyRequestsNode()], edges: [] };
    const created = workRequestCreate(
      doc,
      "c",
      "req",
      "need approval",
      { class: "review", details: "ship checklist before release" },
      ids,
      actorRef("4", "actor-4", "c")
    );
    doc = created.doc;
    expect(created.task.state).toBe("input-required");
    expect(created.task.metadata?.class).toBe("review");
    expect(created.task.claimedBy).toBe(actorRef("4", "actor-4", "c").seatId);
    // Mirror leads with the sink identity (unnamed → kind), then the count.
    expect((doc.nodes[0] as { text: string }).text.startsWith("requests\n1 pending")).toBe(true);

    const resolved = workRequestResolve(
      doc,
      "c",
      "req",
      created.task.id,
      "approved",
      "completed",
      ids
    );
    expect(resolved.task.state).toBe("completed");
    expect(resolved.task.history.at(-1)?.role).toBe("user");
    // The answer is first-class on the item, not only buried in history.
    expect(resolved.task.response).toBe("approved");
    expect((resolved.doc.nodes[0] as { text: string }).text.startsWith("requests\n0 pending")).toBe(true);
  });

  it("message append to agent list and task history", () => {
    let doc: CanvasDoc = {
      nodes: [emptyTaskNode(), agentNode()],
      edges: [],
    };
    const created = workTaskCreate(doc, "c", "tasks", "brief", { details: "brief" }, ids);
    doc = created.doc;
    const msg: Message = {
      messageId: "manual-1",
      role: "agent",
      parts: [{ kind: "text", text: "status note" }],
    };
    const onTask = workMessageAppend(doc, "c", "tasks", created.task.id, msg);
    doc = onTask.doc;
    const task = doc.nodes
      .find((n) => n.id === "tasks")
      ?.ether?.tasks?.items.find((t) => t.id === created.task.id);
    expect(task?.history.some((h) => h.messageId === "manual-1")).toBe(true);

    const onAgent = workMessageAppend(doc, "c", "agent", null, {
      messageId: "manual-2",
      role: "user",
      parts: [{ kind: "text", text: "ping" }],
    });
    const messages = onAgent.doc.nodes.find((n) => n.id === "agent")?.ether?.messages?.items;
    expect(messages?.some((m) => m.messageId === "manual-2")).toBe(true);
    expect(messages?.[0]?.contextId).toBe("c");
  });

  it("uses region label as contextId when node is inside a group", () => {
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
        {
          id: "tasks",
          type: "text",
          text: "tasks",
          x: 40,
          y: 40,
          width: 120,
          height: 80,
          ether: { entity: { kind: "task" } },
        },
      ],
      edges: [],
    };
    const created = workTaskCreate(doc, "canvas-name", "tasks", "inside", { details: "inside" }, ids);
    expect(created.task.history[0]?.contextId).toBe("forge-lane");
  });

  it("links artifacts only to an exact claimed task in the same canvas", () => {
    const artifactNode: CanvasDoc["nodes"][number] = {
      id: "artifacts",
      type: "text",
      text: "artifacts",
      x: 240,
      y: 0,
      width: 200,
      height: 100,
      ether: { entity: { kind: "artifacts" } },
    };
    let doc: CanvasDoc = {
      nodes: [emptyTaskNode(), artifactNode],
      edges: [],
    };
    const created = workTaskCreate(doc, "alpha", "tasks", "ship", { details: "ship" }, ids );
    doc = created.doc;

    const artifact = {
      artifactId: "artifact-task-proof",
      parts: [{ kind: "text" as const, text: "proof" }],
      task: {
        kind: "task" as const,
        itemId: created.task.id,
        sink: { canvasName: "alpha", nodeId: "tasks" },
      },
    };

    expect(() =>
      workArtifactPublish(doc, "alpha", "artifacts", artifact)
    ).toThrow(/must be claimed/);

    const claimed = workTaskClaim(
      doc,
      "alpha",
      "tasks",
      created.task.id,
      actorRef("1", "worker-1"),
      ids
    );
    doc = claimed.doc;
    expect(
      workArtifactPublish(doc, "alpha", "artifacts", artifact).artifact.task
    ).toEqual(artifact.task);

    expect(() =>
      workArtifactPublish(doc, "alpha", "artifacts", {
        ...artifact,
        artifactId: "artifact-missing-task",
        task: { ...artifact.task, itemId: "missing" },
      })
    ).toThrow(/not found/);

    expect(() =>
      workArtifactPublish(doc, "alpha", "artifacts", {
        ...artifact,
        artifactId: "artifact-cross-canvas",
        task: {
          ...artifact.task,
          sink: { ...artifact.task.sink, canvasName: "other" },
        },
      })
    ).toThrow(/artifact canvas/);
  });

  it("artifact archive soft-hides and delete removes from the sink", () => {
    const artifactNode: CanvasNode = {
      id: "artifacts",
      type: "text",
      text: "artifacts",
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      ether: { entity: { kind: "artifacts" } },
    };
    let doc: CanvasDoc = { nodes: [artifactNode], edges: [] };
    const published = workArtifactPublish(doc, "alpha", "artifacts", {
      artifactId: "a1",
      name: "proof.md",
      parts: [{ kind: "text", text: "body" }],
    });
    doc = published.doc;
    expect(isArtifactArchived(published.artifact)).toBe(false);

    const archived = workArtifactArchive(doc, "artifacts", "a1", true);
    doc = archived.doc;
    expect(isArtifactArchived(archived.artifact)).toBe(true);
    expect(
      doc.nodes[0]?.ether?.artifacts?.items.find((a) => a.artifactId === "a1")
        ?.metadata?.archived,
    ).toBe(true);

    const restored = workArtifactArchive(doc, "artifacts", "a1", false);
    doc = restored.doc;
    expect(isArtifactArchived(restored.artifact)).toBe(false);
    expect(restored.artifact.metadata?.archived).toBeUndefined();

    const deleted = workArtifactDelete(doc, "artifacts", "a1");
    expect(deleted.artifactId).toBe("a1");
    expect(deleted.doc.nodes[0]?.ether?.artifacts?.items).toEqual([]);
    expect(() => workArtifactDelete(deleted.doc, "artifacts", "a1")).toThrow(
      /not found/,
    );
  });

  it("state machine: completed work only exits through the QA Queue path", () => {
    expect(canTransitionTaskState("completed", "working")).toBe(false);
    expect(canTransitionTaskState("completed", "submitted")).toBe(true);
    expect(canTransitionTaskState("submitted", "working")).toBe(false);
    expect(canTransitionTaskState("input-required", "rejected")).toBe(true);
    expect(canTransitionTaskState("input-required", "failed")).toBe(true);
    // No producer may enter auth-required; residual rows may still heal out.
    expect(canTransitionTaskState("working", "auth-required")).toBe(false);
    expect(canTransitionTaskState("input-required", "auth-required")).toBe(false);
    expect(canTransitionTaskState("auth-required", "completed")).toBe(true);
    expect(canTransitionTaskState("auth-required", "input-required")).toBe(true);
  });
});
