/**
 * AI-driven seat state — the refinement the subsystem exists for.
 *
 * The deterministic engine answers one question well: is this seat idle, working,
 * or waiting on a human, judged from the screen. It cannot say WHICH human
 * decision is pending, whether a seat is looping on the same failure, whether an
 * access problem is the obstacle, or what a working seat is actually doing. Those
 * are the judgments the model makes, and this module turns them into seat state.
 *
 * This is a DRIVER, not a decoration: the state below is the seat's state for
 * display and for the delivery veto. Two rules bound it, both measured rather
 * than cautious:
 *
 *   1. Deterministic attention always wins. A live dialog, a trust prompt, or an
 *      unreadable screen is a fact the screen proves; an AI answer that reads
 *      "actively editing" over a permission dialog must never downgrade it. The
 *      derived state carries the deterministic state's precedence and reports the
 *      AI answer as detail.
 *   2. There is no AI idle. The model never gets to say a seat is idle, because a
 *      wrong idle is the one answer that could release automation. Absence of a
 *      judgment is `null`, which means "the deterministic state is the state".
 *
 * Everything here is pure: given an assessment (and optionally the deterministic
 * state), it returns state, health, and whether the AI would HOLD a delivery.
 * It never opens one.
 */

import type { AwarenessAssessment } from "./project-result";
import type { AiActivityValue, AiConcernValue } from "./questions";
import type { AgentSeatState } from "../../../../shared/agent-seat-state";

/**
 * The expanded seat vocabulary the model can drive. Every member is a state the
 * deterministic rule packs cannot compute from chrome alone.
 */
export type AwarenessSeatState =
  | "blocked_on_access"
  | "waiting_on_approval"
  | "waiting_on_answer"
  | "error_looping"
  | "execution_failed"
  | "reviewing"
  | "editing"
  | "testing"
  | "running_command"
  | "investigating"
  | "unclear";

/** How the seat looks from the AI plane's side, in one word. */
export type AwarenessSeatHealth =
  | "attention"
  | "degraded"
  | "active"
  | "clear"
  | "unknown";

export type AwarenessSeatVerdict = {
  /** `null` means no judgment: the deterministic state is the state. */
  readonly state: AwarenessSeatState | null;
  readonly health: AwarenessSeatHealth;
  /** The raised concern that drove the state, when one did. */
  readonly concern: AiConcernValue | null;
  /** Lines the driving concern rests on, resolved against its own observation. */
  readonly evidenceLineIds: readonly string[];
  /**
   * The AI would hold a delivery closed. Fail-closed by construction: a wrong
   * hold costs a delayed prompt, while a wrong release would type into a dialog.
   * This is an input to the delivery gate, never a substitute for it.
   */
  readonly holdDelivery: boolean;
  /**
   * True when the deterministic state is attention and the AI answer is shown as
   * detail instead of taking the seat: the screen is the authority on that case.
   */
  readonly deterministicWins: boolean;
  /** Why this state, in words a test can assert. */
  readonly reason: string;
};

/** Concern precedence. The first raised concern in this order drives the state. */
const CONCERN_PRECEDENCE: ReadonlyArray<
  readonly [AiConcernValue, AwarenessSeatState]
> = [
  ["access_problem", "blocked_on_access"],
  ["approval_requested", "waiting_on_approval"],
  ["answer_requested", "waiting_on_answer"],
  ["execution_error", "execution_failed"],
];

/** Activity value to seat state. The value vocabulary is the pack's own. */
const ACTIVITY_STATES: Readonly<
  Partial<Record<AiActivityValue, AwarenessSeatState>>
> = {
  reviewing: "reviewing",
  editing: "editing",
  testing: "testing",
  running_command: "running_command",
  investigating: "investigating",
  // `reporting` is a finished turn presenting its answer: the seat is done
  // working and the operator has not looked yet, which the control plane
  // already expresses as idle plus unseen. It drives no new state.
};

const HEALTH_FOR_STATE: Readonly<Record<AwarenessSeatState, AwarenessSeatHealth>> = {
  blocked_on_access: "attention",
  waiting_on_approval: "attention",
  waiting_on_answer: "attention",
  error_looping: "degraded",
  execution_failed: "degraded",
  reviewing: "active",
  editing: "active",
  testing: "active",
  running_command: "active",
  investigating: "active",
  unclear: "unknown",
};

/** States where the AI would hold a delivery closed. */
const HOLDING_STATES: ReadonlySet<AwarenessSeatState> = new Set([
  "blocked_on_access",
  "waiting_on_approval",
  "waiting_on_answer",
  "error_looping",
]);

const concernIds = (assessment: AwarenessAssessment): ReadonlySet<AiConcernValue> =>
  new Set(assessment.concerns.map((concern) => concern.concern));

const repetitionIsYes = (assessment: AwarenessAssessment): boolean =>
  assessment.concerns.some((concern) => concern.concern === "repetition");

const raisedConcern = (
  assessment: AwarenessAssessment,
): { readonly concern: AiConcernValue; readonly evidenceLineIds: readonly string[] } | null => {
  const raised = concernIds(assessment);
  for (const [concern] of CONCERN_PRECEDENCE) {
    if (!raised.has(concern)) continue;
    const projection = assessment.concerns.find((entry) => entry.concern === concern);
    return { concern, evidenceLineIds: projection?.evidenceLineIds ?? [] };
  }
  return null;
};

/**
 * Derive the seat state from one assessment.
 *
 * `deterministicState` is the control plane's published state for the same seat.
 * When it is `attention` the derived state is still reported (the AI knows what
 * it saw) but `deterministicWins` is true and `state` is null, so a consumer
 * cannot accidentally replace a proven dialog with an AI guess. `holdDelivery`
 * stays true either way: holding is always safe.
 */
export const awarenessSeatVerdict = (
  assessment: AwarenessAssessment,
  deterministicState?: AgentSeatState,
): AwarenessSeatVerdict => {
  const noJudgment = (reason: string): AwarenessSeatVerdict => ({
    state: null,
    health: "unknown",
    concern: null,
    evidenceLineIds: [],
    holdDelivery: false,
    deterministicWins: false,
    reason,
  });

  if (assessment.availability !== "current") {
    return noJudgment(`no judgment: availability is ${assessment.availability}`);
  }

  const concern = raisedConcern(assessment);
  let state: AwarenessSeatState | null = null;
  let evidenceLineIds: readonly string[] = [];
  let reason = "";

  if (concern !== null) {
    const mapped =
      concern.concern === "execution_error" && repetitionIsYes(assessment)
        ? "error_looping"
        : (CONCERN_PRECEDENCE.find(([name]) => name === concern.concern)?.[1] ??
          "execution_failed");
    state = mapped;
    evidenceLineIds = concern.evidenceLineIds;
    reason =
      mapped === "error_looping"
        ? "execution_error raised and the model reads the attempts as repeats"
        : `concern raised: ${concern.concern}`;
  } else {
    const winner = assessment.activity.signals[0];
    const mapped = winner ? ACTIVITY_STATES[winner.value] : undefined;
    if (winner && mapped) {
      state = mapped;
      reason = `activity accepted: ${winner.value}`;
    } else if (assessment.activity.value === "indeterminate") {
      state = "unclear";
      reason = `no activity property accepted (${assessment.activity.reason})`;
    }
  }

  if (state === null) {
    // Nothing raised and no activity: a decisive negative is a clear seat, which
    // is a real answer rather than an absence of one.
    const cleared = assessment.negatives.some((negative) => !negative.crossCheckOnly);
    return {
      state: null,
      health: cleared ? "clear" : "unknown",
      concern: null,
      evidenceLineIds: [],
      holdDelivery: false,
      deterministicWins: false,
      reason: cleared
        ? "nothing raised and concerns were decisively ruled out"
        : "no concern and no accepted activity",
    };
  }

  const holdDelivery = HOLDING_STATES.has(state);
  const deterministicWins = deterministicState === "attention";
  // A seat can be clear about concerns while its activity stays unreadable: the
  // two facts are independent, so `unclear` activity plus ruled-out concerns
  // reports the state as unclear and the health as clear rather than forcing one
  // to stand for both.
  const cleared = assessment.negatives.some((negative) => !negative.crossCheckOnly);
  const health: AwarenessSeatHealth =
    cleared && state === "unclear" ? "clear" : HEALTH_FOR_STATE[state];
  return {
    // A proven dialog outranks an AI reading of the same screen. The AI's answer
    // is still carried (concern, reason, hold), so nothing is thrown away.
    state: deterministicWins ? null : state,
    health: deterministicWins ? "attention" : health,
    concern: concern?.concern ?? null,
    evidenceLineIds,
    holdDelivery,
    deterministicWins,
    reason: deterministicWins
      ? `deterministic attention wins; ai reads ${state}`
      : reason,
  };
};

/** Every state this plane can drive, for tests and for surfaces that list them. */
export const AWARENESS_SEAT_STATES: readonly AwarenessSeatState[] = [
  "blocked_on_access",
  "waiting_on_approval",
  "waiting_on_answer",
  "error_looping",
  "execution_failed",
  "reviewing",
  "editing",
  "testing",
  "running_command",
  "investigating",
  "unclear",
];
