/**
 * Seat awareness — the local IPC contract for the advisory sidecar.
 *
 * The sidecar asks a fixed pack of narrow typed questions about a bounded
 * window of terminal evidence and publishes the answers as advisory display.
 * This file is the wire shape and nothing else: the renderer store
 * (`seat-awareness.ts`) owns hygiene and presentation, and main/preload own
 * the producers. It is deliberately local to the renderer because the parent
 * thread wires the real channels; nothing here writes IPC.
 *
 * Authority boundary (binding):
 *   Awareness is display only. It may never change deterministic seat events,
 *   managed write decisions, delivery, occupancy, or `needsLook`. The five
 *   control states stay `idle | working | attention | unknown | gone` (with
 *   `done` the existing renderer derivation of idle + unseen). Awareness adds
 *   orthogonal read-only axes: AI activity, AI concerns, and assessment
 *   availability. Canonical attention always wins at presentation.
 *
 * Three axes, three vocabularies:
 *   activity      investigating | editing | running_command | testing |
 *                 reviewing | reporting | indeterminate
 *   concern       approval_requested | answer_requested | access_problem |
 *                 execution_error | repetition
 *   availability  not_assessed | current | stale | abstained | unavailable
 *
 * `not_assessed` and `stale` are renderer derivations and never travel on the
 * wire: an assessment is published as `current`, `abstained`, or
 * `unavailable`, and the store ages it out (about five minutes) or degrades
 * it when the seat has left the turn it describes. A cache hit is not a new
 * assessment — `observedAt` stays the original observation, so freshness can
 * never be reset by replaying a cached answer.
 *
 * Two event kinds travel on one channel:
 *   window      the evidence window for a binding changed. Cheap, no model
 *               call. `windowDigest` is a coarse material screen revision —
 *               volatile chrome (spinner and animation frames, elapsed-time and
 *               token counters, cursor position, byte and sequence counters,
 *               repaints that leave the visible text identical) is normalized
 *               out, and it is republished only when that normalized revision
 *               changes, at most once per coalescing window. The evidence
 *               digest, the scheduler's cache key, and the renderer's excerpt
 *               comparison must be that same normalization, exported once by
 *               the projection. The renderer never derives a digest: it only
 *               compares the two it was handed, so it cannot drift from it.
 *   assessment  one judgment (or abstention, or failure) plus the id-tagged
 *               evidence window it was derived from. The excerpt is resolved
 *               against THAT mapping only.
 *
 * The digest drives nothing in presentation. The activity and concerns stay
 * current while they are within the TTL and belong to the live control-state
 * turn; the excerpt makes no currency claim at all and is shown as an
 * age-attributed quotation. A digest-based currency claim cannot be both stable
 * and true on a busy seat (unfloored it flickers about once a second; any floor
 * long enough to stop that exceeds the longest observed gap between material
 * revisions), so the renderer holds the revision for the channel's landing zone
 * and the recorded containment upgrade, and claims nothing from it.
 */

import type { AgentSeatState } from "@shared/agent-seat-state";

/** Main -> renderer: one seat-awareness event. */
export const SEAT_AWARENESS_CHANNEL = "junto:seat-awareness" as const;
/** Renderer -> main: hydration read so a renderer restart loses no state. */
export const SEAT_AWARENESS_SNAPSHOT_CHANNEL =
  "junto:seat-awareness-snapshot" as const;

/**
 * Enrichment lifetime for the judgment axis. Past this the activity and
 * concerns are `stale`, never current, however the seat is behaving.
 */
export const SEAT_AWARENESS_TTL_MS = 5 * 60_000;

/** Ingest bounds. The evidence window is terminal text; it is never trusted. */
export const SEAT_AWARENESS_MAX_LINES = 120;
export const SEAT_AWARENESS_MAX_LINE_CHARS = 400;
/** Rendered excerpt bound. */
export const SEAT_AWARENESS_MAX_EXCERPT_CHARS = 240;
/** Concerns kept per observation — the rest are dropped at ingest. */
export const SEAT_AWARENESS_MAX_CONCERNS = 3;
/** Absurd-payload guard — a window larger than this is dropped, not stored. */
export const SEAT_AWARENESS_MAX_RAW_LINES = 4_000;

/** Control-state vocabulary plus the renderer's derived `done`. */
export type SeatAwarenessControlState = AgentSeatState | "done";

export const SEAT_AWARENESS_ACTIVITIES = [
  "investigating",
  "editing",
  "running_command",
  "testing",
  "reviewing",
  "reporting",
  "indeterminate",
] as const;
export type SeatAwarenessActivity = (typeof SEAT_AWARENESS_ACTIVITIES)[number];

export const SEAT_AWARENESS_CONCERNS = [
  "approval_requested",
  "answer_requested",
  "access_problem",
  "execution_error",
  "repetition",
] as const;
export type SeatAwarenessConcern = (typeof SEAT_AWARENESS_CONCERNS)[number];

export const SEAT_AWARENESS_AVAILABILITIES = [
  "not_assessed",
  "current",
  "stale",
  "abstained",
  "unavailable",
] as const;
export type SeatAwarenessAvailability =
  (typeof SEAT_AWARENESS_AVAILABILITIES)[number];

/** Honest reasons an assessment could not be produced. */
export const SEAT_AWARENESS_UNAVAILABLE_REASONS = [
  "missing_key",
  "provider_failure",
  "budget_exhausted",
  "not_configured",
] as const;
export type SeatAwarenessUnavailableReason =
  (typeof SEAT_AWARENESS_UNAVAILABLE_REASONS)[number];

/** Availability as published by the producer — never `not_assessed`/`stale`. */
export const SEAT_AWARENESS_PUBLISHED_AVAILABILITIES = [
  "current",
  "abstained",
  "unavailable",
] as const;
export type SeatAwarenessPublishedAvailability =
  (typeof SEAT_AWARENESS_PUBLISHED_AVAILABILITIES)[number];

/** One id-tagged line of the bounded evidence window. */
export type SeatAwarenessEvidenceLine = {
  readonly id: string;
  readonly text: string;
};

/**
 * The bounded evidence window an observation was made against, with the
 * id -> line mapping captured for that observation. `digest` identifies the
 * screen state, so a later window event can prove the screen moved on.
 */
export type SeatAwarenessEvidenceWindow = {
  readonly digest: string;
  readonly capturedAt: number;
  readonly lines: readonly SeatAwarenessEvidenceLine[];
};

/** One observation: a judgment, an abstention, or an honest failure. */
export type SeatAwarenessAssessment = {
  readonly bindingId: string;
  /** Provenance of this observation. Replayed cache hits keep their own id. */
  readonly assessmentId: string;
  readonly availability: SeatAwarenessPublishedAvailability;
  /** When the evidence was observed. A cache hit never moves this forward. */
  readonly observedAt: number;
  readonly activity: SeatAwarenessActivity | null;
  readonly concerns: readonly SeatAwarenessConcern[];
  /**
   * Accepted absences: concerns the model decisively ruled out, each with the
   * probability that grounded the call. A non-empty list with no concerns is
   * "checked and clear", which is a different claim from "not assessed" and
   * must not render as no judgment. Activity absences are control-plane
   * cross-checks and never travel here. Optional on the wire: a producer that
   * does not report absences yet omits the field, and decode normalizes that to
   * an empty list.
   */
  readonly absences?: readonly SeatAwarenessAbsence[];
  /** The mapping captured for THIS observation — the only excerpt source. */
  readonly evidence: SeatAwarenessEvidenceWindow;
  /** The line the model selected, or null when it selected none. */
  readonly selectedLineId: string | null;
  readonly unavailableReason: SeatAwarenessUnavailableReason | null;
};

/** One concern the model decisively ruled out for this observation. */
export type SeatAwarenessAbsence = {
  readonly concern: SeatAwarenessConcern;
  /** The Noul probability behind the absence, at or below the negative bar. */
  readonly probability: number;
};

/** The evidence window changed. No judgment; only the live digest moves. */
export type SeatAwarenessWindowEvent = {
  readonly kind: "window";
  readonly bindingId: string;
  readonly windowDigest: string;
  readonly windowCapturedAt: number;
  readonly at: number;
};

/** A new observation, plus the live window digest at publish time. */
export type SeatAwarenessAssessmentEvent = {
  readonly kind: "assessment";
  readonly assessment: SeatAwarenessAssessment;
  readonly windowDigest: string;
  readonly at: number;
};

export type SeatAwarenessEvent =
  | SeatAwarenessWindowEvent
  | SeatAwarenessAssessmentEvent;

const ACTIVITY_SET: ReadonlySet<string> = new Set(SEAT_AWARENESS_ACTIVITIES);
const CONCERN_SET: ReadonlySet<string> = new Set(SEAT_AWARENESS_CONCERNS);
const PUBLISHED_SET: ReadonlySet<string> = new Set(
  SEAT_AWARENESS_PUBLISHED_AVAILABILITIES,
);
const UNAVAILABLE_SET: ReadonlySet<string> = new Set(
  SEAT_AWARENESS_UNAVAILABLE_REASONS,
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const decodeEvidence = (raw: unknown): SeatAwarenessEvidenceWindow | undefined => {
  if (!isRecord(raw)) return undefined;
  if (!isNonEmptyString(raw.digest)) return undefined;
  if (!isFiniteNumber(raw.capturedAt)) return undefined;
  if (!Array.isArray(raw.lines)) return undefined;
  if (raw.lines.length > SEAT_AWARENESS_MAX_RAW_LINES) return undefined;
  const lines: SeatAwarenessEvidenceLine[] = [];
  for (const line of raw.lines) {
    if (!isRecord(line)) return undefined;
    if (!isNonEmptyString(line.id)) return undefined;
    if (typeof line.text !== "string") return undefined;
    lines.push({ id: line.id, text: line.text });
  }
  return { digest: raw.digest, capturedAt: raw.capturedAt, lines };
};

const decodeAssessment = (raw: unknown): SeatAwarenessAssessment | undefined => {
  if (!isRecord(raw)) return undefined;
  if (!isNonEmptyString(raw.bindingId)) return undefined;
  const bindingId = raw.bindingId;
  if (!isNonEmptyString(raw.assessmentId)) return undefined;
  if (typeof raw.availability !== "string" || !PUBLISHED_SET.has(raw.availability))
    return undefined;
  if (!isFiniteNumber(raw.observedAt)) return undefined;
  if (raw.activity !== null && !ACTIVITY_SET.has(String(raw.activity)))
    return undefined;
  if (!Array.isArray(raw.concerns)) return undefined;
  const concerns: SeatAwarenessConcern[] = [];
  for (const concern of raw.concerns) {
    if (typeof concern !== "string" || !CONCERN_SET.has(concern)) return undefined;
    concerns.push(concern as SeatAwarenessConcern);
  }
  const evidence = decodeEvidence(raw.evidence);
  if (!evidence) return undefined;
  // Additive field: a producer that does not report absences yet sends none,
  // which is not the same as "checked and clear". Anything present must be well
  // formed or the whole assessment is refused.
  const absences: SeatAwarenessAbsence[] = [];
  if (raw.absences !== undefined) {
    if (!Array.isArray(raw.absences)) return undefined;
    for (const absence of raw.absences) {
      if (!isRecord(absence)) return undefined;
      if (typeof absence.concern !== "string" || !CONCERN_SET.has(absence.concern))
        return undefined;
      if (!isFiniteNumber(absence.probability)) return undefined;
      absences.push({
        concern: absence.concern as SeatAwarenessConcern,
        probability: absence.probability,
      });
    }
  }
  if (raw.selectedLineId !== null && !isNonEmptyString(raw.selectedLineId))
    return undefined;
  const reason =
    typeof raw.unavailableReason === "string" &&
    UNAVAILABLE_SET.has(raw.unavailableReason)
      ? (raw.unavailableReason as SeatAwarenessUnavailableReason)
      : null;
  const availability = raw.availability as SeatAwarenessPublishedAvailability;
  return {
    bindingId,
    assessmentId: raw.assessmentId,
    availability,
    observedAt: raw.observedAt,
    activity: raw.activity === null ? null : (raw.activity as SeatAwarenessActivity),
    concerns,
    absences,
    evidence,
    selectedLineId: raw.selectedLineId === null ? null : raw.selectedLineId,
    // A reason is only meaningful for an honest failure; never carry one on a
    // judgment or an abstention.
    unavailableReason: availability === "unavailable" ? reason : null,
  };
};

/**
 * Strict decode at the IPC boundary. One malformed field drops the whole
 * event — a half-applied observation is worse than none, and the deterministic
 * card must never be touched by a partially valid message.
 */
export const decodeSeatAwarenessEvent = (
  raw: unknown,
): SeatAwarenessEvent | undefined => {
  if (!isRecord(raw)) return undefined;
  if (!isNonEmptyString(raw.windowDigest)) return undefined;
  if (!isFiniteNumber(raw.at)) return undefined;
  if (raw.kind === "window") {
    if (!isNonEmptyString(raw.bindingId)) return undefined;
    if (!isFiniteNumber(raw.windowCapturedAt)) return undefined;
    return {
      kind: "window",
      bindingId: raw.bindingId,
      windowDigest: raw.windowDigest,
      windowCapturedAt: raw.windowCapturedAt,
      at: raw.at,
    };
  }
  if (raw.kind !== "assessment") return undefined;
  // An assessment carries its binding inside the observation, not beside it.
  const assessment = decodeAssessment(raw.assessment);
  if (!assessment) return undefined;
  return {
    kind: "assessment",
    assessment,
    windowDigest: raw.windowDigest,
    at: raw.at,
  };
};

/** The binding an event belongs to, whichever kind it is. */
export const seatAwarenessEventBinding = (event: SeatAwarenessEvent): string =>
  event.kind === "assessment" ? event.assessment.bindingId : event.bindingId;
