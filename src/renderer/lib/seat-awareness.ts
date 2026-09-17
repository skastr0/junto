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
 *   2. the latest observation per binding, plus the live evidence digest
 *   3. two independent freshness axes. The excerpt is current only on an exact
 *      digest match and is otherwise shown as last observed, because it is
 *      quoted screen text. The judgment (activity + concerns) stays current
 *      while it is within the enrichment lifetime and belongs to the live
 *      control-state turn, so a continuously printing seat keeps a useful label
 *      even though its screen keeps moving
 *   4. availability derivation: `not_assessed` (nothing yet) and `stale`
 *      (expired, or the seat left the turn) are renderer facts, never wire
 *      facts
 *   5. the composed copy: a code-composed label, an extractive excerpt resolved
 *      against the mapping captured for THAT observation, and timestamps
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
 * Effective availability at `now` — the judgment axis (activity + concerns).
 * `not_assessed` is the absence of an observation; `stale` is an observation
 * whose judgment is no longer current because it expired (about five minutes)
 * or because the seat has left the turn it describes. Abstentions and failures
 * stay themselves — there is no enrichment to expire, and neither one ever
 * claims currency.
 *
 * The evidence digest deliberately plays no part here: a continuously printing
 * seat churns its screen without ending its turn, and an excerpt-only
 * degradation must not be allowed to throw away a still-useful label.
 */
export const seatAwarenessAvailability = (
  assessment: SeatAwarenessAssessment | undefined,
  input: {
    readonly now: number;
    /** Live canonical control state — the turn the judgment must belong to. */
    readonly controlState?: SeatAwarenessControlState | undefined;
  },
): SeatAwarenessAvailability => {
  if (!assessment) return "not_assessed";
  if (assessment.availability !== "current") return assessment.availability;
  // A `current` observation with neither activity nor concern carries no
  // judgment to age: present it as an abstention.
  if (assessment.activity === null && assessment.concerns.length === 0) {
    return "abstained";
  }
  const expired = input.now - assessment.observedAt >= SEAT_AWARENESS_TTL_MS;
  if (expired || !seatAwarenessTurnLive(input.controlState)) return "stale";
  return "current";
};

/**
 * Live turns. A judgment describes work in progress, so it stays current while
 * the seat is still in that turn — `working` (a turn under way) or `attention`
 * (a turn waiting on the operator) — and becomes stale once the seat settles
 * (`idle`, `done`) or is vacated (`gone`).
 *
 * Only those three settling states prove the turn ended. `unknown` and an
 * absent state prove nothing, so they never claim staleness. That is the same
 * rule the excerpt axis follows: never claim more than the evidence shows. A
 * new control state must be decided here deliberately rather than defaulting
 * into a degradation.
 */
export const seatAwarenessTurnLive = (
  state: SeatAwarenessControlState | undefined,
): boolean => state !== "idle" && state !== "done" && state !== "gone";

/**
 * The excerpt axis: current only on an exact match against the live window
 * digest, otherwise last observed. A missing live digest cannot prove a match,
 * so it is never relabelled current.
 *
 * This layer never derives a digest — it compares the two it was handed, both
 * produced by the projection, so it cannot drift from the one normalization
 * that also serves the evidence digest and the scheduler's cache key.
 */
export const seatAwarenessExcerptFreshness = (
  assessment: SeatAwarenessAssessment,
  input: { readonly windowDigest?: string | undefined },
): SeatAwarenessExcerptFreshness =>
  input.windowDigest !== undefined &&
  input.windowDigest === assessment.evidence.digest
    ? "current"
    : "last_observed";

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

/** Judgment axis (activity + concerns): the turn plus the enrichment lifetime. */
export type SeatAwarenessJudgmentFreshness = "current" | "stale";
/** Excerpt axis: an exact live window digest match, or an older screen. */
export type SeatAwarenessExcerptFreshness = "current" | "last_observed";

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
  /** Judgment freshness; null when no judgment was accepted. */
  readonly judgmentFreshness: SeatAwarenessJudgmentFreshness | null;
  /** Extractive excerpt from THIS observation's window; never generated. */
  readonly excerpt: string | null;
  /** Excerpt freshness; null when there is no excerpt. */
  readonly excerptFreshness: SeatAwarenessExcerptFreshness | null;
  /** "terminal excerpt", or the same with a last-observed stamp. */
  readonly excerptLabel: string | null;
  readonly freshness: string | null;
  /** Neutral / honest line shown when no judgment was accepted. */
  readonly availabilityLine: string;
  /** One-line composition for aria and title. */
  readonly sentence: string;
};

export type SeatAwarenessPresentationInput = {
  readonly control: SeatAwarenessControl;
  readonly assessment?: SeatAwarenessAssessment | undefined;
  /** Live evidence digest for the binding — the excerpt axis. */
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

/** The excerpt with its own axis: the text, its freshness, and its label. */
const resolveExcerptDisplay = (
  assessment: SeatAwarenessAssessment,
  input: { readonly now: number; readonly windowDigest?: string | undefined },
): {
  readonly text: string;
  readonly freshness: SeatAwarenessExcerptFreshness;
  readonly label: string;
} | null => {
  const text = resolveExcerpt(assessment);
  if (!text) return null;
  const freshness = seatAwarenessExcerptFreshness(assessment, input);
  return {
    text,
    freshness,
    // The age is the window's own capture time: when this screen text existed.
    label:
      freshness === "current"
        ? SEAT_AWARENESS_EXCERPT_LABEL
        : `${SEAT_AWARENESS_EXCERPT_LABEL} (last observed at ${formatSeatAwarenessAge(
            input.now - assessment.evidence.capturedAt,
          )})`,
  };
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
    controlState: control.state,
  });
  // A judgment exists exactly when the availability is one of the two judged
  // states — one source of truth for "did the model actually answer".
  const judgment =
    assessment !== undefined &&
    (availability === "current" || availability === "stale")
      ? assessment
      : undefined;
  const judgmentFreshness: SeatAwarenessJudgmentFreshness | null = judgment
    ? availability === "stale"
      ? "stale"
      : "current"
    : null;

  const activityLabel = judgment?.activity
    ? SEAT_AWARENESS_ACTIVITY_COPY[judgment.activity]
    : null;
  const concerns = judgment?.concerns ?? [];
  const concernTexts = concerns.map((concern) => SEAT_AWARENESS_CONCERN_COPY[concern]);
  const aiLabel = concernTexts[0] ?? activityLabel ?? null;

  const excerptDisplay = judgment
    ? resolveExcerptDisplay(judgment, {
        now: input.now,
        windowDigest: input.windowDigest,
      })
    : null;
  const excerpt = excerptDisplay?.text ?? null;
  const excerptFreshness = excerptDisplay?.freshness ?? null;
  const excerptLabel = excerptDisplay?.label ?? null;

  const freshness = judgment
    ? `${SEAT_AWARENESS_ATTRIBUTION}, ${
        judgmentFreshness === "stale" ? "last observed" : "observed"
      } ${formatSeatAwarenessAge(input.now - judgment.observedAt)}`
    : null;

  const availabilityLine =
    availability === "unavailable"
      ? (assessment?.unavailableReason
          ? SEAT_AWARENESS_UNAVAILABLE_COPY[assessment.unavailableReason]
          : SEAT_AWARENESS_UNAVAILABLE_FALLBACK)
      : SEAT_AWARENESS_NEUTRAL_LINE;

  const sentenceParts: string[] = [aiLabel ?? control.label];
  if (excerpt && excerptLabel) {
    sentenceParts.push(`${excerptLabel}: '${excerpt}'`);
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
    judgmentFreshness,
    excerpt,
    excerptFreshness,
    excerptLabel,
    freshness,
    availabilityLine,
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
