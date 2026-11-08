/**
 * Needs, and where each sits on the one urgency ladder (`wire/urgency.ts`).
 *
 * Urgency belongs to a need, not to a raw signal: a retry and a hard usage
 * limit are both rate problems, and only one needs anyone. Every surface
 * (occupancy, region rollup, operator feed, desktop notifications) projects
 * from `NEED_CAUSES` instead of keeping its own ordering.
 *
 * Rules:
 * - Awareness alone never lifts a need above `escalated`.
 * - Fidelity changes the confidence a surface shows, never the urgency.
 * - `actor: "junto"` marks needs a feature may resolve on its own (wake at
 *   reset, fail over, restart), so automation sits on the same ladder without
 *   paging the operator.
 */
import { Schema } from "effect";
import { compareUrgency, Level, rankOf, UrgencyLevel, UrgencyRank } from "../wire/urgency";
import type { AwarenessReading, SeatSnapshot } from "./status";
import { SignalSource } from "./signal";

export const NeedActor = Schema.Literals(["operator", "junto", "none"]);
export type NeedActor = typeof NeedActor.Type;

/** Every cause of a need, its level on the ladder and who acts. */
export const NEED_CAUSES = {
  permission: { level: Level.waiting, actor: "operator" },
  question: { level: Level.waiting, actor: "operator" },
  dialog: { level: Level.waiting, actor: "operator" },
  seat_blocked: { level: Level.blocked, actor: "operator" },

  usage_limit: { level: Level.stopped, actor: "operator" },
  auth_error: { level: Level.stopped, actor: "operator" },
  crash: { level: Level.stopped, actor: "operator" },
  unexpected_exit: { level: Level.stopped, actor: "operator" },

  seat_escalated: { level: Level.escalated, actor: "operator" },
  awareness_waiting: { level: Level.escalated, actor: "operator" },
  awareness_approval: { level: Level.escalated, actor: "operator" },
  awareness_answer: { level: Level.escalated, actor: "operator" },

  seat_feedback: { level: Level.review, actor: "operator" },
  turn_unseen: { level: Level.done, actor: "operator" },
  turn_failed: { level: Level.done, actor: "operator" },

  retrying: { level: Level.degraded, actor: "none" },
  usage_limit_waking: { level: Level.degraded, actor: "junto" },
  /** The harness resumes at the reset by itself; nobody needs to act. */
  usage_limit_resuming: { level: Level.degraded, actor: "none" },
  stalled: { level: Level.degraded, actor: "junto" },
  awareness_stuck: { level: Level.degraded, actor: "none" },
  awareness_looping: { level: Level.degraded, actor: "none" },
  awareness_thrashing: { level: Level.degraded, actor: "none" },
  awareness_confused: { level: Level.degraded, actor: "none" },
  awareness_overwhelmed: { level: Level.degraded, actor: "none" },
  awareness_access: { level: Level.degraded, actor: "none" },
  awareness_error: { level: Level.degraded, actor: "none" },

  starting: { level: Level.working, actor: "none" },
  working: { level: Level.working, actor: "none" },
  compacting: { level: Level.working, actor: "none" },

  idle: { level: Level.resting, actor: "none" },
  exited: { level: Level.offline, actor: "none" },
  unknown: { level: Level.offline, actor: "none" },
} as const satisfies Record<string, { readonly level: UrgencyLevel; readonly actor: NeedActor }>;

export type NeedCause = keyof typeof NEED_CAUSES;
export const NeedCause = Schema.Literals(Object.keys(NEED_CAUSES) as [NeedCause, ...NeedCause[]]);

export const Need = Schema.Struct({
  cause: NeedCause,
  level: UrgencyLevel,
  urgency: UrgencyRank,
  actor: NeedActor,
  since: Schema.Number,
  source: SignalSource,
  /** Present on awareness needs, which are advisory. */
  probability: Schema.optionalKey(Schema.Number),
});
export type Need = typeof Need.Type;

const need = (
  cause: NeedCause,
  since: number,
  source: SignalSource,
  probability?: number,
): Need => {
  const entry = NEED_CAUSES[cause];
  return {
    cause,
    level: entry.level,
    urgency: rankOf(entry.level),
    actor: entry.actor,
    since,
    source,
    ...(probability === undefined ? {} : { probability }),
  };
};

const statusNeed = (snapshot: SeatSnapshot): Need => {
  const { status, since, statusSource } = snapshot;
  switch (status._tag) {
    case "Starting":
      return need("starting", since, statusSource);
    case "Idle":
      return need("idle", since, statusSource);
    case "Unknown":
      return need("unknown", since, statusSource);
    case "Exited":
      return need(status.expected === false ? "unexpected_exit" : "exited", since, statusSource);
    case "Working":
      if (status.phase === "retrying") return need("retrying", since, statusSource);
      if (status.phase === "compacting") return need("compacting", since, statusSource);
      return need("working", since, statusSource);
    case "Blocked":
      switch (status.reason._tag) {
        case "Permission":
          return need("permission", since, statusSource);
        case "Question":
          return need("question", since, statusSource);
        case "Dialog":
          return need("dialog", since, statusSource);
        case "UsageLimit":
          if (status.reason.autoResume === true) return need("usage_limit_resuming", since, statusSource);
          return need(snapshot.wakeAt === undefined ? "usage_limit" : "usage_limit_waking", since, statusSource);
        case "Error":
          return need(status.reason.kind === "auth" ? "auth_error" : "crash", since, statusSource);
      }
  }
};

const AWARENESS_CAUSE: Readonly<Record<string, NeedCause>> = {
  "health:waiting_on_operator": "awareness_waiting",
  "health:stuck": "awareness_stuck",
  "health:looping": "awareness_looping",
  "health:thrashing": "awareness_thrashing",
  "health:confused": "awareness_confused",
  "health:overwhelmed": "awareness_overwhelmed",
  "concern:approval_requested": "awareness_approval",
  "concern:answer_requested": "awareness_answer",
  "concern:access_problem": "awareness_access",
  "concern:execution_error": "awareness_error",
  "concern:repetition": "awareness_looping",
};

const awarenessNeed = (reading: AwarenessReading): Need | undefined => {
  const cause = AWARENESS_CAUSE[`${reading.answer.axis}:${reading.answer.value}`];
  return cause === undefined ? undefined : need(cause, reading.since, "awareness", reading.probability);
};

const REPORT_CAUSE = {
  blocked: "seat_blocked",
  escalate: "seat_escalated",
  feedback: "seat_feedback",
} as const satisfies Record<SeatSnapshot["reports"][number]["kind"], NeedCause>;

/**
 * Every current need of a seat, most urgent first, one per cause. Ties keep
 * the older need first.
 */
export const deriveNeeds = (snapshot: SeatSnapshot): readonly Need[] => {
  const needs: Need[] = [statusNeed(snapshot)];
  for (const report of snapshot.reports) needs.push(need(REPORT_CAUSE[report.kind], report.since, "seat"));
  for (const reading of snapshot.awareness) {
    const derived = awarenessNeed(reading);
    if (derived) needs.push(derived);
  }
  if (snapshot.turnUnseen && !isStopped(snapshot)) {
    needs.push(
      need(snapshot.turnUnseen.outcome === "failed" ? "turn_failed" : "turn_unseen", snapshot.turnUnseen.since, snapshot.statusSource),
    );
  }
  if (snapshot.stalledSince !== undefined && snapshot.status._tag !== "Exited") {
    needs.push(need("stalled", snapshot.stalledSince, "system"));
  }
  const byCause = new Map<NeedCause, Need>();
  for (const entry of needs) {
    const held = byCause.get(entry.cause);
    if (!held || entry.since < held.since) byCause.set(entry.cause, entry);
  }
  return [...byCause.values()].sort((a, b) => compareUrgency(a.level, b.level) || a.since - b.since);
};

const isStopped = (snapshot: SeatSnapshot): boolean =>
  snapshot.status._tag === "Blocked" &&
  (snapshot.status.reason._tag === "UsageLimit" || snapshot.status.reason._tag === "Error");

/** The need a seat's ring, rollup and notification show. */
export const topNeed = (snapshot: SeatSnapshot): Need => deriveNeeds(snapshot)[0] ?? statusNeed(snapshot);
