/**
 * Needs projected onto each surface's own vocabulary.
 *
 * Four surfaces keep their own urgency ladder today: occupancy
 * (`occupancy/derive.ts`), the region rollup (`region-rollup.ts`), the
 * operator feed (`FEED_URGENCY` in `wire/operator-feed.ts`) and desktop
 * notifications (`desktop-notifications.ts`). Build step 6 of
 * `docs/harness-domain.md` makes each read the one ladder in
 * `harness-domain/need.ts` instead. This module is the groundwork: one table
 * per surface from a need's cause to the value that surface shows, `null`
 * where the surface does not show that need, and the places where a surface's
 * own order disagrees with the need ladder, computed rather than written down.
 *
 * The operator feed reads `FEED_FROM_NEED` (operator-feed.ts); the other
 * tables are read by nothing yet. Pure: no I/O, no clock.
 */
import type { MemberSeverity } from "./region-rollup";
import { MemberSeverity as MemberSeveritySchema } from "./region-rollup";
import type { OccupancySpectrum } from "./occupancy/derive";
import { FEED_URGENCY, type FeedItemKind } from "./wire/operator-feed";
import { NOTIFY_CATEGORIES, type NotifyCategory } from "./desktop-notifications";
import { NEED_CAUSES, NEED_URGENCY, type Need, type NeedCause, type NeedLevel } from "./harness-domain/need";

/** A surface's value for every need cause, `null` where it does not show it. */
export type NeedProjection<V extends string> = Readonly<Record<NeedCause, V | null>>;

/**
 * What a surface shows for a seat: the most urgent need it has a value for.
 * `needs` is `deriveNeeds` output, most urgent first; a need the surface does
 * not show falls through to the next.
 */
export const projectNeeds = <V extends string>(
  needs: readonly Need[],
  projection: NeedProjection<V>,
): V | undefined => {
  for (const need of needs) {
    const value = projection[need.cause];
    if (value !== null) return value;
  }
  return undefined;
};

/**
 * Occupancy, for a bound seat. Vacancy (`empty`) is the caller's: no need
 * says a seat was never occupied.
 */
export const OCCUPANCY_FROM_NEED: NeedProjection<OccupancySpectrum> = {
  permission: "attention",
  question: "attention",
  dialog: "attention",
  seat_blocked: null,

  usage_limit: "activity_blocked",
  auth_error: "activity_blocked",
  crash: "activity_blocked",
  unexpected_exit: "gone",

  seat_escalated: null,
  awareness_waiting: null,
  awareness_approval: null,
  awareness_answer: null,

  seat_feedback: null,
  turn_unseen: null,
  turn_failed: null,

  retrying: "working",
  usage_limit_waking: "stalled",
  stalled: "stalled",
  awareness_stuck: null,
  awareness_looping: null,
  awareness_thrashing: null,
  awareness_confused: null,
  awareness_overwhelmed: null,
  awareness_access: null,
  awareness_error: null,

  starting: "working",
  working: "working",
  compacting: "working",

  idle: "idle",
  exited: "gone",
  unknown: "idle",
};

/** Region rollup member severity. */
export const ROLLUP_FROM_NEED: NeedProjection<MemberSeverity> = {
  permission: "attention",
  question: "attention",
  dialog: "attention",
  seat_blocked: "blocked",

  usage_limit: "blocked",
  auth_error: "blocked",
  crash: "blocked",
  unexpected_exit: "blocked",

  seat_escalated: "attention",
  awareness_waiting: null,
  awareness_approval: null,
  awareness_answer: null,

  seat_feedback: "ready",
  turn_unseen: "ready",
  turn_failed: "ready",

  retrying: "working",
  usage_limit_waking: null,
  stalled: null,
  awareness_stuck: null,
  awareness_looping: null,
  awareness_thrashing: null,
  awareness_confused: null,
  awareness_overwhelmed: null,
  awareness_access: null,
  awareness_error: null,

  starting: "working",
  working: "working",
  compacting: "working",

  idle: "idle",
  exited: "idle",
  unknown: "idle",
};

/**
 * Operator feed item kind. `health` is the advisory reading that a thread is
 * waiting on the operator: listed, never counted. An access problem reads
 * degraded, below anything the feed lists, so it is not shown.
 */
export const FEED_FROM_NEED: NeedProjection<FeedItemKind> = {
  permission: "attention",
  question: "attention",
  dialog: "attention",
  seat_blocked: "blocked",

  usage_limit: "stopped",
  auth_error: "stopped",
  crash: "stopped",
  unexpected_exit: "stopped",

  seat_escalated: "escalate",
  awareness_waiting: "health",
  awareness_approval: "health",
  awareness_answer: "health",

  seat_feedback: "feedback",
  turn_unseen: null,
  turn_failed: null,

  retrying: null,
  usage_limit_waking: null,
  stalled: null,
  awareness_stuck: null,
  awareness_looping: null,
  awareness_thrashing: null,
  awareness_confused: null,
  awareness_overwhelmed: null,
  awareness_access: null,
  awareness_error: null,

  starting: null,
  working: null,
  compacting: null,

  idle: null,
  exited: null,
  unknown: null,
};

/**
 * Desktop notification category. Advisory readings never ping. A category is
 * the banner's kind, label and cue; the need's ladder level ranks it (see
 * `notifyNeed`).
 */
export const NOTIFY_FROM_NEED: NeedProjection<NotifyCategory> = {
  permission: "needsYou",
  question: "needsYou",
  dialog: "needsYou",
  seat_blocked: "blocked",

  usage_limit: "failed",
  auth_error: "failed",
  crash: "failed",
  unexpected_exit: "failed",

  seat_escalated: "needsYou",
  awareness_waiting: null,
  awareness_approval: null,
  awareness_answer: null,

  seat_feedback: "needsYou",
  turn_unseen: "done",
  turn_failed: "done",

  retrying: null,
  usage_limit_waking: null,
  stalled: null,
  awareness_stuck: null,
  awareness_looping: null,
  awareness_thrashing: null,
  awareness_confused: null,
  awareness_overwhelmed: null,
  awareness_access: null,
  awareness_error: null,

  starting: null,
  working: null,
  compacting: null,

  idle: null,
  exited: null,
  unknown: null,
};

/** One need a surface shows: its value there and the ladder level that ranks it. */
export type ShownNeed<V extends string> = {
  readonly cause: NeedCause;
  readonly value: V;
  readonly level: NeedLevel;
  readonly urgency: number;
};

/**
 * Every need a surface shows, in ladder order (`needs` is `deriveNeeds`
 * output). For a surface that lists several, such as the feed.
 */
export const shownNeeds = <V extends string>(
  needs: readonly Need[],
  projection: NeedProjection<V>,
): readonly ShownNeed<V>[] =>
  needs.flatMap((need) => {
    const value = projection[need.cause];
    return value === null ? [] : [{ cause: need.cause, value, level: need.level, urgency: need.urgency }];
  });

/**
 * A need as a desktop notification: its category, and the ladder level that
 * ranks it. Notifications order by level, never by category, so inside
 * `needsYou` a proven dialog (waiting) outranks an escalation (escalated),
 * which outranks feedback (ready), and a dialog outranks a stop. Undefined
 * for a need that never pings.
 */
export const notifyNeed = (
  cause: NeedCause,
): { readonly category: NotifyCategory; readonly level: NeedLevel } | undefined => {
  const category = NOTIFY_FROM_NEED[cause];
  return category === null ? undefined : { category, level: NEED_CAUSES[cause].level };
};

// ── Each surface's own order ──────────────────────────────────────────────

/** Occupancy's first-match order for a bound seat, worst first (`derive.ts`). */
export const OCCUPANCY_LADDER = ["activity_blocked", "attention", "stalled", "working", "idle"] as const;

const urgencyOf = (cause: NeedCause): number => NEED_URGENCY[NEED_CAUSES[cause].level];

const rankFrom = <V extends string>(worstFirst: readonly V[]): ((value: V) => number | undefined) => {
  const ranks = new Map(worstFirst.map((value, index) => [value, worstFirst.length - index]));
  return (value) => ranks.get(value);
};

export type NeedSurface = "occupancy" | "rollup" | "feed" | "notify";

/**
 * How each surface ranks what it shows today. Higher is more urgent;
 * `undefined` for a value outside the surface's ladder. Notifications rank
 * by the need's level (product-lead, 2026-10-17), not by category.
 */
export const SURFACE_RANK: Readonly<Record<NeedSurface, (value: string, cause: NeedCause) => number | undefined>> = {
  occupancy: rankFrom<string>(OCCUPANCY_LADDER),
  rollup: rankFrom<string>(MemberSeveritySchema.literals),
  feed: (value) => FEED_URGENCY[value as FeedItemKind],
  notify: (_value, cause) => urgencyOf(cause),
};

/**
 * Whose call each surface's order is, and where it stands. `ladder`: the
 * surface follows the need ladder, so any disagreement left is a decided
 * kind or label (notifications keep `needsYou` across three levels and
 * order inside it by level). `open`: not yet decided.
 */
export const SURFACE_ORDER: Readonly<Record<NeedSurface, { readonly order: "ladder" | "open"; readonly owner: string }>> = {
  feed: { order: "ladder", owner: "product-feed" },
  notify: { order: "ladder", owner: "product-attention" },
  rollup: { order: "open", owner: "canvas-lead" },
  occupancy: { order: "open", owner: "canvas-lead" },
};

export const SURFACE_PROJECTION: Readonly<Record<NeedSurface, NeedProjection<string>>> = {
  occupancy: OCCUPANCY_FROM_NEED,
  rollup: ROLLUP_FROM_NEED,
  feed: FEED_FROM_NEED,
  notify: NOTIFY_FROM_NEED,
};

/**
 * One place a surface's order and the need ladder disagree.
 * - inverted: the surface ranks `above` over `below`, the ladder ranks a
 *   cause behind `above` lower than a cause behind `below`.
 * - split: the ladder ties the causes, the surface orders them.
 * - merged: the ladder orders the causes, the surface shows one value.
 */
export type LadderDisagreement = {
  readonly surface: NeedSurface;
  readonly kind: "inverted" | "split" | "merged";
  readonly above: string;
  readonly below: string;
  /** `[cause behind above, cause behind below]`, one pair per need level pair. */
  readonly causes: readonly (readonly [NeedCause, NeedCause])[];
};

/** Every disagreement between a surface's own order and the need ladder. */
export const ladderDisagreements = (surface: NeedSurface): readonly LadderDisagreement[] => {
  const projection = SURFACE_PROJECTION[surface];
  const rank = SURFACE_RANK[surface];
  const shown = (Object.keys(projection) as NeedCause[]).flatMap((cause) => {
    const value = projection[cause];
    const valueRank = value === null ? undefined : rank(value, cause);
    return value === null || valueRank === undefined ? [] : [{ cause, value, rank: valueRank }];
  });
  const found = new Map<string, { kind: LadderDisagreement["kind"]; above: string; below: string; causes: Map<string, readonly [NeedCause, NeedCause]> }>();
  const note = (kind: LadderDisagreement["kind"], above: string, below: string, pair: readonly [NeedCause, NeedCause]) => {
    const key = `${kind}:${above}:${below}`;
    const entry = found.get(key) ?? { kind, above, below, causes: new Map() };
    const levels = `${NEED_CAUSES[pair[0]].level}:${NEED_CAUSES[pair[1]].level}`;
    if (!entry.causes.has(levels)) entry.causes.set(levels, pair);
    found.set(key, entry);
  };
  for (const a of shown) {
    for (const b of shown) {
      const needA = urgencyOf(a.cause);
      const needB = urgencyOf(b.cause);
      if (a.rank > b.rank) {
        if (needA < needB) note("inverted", a.value, b.value, [a.cause, b.cause]);
        else if (needA === needB) note("split", a.value, b.value, [a.cause, b.cause]);
      } else if (a.value === b.value && needA > needB) {
        note("merged", a.value, a.value, [a.cause, b.cause]);
      }
    }
  }
  return [...found.values()].map((entry) => ({
    surface,
    kind: entry.kind,
    above: entry.above,
    below: entry.below,
    causes: [...entry.causes.values()],
  }));
};

/**
 * Needs a surface shows differently once it projects from needs, beyond the
 * order disagreements above. `before` says what the surface did for a seat
 * with that need; `decided` names who settled the change, and an open entry
 * waits on the surface's owner (`SURFACE_ORDER`).
 */
export const SURFACE_CHANGES: ReadonlyArray<{
  readonly surface: NeedSurface;
  readonly causes: readonly NeedCause[];
  readonly before: string;
  readonly status: "open" | "decided";
  readonly decided?: string;
}> = [
  {
    surface: "occupancy",
    causes: ["usage_limit", "auth_error", "crash"],
    before: "never produced: no seat state maps to activity_blocked, so these read as whatever the screen showed",
    status: "open",
  },
  { surface: "occupancy", causes: ["usage_limit_waking"], before: "not modelled", status: "open" },
  { surface: "occupancy", causes: ["starting"], before: "idle (seat state unknown)", status: "open" },
  {
    surface: "rollup",
    causes: ["seat_blocked", "seat_escalated", "seat_feedback"],
    before: "not shown: declared signals never reach the rollup",
    status: "open",
  },
  { surface: "rollup", causes: ["usage_limit", "auth_error", "crash", "unexpected_exit"], before: "idle", status: "open" },
  { surface: "rollup", causes: ["starting"], before: "idle (seat state unknown)", status: "open" },
  {
    surface: "feed",
    causes: ["usage_limit", "auth_error", "crash", "unexpected_exit"],
    before: "not listed: the feed had no stopped kind",
    status: "decided",
    decided: "product-lead 2026-10-17: a stopped kind at the ladder's stopped level",
  },
  {
    surface: "feed",
    causes: ["awareness_access"],
    before: "listed as health: the pack reads an access problem as waiting on the operator",
    status: "decided",
    decided: "product-lead 2026-10-17: the ladder's degraded, below what the feed lists",
  },
  {
    surface: "notify",
    causes: ["usage_limit", "auth_error", "crash"],
    before: "not posted: failed was raised only by a failure exit",
    status: "decided",
    decided: "product-lead 2026-10-17: these post as failed",
  },
];
