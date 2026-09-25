/**
 * Seat-awareness wire adapter — the scheduler's advisory record becomes the
 * exact events the renderer's `decodeSeatAwarenessEvent` accepts.
 *
 * This is the one translation site between the producer half (the scheduler's
 * `AwarenessAdvisory`) and the renderer contract
 * (`src/renderer/lib/seat-awareness-contract.ts`). The contract is imported as
 * TYPES only: nothing here re-implements a rule the contract already states,
 * and the renderer decoder remains the authority on what is well formed. A
 * unit test feeds every advisory variant through this adapter and through the
 * renderer's decoder, so a drift between the two halves fails a test rather
 * than a card.
 *
 * Two events may come out of one advisory:
 *   window      the live material revision moved. Cheap and judgment-free; it
 *               carries only the digest and its capture time.
 *   assessment  a judgment, an abstention, an honest failure, or the gate-off
 *               notice. The excerpt mapping travels with it.
 *
 * A judgment-free notice (the sidecar is off, or nothing was ever observed)
 * names no window, so its evidence digest is the explicit `unobserved`
 * sentinel: the renderer stores it as a landing zone and reads none of it for
 * presentation, and the unavailable reason is what the card says.
 */

import type {
  SeatAwarenessAbsence,
  SeatAwarenessActivity,
  SeatAwarenessAssessment,
  SeatAwarenessConcern,
  SeatAwarenessEvent,
  SeatAwarenessEvidenceLine,
  SeatAwarenessUnavailableReason,
} from "@renderer/lib/seat-awareness-contract";
import type { ThreadHealthReading } from "@shared/thread-health";
import type { AwarenessAdvisory } from "./scheduler";

/**
 * Evidence digest for a notice that names no window at all. The renderer never
 * derives a digest and never reads one for presentation, so this is a stable
 * placeholder for "there is no observed screen", not a claim about one.
 */
export const SEAT_AWARENESS_UNOBSERVED_DIGEST = "unobserved";

const nonEmptyString = (value: string | undefined): string | undefined =>
  value !== undefined && value.length > 0 ? value : undefined;

/** A judgment exists only for the two judged availabilities. */
const judged = (advisory: AwarenessAdvisory): boolean =>
  advisory.availability === "current" || advisory.availability === "abstained";

const activityOf = (advisory: AwarenessAdvisory): SeatAwarenessActivity | null =>
  judged(advisory) ? (advisory.assessment?.activity.value ?? null) : null;

const concernsOf = (advisory: AwarenessAdvisory): SeatAwarenessConcern[] =>
  judged(advisory) ? (advisory.assessment?.concerns ?? []).map((entry) => entry.concern) : [];

const absencesOf = (advisory: AwarenessAdvisory): SeatAwarenessAbsence[] =>
  judged(advisory)
    ? advisory.absences.map((absence) => ({
        concern: absence.concern,
        probability: absence.probability,
      }))
    : [];

const selectedLineOf = (advisory: AwarenessAdvisory): string | null => {
  if (!judged(advisory)) return null;
  const highlight = advisory.assessment?.highlight;
  return highlight?.kind === "line" ? highlight.lineId : null;
};

const evidenceLinesOf = (
  advisory: AwarenessAdvisory,
): SeatAwarenessEvidenceLine[] =>
  advisory.evidenceLines.map((line) => ({ id: line.id, text: line.text }));

/**
 * The thread-health reading, only for a judged observation. It shares the
 * assessment's id and observation time, so the renderer can never pair a
 * health reading with a different observation than the one it came from.
 */
const healthOf = (
  advisory: AwarenessAdvisory,
  assessmentId: string,
  observedAt: number,
): ThreadHealthReading | undefined => {
  if (!judged(advisory)) return undefined;
  const assessment = advisory.assessment;
  const health = assessment?.health;
  if (assessment === undefined || health === undefined) return undefined;
  const model =
    assessment.provenance.returnedModel ?? assessment.provenance.requestedModel;
  return {
    bindingId: advisory.bindingId,
    value: health.value,
    confidence: health.probability,
    observedAt,
    provenance: {
      source: "jev",
      assessmentId,
      questionId: health.questionId,
      packVersion: assessment.packVersion,
      ...(model !== undefined ? { model } : {}),
    },
    signals: health.signals.map((signal) => ({
      value: signal.value,
      probability: signal.probability,
      questionId: signal.questionId,
    })),
  };
};

const assessmentFor = (
  advisory: AwarenessAdvisory,
  at: number,
): SeatAwarenessAssessment | undefined => {
  const availability = advisory.availability;
  if (availability === undefined) return undefined;
  const observedAt =
    advisory.assessment?.provenance.observedAt ?? advisory.windowCapturedAt ?? at;
  const digest =
    nonEmptyString(advisory.evidenceDigest) ??
    nonEmptyString(advisory.windowDigest) ??
    SEAT_AWARENESS_UNOBSERVED_DIGEST;
  const unavailableReason: SeatAwarenessUnavailableReason | null =
    availability === "unavailable" ? (advisory.unavailableReason ?? null) : null;
  // A cache hit keeps the producer's own id; a notice with no observation
  // gets one derived from its binding so the field is never empty.
  const assessmentId =
    advisory.assessmentId ?? `${SEAT_AWARENESS_UNOBSERVED_DIGEST}:${advisory.bindingId}`;
  const health = healthOf(advisory, assessmentId, observedAt);
  return {
    bindingId: advisory.bindingId,
    assessmentId,
    availability,
    observedAt,
    activity: activityOf(advisory),
    concerns: concernsOf(advisory),
    absences: absencesOf(advisory),
    // Present, possibly empty: the strong "checked and clear" claim requires a
    // present empty list, so the adapter never drops the field the producer set.
    unansweredConcerns: advisory.unansweredConcerns,
    evidence: {
      digest,
      capturedAt: advisory.windowCapturedAt ?? observedAt,
      lines: evidenceLinesOf(advisory),
    },
    selectedLineId: selectedLineOf(advisory),
    unavailableReason,
    ...(health !== undefined ? { health } : {}),
  };
};

/**
 * Every wire event one advisory implies, in the order the renderer should
 * apply them (the window revision lands before the judgment derived from it).
 */
export const seatAwarenessEventsForAdvisory = (
  advisory: AwarenessAdvisory,
  at: number = Date.now(),
): readonly SeatAwarenessEvent[] => {
  const events: SeatAwarenessEvent[] = [];
  const windowDigest = nonEmptyString(advisory.windowDigest);
  const windowCapturedAt = advisory.windowCapturedAt;
  if (
    windowDigest !== undefined &&
    typeof windowCapturedAt === "number" &&
    Number.isFinite(windowCapturedAt)
  ) {
    events.push({
      kind: "window",
      bindingId: advisory.bindingId,
      windowDigest,
      windowCapturedAt,
      at,
    });
  }
  const assessment = assessmentFor(advisory, at);
  if (assessment !== undefined) {
    events.push({
      kind: "assessment",
      assessment,
      windowDigest: windowDigest ?? assessment.evidence.digest,
      at,
    });
  }
  return events;
};
