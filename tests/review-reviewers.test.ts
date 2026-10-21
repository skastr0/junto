import { describe, expect, it } from "vitest";
import type { ActorSeatId } from "../src/shared/actor-seat";
import type { NodeId } from "../src/shared/physics/schema";
import { seatNodeId, type Reviewer } from "../src/shared/task-model";
import type { ActorRef } from "../src/shared/work-reference";
import type { ReviewVerdict } from "../src/shared/crew";
import type { RuleInForce } from "../src/shared/rules";
import {
  evaluateReviewGate,
  reviewerSeatsOf,
  type ReviewSubjectProjection,
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

describe("evaluateReviewGate", () => {
  const projection = {
    installationId: "cc", canvasName: "c", nodeId: "board", taskId: "t1",
    state: "working", epoch: 2, subjectHash: "h", refs: [], authorSeatId: seat("author"),
  } as ReviewSubjectProjection;
  const green = {
    verdictId: "v1", kind: "green", reviewerSeatId: seat("r"), authorSeatId: seat("author"),
    subject: { kind: "task", installationId: "cc", canvasName: "c", nodeId: "board", taskId: "t1", epoch: 2, subjectHash: "h" },
    subjectHash: "h", epoch: 2, findings: [], refs: [], postedAtMs: 1,
  } as ReviewVerdict;
  const rules = [{
    rule: { id: "r1", kind: "requires-review", text: "a reviewer signs off" },
    provenance: { kind: "board", boardId: "board" },
  }] as unknown as ReadonlyArray<RuleInForce>;
  const gate = (listed: boolean) => evaluateReviewGate({
    rulesInForce: rules, projection, verdicts: [green], authorSeatId: seat("author"),
    reviewerListed: () => listed,
  });

  it("counts a listed reviewer's green on the current binding", () => {
    expect(gate(true).satisfied).toBe(true);
  });

  it("drops a green whose reviewer was taken off the list", () => {
    expect(gate(false)).toMatchObject({ satisfied: false, unsatisfied: [{ ruleId: "r1", reason: "reviewer-removed" }] });
  });
});
