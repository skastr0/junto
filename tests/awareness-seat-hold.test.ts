/**
 * The AI seat hold — the one consumer that is not display.
 *
 * The verdict is derived elsewhere (`seat-state.ts`); this pins the registry
 * that the drive reads before typing into a seat, and the direction of every
 * failure: a hold is only ever added, and every unknown clears it.
 */

import { describe, expect, it } from "vitest";
import type { AwarenessAdvisory } from "../src/main/junto/term/awareness/scheduler";
import { makeAwarenessSeatHold } from "../src/main/junto/term/awareness/seat-hold";
import type {
  ActivityProjection,
  AwarenessAssessment,
  ConcernProjection,
} from "../src/main/junto/term/awareness/project-result";
import type {
  AiActivityValue,
  AiConcernValue,
} from "../src/main/junto/term/awareness/questions";

const activity = (
  value: AiActivityValue,
  signals: ActivityProjection["signals"] = [
    { questionId: `activity.${value}`, value, probability: 0.95 },
  ],
): ActivityProjection => ({
  value,
  reason: "test",
  signals,
});

const concern = (
  value: AiConcernValue,
  evidenceLineIds: readonly string[] = [],
): ConcernProjection => ({
  concern: value,
  questionId: `concern.${value}`,
  display: value,
  probability: 0.95,
  evidenceLineIds,
});

const assessment = (
  over: Partial<AwarenessAssessment> = {},
): AwarenessAssessment => ({
  advisory: true,
  availability: "current",
  packVersion: "awareness-pack/1",
  activity: activity("editing"),
  concerns: [],
  negatives: [],
  unansweredConcerns: [],
  abstentions: [],
  rejections: [],
  provenance: {
    bindingId: "b1",
    epoch: "e1",
    sourceSeq: "1",
    evidenceHash: "d1",
    observedAt: 1_000,
    packVersion: "awareness-pack/1",
    gaps: [],
  },
  ...over,
});

const advisory = (over: Partial<AwarenessAdvisory> & { readonly bindingId: string }): AwarenessAdvisory =>
  ({
    epoch: "e1",
    assessmentId: "a1",
    absences: [],
    unansweredConcerns: [],
    evidenceLines: [],
    evidenceDigest: "d1",
    windowDigest: "d1",
    windowCapturedAt: 1_000,
    availability: "current",
    status: "current",
    reason: "judged",
    pending: false,
    trigger: undefined,
    ...over,
  }) as unknown as AwarenessAdvisory;

const waiting = advisory({
  bindingId: "b1",
  assessment: assessment({ concerns: [concern("approval_requested", ["L003"])] }),
});

describe("AI seat hold", () => {
  it("holds the drive for a seat the AI judged blocked on an approval", () => {
    const hold = makeAwarenessSeatHold();
    expect(hold.holds("b1")).toBe(false);
    hold.apply(waiting);
    expect(hold.holds("b1")).toBe(true);
    expect(hold.verdictFor("b1")?.state).toBe("waiting_on_approval");
    expect(hold.verdictFor("b1")?.concern).toBe("approval_requested");
  });

  it("holds for every holding state and never for a working one", () => {
    const hold = makeAwarenessSeatHold();
    // The dialog states hold: the seat cannot accept input past a dialog.
    const holdingConcerns: readonly AiConcernValue[] = [
      "access_problem",
      "approval_requested",
      "answer_requested",
    ];
    for (const raised of holdingConcerns) {
      hold.apply(
        advisory({
          bindingId: "b1",
          assessment: assessment({ concerns: [concern(raised)] }),
        }),
      );
      expect(hold.holds("b1")).toBe(true);
    }
    // A failure is degraded, not a dialog: the seat can still take a prompt, so
    // it is reported and not held.
    hold.apply(
      advisory({
        bindingId: "b1",
        assessment: assessment({ concerns: [concern("execution_error")] }),
      }),
    );
    expect(hold.verdictFor("b1")?.state).toBe("execution_failed");
    expect(hold.verdictFor("b1")?.health).toBe("degraded");
    expect(hold.holds("b1")).toBe(false);
    hold.apply(
      advisory({
        bindingId: "b1",
        assessment: assessment({ activity: activity("editing") }),
      }),
    );
    expect(hold.holds("b1")).toBe(false);
    expect(hold.verdictFor("b1")?.state).toBe("editing");
  });

  it("clears the hold when the sidecar has nothing to say", () => {
    const hold = makeAwarenessSeatHold();
    hold.apply(waiting);
    expect(hold.holds("b1")).toBe(true);
    // The gate-off notice, a missing key, a provider failure, an abstention
    // with no verdict: none of them is evidence of a dialog.
    hold.apply(
      advisory({
        bindingId: "b1",
        availability: "unavailable",
        unavailableReason: "not_configured",
        assessment: undefined,
      }),
    );
    expect(hold.holds("b1")).toBe(false);
    expect(hold.verdictFor("b1")).toBeUndefined();
  });

  it("never lets a hold outlive the seat or the plane", () => {
    const hold = makeAwarenessSeatHold();
    hold.apply(waiting);
    hold.forget("b1");
    expect(hold.holds("b1")).toBe(false);
    hold.apply(waiting);
    hold.clear();
    expect(hold.size()).toBe(0);
    expect(hold.holds("b1")).toBe(false);
  });

  it("keeps holding when the deterministic plane proves a dialog, whatever the AI says", () => {
    const hold = makeAwarenessSeatHold();
    // The deterministic state wins for display, but holding stays safe either
    // way, which is why the flag is true even when `state` is nulled.
    hold.apply(waiting, "attention");
    const verdict = hold.verdictFor("b1");
    expect(verdict?.deterministicWins).toBe(true);
    expect(verdict?.state).toBeNull();
    expect(hold.holds("b1")).toBe(true);
  });
});
