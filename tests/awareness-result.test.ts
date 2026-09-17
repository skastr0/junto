/**
 * Awareness answer projection — validation, id resolution, and abstention.
 *
 * Every test here works on a request state produced by the real projection, so
 * the line-id mapping under test is the one the transport would actually have
 * sent for that observation.
 */

import { describe, expect, it } from "vitest";
import {
  AI_ACTIVITY_VALUES,
  AI_CONCERN_VALUES,
  ASSESSMENT_AVAILABILITY_VALUES,
  AWARENESS_PACK_VERSION,
} from "../src/main/junto/term/awareness/questions";
import {
  selectAwarenessInput,
  type AwarenessEvidenceWindow,
  type AwarenessRequestState,
} from "../src/main/junto/term/awareness/select-input";
import {
  projectAwarenessAnswers,
  projectAwarenessUnavailable,
  resolveEvidenceLineId,
  type RawAwarenessAnswer,
  type RawAwarenessResponse,
} from "../src/main/junto/term/awareness/project-result";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OBSERVED_AT = 1_700_000_000_000;

const windowOf = (
  lines: readonly string[],
  overrides: Partial<AwarenessEvidenceWindow> = {},
): AwarenessEvidenceWindow => ({
  bindingId: "seat-1",
  epoch: "e1",
  cols: 120,
  rows: 32,
  seq: 42n,
  lines,
  totalLines: lines.length,
  truncated: false,
  observedAt: OBSERVED_AT,
  ...overrides,
});

/** Three evidence lines: L000 alpha, L001 beta, L002 gamma. */
const plain = (): AwarenessRequestState =>
  selectAwarenessInput(windowOf(["alpha", "beta", "gamma"]));

/** A LATER observation with a longer window, so it has ids `plain` never sent. */
const later = (): AwarenessRequestState =>
  selectAwarenessInput(
    windowOf(["one", "two", "three", "four", "five", "six"], { seq: 99n, observedAt: OBSERVED_AT + 5_000 }),
  );

/** Two comparable failing attempts, so the comparison question is asked. */
const paired = (): AwarenessRequestState =>
  selectAwarenessInput(
    windowOf([
      "$ npm test",
      "Tests  2 failed",
      "FAIL src/a.test.ts",
      "",
      "$ npm test",
      "Tests  2 failed",
      "FAIL src/a.test.ts",
    ]),
  );

const noul = (
  request: AwarenessRequestState,
  questionId: string,
  probability: unknown,
): RawAwarenessAnswer => ({ questionId, kind: "noul", probability, evidenceHash: request.evidenceHash });

const choice = (
  request: AwarenessRequestState,
  questionId: string,
  selectedOptionId: unknown,
  confidence: unknown,
  optionProbabilities: unknown,
): RawAwarenessAnswer => ({
  questionId,
  kind: "choice",
  selectedOptionId,
  confidence,
  optionProbabilities,
  evidenceHash: request.evidenceHash,
});

const respond = (
  request: AwarenessRequestState,
  answers: readonly RawAwarenessAnswer[],
  overrides: Partial<RawAwarenessResponse> = {},
) =>
  projectAwarenessAnswers(
    request,
    {
      packVersion: request.packVersion,
      requestedModel: "systemone",
      returnedModel: "jev-1.13.0",
      answers,
      ...overrides,
    },
  );

const reasons = (assessment: { readonly rejections: readonly { reason: string }[] }) =>
  assessment.rejections.map((rejection) => rejection.reason);

/**
 * Every `plain()` request skips the comparison question for lack of a temporal
 * pair, so that abstention is always the first entry. Spelled out here so the
 * expectations stay exact instead of loosening to a `contains` check.
 */
const REPETITION_SKIP = {
  questionId: "concern.repetition",
  reason: "temporal_pair_missing",
  detail: "the projection found no comparable attempt pair to compare",
} as const;

// ---------------------------------------------------------------------------
// States that are not an answer
// ---------------------------------------------------------------------------

describe("awareness assessment states", () => {
  it("keeps unavailable distinct from abstained", () => {
    const assessment = projectAwarenessUnavailable({
      bindingId: "seat-1",
      epoch: "e1",
      sourceSeq: "42",
      observedAt: OBSERVED_AT,
      evidenceHash: "abc",
      packVersion: AWARENESS_PACK_VERSION,
      requestedModel: "systemone",
      returnedModel: "jev-1.13.0",
      reason: "transport_error",
      detail: "socket closed",
    });
    expect(assessment.availability).toBe("unavailable");
    expect(assessment.unavailableReason).toBe("transport_error");
    expect(assessment.unavailableDetail).toBe("socket closed");
    // An abstention would mean the model answered and declined. It did not.
    expect(assessment.abstentions).toEqual([]);
    expect(assessment.provenance.gaps).toEqual([]);
  });

  it("treats an empty answer list as unavailable, not as an abstention", () => {
    const request = plain();
    const assessment = respond(request, []);
    expect(assessment.availability).toBe("unavailable");
    expect(assessment.unavailableReason).toBe("no_answers");
  });

  it("treats a non-array answers field as malformed", () => {
    const request = plain();
    const assessment = projectAwarenessAnswers(request, { answers: "nope" });
    expect(assessment.availability).toBe("unavailable");
    expect(assessment.unavailableReason).toBe("malformed_answers");
  });

  it("refuses answers that came from a different question pack", () => {
    const request = plain();
    const assessment = respond(request, [noul(request, "concern.approval_requested", 0.99)], {
      packVersion: "awareness-pack/2",
    });
    expect(assessment.availability).toBe("unavailable");
    expect(assessment.unavailableReason).toBe("pack_version_mismatch");
    expect(assessment.concerns).toEqual([]);
  });

  it("marks the assessment unavailable when every answer was rejected", () => {
    const request = plain();
    const assessment = respond(request, [
      noul(request, "concern.approval_requested", Number.NaN),
      noul(request, "concern.execution_error", 1.5),
    ]);
    expect(assessment.availability).toBe("unavailable");
    expect(assessment.unavailableReason).toBe("answers_rejected");
    expect(reasons(assessment)).toEqual(["non_finite_probability", "probability_out_of_range"]);
  });
});

// ---------------------------------------------------------------------------
// Provenance and line-id resolution
// ---------------------------------------------------------------------------

describe("awareness provenance and line-id resolution", () => {
  it("resolves a line id against the mapping of THAT observation only", () => {
    const a = plain();
    const b = later();

    // Same id, different observation: each resolves to its own text.
    expect(resolveEvidenceLineId(a, "L001")?.text).toBe("beta");
    expect(resolveEvidenceLineId(b, "L001")?.text).toBe("two");
    // An id the earlier observation never sent does not resolve at all.
    expect(resolveEvidenceLineId(a, "L005")).toBeUndefined();
    expect(resolveEvidenceLineId(b, "L005")?.text).toBe("six");
    // A later screen's mapping never leaks into the earlier one.
    expect(a.evidenceHash).not.toBe(b.evidenceHash);
    expect(a.evidenceLines.map((line) => line.text)).not.toContain("six");
  });

  it("rejects a highlight naming a line the observation never sent", () => {
    const a = plain();
    const b = later();
    const foreign = b.evidenceLines[5]!.id;
    const assessment = respond(a, [
      choice(a, "highlight.line", foreign, 0.95, { [foreign]: 0.95, NONE: 0.05 }),
    ]);

    expect(reasons(assessment)).toEqual(["line_id_outside_mapping"]);
    expect(assessment.highlight).toBeUndefined();
    expect(assessment.availability).toBe("unavailable");
  });

  it("rejects an answer computed from different evidence before resolving anything", () => {
    const a = plain();
    const b = later();
    const assessment = respond(a, [
      {
        questionId: "highlight.line",
        kind: "choice",
        selectedOptionId: "L000",
        confidence: 0.95,
        optionProbabilities: { L000: 0.95, NONE: 0.05 },
        evidenceHash: b.evidenceHash,
      },
    ]);
    expect(reasons(assessment)).toEqual(["evidence_mismatch"]);
    expect(assessment.highlight).toBeUndefined();
  });

  it("accepts an answer from a material-equivalent observation", () => {
    // Same material screen, a different spinner frame and a different PTY
    // sequence. The digest is the same by design, the line count is unchanged,
    // and the ids therefore resolve positionally — so this answer belongs to
    // this evidence and is not a mismatch.
    const a = selectAwarenessInput(windowOf(["⠂ Thinking…", "alpha", "beta"]));
    const b = selectAwarenessInput(
      windowOf(["⠐ Thinking…", "alpha", "beta"], { seq: 777n }),
    );
    expect(b.evidenceHash).toBe(a.evidenceHash);
    expect(b.evidenceLines.length).toBe(a.evidenceLines.length);

    const assessment = respond(a, [
      noul(b, "concern.approval_requested", 0.97),
      choice(b, "highlight.line", "L002", 0.9, { L002: 0.9, NONE: 0.1 }),
    ]);
    expect(assessment.availability).toBe("current");
    expect(assessment.concerns.map((c) => c.concern)).toEqual(["approval_requested"]);
    // The line resolves to THIS observation's mapping text.
    expect(assessment.highlight).toEqual({
      kind: "line",
      lineId: "L002",
      text: "beta",
      sourceIndex: 2,
    });
  });

  it("rejects an answer with no evidence hash at all", () => {
    const request = plain();
    const assessment = respond(request, [
      { questionId: "concern.approval_requested", kind: "noul", probability: 0.99 },
    ]);
    expect(reasons(assessment)).toEqual(["missing_evidence_hash"]);
  });

  it("carries full provenance on an accepted answer", () => {
    const request = plain();
    const assessment = respond(request, [
      noul(request, "concern.approval_requested", 0.97),
      choice(request, "highlight.line", "L001", 0.9, { L001: 0.9, NONE: 0.1 }),
    ]);

    expect(assessment.availability).toBe("current");
    expect(assessment.advisory).toBe(true);
    expect(assessment.packVersion).toBe(AWARENESS_PACK_VERSION);
    expect(assessment.provenance).toEqual({
      bindingId: "seat-1",
      epoch: "e1",
      sourceSeq: "42",
      evidenceHash: request.evidenceHash,
      observedAt: OBSERVED_AT,
      packVersion: AWARENESS_PACK_VERSION,
      requestedModel: "systemone",
      returnedModel: "jev-1.13.0",
      evidenceLineId: "L001",
      gaps: [],
    });
    expect(assessment.highlight).toEqual({
      kind: "line",
      lineId: "L001",
      text: "beta",
      sourceIndex: 1,
    });
  });

  it("records which provenance fields the transport did not supply", () => {
    const request = plain();
    const assessment = projectAwarenessAnswers(request, {
      answers: [noul(request, "concern.approval_requested", 0.97)],
    });
    expect(assessment.availability).toBe("current");
    expect(assessment.provenance.gaps).toEqual(["requested_model", "returned_model"]);
    expect(assessment.provenance.requestedModel).toBeUndefined();
    expect(assessment.provenance.returnedModel).toBeUndefined();
  });

  it("reads the model from the answer when the response omits it", () => {
    const request = plain();
    const assessment = projectAwarenessAnswers(request, {
      packVersion: request.packVersion,
      answers: [
        {
          ...noul(request, "concern.approval_requested", 0.97),
          requestedModel: "systemone",
          returnedModel: "jev-1.13.0",
        },
      ],
    });
    expect(assessment.provenance.requestedModel).toBe("systemone");
    expect(assessment.provenance.returnedModel).toBe("jev-1.13.0");
    expect(assessment.provenance.gaps).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Answer validation
// ---------------------------------------------------------------------------

describe("awareness answer validation", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly answer: (request: AwarenessRequestState) => RawAwarenessAnswer;
    readonly reason: string;
  }> = [
    {
      name: "missing probability",
      answer: (r) => ({ questionId: "concern.approval_requested", kind: "noul", evidenceHash: r.evidenceHash }),
      reason: "missing_probability",
    },
    {
      name: "NaN probability",
      answer: (r) => noul(r, "concern.approval_requested", Number.NaN),
      reason: "non_finite_probability",
    },
    {
      name: "infinite probability",
      answer: (r) => noul(r, "concern.approval_requested", Number.POSITIVE_INFINITY),
      reason: "non_finite_probability",
    },
    {
      name: "probability above one",
      answer: (r) => noul(r, "concern.approval_requested", 1.5),
      reason: "probability_out_of_range",
    },
    {
      name: "probability below zero",
      answer: (r) => noul(r, "concern.approval_requested", -0.2),
      reason: "probability_out_of_range",
    },
    {
      name: "unknown question id",
      answer: (r) => noul(r, "concern.invented", 0.99),
      reason: "unknown_question",
    },
    {
      name: "wrong answer kind",
      answer: (r) => ({
        questionId: "concern.approval_requested",
        kind: "choice",
        probability: 0.99,
        evidenceHash: r.evidenceHash,
      }),
      reason: "unsupported_kind",
    },
    {
      name: "missing choice selection",
      answer: (r) => ({ questionId: "highlight.line", kind: "choice", evidenceHash: r.evidenceHash }),
      reason: "missing_choice_selection",
    },
    {
      name: "unpermitted option",
      answer: (r) => choice(r, "highlight.line", "maybe", 0.95, { maybe: 0.95, NONE: 0.05 }),
      reason: "unpermitted_choice",
    },
    {
      name: "missing confidence",
      answer: (r) => ({
        questionId: "highlight.line",
        kind: "choice",
        selectedOptionId: "L000",
        optionProbabilities: { L000: 0.95, NONE: 0.05 },
        evidenceHash: r.evidenceHash,
      }),
      reason: "missing_confidence",
    },
    {
      name: "non-finite confidence",
      answer: (r) => choice(r, "highlight.line", "L000", Number.NaN, { L000: 0.95, NONE: 0.05 }),
      reason: "non_finite_confidence",
    },
    {
      name: "confidence above one",
      answer: (r) => choice(r, "highlight.line", "L000", 1.2, { L000: 0.95, NONE: 0.05 }),
      reason: "confidence_out_of_range",
    },
    {
      name: "no per-option probabilities",
      answer: (r) => choice(r, "highlight.line", "L000", 0.95, undefined),
      reason: "missing_option_probabilities",
    },
    {
      name: "per-option probabilities are not an object",
      answer: (r) => choice(r, "highlight.line", "L000", 0.95, [0.95, 0.05]),
      reason: "missing_option_probabilities",
    },
    {
      name: "non-finite per-option probability",
      answer: (r) => choice(r, "highlight.line", "L000", 0.95, { L000: Number.NaN, NONE: 0.05 }),
      reason: "invalid_option_probabilities",
    },
    {
      name: "per-option probability for an unpermitted option",
      answer: (r) => choice(r, "highlight.line", "L000", 0.95, { L000: 0.95, L999: 0.05 }),
      reason: "invalid_option_probabilities",
    },
    {
      name: "per-option probabilities omit the selection",
      answer: (r) => choice(r, "highlight.line", "L000", 0.95, { L001: 0.95, NONE: 0.05 }),
      reason: "invalid_option_probabilities",
    },
  ];

  for (const entry of cases) {
    it(`rejects ${entry.name}`, () => {
      const request = plain();
      const assessment = respond(request, [entry.answer(request)]);
      expect(reasons(assessment)).toContain(entry.reason);
      expect(assessment.availability).toBe("unavailable");
      expect(assessment.concerns).toEqual([]);
      expect(assessment.highlight).toBeUndefined();
    });
  }

  it("rejects a second answer for the same question", () => {
    const request = plain();
    const assessment = respond(request, [
      noul(request, "concern.approval_requested", 0.97),
      noul(request, "concern.approval_requested", 0.95),
    ]);
    expect(reasons(assessment)).toEqual(["duplicate_answer"]);
    // The first answer still counts.
    expect(assessment.concerns.map((c) => c.concern)).toEqual(["approval_requested"]);
  });

  it("rejects an answer for a question the projection skipped", () => {
    const request = plain(); // no temporal pair, so the comparison is skipped
    expect(request.skipped.map((s) => s.questionId)).toEqual(["concern.repetition"]);

    const assessment = respond(request, [
      choice(request, "concern.repetition", "repeats", 0.99, {
        repeats: 0.99,
        different: 0.01,
        insufficient_evidence: 0,
      }),
    ]);
    expect(reasons(assessment)).toEqual(["question_not_asked"]);
    // The response was unusable (a spurious answer and nothing accepted), but
    // the skipped question is still reported as the abstention it is.
    expect(assessment.availability).toBe("unavailable");
    expect(assessment.unavailableReason).toBe("answers_rejected");
    expect(assessment.abstentions).toEqual([REPETITION_SKIP]);
  });

  it("does not mutate the request it was given", () => {
    const request = plain();
    const before = JSON.stringify(request);
    respond(request, [
      noul(request, "concern.approval_requested", 0.97),
      choice(request, "highlight.line", "L002", 0.9, { L002: 0.9, NONE: 0.1 }),
    ]);
    expect(JSON.stringify(request)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Acceptance, combination, and abstention
// ---------------------------------------------------------------------------

describe("awareness acceptance and combination", () => {
  it("accepts a concern at the 0.9 bar and phrases it as a suggestion", () => {
    const request = plain();
    const assessment = respond(request, [noul(request, "concern.approval_requested", 0.95)]);

    expect(assessment.availability).toBe("current");
    expect(assessment.concerns).toEqual([
      {
        concern: "approval_requested",
        questionId: "concern.approval_requested",
        display: "AI suggests checking approval",
        probability: 0.95,
        evidenceLineIds: [],
      },
    ]);
    // Advisory display only: no flag, no control state, no canonical vocabulary.
    expect(assessment.advisory).toBe(true);
    for (const concern of assessment.concerns) {
      expect(AI_CONCERN_VALUES).toContain(concern.concern);
      expect(concern.display.startsWith("AI suggests")).toBe(true);
    }
  });

  it("abstains in the indecisive band and keeps the model's own number", () => {
    const request = plain();
    const assessment = respond(request, [noul(request, "concern.approval_requested", 0.5)]);

    expect(assessment.availability).toBe("abstained");
    expect(assessment.concerns).toEqual([]);
    expect(assessment.abstentions).toEqual([
      REPETITION_SKIP,
      {
        questionId: "concern.approval_requested",
        reason: "below_acceptance_bar",
        probability: 0.5,
        detail: "probability 0.5 is inside the indecisive band (0.1, 0.9)",
      },
    ]);
  });

  it("pins both Noul bars: present at 0.9, absent at 0.1, the band between abstains", () => {
    const request = plain();
    const cases: ReadonlyArray<{ readonly p: number; readonly verdict: "present" | "absent" | "band" }> = [
      { p: 0.99, verdict: "present" },
      { p: 0.9, verdict: "present" },
      { p: 0.89, verdict: "band" },
      { p: 0.5, verdict: "band" },
      { p: 0.11, verdict: "band" },
      { p: 0.1, verdict: "absent" },
      { p: 0.02, verdict: "absent" },
      { p: 0, verdict: "absent" },
    ];
    for (const entry of cases) {
      const assessment = respond(request, [noul(request, "concern.approval_requested", entry.p)]);
      if (entry.verdict === "present") {
        expect(assessment.concerns.map((c) => c.concern), `p=${entry.p}`).toEqual([
          "approval_requested",
        ]);
        expect(assessment.negatives, `p=${entry.p}`).toEqual([]);
      } else if (entry.verdict === "absent") {
        expect(assessment.concerns, `p=${entry.p}`).toEqual([]);
        expect(assessment.negatives.map((n) => n.probability), `p=${entry.p}`).toEqual([entry.p]);
      } else {
        expect(assessment.concerns, `p=${entry.p}`).toEqual([]);
        expect(assessment.negatives, `p=${entry.p}`).toEqual([]);
        expect(
          assessment.abstentions.some(
            (a) => a.questionId === "concern.approval_requested" && a.reason === "below_acceptance_bar",
          ),
          `p=${entry.p}`,
        ).toBe(true);
      }
    }
  });

  it("marks an activity absence as a cross-check, never as a displayed state", () => {
    const request = plain();
    const assessment = respond(request, [
      noul(request, "activity.command_executing", 0.02),
      noul(request, "activity.reading_existing_material", 0.04),
    ]);

    // The absence is recorded and flagged for the control-plane cross-check.
    expect(assessment.negatives).toEqual([
      {
        questionId: "activity.command_executing",
        activity: "running_command",
        probability: 0.02,
        display: "AI found no command running",
        crossCheckOnly: true,
      },
      {
        questionId: "activity.reading_existing_material",
        activity: "investigating",
        probability: 0.04,
        display: "AI found no read-only exploration",
        crossCheckOnly: true,
      },
    ]);
    // It never becomes an activity label: the engine owns idle versus working.
    expect(assessment.activity.value).toBe("indeterminate");
    expect(assessment.activity.signals).toEqual([]);
    expect(assessment.activity.reason).toBe("every_activity_property_absent");
    expect(assessment.concerns).toEqual([]);
    // Decisive absences still make the assessment current: the surface, not the
    // producer, decides how much of that to display.
    expect(assessment.availability).toBe("current");
  });

  it("reports current, not not_assessed, when every answer was a decisive absence", () => {
    const request = plain();
    const assessment = respond(request, [
      noul(request, "concern.approval_requested", 0.02),
      noul(request, "activity.command_executing", 0.03),
    ]);

    // An assessment exists and is decisive; "checked and clear" is a different
    // fact from `not_assessed` (nothing was ever received).
    expect(assessment.availability).toBe("current");
    expect(assessment.negatives.length).toBe(2);
    expect(assessment.abstentions).toEqual([REPETITION_SKIP]);
    expect(assessment.rejections).toEqual([]);
  });

  it("records a confident absence as a negative, not an abstention", () => {
    const request = plain();
    const assessment = respond(request, [noul(request, "concern.approval_requested", 0.03)]);

    expect(assessment.negatives).toEqual([
      {
        questionId: "concern.approval_requested",
        concern: "approval_requested",
        probability: 0.03,
        display: "AI found no approval prompt",
        crossCheckOnly: false,
      },
    ]);
    expect(assessment.abstentions).toEqual([REPETITION_SKIP]);
    expect(assessment.concerns).toEqual([]);
  });

  it("combines activity by precedence and never multiplies probabilities", () => {
    const request = plain();
    const assessment = respond(request, [
      noul(request, "activity.reading_existing_material", 0.95),
      noul(request, "activity.command_executing", 0.93),
    ]);

    expect(assessment.activity.value).toBe("running_command");
    expect(assessment.activity.reason).toBe("activity.command_executing");
    // The reported number is the winning question's own number, unchanged.
    expect(assessment.activity.probability).toBe(0.93);
    expect(assessment.activity.signals).toEqual([
      { questionId: "activity.command_executing", value: "running_command", probability: 0.93 },
      { questionId: "activity.reading_existing_material", value: "investigating", probability: 0.95 },
    ]);
    // No combination product appears anywhere.
    expect(assessment.activity.signals.map((s) => s.probability)).not.toContain(0.93 * 0.95);
    expect(AI_ACTIVITY_VALUES).toContain(assessment.activity.value);
  });

  it("reports indeterminate activity when no property was accepted", () => {
    const request = plain();
    const assessment = respond(request, [noul(request, "activity.command_executing", 0.4)]);
    expect(assessment.activity.value).toBe("indeterminate");
    expect(assessment.activity.reason).toBe("no_activity_property_accepted");
    expect(assessment.activity.probability).toBeUndefined();
    expect(assessment.availability).toBe("abstained");
  });

  it("takes the highlight line, or the explicit NONE", () => {
    const request = plain();
    const chosen = respond(request, [
      choice(request, "highlight.line", "L002", 0.9, { L002: 0.9, L000: 0.05, L001: 0.03, NONE: 0.02 }),
    ]);
    expect(chosen.highlight).toEqual({ kind: "line", lineId: "L002", text: "gamma", sourceIndex: 2 });
    expect(chosen.provenance.evidenceLineId).toBe("L002");

    const declined = respond(request, [
      choice(request, "highlight.line", "NONE", 0.9, { NONE: 0.9, L000: 0.05, L001: 0.03, L002: 0.02 }),
    ]);
    expect(declined.highlight).toEqual({ kind: "none", reason: "model_declined" });
    expect(declined.provenance.evidenceLineId).toBeUndefined();
    // Declining is an answer, not an abstention (the only abstention here is
    // the comparison question the projection skipped).
    expect(declined.abstentions).toEqual([REPETITION_SKIP]);
    expect(declined.availability).toBe("current");
  });

  it("abstains when the highlight selection is below the choice bar", () => {
    const request = plain();
    const assessment = respond(request, [
      choice(request, "highlight.line", "L000", 0.6, { L000: 0.6, NONE: 0.4 }),
    ]);
    expect(assessment.highlight).toBeUndefined();
    expect(assessment.abstentions.map((a) => a.reason)).toContain("below_acceptance_bar");
    expect(assessment.availability).toBe("abstained");
  });

  it("accepts a repetition at the concern bar and points at the compared lines", () => {
    const request = paired();
    const assessment = respond(request, [
      choice(request, "concern.repetition", "repeats", 0.95, {
        repeats: 0.95,
        different: 0.03,
        insufficient_evidence: 0.02,
      }),
    ]);

    expect(assessment.concerns).toEqual([
      {
        concern: "repetition",
        questionId: "concern.repetition",
        display: "AI suggests checking a repeat",
        probability: 0.95,
        evidenceLineIds: ["L000", "L001", "L002", "L004", "L005", "L006"],
      },
    ]);
  });

  it("records 'different' as a negative and 'insufficient_evidence' as an abstention", () => {
    const request = paired();
    const different = respond(request, [
      choice(request, "concern.repetition", "different", 0.95, {
        repeats: 0.03,
        different: 0.95,
        insufficient_evidence: 0.02,
      }),
    ]);
    expect(different.concerns).toEqual([]);
    expect(different.negatives).toEqual([
      {
        questionId: "concern.repetition",
        concern: "repetition",
        probability: 0.95,
        display: "AI found no repeat",
        crossCheckOnly: false,
      },
    ]);

    const unsure = respond(request, [
      choice(request, "concern.repetition", "insufficient_evidence", 0.95, {
        repeats: 0.02,
        different: 0.03,
        insufficient_evidence: 0.95,
      }),
    ]);
    expect(unsure.concerns).toEqual([]);
    expect(unsure.negatives).toEqual([]);
    expect(unsure.abstentions).toEqual([
      {
        questionId: "concern.repetition",
        reason: "model_reported_insufficient_evidence",
        detail: "the model selected insufficient_evidence",
      },
    ]);
    expect(unsure.availability).toBe("abstained");
  });

  it("never reports a display freshness of its own", () => {
    // The producer holds no clock for the display and no control-plane turn, so
    // `stale` and `not_assessed` are the renderer's to derive. The same response
    // is the same assessment however long it has been showing.
    const request = plain();
    const assessment = respond(request, [noul(request, "concern.approval_requested", 0.97)]);
    expect(assessment.availability).toBe("current");
    expect(ASSESSMENT_AVAILABILITY_VALUES).not.toContain("stale");
    expect(ASSESSMENT_AVAILABILITY_VALUES).not.toContain("not_assessed");
    // An old observation is still the same verdict, and its age travels in
    // provenance rather than as a downgraded availability.
    expect(assessment.provenance.observedAt).toBe(OBSERVED_AT);
  });

  it("only ever reports availability from the frozen set", () => {
    const request = plain();
    const states = [
      projectAwarenessUnavailable({
        bindingId: "b",
        epoch: "e",
        sourceSeq: "1",
        observedAt: 0,
        reason: "model_error",
      }),
      respond(request, []),
      respond(request, [noul(request, "concern.approval_requested", 0.5)]),
      respond(request, [noul(request, "concern.approval_requested", 0.97)]),
      // Every answer a decisive absence: an assessment exists, so it is current.
      respond(request, [noul(request, "activity.command_executing", 0.02)]),
    ];
    for (const assessment of states) {
      expect(ASSESSMENT_AVAILABILITY_VALUES).toContain(assessment.availability);
      expect(assessment.advisory).toBe(true);
    }
  });
});
