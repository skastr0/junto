/**
 * Awareness answer projection — raw model answers to a validated assessment.
 *
 * WHAT THIS DOES
 * --------------
 * Turns the raw answers that came back from the awareness transport into the
 * read-only assessment the display consumes, or refuses to. It owns:
 *
 *   - line-id resolution against the mapping captured for THAT observation
 *     (never the latest screen), so a stale id cannot resolve to newer text;
 *   - rejection of ids outside the mapping, non-finite or out-of-range
 *     probabilities, unpermitted options, answers for questions that were not
 *     asked, answers computed from materially different evidence, and answers
 *     from a different question pack;
 *   - the two-sided acceptance bar, with `abstained` (the model answered and
 *     only the indecisive band, or the evidence a question needs was absent)
 *     kept distinct from `unavailable` (no usable answer could be obtained at
 *     all). A Noul publishes PRESENT at or above its positive bar and ABSENT at
 *     or below its negative bar; only the band between abstains;
 *   - provenance: binding id, epoch, source sequence, evidence hash, observed
 *     time, question-pack version, requested and returned model, and the
 *     evidence line a highlight refers to.
 *
 * COMBINATION LAW
 * ---------------
 * Independently evaluated questions are NOT independent evidence, so this
 * module never multiplies probabilities. Activity is a fixed precedence over
 * the narrow activity Nouls (see ACTIVITY_DERIVATION); each reported
 * probability is the model's own number for that one question, unchanged.
 *
 * AVAILABILITY OWNERSHIP
 * ----------------------
 * This module publishes exactly `current | abstained | unavailable`. The two
 * other values of the axis belong to the renderer and never travel: it derives
 * `not_assessed` (nothing received at all) and `stale` (an assessment whose
 * judgment expired, or whose seat left the turn it describes). Neither is
 * computable here — this module runs on a response that was just received and
 * holds no clock for the display and no control-plane turn.
 *
 * AUTHORITY
 * ---------
 * The assessment is display input and nothing else. It is not a control state,
 * it never sets or clears a flag, and nothing in this module writes anything.
 * `advisory: true` is on every assessment so a caller cannot mistake it.
 */

import {
  ACTIVITY_ABSENT_DISPLAY,
  ACTIVITY_DERIVATION,
  AWARENESS_QUESTIONS,
  CONCERN_ABSENT_DISPLAY,
  CONCERN_DISPLAY,
  HIGHLIGHT_NONE_OPTION_ID,
  awarenessQuestion,
  type AiActivityValue,
  type AiConcernValue,
  type AssessmentAvailability,
} from "./questions";
import type { AwarenessRequestState, EvidenceLine } from "./select-input";

// ---------------------------------------------------------------------------
// Raw wire shapes (untrusted)
// ---------------------------------------------------------------------------

/**
 * One answer exactly as the transport delivered it. Every field is `unknown`
 * because this module is the validation boundary: nothing here trusts the
 * wire, and an unrecognized shape is a rejection with a reason, not a crash.
 */
export type RawAwarenessAnswer = {
  readonly questionId?: unknown;
  /**
   * Provenance echo: the window digest this answer was computed from
   * (`computeWindowDigest`). Two observations of the same material screen share
   * it by design, and normalization is line-preserving, so an answer that
   * echoes a material-equivalent observation still belongs to this evidence and
   * its line ids resolve to the same positions.
   */
  readonly evidenceHash?: unknown;
  /** Per-answer overrides of the response-level model provenance. */
  readonly requestedModel?: unknown;
  readonly returnedModel?: unknown;
  readonly kind?: unknown;
  /** Noul: probability that the property holds. */
  readonly probability?: unknown;
  /** Choice: the selected option id. */
  readonly selectedOptionId?: unknown;
  /** Choice: model confidence in the selection. */
  readonly confidence?: unknown;
  /** Choice: probability mass per option id. */
  readonly optionProbabilities?: unknown;
};

export type RawAwarenessResponse = {
  readonly packVersion?: unknown;
  readonly requestedModel?: unknown;
  readonly returnedModel?: unknown;
  readonly answers: unknown;
};

// ---------------------------------------------------------------------------
// Projected shapes
// ---------------------------------------------------------------------------

export type RejectionReason =
  | "unknown_question"
  | "question_not_asked"
  | "duplicate_answer"
  | "missing_evidence_hash"
  | "evidence_mismatch"
  | "unsupported_kind"
  | "missing_probability"
  | "non_finite_probability"
  | "probability_out_of_range"
  | "missing_choice_selection"
  | "unpermitted_choice"
  | "line_id_outside_mapping"
  | "missing_confidence"
  | "non_finite_confidence"
  | "confidence_out_of_range"
  | "missing_option_probabilities"
  | "invalid_option_probabilities"
  | "unresolvable_evidence_line";

export type Rejection = {
  readonly questionId: string;
  readonly reason: RejectionReason;
  readonly detail: string;
};

export type AbstentionReason =
  | "below_acceptance_bar"
  | "model_reported_insufficient_evidence"
  | "evidence_unavailable"
  | "temporal_pair_missing";

export type Abstention = {
  readonly questionId: string;
  readonly reason: AbstentionReason;
  /** The model's own number when it gave one; never invented. */
  readonly probability?: number;
  readonly detail: string;
};

/**
 * An accepted ABSENT verdict: the model answered below the negative bar, so the
 * property is confidently absent. Display only; nothing is cleared.
 *
 * `crossCheckOnly` is true for an activity property, whose absence is a
 * cross-check against the control plane rather than a displayed state — the
 * deterministic engine already owns idle versus working. A concern's absence is
 * the surface's "checked and clear".
 */
export type NegativeVerdict = {
  readonly questionId: string;
  /** Set when the question is a concern. */
  readonly concern?: AiConcernValue;
  /** Set when the question is an activity property. */
  readonly activity?: AiActivityValue;
  readonly probability: number;
  readonly display: string;
  readonly crossCheckOnly: boolean;
};

export type ActivitySignal = {
  readonly questionId: string;
  readonly value: AiActivityValue;
  readonly probability: number;
};

export type ActivityProjection = {
  readonly value: AiActivityValue;
  /** The winning question id, or why nothing won. */
  readonly reason: string;
  readonly probability?: number;
  /** Every accepted activity property, in precedence order, unchanged. */
  readonly signals: readonly ActivitySignal[];
};

export type ConcernProjection = {
  readonly concern: AiConcernValue;
  readonly questionId: string;
  /** Advisory phrasing from the pack. Never a control state, never a flag. */
  readonly display: string;
  readonly probability: number;
  /** Evidence the concern rests on, when the question names lines. */
  readonly evidenceLineIds: readonly string[];
};

export type HighlightProjection =
  | {
      readonly kind: "line";
      readonly lineId: string;
      readonly text: string;
      readonly sourceIndex: number;
    }
  | { readonly kind: "none"; readonly reason: "model_declined" };

export type AssessmentProvenance = {
  readonly bindingId: string;
  readonly epoch: string;
  readonly sourceSeq: string;
  readonly evidenceHash: string;
  readonly observedAt: number;
  readonly packVersion: string;
  readonly requestedModel?: string;
  readonly returnedModel?: string;
  /** The evidence line the highlight refers to, when it named one. */
  readonly evidenceLineId?: string;
  /** Provenance fields the transport could not supply. */
  readonly gaps: readonly string[];
};

export type UnavailableReason =
  | "no_answers"
  | "transport_error"
  | "model_error"
  | "malformed_answers"
  | "answers_rejected"
  | "pack_version_mismatch"
  | "not_configured";

export type AwarenessAssessment = {
  /** Literal cement: this value is display input, never a control input. */
  readonly advisory: true;
  readonly availability: AssessmentAvailability;
  readonly packVersion: string;
  readonly activity: ActivityProjection;
  readonly concerns: readonly ConcernProjection[];
  /** Accepted ABSENT verdicts, for concerns and activity properties alike. */
  readonly negatives: readonly NegativeVerdict[];
  readonly highlight?: HighlightProjection;
  readonly abstentions: readonly Abstention[];
  readonly rejections: readonly Rejection[];
  /** Set only when `availability` is `unavailable`. */
  readonly unavailableReason?: UnavailableReason;
  /** The transport's own words for an unavailable assessment, when it gave any. */
  readonly unavailableDetail?: string;
  readonly provenance: AssessmentProvenance;
};

// ---------------------------------------------------------------------------
// Line-id resolution against the captured mapping
// ---------------------------------------------------------------------------

/**
 * Resolve one evidence line id against the mapping of the observation it came
 * from. The mapping is the ONLY source: an id that this observation did not
 * send resolves to `undefined`, and the caller never falls back to a later
 * screen's text.
 */
export const resolveEvidenceLineId = (
  request: Pick<AwarenessRequestState, "evidenceLines">,
  lineId: string,
): EvidenceLine | undefined => request.evidenceLines.find((line) => line.id === lineId);

const LINE_ID_SHAPE = /^L\d+$/u;

// ---------------------------------------------------------------------------
// Construction helpers
// ---------------------------------------------------------------------------

type ProvenanceInput = {
  readonly bindingId: string;
  readonly epoch: string;
  readonly sourceSeq: string;
  readonly observedAt: number;
  readonly evidenceHash?: string;
  readonly packVersion?: string;
  readonly requestedModel?: string;
  readonly returnedModel?: string;
  readonly evidenceLineId?: string;
};

const buildProvenance = (input: ProvenanceInput): AssessmentProvenance => {
  const gaps: string[] = [];
  if (input.requestedModel === undefined) gaps.push("requested_model");
  if (input.returnedModel === undefined) gaps.push("returned_model");
  if (input.packVersion === undefined) gaps.push("pack_version");
  return {
    bindingId: input.bindingId,
    epoch: input.epoch,
    sourceSeq: input.sourceSeq,
    evidenceHash: input.evidenceHash ?? "",
    observedAt: input.observedAt,
    packVersion: input.packVersion ?? "unknown",
    ...(input.requestedModel !== undefined ? { requestedModel: input.requestedModel } : {}),
    ...(input.returnedModel !== undefined ? { returnedModel: input.returnedModel } : {}),
    ...(input.evidenceLineId !== undefined ? { evidenceLineId: input.evidenceLineId } : {}),
    gaps,
  };
};

/**
 * No usable answer could be obtained. Distinct from `abstained` by contract:
 * `unavailable` means the sidecar could not get an answer at all, so the
 * display must not imply the model looked and declined.
 */
export const projectAwarenessUnavailable = (input: ProvenanceInput & {
  readonly reason: UnavailableReason;
  readonly detail?: string;
}): AwarenessAssessment => ({
  advisory: true,
  availability: "unavailable",
  packVersion: input.packVersion ?? "unknown",
  activity: { value: "indeterminate", reason: input.reason, signals: [] },
  concerns: [],
  negatives: [],
  abstentions: [],
  rejections: [],
  unavailableReason: input.reason,
  ...(input.detail !== undefined ? { unavailableDetail: input.detail } : {}),
  provenance: buildProvenance(input),
});

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

const asFiniteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const asNonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * Project raw answers into an assessment.
 *
 * Acceptance, stated once so the display never has to guess:
 *   - a Noul is TWO-SIDED. At or above its positive bar the property is
 *     published present; at or below its negative bar it is published absent as
 *     a negative verdict, so "the model looked and found nothing" is not
 *     confused with "nothing was assessed"; only the band between the bars is
 *     an abstention, and the abstention carries the model's own number so the
 *     information survives without inventing a second acceptance path.
 *   - a concern is SHOWN only at or above its question's bar (0.9 for a Noul
 *     concern and for the concern Choice; 0.8 confidence plus 0.8 top
 *     probability for the highlight).
 *
 * No clock is read here. Display freshness (`stale`) and cache retention belong
 * to the renderer and the scheduler; this module reports what one response
 * means for one observation, and nothing about how long it has been showing.
 */
export const projectAwarenessAnswers = (
  request: AwarenessRequestState,
  response: RawAwarenessResponse,
): AwarenessAssessment => {
  const unavailable = (reason: UnavailableReason, detail: string): AwarenessAssessment =>
    projectAwarenessUnavailable({
      bindingId: request.bindingId,
      epoch: request.epoch,
      sourceSeq: request.sourceSeq,
      observedAt: request.observedAt,
      evidenceHash: request.evidenceHash,
      packVersion: request.packVersion,
      requestedModel: asNonEmptyString(response.requestedModel),
      returnedModel: asNonEmptyString(response.returnedModel),
      reason,
      detail,
    });

  if (!Array.isArray(response.answers)) {
    return unavailable("malformed_answers", "response.answers was not an array");
  }
  const rawAnswers = response.answers as readonly RawAwarenessAnswer[];
  if (rawAnswers.length === 0) {
    return unavailable("no_answers", "the transport returned no answers for this observation");
  }

  // An answer from a different pack cannot be resolved against this pack's
  // questions or this observation's mapping. Fail closed, loudly.
  const responsePackVersion = asNonEmptyString(response.packVersion);
  if (responsePackVersion !== undefined && responsePackVersion !== request.packVersion) {
    return unavailable(
      "pack_version_mismatch",
      `answers came from pack ${responsePackVersion}, request used ${request.packVersion}`,
    );
  }

  const responseRequestedModel = asNonEmptyString(response.requestedModel);
  const responseReturnedModel = asNonEmptyString(response.returnedModel);
  const requestedById = new Map(request.questions.map((q) => [q.id, q]));
  const skippedById = new Map(request.skipped.map((s) => [s.questionId, s]));

  const rejections: Rejection[] = [];
  const abstentions: Abstention[] = [];
  const negatives: NegativeVerdict[] = [];
  const acceptedNouls = new Map<string, number>();
  const acceptedChoices = new Map<string, { readonly optionId: string; readonly probability: number }>();
  const answered = new Set<string>();
  let highlight: HighlightProjection | undefined;
  let evidenceLineId: string | undefined;
  let answerRequestedModel: string | undefined;
  let answerReturnedModel: string | undefined;

  // A question the projection declined to ask is reported as an abstention
  // before any answer is read: the model was never asked, so an answer for it
  // is a rejection below.
  for (const skip of request.skipped) {
    abstentions.push({
      questionId: skip.questionId,
      reason: skip.reason,
      detail:
        skip.reason === "temporal_pair_missing"
          ? "the projection found no comparable attempt pair to compare"
          : "the evidence window carried no lines to judge",
    });
  }

  const reject = (questionId: string, reason: RejectionReason, detail: string): void => {
    rejections.push({ questionId, reason, detail });
  };

  for (const raw of rawAnswers) {
    const questionId = asNonEmptyString(raw.questionId);
    if (questionId === undefined) {
      reject("<missing>", "unknown_question", "answer carried no questionId");
      continue;
    }
    if (answered.has(questionId)) {
      reject(questionId, "duplicate_answer", "a second answer arrived for the same question");
      continue;
    }
    answered.add(questionId);

    const question = awarenessQuestion(questionId);
    if (question === undefined) {
      reject(questionId, "unknown_question", "no question with this id exists in the pack");
      continue;
    }
    const requested = requestedById.get(questionId);
    if (requested === undefined) {
      reject(
        questionId,
        "question_not_asked",
        skippedById.has(questionId)
          ? "the projection skipped this question for lack of evidence"
          : "this question was not part of the request",
      );
      continue;
    }

    // Provenance echo first: an answer computed from MATERIALLY different
    // evidence must never be resolved against this observation's line mapping.
    // The digest is coarse (volatile chrome normalized), so a material-equivalent
    // observation passes here on purpose; the line-id membership check below is
    // what keeps resolution honest within it.
    const answerHash = asNonEmptyString(raw.evidenceHash);
    if (answerHash === undefined) {
      reject(questionId, "missing_evidence_hash", "answer carried no evidence hash");
      continue;
    }
    if (answerHash !== request.evidenceHash) {
      reject(
        questionId,
        "evidence_mismatch",
        `answer hash ${answerHash} does not match observation ${request.evidenceHash}`,
      );
      continue;
    }

    const answerModel = asNonEmptyString(raw.requestedModel) ?? responseRequestedModel;
    const answerReturned = asNonEmptyString(raw.returnedModel) ?? responseReturnedModel;
    if (answerModel !== undefined) answerRequestedModel = answerModel;
    if (answerReturned !== undefined) answerReturnedModel = answerReturned;

    const kind = raw.kind === undefined ? question.kind : raw.kind;
    if (kind !== question.kind) {
      reject(questionId, "unsupported_kind", `answer kind ${String(kind)} is not ${question.kind}`);
      continue;
    }

    if (question.kind === "noul") {
      if (raw.probability === undefined) {
        reject(questionId, "missing_probability", "Noul answer carried no probability");
        continue;
      }
      const probability = asFiniteNumber(raw.probability);
      if (probability === undefined) {
        reject(
          questionId,
          "non_finite_probability",
          `probability ${String(raw.probability)} is not finite`,
        );
        continue;
      }
      if (probability < 0 || probability > 1) {
        reject(questionId, "probability_out_of_range", `probability ${probability} is outside [0, 1]`);
        continue;
      }
      // Two-sided: a Noul that can only say "yes" throws away its most
      // reliable half (measured: 28 correct answers at or below 0.2 against one
      // above 0.9). Absence is an accepted verdict, not a silence.
      const presentBar = requested.acceptance.minNoulProbability ?? 1;
      const absentBar = requested.acceptance.maxNoulAbsenceProbability ?? 0;
      if (probability >= presentBar) {
        acceptedNouls.set(questionId, probability);
      } else if (probability <= absentBar) {
        negatives.push({
          questionId,
          ...(question.concern !== undefined ? { concern: question.concern } : {}),
          ...(question.activity !== undefined ? { activity: question.activity } : {}),
          probability,
          display:
            question.concern !== undefined
              ? CONCERN_ABSENT_DISPLAY[question.concern]
              : ACTIVITY_ABSENT_DISPLAY[question.activity ?? "indeterminate"],
          // A concern's absence is the surface's "checked and clear"; an
          // activity property's absence is a cross-check for the control plane,
          // which already owns idle versus working.
          crossCheckOnly: question.concern === undefined,
        });
      } else {
        abstentions.push({
          questionId,
          reason: "below_acceptance_bar",
          probability,
          detail:
            `probability ${probability} is inside the indecisive band ` +
            `(${absentBar}, ${presentBar})`,
        });
      }
      continue;
    }

    // Choice.
    const selected = asNonEmptyString(raw.selectedOptionId);
    if (selected === undefined) {
      reject(questionId, "missing_choice_selection", "Choice answer carried no selected option id");
      continue;
    }
    if (!requested.optionIds.includes(selected)) {
      reject(
        questionId,
        LINE_ID_SHAPE.test(selected) ? "line_id_outside_mapping" : "unpermitted_choice",
        `option ${selected} is not permitted for this observation`,
      );
      continue;
    }
    const declines = question.options.some(
      (option) => option.id === selected && option.declines === true,
    );
    if (declines) {
      abstentions.push({
        questionId,
        reason: "model_reported_insufficient_evidence",
        detail: `the model selected ${selected}`,
      });
      continue;
    }

    if (raw.confidence === undefined) {
      reject(questionId, "missing_confidence", "Choice answer carried no confidence");
      continue;
    }
    const confidence = asFiniteNumber(raw.confidence);
    if (confidence === undefined) {
      reject(questionId, "non_finite_confidence", `confidence ${String(raw.confidence)} is not finite`);
      continue;
    }
    if (confidence < 0 || confidence > 1) {
      reject(questionId, "confidence_out_of_range", `confidence ${confidence} is outside [0, 1]`);
      continue;
    }

    const probabilities = raw.optionProbabilities;
    if (
      probabilities === undefined ||
      probabilities === null ||
      typeof probabilities !== "object" ||
      Array.isArray(probabilities)
    ) {
      reject(
        questionId,
        "missing_option_probabilities",
        "Choice answer carried no per-option probabilities, so the top-probability bar cannot be checked",
      );
      continue;
    }
    let top = 0;
    let hasSelected = false;
    let malformed: string | undefined;
    for (const [optionId, value] of Object.entries(probabilities as Record<string, unknown>)) {
      const p = asFiniteNumber(value);
      if (p === undefined || p < 0 || p > 1) {
        malformed = `option ${optionId} has a non-finite or out-of-range probability`;
        break;
      }
      if (!requested.optionIds.includes(optionId)) {
        malformed = `option ${optionId} was not permitted for this observation`;
        break;
      }
      if (optionId === selected) hasSelected = true;
      if (p > top) top = p;
    }
    if (malformed !== undefined) {
      reject(questionId, "invalid_option_probabilities", malformed);
      continue;
    }
    if (!hasSelected) {
      reject(
        questionId,
        "invalid_option_probabilities",
        `per-option probabilities omit the selected option ${selected}`,
      );
      continue;
    }

    const minConfidence = requested.acceptance.minConfidence ?? 1;
    const minTop = requested.acceptance.minTopProbability ?? 1;
    if (confidence < minConfidence || top < minTop) {
      abstentions.push({
        questionId,
        reason: "below_acceptance_bar",
        probability: top,
        detail: `confidence ${confidence} / top ${top} is below the ${minConfidence} / ${minTop} bar`,
      });
      continue;
    }
    acceptedChoices.set(questionId, { optionId: selected, probability: top });
  }

  // ---- axes -------------------------------------------------------------

  const signals: ActivitySignal[] = [];
  for (const entry of ACTIVITY_DERIVATION) {
    const probability = acceptedNouls.get(entry.questionId);
    if (probability === undefined) continue;
    signals.push({ questionId: entry.questionId, value: entry.value, probability });
  }
  const winner = signals[0];
  // The reason distinguishes "no property was present but every one was
  // decisively absent" from "the model declined to say", because only the first
  // is a usable cross-check for the control plane.
  const activityAbsences = negatives.filter((entry) => entry.activity !== undefined).length;
  const activity: ActivityProjection = winner
    ? {
        value: winner.value,
        reason: winner.questionId,
        probability: winner.probability,
        signals,
      }
    : {
        value: "indeterminate",
        reason:
          activityAbsences > 0
            ? "every_activity_property_absent"
            : "no_activity_property_accepted",
        signals,
      };

  const concerns: ConcernProjection[] = [];
  for (const question of AWARENESS_QUESTIONS) {
    const concern = question.concern;
    if (concern === undefined) continue;
    const noul = acceptedNouls.get(question.id);
    if (noul !== undefined) {
      concerns.push({
        concern,
        questionId: question.id,
        display: CONCERN_DISPLAY[concern],
        probability: noul,
        evidenceLineIds: [],
      });
      continue;
    }
    const choice = acceptedChoices.get(question.id);
    if (choice === undefined) continue;
    if (choice.optionId === "repeats") {
      concerns.push({
        concern,
        questionId: question.id,
        display: CONCERN_DISPLAY[concern],
        probability: choice.probability,
        evidenceLineIds:
          request.temporal.kind === "pair"
            ? [...request.temporal.firstLineIds, ...request.temporal.secondLineIds]
            : [],
      });
    } else {
      negatives.push({
        questionId: question.id,
        concern,
        probability: choice.probability,
        display: CONCERN_ABSENT_DISPLAY[concern],
        crossCheckOnly: false,
      });
    }
  }

  // The highlight is not a concern; interpret it separately.
  const highlightChoice = acceptedChoices.get("highlight.line");
  if (highlightChoice !== undefined) {
    if (highlightChoice.optionId === HIGHLIGHT_NONE_OPTION_ID) {
      highlight = { kind: "none", reason: "model_declined" };
    } else {
      const line = resolveEvidenceLineId(request, highlightChoice.optionId);
      if (line === undefined) {
        rejections.push({
          questionId: "highlight.line",
          reason: "unresolvable_evidence_line",
          detail: `line ${highlightChoice.optionId} is not in this observation's mapping`,
        });
      } else {
        highlight = {
          kind: "line",
          lineId: line.id,
          text: line.text,
          sourceIndex: line.sourceIndex,
        };
        evidenceLineId = line.id;
      }
    }
  }

  // ---- availability -----------------------------------------------------

  // A DECISIVE verdict is a present or absent answer about the evidence, from
  // any question. Decisiveness — not the presence of a displayed label — is what
  // makes an assessment current, so an all-absence assessment reads as "checked
  // and clear" rather than as a refusal, and an unrelated skipped question
  // cannot mask verdicts that did land.
  const decisiveCount =
    (activity.probability === undefined ? 0 : 1) +
    concerns.length +
    negatives.length +
    (highlight === undefined ? 0 : 1);

  let availability: AssessmentAvailability;
  let unavailableReason: UnavailableReason | undefined;
  if (decisiveCount > 0) {
    availability = "current";
  } else if (rejections.length > 0) {
    availability = "unavailable";
    unavailableReason = "answers_rejected";
  } else {
    // Nothing decisive and nothing rejected: every answer sat in the indecisive
    // band, or the questions the evidence could not support were skipped.
    availability = "abstained";
  }

  return {
    advisory: true,
    availability,
    packVersion: request.packVersion,
    activity,
    concerns,
    negatives,
    ...(highlight !== undefined ? { highlight } : {}),
    abstentions,
    rejections,
    ...(unavailableReason !== undefined ? { unavailableReason } : {}),
    provenance: buildProvenance({
      bindingId: request.bindingId,
      epoch: request.epoch,
      sourceSeq: request.sourceSeq,
      observedAt: request.observedAt,
      evidenceHash: request.evidenceHash,
      packVersion: request.packVersion,
      requestedModel: answerRequestedModel,
      returnedModel: answerReturnedModel,
      evidenceLineId,
    }),
  };
};
