/**
 * Awareness as an author on the seat signal contract.
 *
 * Turns one projected assessment into `AwarenessAssessed` envelopes
 * (`src/shared/harness-domain/signal.ts`), one per question that got a
 * decisive answer:
 *
 *   - PRESENT: an accepted activity property, an accepted concern, or an
 *     accepted health property that survived HEALTH_REQUIRES_ALSO;
 *   - ABSENT (`present: false`): an accepted negative verdict, which withdraws
 *     an earlier answer on the same question.
 *
 * Indecisive, declined, skipped and rejected questions emit nothing: only a
 * decisive answer may change what the reducer holds. The highlight is not an
 * axis and never travels.
 *
 * Each question answers on its own axis exactly once. Health readings the pack
 * derives from concern questions (a live approval prompt reads as a thread
 * waiting on the operator) are not re-emitted as health: the concern answer is
 * the fact, and the contract's need table already ranks it.
 *
 * `probability` is the confidence in the published answer: the model's own
 * number for a present answer, its complement for an absent Noul (which the
 * model scored as the chance the property holds), and the chosen option's mass
 * for an absent Choice. Nothing is multiplied or combined.
 *
 * `awarenessRetired` is the other half: when the runtime stops holding the
 * assessment its envelopes came from (it expired, or the seat changed
 * generation), every reading those envelopes left in the reducer stops
 * counting. It is Junto's own observation, so it travels as a system signal.
 *
 * Authority: advisory. The envelopes are facts for the reducer and the need
 * table, which caps awareness at `escalated`. Nothing here drives a command.
 */

import { Schema } from "effect";
import type { AwarenessAnswer, SignalEnvelope } from "@shared/harness-domain";
import { BindingId } from "@shared/terminal-session-domain";
import { AWARENESS_QUESTIONS, type AwarenessQuestion } from "./questions";
import type { AwarenessAssessment } from "./project-result";

export type { SignalEnvelope } from "@shared/harness-domain";

const axisAnswer = (question: AwarenessQuestion): AwarenessAnswer | undefined => {
  if (question.concern !== undefined) return { axis: "concern", value: question.concern };
  if (question.kind !== "noul") return undefined;
  if (question.activity !== undefined) return { axis: "activity", value: question.activity };
  if (question.health !== undefined) return { axis: "health", value: question.health };
  return undefined;
};

/** Every question that answers an axis, in pack order, with its own answer. */
const AXIS_QUESTIONS: ReadonlyArray<{
  readonly question: AwarenessQuestion;
  readonly answer: AwarenessAnswer;
}> = AWARENESS_QUESTIONS.flatMap((question) => {
  const answer = axisAnswer(question);
  return answer === undefined ? [] : [{ question, answer }];
});

const decodeSeat = Schema.decodeUnknownOption(BindingId);

/**
 * The decisive answers of one assessment as signal envelopes, in pack order.
 * Empty when nothing was decided, including every unavailable assessment.
 */
export const assessmentSignals = (assessment: AwarenessAssessment): readonly SignalEnvelope[] => {
  const present = new Map<string, number>();
  for (const signal of assessment.activity.signals) present.set(signal.questionId, signal.probability);
  for (const concern of assessment.concerns) present.set(concern.questionId, concern.probability);
  for (const signal of assessment.health?.signals ?? []) {
    if (!present.has(signal.questionId)) present.set(signal.questionId, signal.probability);
  }
  const absent = new Map<string, number>();
  for (const verdict of assessment.negatives) absent.set(verdict.questionId, verdict.probability);
  if (present.size === 0 && absent.size === 0) return [];

  const { provenance } = assessment;
  const seat = decodeSeat(provenance.bindingId);
  if (seat._tag === "None") return [];

  const envelopes: SignalEnvelope[] = [];
  for (const { question, answer } of AXIS_QUESTIONS) {
    const held = present.get(question.id);
    const cleared = absent.get(question.id);
    if (held === undefined && cleared === undefined) continue;
    const isPresent = held !== undefined;
    const probability = isPresent
      ? held
      : question.kind === "noul"
        ? 1 - cleared!
        : cleared!;
    envelopes.push({
      seat: seat.value,
      at: provenance.observedAt,
      source: "awareness",
      fidelity: "screen",
      signal: {
        _tag: "AwarenessAssessed",
        questionId: question.id,
        answer,
        present: isPresent,
        probability,
        evidenceHash: provenance.evidenceHash,
        packVersion: assessment.packVersion,
      },
    });
  }
  return envelopes;
};

/** Every held awareness reading of a seat stops counting. Undefined for an empty id. */
export const awarenessRetired = (
  bindingId: string,
  reason: "expired" | "epoch",
  at: number,
): SignalEnvelope | undefined => {
  const seat = decodeSeat(bindingId);
  if (seat._tag === "None") return undefined;
  return {
    seat: seat.value,
    at,
    source: "system",
    fidelity: "native",
    signal: { _tag: "AwarenessRetired", reason },
  };
};
