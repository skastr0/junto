/**
 * Needs and the one urgency ladder.
 *
 * Urgency belongs to a need, not to a raw signal: a retry and a hard usage
 * limit are both rate problems, and only one needs anyone. Every surface
 * (occupancy, region rollup, operator feed, desktop notifications) projects
 * from `NEED_CAUSES` instead of keeping its own ordering.
 *
 * Rules:
 * - Awareness alone never lifts a need above `escalated` (4).
 * - Fidelity changes the confidence a surface shows, never the urgency.
 * - `actor: "junto"` marks needs a feature may resolve on its own (wake at
 *   reset, fail over, restart), so automation sits on the same ladder without
 *   paging the operator.
 */
import { Schema } from "effect";
import type { AwarenessReading, SeatSnapshot } from "./status";
import type { SignalSource } from "./signal";

export const NEED_LEVELS = ["idle", "working", "degraded", "ready", "escalated", "stopped", "waiting"] as const;
export const NeedLevel = Schema.Literals(NEED_LEVELS);
export type NeedLevel = typeof NeedLevel.Type;

/** 0 idle .. 6 waiting on the operator. */
export const NEED_URGENCY: Readonly<Record<NeedLevel, number>> = {
  idle: 0,
  working: 1,
  degraded: 2,
  ready: 3,
  escalated: 4,
  stopped: 5,
  waiting: 6,
};

export const NeedActor = Schema.Literals(["operator", "junto", "none"]);
export type NeedActor = typeof NeedActor.Type;

/** Every cause of a need, its level and who acts. The single urgency table. */
export const NEED_CAUSES = {
  permission: { level: "waiting", actor: "operator" },
  question: { level: "waiting", actor: "operator" },
  dialog: { level: "waiting", actor: "operator" },
  seat_blocked: { level: "waiting", actor: "operator" },

  usage_limit: { level: "stopped", actor: "operator" },
  auth_error: { level: "stopped", actor: "operator" },
  crash: { level: "stopped", actor: "operator" },
  unexpected_exit: { level: "stopped", actor: "operator" },

  seat_escalated: { level: "escalated", actor: "operator" },
  awareness_waiting: { level: "escalated", actor: "operator" },
  awareness_approval: { level: "escalated", actor: "operator" },
  awareness_answer: { level: "escalated", actor: "operator" },

  seat_feedback: { level: "ready", actor: "operator" },
  turn_unseen: { level: "ready", actor: "operator" },
  turn_failed: { level: "ready", actor: "operator" },

  retrying: { level: "degraded", actor: "none" },
  usage_limit_waking: { level: "degraded", actor: "junto" },
  stalled: { level: "degraded", actor: "junto" },
  awareness_stuck: { level: "degraded", actor: "none" },
  awareness_looping: { level: "degraded", actor: "none" },
  awareness_thrashing: { level: "degraded", actor: "none" },
  awareness_confused: { level: "degraded", actor: "none" },
  awareness_overwhelmed: { level: "degraded", actor: "none" },
  awareness_access: { level: "degraded", actor: "none" },
  awareness_error: { level: "degraded", actor: "none" },

  starting: { level: "working", actor: "none" },
  working: { level: "working", actor: "none" },
  compacting: { level: "working", actor: "none" },

  idle: { level: "idle", actor: "none" },
  exited: { level: "idle", actor: "none" },
  unknown: { level: "idle", actor: "none" },
} as const satisfies Record<string, { readonly level: NeedLevel; readonly actor: NeedActor }>;

export type NeedCause = keyof typeof NEED_CAUSES;
export const NeedCause = Schema.Literals(Object.keys(NEED_CAUSES) as [NeedCause, ...NeedCause[]]);

export interface Need {
  readonly cause: NeedCause;
  readonly level: NeedLevel;
  readonly urgency: number;
  readonly actor: NeedActor;
  readonly since: number;
  readonly source: SignalSource;
  /** Present on awareness needs, which are advisory. */
  readonly probability?: number;
}

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
    urgency: NEED_URGENCY[entry.level],
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
      return need(status.expected ? "exited" : "unexpected_exit", since, statusSource);
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
  return [...byCause.values()].sort((a, b) => b.urgency - a.urgency || a.since - b.since);
};

const isStopped = (snapshot: SeatSnapshot): boolean =>
  snapshot.status._tag === "Blocked" &&
  (snapshot.status.reason._tag === "UsageLimit" || snapshot.status.reason._tag === "Error");

/** The need a seat's ring, rollup and notification show. */
export const topNeed = (snapshot: SeatSnapshot): Need => deriveNeeds(snapshot)[0] ?? statusNeed(snapshot);
