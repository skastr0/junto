/**
 * AI-driven seat state: precedence, the two bounds, and the delivery veto.
 *
 * The point of these tests is that the model DRIVES the seat (state, health,
 * hold) while two things stay structurally true: a proven dialog cannot be
 * downgraded by an AI reading, and the model never gets to say a seat is idle.
 */

import { describe, expect, it } from "vitest";
import {
  AWARENESS_SEAT_STATES,
  awarenessSeatVerdict,
  type AwarenessSeatState,
} from "../src/main/junto/term/awareness/seat-state";
import type { AwarenessAssessment } from "../src/main/junto/term/awareness/project-result";
import type { AiActivityValue, AiConcernValue } from "../src/main/junto/term/awareness/questions";

const provenance = {
  bindingId: "seat-1",
  epoch: "e1",
  sourceSeq: "42",
  observedAt: 1_000_000,
  questionPackVersion: "pack-1",
  requestedModel: "jev-latest",
  returnedModel: "jev-1.13.0",
  evidenceHash: "hash-1",
} as unknown as AwarenessAssessment["provenance"];

const assessment = (
  input: {
    readonly availability?: AwarenessAssessment["availability"];
    readonly concerns?: readonly AiConcernValue[];
    readonly activity?: AiActivityValue;
    readonly activityReason?: string;
    readonly absentConcerns?: readonly AiConcernValue[];
  } = {},
): AwarenessAssessment => {
  const concerns = input.concerns ?? [];
  const activity = input.activity ?? "indeterminate";
  return {
    advisory: true,
    availability: input.availability ?? "current",
    packVersion: "pack-1",
    activity: {
      value: activity,
      reason: input.activityReason ?? "test",
      ...(activity === "indeterminate" ? {} : { probability: 0.95 }),
      signals:
        activity === "indeterminate"
          ? []
          : [{ questionId: `activity.${activity}`, value: activity, probability: 0.95 }],
    },
    concerns: concerns.map((concern) => ({
      concern,
      questionId: `concern.${concern}`,
      display: concern,
      probability: 0.97,
      evidenceLineIds: [`L00${concerns.indexOf(concern) + 1}`],
    })),
    negatives: (input.absentConcerns ?? []).map((concern) => ({
      questionId: `concern.${concern}`,
      concern,
      probability: 0.05,
      display: concern,
      crossCheckOnly: false,
    })),
    unansweredConcerns: [],
    abstentions: [],
    rejections: [],
    provenance,
  };
};

describe("AI-driven seat state", () => {
  it("has no idle state: the model never gets to call a seat idle", () => {
    expect(AWARENESS_SEAT_STATES).not.toContain("idle" as AwarenessSeatState);
    // A quiet screen with everything ruled out is `clear`, never idle. Its
    // activity can still be unreadable; the state says so and the health stays
    // clear, because the two facts are independent.
    const verdict = awarenessSeatVerdict(assessment({ absentConcerns: ["approval_requested"] }));
    expect(verdict.state).toBe("unclear");
    expect(verdict.health).toBe("clear");
    expect(verdict.holdDelivery).toBe(false);

    // With no negatives at all there is nothing to report.
    expect(awarenessSeatVerdict(assessment({})).health).toBe("unknown");
  });

  it("drives the state from a raised concern, in declared precedence", () => {
    const approval = awarenessSeatVerdict(assessment({ concerns: ["approval_requested"] }));
    expect(approval.state).toBe("waiting_on_approval");
    expect(approval.health).toBe("attention");
    expect(approval.holdDelivery).toBe(true);
    expect(approval.evidenceLineIds).toEqual(["L001"]);

    // Access outranks a pending answer, and both outrank an execution error.
    const access = awarenessSeatVerdict(
      assessment({ concerns: ["execution_error", "answer_requested", "access_problem"] }),
    );
    expect(access.state).toBe("blocked_on_access");
    expect(access.concern).toBe("access_problem");

    const answer = awarenessSeatVerdict(
      assessment({ concerns: ["execution_error", "answer_requested"] }),
    );
    expect(answer.state).toBe("waiting_on_answer");
  });

  it("reads a repeat failure as an error loop, and a single one as a failure", () => {
    const looping = awarenessSeatVerdict(
      assessment({ concerns: ["execution_error", "repetition"] }),
    );
    expect(looping.state).toBe("error_looping");
    expect(looping.health).toBe("degraded");
    expect(looping.holdDelivery).toBe(true);

    const single = awarenessSeatVerdict(assessment({ concerns: ["execution_error"] }));
    expect(single.state).toBe("execution_failed");
    // Degraded is not attention: a failed command is not a request for a human.
    expect(single.holdDelivery).toBe(false);
  });

  it("maps every accepted activity property to a state, and never holds delivery for one", () => {
    const expected: ReadonlyArray<readonly [AiActivityValue, AwarenessSeatState]> = [
      ["reviewing", "reviewing"],
      ["editing", "editing"],
      ["testing", "testing"],
      ["running_command", "running_command"],
      ["investigating", "investigating"],
    ];
    for (const [activity, state] of expected) {
      const verdict = awarenessSeatVerdict(assessment({ activity }));
      expect(verdict.state).toBe(state);
      expect(verdict.health).toBe("active");
      expect(verdict.holdDelivery).toBe(false);
    }
  });

  it("calls an unreadable screen unclear rather than inventing work", () => {
    const verdict = awarenessSeatVerdict(assessment({ activityReason: "no_activity_property_accepted" }));
    expect(verdict.state).toBe("unclear");
    expect(verdict.health).toBe("unknown");
    expect(verdict.holdDelivery).toBe(false);
  });

  it("yields no judgment at all when the assessment is not current", () => {
    for (const availability of ["abstained", "unavailable"] as const) {
      const verdict = awarenessSeatVerdict(
        assessment({ availability, concerns: ["approval_requested"] }),
      );
      expect(verdict.state).toBeNull();
      expect(verdict.health).toBe("unknown");
      expect(verdict.holdDelivery).toBe(false);
      expect(verdict.reason).toContain(availability);
    }
  });

  it("never lets an AI reading downgrade a proven dialog", () => {
    const verdict = awarenessSeatVerdict(
      assessment({ activity: "editing" }),
      "attention",
    );
    // The screen proved a dialog; the AI's reading is carried as detail only.
    expect(verdict.state).toBeNull();
    expect(verdict.health).toBe("attention");
    expect(verdict.deterministicWins).toBe(true);
    expect(verdict.reason).toContain("deterministic attention wins");
  });

  it("still holds a delivery closed when the deterministic state wins", () => {
    const verdict = awarenessSeatVerdict(
      assessment({ concerns: ["approval_requested"] }),
      "attention",
    );
    expect(verdict.state).toBeNull();
    expect(verdict.holdDelivery).toBe(true);
    expect(verdict.concern).toBe("approval_requested");
  });

  it("holds delivery for exactly the four states that mean a human is the obstacle", () => {
    const holding: readonly AiConcernValue[] = [
      "access_problem",
      "approval_requested",
      "answer_requested",
    ];
    for (const concern of holding) {
      expect(awarenessSeatVerdict(assessment({ concerns: [concern] })).holdDelivery).toBe(true);
    }
    expect(
      awarenessSeatVerdict(assessment({ concerns: ["execution_error", "repetition"] })).holdDelivery,
    ).toBe(true);
    // Never for work, and never for a clear or unreadable seat.
    expect(awarenessSeatVerdict(assessment({ activity: "testing" })).holdDelivery).toBe(false);
    expect(awarenessSeatVerdict(assessment({})).holdDelivery).toBe(false);
    expect(
      awarenessSeatVerdict(assessment({ absentConcerns: ["execution_error"] })).holdDelivery,
    ).toBe(false);
  });
});
