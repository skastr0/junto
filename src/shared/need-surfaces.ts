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
 * Nothing reads this yet. Pure: no I/O, no clock.
 */
import type { MemberSeverity } from "./region-rollup";
import { MemberSeverity as MemberSeveritySchema } from "./region-rollup";
import type { OccupancySpectrum } from "./occupancy/derive";
import { FEED_URGENCY, type FeedItemKind } from "./wire/operator-feed";
import { NOTIFY_CATEGORIES, type NotifyCategory } from "./desktop-notifications";
import { NEED_CAUSES, NEED_URGENCY, type Need, type NeedCause } from "./harness-domain/need";

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
 * waiting on the operator: listed, never counted.
 */
export const FEED_FROM_NEED: NeedProjection<FeedItemKind> = {
  permission: "attention",
  question: "attention",
  dialog: "attention",
  seat_blocked: "blocked",

  usage_limit: null,
  auth_error: null,
  crash: null,
  unexpected_exit: null,

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
  awareness_access: "health",
  awareness_error: null,

  starting: null,
  working: null,
  compacting: null,

  idle: null,
  exited: null,
  unknown: null,
};

/** Desktop notification category. Advisory readings never ping. */
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

// ── Each surface's own order ──────────────────────────────────────────────

/** Occupancy's first-match order for a bound seat, worst first (`derive.ts`). */
export const OCCUPANCY_LADDER = ["activity_blocked", "attention", "stalled", "working", "idle"] as const;

const rankFrom = <V extends string>(worstFirst: readonly V[]): ((value: V) => number | undefined) => {
  const ranks = new Map(worstFirst.map((value, index) => [value, worstFirst.length - index]));
  return (value) => ranks.get(value);
};

export type NeedSurface = "occupancy" | "rollup" | "feed" | "notify";

/** Higher is more urgent; `undefined` for a value outside the surface's ladder. */
export const SURFACE_RANK: Readonly<Record<NeedSurface, (value: string) => number | undefined>> = {
  occupancy: rankFrom<string>(OCCUPANCY_LADDER),
  rollup: rankFrom<string>(MemberSeveritySchema.literals),
  feed: (value) => FEED_URGENCY[value as FeedItemKind],
  notify: rankFrom<string>(NOTIFY_CATEGORIES),
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

const urgencyOf = (cause: NeedCause): number => NEED_URGENCY[NEED_CAUSES[cause].level];

/** Every disagreement between a surface's own order and the need ladder. */
export const ladderDisagreements = (surface: NeedSurface): readonly LadderDisagreement[] => {
  const projection = SURFACE_PROJECTION[surface];
  const rank = SURFACE_RANK[surface];
  const shown = (Object.keys(projection) as NeedCause[]).flatMap((cause) => {
    const value = projection[cause];
    const valueRank = value === null ? undefined : rank(value);
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
 * Needs a surface shows differently from today once it projects from needs,
 * beyond the order disagreements above. `today` says what the surface does
 * now for a seat with that need.
 */
export const SURFACE_CHANGES: ReadonlyArray<{
  readonly surface: NeedSurface;
  readonly causes: readonly NeedCause[];
  readonly today: string;
}> = [
  {
    surface: "occupancy",
    causes: ["usage_limit", "auth_error", "crash"],
    today: "never produced: no seat state maps to activity_blocked, so these read as whatever the screen showed",
  },
  { surface: "occupancy", causes: ["usage_limit_waking"], today: "not modelled" },
  { surface: "occupancy", causes: ["starting"], today: "idle (seat state unknown)" },
  { surface: "rollup", causes: ["seat_blocked", "seat_escalated", "seat_feedback"], today: "not shown: declared signals never reach the rollup" },
  { surface: "rollup", causes: ["usage_limit", "auth_error", "crash", "unexpected_exit"], today: "idle" },
  { surface: "rollup", causes: ["starting"], today: "idle (seat state unknown)" },
  { surface: "notify", causes: ["usage_limit", "auth_error", "crash"], today: "not posted: failed is raised only by a failure exit" },
];
