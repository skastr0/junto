import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import { canTransitionTaskState } from "../src/shared/task";
import {
  WorkError,
  workRequestCreate,
  workTaskClaim,
  workTaskCreate,
  workTaskTransition,
} from "../src/shared/work";
import { ActorRef } from "../src/shared/work-protocol";

const ids = (() => {
  let next = 0;
  return {
    id: () => `task-${++next}`,
    messageId: () => `message-${++next}`,
  };
})();

const actorRef = (
  digit: string,
  nodeId: string,
  canvasName: string
) =>
  Schema.decodeUnknownSync(ActorRef)({
    seatId: `seat_${digit.repeat(64)}`,
    canvasName,
    nodeId,
  });

const taskDoc = (): CanvasDoc => ({
  nodes: [
    {
      id: "tasks",
      type: "text",
      text: "tasks",
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      ether: { entity: { kind: "task" } },
    },
  ],
  edges: [],
});

const requestDoc = (): CanvasDoc => ({
  nodes: [
    {
      id: "requests",
      type: "text",
      text: "0 pending",
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      ether: { entity: { kind: "requests" } },
    },
  ],
  edges: [],
});

describe("work claimant policy", () => {
  it("claims submitted work through ActorRef and stamps only Task.claimedBy", () => {
    const created = workTaskCreate(taskDoc(), "alpha", "tasks", "ship", { details: "ship" }, ids );
    const actor = actorRef("1", "worker-a", "alpha");

    const claimed = workTaskClaim(
      created.doc,
      "alpha",
      "tasks",
      created.task.id,
      actor,
      ids
    );

    expect(claimed.task.state).toBe("working");
    expect(claimed.task.claimedBy).toBe(actor.seatId);
    // Description is required at create; claim must not stamp retired metadata.claimedBy.
    expect(claimed.task.metadata).toEqual({ details: "ship" });
    expect(claimed.claimedBy).toEqual(actor);
  });

  it("keys idempotency and contention on stable ActorSeatId", () => {
    const created = workTaskCreate(taskDoc(), "alpha", "tasks", "ship", { details: "ship" }, ids );
    const first = actorRef("1", "worker-a", "alpha");
    const claimed = workTaskClaim(
      created.doc,
      "alpha",
      "tasks",
      created.task.id,
      first,
      ids
    );
    const historyLength = claimed.task.history.length;
    const alias = actorRef("1", "worker-alias", "beta");

    const replayed = workTaskClaim(
      claimed.doc,
      "alpha",
      "tasks",
      created.task.id,
      alias,
      ids
    );

    expect(replayed.task.history).toHaveLength(historyLength);
    expect(replayed.task.claimedBy).toBe(first.seatId);
    expect(replayed.claimedBy).toEqual(alias);
    expect(() =>
      workTaskClaim(
        replayed.doc,
        "alpha",
        "tasks",
        created.task.id,
        actorRef("2", "worker-b", "alpha"),
        ids
      )
    ).toThrowError(
      expect.objectContaining<Partial<WorkError>>({
        code: "claim_contention",
      })
    );
  });

  it("reserves the first submitted-to-working transition for claim", () => {
    const created = workTaskCreate(taskDoc(), "alpha", "tasks", "ship", { details: "ship" }, ids );

    expect(canTransitionTaskState("submitted", "working")).toBe(false);
    for (const state of [
      "working",
      "input-required",
      "auth-required",
    ] as const) {
      expect(canTransitionTaskState("submitted", state)).toBe(false);
      expect(() =>
        workTaskTransition(
          created.doc,
          "alpha",
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

  it("rejects metadata.claimedBy instead of preserving a compatibility shape", () => {
    expect(() =>
      workTaskCreate(
        taskDoc(),
        "alpha",
        "tasks",
        "ship",
        { claimedBy: actorRef("1", "worker-a", "alpha").seatId },
        ids
      )
    ).toThrowError(
      expect.objectContaining<Partial<WorkError>>({
        code: "invalid",
      })
    );
  });

  it("claims actor-raised requests first-class at creation", () => {
    const actor = actorRef("3", "worker-c", "alpha");
    const raised = workRequestCreate(
      requestDoc(),
      "alpha",
      "requests",
      "need approval",
      { class: "review", details: "operator must approve before continue" },
      ids,
      actor
    );

    expect(raised.task.state).toBe("input-required");
    expect(raised.task.claimedBy).toBe(actor.seatId);
    expect(raised.task.metadata).toEqual({
      class: "review",
      details: "operator must approve before continue",
    });
  });
});
