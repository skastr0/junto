/**
 * Seat-awareness wire adapter — every advisory shape must survive the
 * renderer's strict decoder.
 *
 * The adapter is the one translation site between the scheduler's advisory
 * record and the renderer contract, so this test is deliberately end-to-end
 * across that seam: it builds real assessments through the real projection,
 * converts them with the adapter, and decodes the result with the renderer's
 * own `decodeSeatAwarenessEvent`. A shape the adapter emits that the decoder
 * refuses fails here rather than on a card.
 *
 * No network is touched: the projection is pure and the unavailable notice is
 * constructed directly.
 */

import { describe, expect, it } from "vitest";
import {
  SEAT_AWARENESS_CHANNEL,
  SEAT_AWARENESS_SNAPSHOT_CHANNEL,
  decodeSeatAwarenessEvent,
  type SeatAwarenessEvent,
} from "../src/renderer/lib/seat-awareness-contract";
import { IPC_CHANNELS } from "../src/shared/ipc";
import {
  SEAT_AWARENESS_UNOBSERVED_DIGEST,
  seatAwarenessEventsForAdvisory,
} from "../src/main/junto/term/awareness/awareness-wire";
import {
  projectAwarenessAnswers,
  projectAwarenessUnavailable,
  type AwarenessAssessment,
} from "../src/main/junto/term/awareness/project-result";
import {
  selectAwarenessInput,
  type AwarenessEvidenceWindow,
  type AwarenessRequestState,
} from "../src/main/junto/term/awareness/select-input";
import type { AwarenessAdvisory } from "../src/main/junto/term/awareness/scheduler";
import { notConfiguredAdvisory } from "../src/main/junto/term/seat-awareness";

const T0 = 1_700_000_000_000;
const AT = T0 + 1_000;

const evidenceWindow = (): AwarenessEvidenceWindow => ({
  bindingId: "b1",
  epoch: "e1",
  cols: 80,
  rows: 24,
  seq: 9n,
  lines: ["step one: reading the config", "step two: applying the change"],
  totalLines: 2,
  truncated: false,
  observedAt: T0,
});

const request = (): AwarenessRequestState => selectAwarenessInput(evidenceWindow());

/** A real `current` assessment: a raised concern, an accepted absence, activity. */
const currentAssessment = (): AwarenessAssessment => {
  const state = request();
  return projectAwarenessAnswers(state, {
    packVersion: state.packVersion,
    requestedModel: "jev-test",
    returnedModel: "jev-test-1",
    answers: [
      {
        questionId: "concern.approval_requested",
        evidenceHash: state.evidenceHash,
        kind: "noul",
        probability: 0.97,
      },
      {
        questionId: "concern.execution_error",
        evidenceHash: state.evidenceHash,
        kind: "noul",
        probability: 0.05,
      },
      {
        questionId: "activity.tests_running",
        evidenceHash: state.evidenceHash,
        kind: "noul",
        probability: 0.95,
      },
    ],
  });
};

/** A real `abstained` assessment: one Noul inside the indecisive band. */
const abstainedAssessment = (): AwarenessAssessment => {
  const state = request();
  return projectAwarenessAnswers(state, {
    packVersion: state.packVersion,
    requestedModel: "jev-test",
    returnedModel: "jev-test-1",
    answers: [
      {
        questionId: "concern.approval_requested",
        evidenceHash: state.evidenceHash,
        kind: "noul",
        probability: 0.5,
      },
    ],
  });
};

/** A real `unavailable` assessment, as a provider failure produces. */
const unavailableAssessment = (): AwarenessAssessment => {
  const state = request();
  return projectAwarenessUnavailable({
    bindingId: state.bindingId,
    epoch: state.epoch,
    sourceSeq: state.sourceSeq,
    observedAt: state.observedAt,
    evidenceHash: state.evidenceHash,
    packVersion: state.packVersion,
    reason: "transport_error",
    detail: "Jev did not answer inside the awareness deadline",
  });
};

const advisory = (
  partial: Partial<AwarenessAdvisory> & { readonly bindingId: string },
): AwarenessAdvisory => ({
  epoch: "e1",
  assessmentId: "assessment-1",
  assessment: undefined,
  absences: [],
  unansweredConcerns: [],
  evidenceLines: [],
  evidenceDigest: undefined,
  windowDigest: undefined,
  windowCapturedAt: undefined,
  availability: undefined,
  unavailableReason: null,
  status: "none",
  reason: undefined,
  pending: false,
  trigger: undefined,
  ...partial,
});

/** Adapter output for one advisory, with every event strictly decoded. */
const decodedEvents = (
  input: AwarenessAdvisory,
): ReadonlyArray<SeatAwarenessEvent> => {
  const events = seatAwarenessEventsForAdvisory(input, AT);
  const decoded: SeatAwarenessEvent[] = [];
  for (const event of events) {
    const roundTripped = decodeSeatAwarenessEvent(event);
    expect(roundTripped, `event did not decode: ${JSON.stringify(event)}`).toBeDefined();
    decoded.push(roundTripped!);
  }
  return decoded;
};

const assessmentEventOf = (events: ReadonlyArray<SeatAwarenessEvent>) => {
  const event = events.find((entry) => entry.kind === "assessment");
  expect(event).toBeDefined();
  if (event?.kind !== "assessment") throw new Error("expected an assessment event");
  return event.assessment;
};

describe("seat-awareness wire adapter", () => {
  it("round-trips a current judgment through the renderer decoder", () => {
    const state = request();
    const assessment = currentAssessment();
    const events = decodedEvents(
      advisory({
        bindingId: "b1",
        assessment,
        assessmentId: "assessment-current",
        absences: [{ concern: "execution_error", probability: 0.05 }],
        unansweredConcerns: ["answer_requested"],
        evidenceLines: state.evidenceLines,
        evidenceDigest: state.evidenceHash,
        windowDigest: "material-revision-1",
        windowCapturedAt: T0,
        availability: "current",
        status: "fresh",
      }),
    );

    // The window revision lands, then the judgment derived from it.
    expect(events.map((event) => event.kind)).toEqual(["window", "assessment"]);
    const windowEvent = events[0]!;
    expect(windowEvent).toMatchObject({
      kind: "window",
      bindingId: "b1",
      windowDigest: "material-revision-1",
      windowCapturedAt: T0,
      at: AT,
    });

    const decoded = assessmentEventOf(events)!;
    expect(decoded.availability).toBe("current");
    expect(decoded.activity).toBe("testing");
    expect(decoded.concerns).toEqual(["approval_requested"]);
    expect(decoded.absences).toEqual([
      { concern: "execution_error", probability: 0.05 },
    ]);
    expect(decoded.unansweredConcerns).toEqual(["answer_requested"]);
    expect(decoded.unavailableReason).toBeNull();
    expect(decoded.observedAt).toBe(T0);
    expect(decoded.evidence.digest).toBe(state.evidenceHash);
    expect(decoded.evidence.lines.length).toBeGreaterThan(0);
  });

  it("round-trips an abstention", () => {
    const events = decodedEvents(
      advisory({
        bindingId: "b1",
        assessment: abstainedAssessment(),
        availability: "abstained",
        status: "fresh",
      }),
    );
    const decoded = assessmentEventOf(events)!;
    expect(decoded.availability).toBe("abstained");
    // The projection's "no activity property won" marker travels verbatim; the
    // renderer owns the rule that it is never a finding.
    expect(decoded.activity).toBe("indeterminate");
    expect(decoded.unavailableReason).toBeNull();
  });

  it("round-trips an honest provider failure", () => {
    const events = decodedEvents(
      advisory({
        bindingId: "b1",
        assessment: unavailableAssessment(),
        availability: "unavailable",
        unavailableReason: "provider_failure",
        status: "unavailable",
      }),
    );
    const decoded = assessmentEventOf(events)!;
    expect(decoded.availability).toBe("unavailable");
    expect(decoded.unavailableReason).toBe("provider_failure");
    expect(decoded.activity).toBeNull();
    expect(decoded.concerns).toEqual([]);
    expect(decoded.selectedLineId).toBeNull();
  });

  it("round-trips the gate-off notice with no observation at all", () => {
    const events = decodedEvents(notConfiguredAdvisory("b1"));
    // No window: nothing was observed, so only the notice travels.
    expect(events.map((event) => event.kind)).toEqual(["assessment"]);
    const event = events[0]!;
    expect(event.kind === "assessment" && event.windowDigest).toBe(
      SEAT_AWARENESS_UNOBSERVED_DIGEST,
    );
    const decoded = assessmentEventOf(events)!;
    expect(decoded.availability).toBe("unavailable");
    expect(decoded.unavailableReason).toBe("not_configured");
    expect(decoded.activity).toBeNull();
    expect(decoded.concerns).toEqual([]);
    expect(decoded.absences).toEqual([]);
    expect(decoded.selectedLineId).toBeNull();
    expect(decoded.evidence.lines).toEqual([]);
    expect(decoded.evidence.digest).toBe(SEAT_AWARENESS_UNOBSERVED_DIGEST);
  });

  it("round-trips a window-only revision", () => {
    const events = decodedEvents(
      advisory({
        bindingId: "b1",
        windowDigest: "material-revision-2",
        windowCapturedAt: T0,
      }),
    );
    expect(events.map((event) => event.kind)).toEqual(["window"]);
    expect(events[0]).toMatchObject({
      kind: "window",
      bindingId: "b1",
      windowDigest: "material-revision-2",
      windowCapturedAt: T0,
      at: AT,
    });
  });

  it("never emits an empty window digest on any shape", () => {
    const shapes: ReadonlyArray<AwarenessAdvisory> = [
      advisory({
        bindingId: "b1",
        assessment: currentAssessment(),
        availability: "current",
        windowDigest: "material-revision-1",
        windowCapturedAt: T0,
      }),
      advisory({ bindingId: "b2", availability: "abstained", assessment: abstainedAssessment() }),
      advisory({ bindingId: "b3", availability: "unavailable", unavailableReason: "budget_exhausted" }),
      notConfiguredAdvisory("b4"),
      advisory({ bindingId: "b5", windowDigest: "material-revision-3", windowCapturedAt: T0 }),
    ];
    for (const shape of shapes) {
      for (const event of seatAwarenessEventsForAdvisory(shape, AT)) {
        expect(event.windowDigest.length).toBeGreaterThan(0);
        expect(decodeSeatAwarenessEvent(event)).toBeDefined();
      }
    }
  });

  it("pins the IPC channel names against the renderer contract", () => {
    expect(IPC_CHANNELS.seatAwarenessChanged).toBe(SEAT_AWARENESS_CHANNEL);
    expect(IPC_CHANNELS.seatAwarenessSnapshot).toBe(SEAT_AWARENESS_SNAPSHOT_CHANNEL);
  });
});

describe("thread health on the wire", () => {
  const healthAssessment = (): AwarenessAssessment => {
    const state = request();
    return projectAwarenessAnswers(state, {
      packVersion: state.packVersion,
      requestedModel: "jev-test",
      returnedModel: "jev-test-1",
      answers: [
        { questionId: "health.waiting_on_operator", evidenceHash: state.evidenceHash, kind: "noul", probability: 0.96 },
        { questionId: "health.going_well", evidenceHash: state.evidenceHash, kind: "noul", probability: 0.92 },
      ],
    });
  };

  it("carries the reading for a judged observation, tied to that observation", () => {
    const assessment = healthAssessment();
    const events = decodedEvents(
      advisory({
        bindingId: "b1",
        assessment,
        availability: "current",
        evidenceDigest: assessment.provenance.evidenceHash,
        windowDigest: assessment.provenance.evidenceHash,
        windowCapturedAt: T0,
      }),
    );
    const judged = events.find((event) => event.kind === "assessment");
    expect(judged?.kind).toBe("assessment");
    if (judged?.kind !== "assessment") return;
    expect(judged.assessment.health).toEqual({
      bindingId: "b1",
      value: "waiting_on_operator",
      confidence: 0.96,
      observedAt: judged.assessment.observedAt,
      provenance: {
        source: "jev",
        assessmentId: "assessment-1",
        questionId: "health.waiting_on_operator",
        packVersion: assessment.packVersion,
        model: "jev-test-1",
      },
      signals: [
        { value: "waiting_on_operator", probability: 0.96, questionId: "health.waiting_on_operator" },
        { value: "going_well", probability: 0.92, questionId: "health.going_well" },
      ],
    });
  });

  it("never carries a reading on an unavailable assessment", () => {
    const events = decodedEvents(
      advisory({ bindingId: "b1", assessment: healthAssessment(), availability: "unavailable", unavailableReason: "provider_failure" }),
    );
    for (const event of events) {
      if (event.kind === "assessment") expect(event.assessment.health).toBeUndefined();
    }
  });

  it("refuses a reading that names a different observation", () => {
    const events = seatAwarenessEventsForAdvisory(
      advisory({ bindingId: "b1", assessment: healthAssessment(), availability: "current" }),
      AT,
    );
    const judged = events.find((event) => event.kind === "assessment");
    if (judged?.kind !== "assessment" || judged.assessment.health === undefined) {
      throw new Error("expected a health reading");
    }
    const forged = {
      ...judged,
      assessment: {
        ...judged.assessment,
        health: { ...judged.assessment.health, bindingId: "other-seat" },
      },
    };
    expect(decodeSeatAwarenessEvent(forged)).toBeUndefined();
  });
});
