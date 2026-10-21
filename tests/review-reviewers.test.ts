import { describe, expect, it } from "vitest";
import type { ActorSeatId } from "../src/shared/actor-seat";
import type { NodeId } from "../src/shared/physics/schema";
import { seatNodeId, type Reviewer } from "../src/shared/task-model";
import type { ActorRef } from "../src/shared/work-reference";
import {
  REVIEW_REASON_NOT_REVIEWER,
  planVerdictPost,
  reviewerSeatsOf,
} from "../src/main/junto/work/reviews";

// Review eligibility lives on the task's reviewer list; no edge grants it.

const seat = (id: string): ActorSeatId => `seat-${id}` as ActorSeatId;
const ref = (node: string, seatId: ActorSeatId = seat(node)): ActorRef =>
  ({ canvasName: "c", nodeId: node, seatId }) as ActorRef;
const listed = (node: string): Reviewer => ({ kind: "seat", seat: seatNodeId(node as NodeId) });

describe("reviewerSeatsOf", () => {
  it("resolves listed seats through the live refs, in list order", () => {
    expect(reviewerSeatsOf({
      reviewers: [listed("b"), { kind: "operator" }, listed("ghost"), listed("a")],
      actorRefs: [ref("a"), ref("b")],
    })).toEqual([
      { nodeId: "b", seatId: seat("b") },
      { nodeId: "a", seatId: seat("a") },
    ]);
  });

  it("keeps one entry for a stable seat listed under two live nodes", () => {
    expect(reviewerSeatsOf({
      reviewers: [listed("a1"), listed("a2")],
      actorRefs: [ref("a1", seat("a")), ref("a2", seat("a"))],
    })).toEqual([{ nodeId: "a1", seatId: seat("a") }]);
  });
});

describe("planVerdictPost", () => {
  const post = (reviewerListed: boolean) => planVerdictPost({
    caller: { seatId: seat("r"), nodeId: "r" },
    subject: { kind: "commit", sha: "abc123", authorSeatId: seat("author") },
    kind: "green",
    findings: [],
    refs: [],
    reviewerListed,
    verdictId: "v1",
    postedAtMs: 1,
  });

  it("refuses a seat that is not a reviewer of the subject", () => {
    const plan = post(false);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toMatchObject({ details: { reason: REVIEW_REASON_NOT_REVIEWER } });
  });

  it("plans the verdict for a listed reviewer", () => {
    expect(post(true).ok).toBe(true);
  });
});
