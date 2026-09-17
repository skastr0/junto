/**
 * Seat awareness — renderer store and presentation for the advisory sidecar.
 *
 * Display only. Nothing here writes the canvas, a seat event, a managed write
 * decision, delivery, occupancy, or `needsLook`; the hover that consumes this
 * module is a leaf and hovering never marks a seat seen. Canonical attention
 * always wins: `control` is echoed unchanged into every view and the AI line
 * is a separate, attributed plane.
 *
 * What this module owns:
 *   1. strict ingest of the awareness channel (`decodeSeatAwarenessEvent`) plus
 *      hygiene — every evidence line is sanitized and bounded before it can
 *      ever reach a render
 *   2. the latest observation per binding, plus the live evidence digest so a
 *      judgment derived from an older screen reads as "last observed"
 *   3. availability derivation: `not_assessed` (nothing yet) and `stale`
 *      (expired or screen moved on) are renderer facts, never wire facts
 *   4. the composed copy: a code-composed label, an extractive excerpt resolved
 *      against the mapping captured for THAT observation, and a timestamp
 *
 * Deterministic fallback is mandatory: with no assessment (or while one is
 * stale) the surface still shows the existing deterministic status plus a
 * neutral line, and a missing key, provider failure, or spent budget renders
 * as `unavailable` honestly. Awareness never delays terminal startup or
 * automation because nothing here blocks on the sidecar.
 *
 * Terminal text is evidence, never instruction: excerpts render as inert text,
 * control characters and escape sequences are stripped (so no terminal-supplied
 * link can be activated), lengths are bounded, and the repository's hard
 * no-middle-dot invariant is enforced on ingest because copy includes
 * terminal-derived text.
 */

import { observable } from "@legendapp/state";
import {
  SEAT_AWARENESS_MAX_CONCERNS,
  SEAT_AWARENESS_MAX_EXCERPT_CHARS,
  SEAT_AWARENESS_MAX_LINES,
  SEAT_AWARENESS_MAX_LINE_CHARS,
  SEAT_AWARENESS_TTL_MS,
  decodeSeatAwarenessEvent,
  seatAwarenessEventBinding,
  type SeatAwarenessActivity,
  type SeatAwarenessAssessment,
  type SeatAwarenessAvailability,
  type SeatAwarenessConcern,
  type SeatAwarenessControlState,
  type SeatAwarenessEvent,
  type SeatAwarenessUnavailableReason,
} from "./seat-awareness-contract";
import type { ActivityTone } from "./activity";
import { getJuntoApi } from "./junto-api";

export const SEAT_AWARENESS_EXCERPT_LABEL = "terminal excerpt";
/** Eyebrow when no assessment exists — the deterministic surface. */
export const SEAT_AWARENESS_TERMINAL_ATTRIBUTION = "terminal";
export const SEAT_AWARENESS_ATTRIBUTION = "AI assessment";
export const SEAT_AWARENESS_NEUTRAL_LINE = "recent terminal output available";
export const SEAT_AWARENESS_UNAVAILABLE_FALLBACK = "AI assessment unavailable";

/**
 * Code-composed labels. Every one of these is hedged or attributed on purpose:
 * an AI judgment is a suggestion ("AI suggests checking approval") or a
 * likelihood ("Likely testing"), never a canonical control transition and never
 * a promise that delivery has paused. None of them may read as a control state.
 */
export const SEAT_AWARENESS_ACTIVITY_COPY: Readonly<
  Record<SeatAwarenessActivity, string>
> = {
  investigating: "Likely investigating",
  editing: "Likely editing",
  running_command: "Likely running a command",
  testing: "Likely testing",
  reviewing: "Likely reviewing",
  reporting: "Likely reporting",
  indeterminate: "Activity unclear",
};

export const SEAT_AWARENESS_CONCERN_COPY: Readonly<
  Record<SeatAwarenessConcern, string>
> = {
  approval_requested: "AI suggests checking approval",
  answer_requested: "AI suggests answering a question",
  access_problem: "AI suggests checking access",
  execution_error: "AI suggests checking a failure",
  repetition: "AI suggests checking a repeat",
};

export const SEAT_AWARENESS_UNAVAILABLE_COPY: Readonly<
  Record<SeatAwarenessUnavailableReason, string>
> = {
  missing_key: "AI assessment unavailable: no API key configured",
  provider_failure: "AI assessment unavailable: the provider did not answer",
  budget_exhausted: "AI assessment unavailable: assessment budget spent",
  not_configured: "AI assessment unavailable: the sidecar is not configured",
};

export const SEAT_AWARENESS_AVAILABILITY_COPY: Readonly<
  Record<SeatAwarenessAvailability, string>
> = {
  not_assessed: "NOT ASSESSED",
  current: "CURRENT",
  stale: "LAST OBSERVED",
  abstained: "NO JUDGMENT",
  unavailable: "UNAVAILABLE",
};

/** Chip tone per availability. Amber stays reserved for attention, crimson for
 * blockers — an unavailable sidecar is neither. */
export const SEAT_AWARENESS_AVAILABILITY_TONE: Readonly<
  Record<SeatAwarenessAvailability, "cyan" | "steel">
> = {
  not_assessed: "steel",
  current: "cyan",
  stale: "steel",
  abstained: "steel",
  unavailable: "steel",
};

export type SeatAwarenessStore = {
  /** Latest observation by terminal bindingId. */
  readonly byBindingId: Record<string, SeatAwarenessAssessment | undefined>;
  /** Live evidence digest by bindingId — newest window the producer reported. */
  readonly windowDigestByBindingId: Record<string, string | undefined>;
  /**
   * Monotonic apply counter. Nested Legend writes on `byBindingId[id]` keep
   * the parent object identity, so React `use$(byBindingId)` effects miss
   * in-place replacements. Depend on `rev` instead.
   */
  readonly rev: number;
};

export const seatAwareness$ = observable<SeatAwarenessStore>({
  byBindingId: {},
  windowDigestByBindingId: {},
  rev: 0,
});

// Newest applied event time per binding. Events are ordered over IPC, but a
// replayed or raced message must never regress the live window digest.
const appliedAtByBindingId = new Map<string, number>();

// --- text hygiene ------------------------------------------------------------

// OSC (including OSC 8 hyperlinks), CSI, and two-character escapes. Stripped
// first so a sequence never degrades into its printable payload.
const ANSI_SEQUENCE =
  /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)?|\u001B\[[0-?]*[ -/]*[@-~]|\u001B[@-Z\\-_]/gu;
const CONTROL_CHAR = /[\u0000-\u001F\u007F-\u009F]/gu;
// Bidi overrides, zero-width marks, soft hyphen, and other invisible format
// characters: they can reorder or hide what the operator reads.
const INVISIBLE_FORMAT =
  /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/gu;
/** U+00B7 MIDDLE DOT — banned product-wide, and copy carries terminal text. */
const MIDDLE_DOT = /\u00B7/gu;
const WHITESPACE_RUN = /\s+/gu;

const ELLIPSIS = "...";

/** Bound a string to `max` characters, ending with a plain ASCII ellipsis. */
export const boundExcerptText = (
  text: string,
  max: number = SEAT_AWARENESS_MAX_EXCERPT_CHARS,
): string => {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.max(0, max - ELLIPSIS.length)).trimEnd();
  return `${head}${ELLIPSIS}`;
};

/**
 * One line of terminal text -> inert, bounded, middot-free copy.
 * Control characters become spaces (never removed mid-word) so words do not
 * fuse, then runs of whitespace collapse and the ends are trimmed.
 */
export const sanitizeTerminalText = (raw: string): string =>
  raw
    .replace(ANSI_SEQUENCE, "")
    .replace(CONTROL_CHAR, " ")
    .replace(INVISIBLE_FORMAT, "")
    .replace(MIDDLE_DOT, " ")
    .replace(WHITESPACE_RUN, " ")
    .trim();

const sanitizeEvidenceLineText = (raw: string): string =>
  boundExcerptText(sanitizeTerminalText(raw), SEAT_AWARENESS_MAX_LINE_CHARS);

/**
 * Ingest hygiene: bound the window, sanitize every line, dedupe and bound the
 * concerns. Runs once, before an observation can be read by any renderer.
 */
const sanitizeAssessment = (
  assessment: SeatAwarenessAssessment,
): SeatAwarenessAssessment => {
  const concerns: SeatAwarenessConcern[] = [];
  for (const concern of assessment.concerns) {
    if (!concerns.includes(concern)) concerns.push(concern);
  }
  return {
    ...assessment,
    concerns: concerns.slice(0, SEAT_AWARENESS_MAX_CONCERNS),
    evidence: {
      digest: assessment.evidence.digest,
      capturedAt: assessment.evidence.capturedAt,
      lines: assessment.evidence.lines
        .slice(0, SEAT_AWARENESS_MAX_LINES)
        .map((line) => ({ id: line.id, text: sanitizeEvidenceLineText(line.text) })),
    },
  };
};

// --- store -------------------------------------------------------------------

/**
 * Apply one decoded event. The newest event per binding wins; a replayed
 * cache hit keeps its original `observedAt`, so freshness can never be reset
 * by replaying a cached answer.
 */
export const applySeatAwarenessEvent = (event: SeatAwarenessEvent): void => {
  const bindingId = seatAwarenessEventBinding(event);
  if (!bindingId) return;
  const appliedAt = appliedAtByBindingId.get(bindingId);
  if (appliedAt !== undefined && event.at < appliedAt) return;
  appliedAtByBindingId.set(bindingId, event.at);

  seatAwareness$.windowDigestByBindingId[bindingId].set(event.windowDigest);
  if (event.kind === "assessment") {
    const current = seatAwareness$.byBindingId[bindingId].peek();
    if (!current || event.assessment.observedAt >= current.observedAt) {
      seatAwareness$.byBindingId[bindingId].set(
        sanitizeAssessment(event.assessment),
      );
    }
  }
  seatAwareness$.rev.set(seatAwareness$.rev.peek() + 1);
};

export const awarenessForBinding = (
  bindingId: string | undefined,
): SeatAwarenessAssessment | undefined => {
  if (!bindingId) return undefined;
  return seatAwareness$.byBindingId[bindingId].peek();
};

export const windowDigestForBinding = (
  bindingId: string | undefined,
): string | undefined => {
  if (!bindingId) return undefined;
  return seatAwareness$.windowDigestByBindingId[bindingId].peek();
};

// --- IPC ---------------------------------------------------------------------

/**
 * The parent thread wires the real channel into preload. Until it lands the
 * method is simply absent, and this structural read degrades to a no-op
 * subscribe so no renderer path can crash or block on a missing sidecar.
 */
type SeatAwarenessBridge = {
  readonly onSeatAwarenessChanged?: (
    listener: (event: unknown) => void,
  ) => () => void;
  readonly seatAwarenessSnapshot?: () => Promise<unknown>;
};

const seatAwarenessBridge = (): SeatAwarenessBridge | undefined => {
  const api: unknown = getJuntoApi();
  if (typeof api !== "object" || api === null) return undefined;
  return api as SeatAwarenessBridge;
};

let activeUnsubscribe: (() => void) | undefined;

export const subscribeSeatAwareness = (): (() => void) => {
  if (activeUnsubscribe) return activeUnsubscribe;
  const bridge = seatAwarenessBridge();
  if (!bridge || typeof bridge.onSeatAwarenessChanged !== "function") {
    return () => undefined;
  }
  const unsubscribe = bridge.onSeatAwarenessChanged((raw) => {
    const event = decodeSeatAwarenessEvent(raw);
    if (!event) return;
    applySeatAwarenessEvent(event);
  });
  let active = true;
  activeUnsubscribe = () => {
    active = false;
    unsubscribe();
    activeUnsubscribe = undefined;
  };

  // Subscribe before reading current state; the timestamp guard in
  // applySeatAwarenessEvent keeps a racing older snapshot from winning.
  if (typeof bridge.seatAwarenessSnapshot === "function") {
    void bridge.seatAwarenessSnapshot().then(
      (snapshot) => {
        if (!active || !Array.isArray(snapshot)) return;
        for (const raw of snapshot) {
          const event = decodeSeatAwarenessEvent(raw);
          if (event) applySeatAwarenessEvent(event);
        }
      },
      () => undefined,
    );
  }

  return activeUnsubscribe;
};

// --- availability ------------------------------------------------------------

export const formatSeatAwarenessAge = (ageMs: number): string => {
  if (!Number.isFinite(ageMs) || ageMs < 5_000) return "just now";
  const seconds = Math.floor(ageMs / 1_000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
};

/**
 * Effective availability at `now`. `not_assessed` is the absence of an
 * observation; `stale` is an observation that expired (about five minutes) or
 * that was made against a screen the live window digest has since replaced.
 * Abstentions and failures stay themselves — there is no enrichment to expire,
 * and neither one ever claims currency.
 */
export const seatAwarenessAvailability = (
  assessment: SeatAwarenessAssessment | undefined,
  input: { readonly now: number; readonly windowDigest?: string | undefined },
): SeatAwarenessAvailability => {
  if (!assessment) return "not_assessed";
  if (assessment.availability !== "current") return assessment.availability;
  const expired = input.now - assessment.observedAt >= SEAT_AWARENESS_TTL_MS;
  const screenMoved =
    input.windowDigest !== undefined &&
    input.windowDigest !== assessment.evidence.digest;
  if (expired || screenMoved) return "stale";
  return "current";
};

// --- presentation ------------------------------------------------------------

/**
 * The canonical deterministic status, unchanged by awareness. `tone` is the
 * existing activity tone (`lib/activity.ts`) so the control row paints from the
 * one severity vocabulary; `label`/`detail` are the card's existing status copy.
 */
export type SeatAwarenessControl = {
  readonly state?: SeatAwarenessControlState | undefined;
  readonly label: string;
  readonly tone?: ActivityTone | undefined;
  readonly pulse?: boolean | undefined;
  readonly detail?: string | undefined;
};

/** `SeatAwarenessControl` with the defaults applied — what the view carries. */
export type SeatAwarenessResolvedControl = {
  readonly state: SeatAwarenessControlState | undefined;
  readonly label: string;
  readonly tone: ActivityTone;
  readonly pulse: boolean;
  readonly detail: string | undefined;
};

export type SeatAwarenessView = {
  readonly availability: SeatAwarenessAvailability;
  readonly availabilityLabel: string;
  readonly control: SeatAwarenessResolvedControl;
  readonly canonicalAttention: boolean;
  /** Eyebrow above the AI block; null when no assessment exists. */
  readonly attribution: string | null;
  /** Code-composed AI headline, or null when no judgment was accepted. */
  readonly aiLabel: string | null;
  readonly activityLabel: string | null;
  readonly concerns: readonly SeatAwarenessConcern[];
  readonly concernTexts: readonly string[];
  /** Extractive excerpt from THIS observation's window; never generated. */
  readonly excerpt: string | null;
  readonly excerptLabel: string | null;
  readonly freshness: string | null;
  /** Neutral / honest line shown when no judgment was accepted. */
  readonly availabilityLine: string;
  /** True when the judgment describes a screen that has since moved on. */
  readonly degraded: boolean;
  /** One-line composition for aria and title. */
  readonly sentence: string;
};

export type SeatAwarenessPresentationInput = {
  readonly control: SeatAwarenessControl;
  readonly assessment?: SeatAwarenessAssessment | undefined;
  /** Live evidence digest for the binding. */
  readonly windowDigest?: string | undefined;
  readonly now: number;
};

const DEFAULT_CONTROL_TONE: ActivityTone = "steel";

/**
 * Resolve the selected line against the mapping captured for THIS observation.
 * An id that is not in this window resolves to nothing — never to a line from
 * another window, and never to prose invented to fill the gap.
 */
const resolveExcerpt = (
  assessment: SeatAwarenessAssessment,
): string | null => {
  const selectedLineId = assessment.selectedLineId;
  if (!selectedLineId) return null;
  const line = assessment.evidence.lines.find((entry) => entry.id === selectedLineId);
  if (!line) return null;
  const text = boundExcerptText(sanitizeTerminalText(line.text));
  return text.length > 0 ? text : null;
};

export const seatAwarenessView = (
  input: SeatAwarenessPresentationInput,
): SeatAwarenessView => {
  const control: SeatAwarenessResolvedControl = {
    state: input.control.state,
    label: input.control.label,
    tone: input.control.tone ?? DEFAULT_CONTROL_TONE,
    pulse: input.control.pulse === true,
    detail: input.control.detail,
  };
  const assessment = input.assessment;
  const availability = seatAwarenessAvailability(assessment, {
    now: input.now,
    windowDigest: input.windowDigest,
  });
  // A judgment only exists when the model actually answered something. A
  // `current` observation with neither activity nor concern is presented as an
  // abstention rather than as an empty judgment, and a failure has none by
  // definition.
  const judgment =
    assessment !== undefined &&
    availability !== "abstained" &&
    availability !== "unavailable" &&
    (assessment.activity !== null || assessment.concerns.length > 0)
      ? assessment
      : undefined;

  const activityLabel = judgment?.activity
    ? SEAT_AWARENESS_ACTIVITY_COPY[judgment.activity]
    : null;
  const concerns = judgment?.concerns ?? [];
  const concernTexts = concerns.map((concern) => SEAT_AWARENESS_CONCERN_COPY[concern]);
  const aiLabel = concernTexts[0] ?? activityLabel ?? null;

  const excerpt = judgment ? resolveExcerpt(judgment) : null;

  const freshness = judgment
    ? `${SEAT_AWARENESS_ATTRIBUTION}, ${
        availability === "stale" ? "last observed" : "observed"
      } ${formatSeatAwarenessAge(input.now - judgment.observedAt)}`
    : null;

  const availabilityLine =
    availability === "unavailable"
      ? (assessment?.unavailableReason
          ? SEAT_AWARENESS_UNAVAILABLE_COPY[assessment.unavailableReason]
          : SEAT_AWARENESS_UNAVAILABLE_FALLBACK)
      : SEAT_AWARENESS_NEUTRAL_LINE;

  const sentenceParts: string[] = [aiLabel ?? control.label];
  if (excerpt) {
    sentenceParts.push(`${SEAT_AWARENESS_EXCERPT_LABEL}: '${excerpt}'`);
  }
  if (freshness) sentenceParts.push(freshness);
  if (!aiLabel) sentenceParts.push(availabilityLine);

  return {
    availability,
    availabilityLabel: SEAT_AWARENESS_AVAILABILITY_COPY[availability],
    control,
    canonicalAttention: control.state === "attention",
    attribution: assessment !== undefined ? SEAT_AWARENESS_ATTRIBUTION : null,
    aiLabel,
    activityLabel,
    concerns,
    concernTexts,
    excerpt,
    excerptLabel: excerpt ? SEAT_AWARENESS_EXCERPT_LABEL : null,
    freshness,
    availabilityLine,
    degraded: availability === "stale",
    sentence: sentenceParts.join(" - "),
  };
};

/** Store-reading form: the parent hands a binding and the card's own status. */
export const seatAwarenessViewForBinding = (input: {
  readonly bindingId: string | undefined;
  readonly control: SeatAwarenessControl;
  readonly now?: number;
}): SeatAwarenessView =>
  seatAwarenessView({
    control: input.control,
    assessment: awarenessForBinding(input.bindingId),
    windowDigest: windowDigestForBinding(input.bindingId),
    now: input.now ?? Date.now(),
  });

/** Test / unmount helper — clear store + allow re-subscribe. */
export const resetSeatAwareness = (): void => {
  seatAwareness$.byBindingId.set({});
  seatAwareness$.windowDigestByBindingId.set({});
  seatAwareness$.rev.set(0);
  appliedAtByBindingId.clear();
  if (activeUnsubscribe) {
    activeUnsubscribe();
    activeUnsubscribe = undefined;
  }
};
