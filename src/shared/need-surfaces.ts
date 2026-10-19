/**
 * Needs projected onto each surface's own vocabulary.
 *
 * One table per surface from a need's cause to the value that surface shows,
 * `null` where the surface does not show that need, and the places where a
 * surface's own order disagrees with the one urgency ladder
 * (`wire/urgency.ts`), computed rather than written down.
 *
 * The region rollup reads `ROLLUP_FROM_NEED` (region-rollups.ts), occupancy
 * `OCCUPANCY_FROM_NEED` (occupancy/derive.ts), the operator feed
 * `FEED_FROM_NEED` (operator-feed.ts) and desktop notifications
 * `NOTIFY_FROM_NEED` (through `notifyNeed`). Pure: no I/O, no clock.
 */
import type { OccupancySpectrum } from "./occupancy/derive";
import { feedItemRank, type FeedItemKind } from "./wire/operator-feed";
import type { NotifyCategory } from "./desktop-notifications";
import { NEED_CAUSES, type Need, type NeedCause } from "./harness-domain/need";
import { MemberSeverity, rankOf, worstOf, type UrgencyLevel, type UrgencyRank } from "./wire/urgency";

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
 * says a seat was never occupied. A map by cause, not a view of the ladder:
 * occupancy splits levels the ladder keeps whole (a stop reads
 * activity_blocked but an unexpected exit gone, a retry working but a stall
 * stalled, an unknown state idle but an exit gone). Its order is the
 * ladder's all the same, since it shows the most urgent need it has a value
 * for.
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
  usage_limit_resuming: "stalled",
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

/**
 * Region rollup member tier: each cause's level read through the MemberSeverity
 * view, except the needs the rollup does not show. A wake or resume at the
 * reset and a stall are the seat's own business until they become something
 * else, and the AI's advisory readings never reach a region.
 */
const ROLLUP_HIDES: ReadonlySet<NeedCause> = new Set<NeedCause>([
  "usage_limit_waking",
  "usage_limit_resuming",
  "stalled",
  "awareness_stuck",
  "awareness_looping",
  "awareness_thrashing",
  "awareness_confused",
  "awareness_overwhelmed",
  "awareness_access",
  "awareness_error",
]);

/** One value per cause, from a rule. */
const byCause = <V extends string>(value: (cause: NeedCause) => V | null): NeedProjection<V> => {
  const projection = {} as Record<NeedCause, V | null>;
  for (const cause of Object.keys(NEED_CAUSES) as NeedCause[]) projection[cause] = value(cause);
  return projection;
};

export const ROLLUP_FROM_NEED = byCause((cause) =>
  ROLLUP_HIDES.has(cause) ? null : MemberSeverity.groupOf(NEED_CAUSES[cause].level),
);

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
  usage_limit_resuming: null,
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
  usage_limit_resuming: null,
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
  readonly level: UrgencyLevel;
  readonly urgency: UrgencyRank;
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
 * which outranks feedback (review), and a declared block and a stop outrank
 * a dialog. Undefined for a need that never pings.
 */
export const notifyNeed = (
  cause: NeedCause,
): { readonly category: NotifyCategory; readonly level: UrgencyLevel } | undefined => {
  const category = NOTIFY_FROM_NEED[cause];
  return category === null ? undefined : { category, level: NEED_CAUSES[cause].level };
};

// ── Each surface's own order ──────────────────────────────────────────────

const urgencyOf = (cause: NeedCause): number => rankOf(NEED_CAUSES[cause].level);

/**
 * A value's rank on a surface that shows the most urgent need it has a value
 * for (`projectNeeds`): the rank of the most urgent cause behind it.
 */
const worstCauseRank = <V extends string>(projection: NeedProjection<V>) => (value: string): number | undefined => {
  const causes = (Object.keys(projection) as NeedCause[]).filter((cause) => projection[cause] === value);
  const worst = worstOf(causes.map((cause) => NEED_CAUSES[cause].level));
  return worst === undefined ? undefined : rankOf(worst);
};

export type NeedSurface = "occupancy" | "rollup" | "feed" | "notify";

/**
 * How each surface ranks what it shows today. Higher is more urgent;
 * `undefined` for a value outside the surface's ladder. Notifications rank
 * by the need's level (product-lead, 2026-10-17), not by category.
 */
export const SURFACE_RANK: Readonly<Record<NeedSurface, (value: string, cause: NeedCause) => number | undefined>> = {
  // Gone is the process's absence, which no need ranks; vacancy says it too.
  occupancy: (value) => (value === "gone" ? undefined : worstCauseRank(OCCUPANCY_FROM_NEED)(value)),
  rollup: (value) => {
    const group = MemberSeverity.groups.find((tier) => tier === value);
    return group === undefined ? undefined : rankOf(MemberSeverity.topOf(group));
  },
  feed: (value) => feedItemRank(value as FeedItemKind),
  notify: (_value, cause) => urgencyOf(cause),
};

/**
 * Whose call each surface's order is, and where it stands. `ladder`: the
 * surface follows the need ladder, and `accepted` lists the disagreements
 * left (as `ladderDisagreements` names them) with why they stand.
 * Notifications keep `needsYou` across three levels and order inside it by
 * level, so they list none. `open`: not yet decided.
 */
export const SURFACE_ORDER: Readonly<
  Record<
    NeedSurface,
    {
      readonly order: "ladder" | "open";
      readonly owner: string;
      readonly accepted: ReadonlyArray<{ readonly disagreement: string; readonly why: string }>;
    }
  >
> = {
  feed: {
    order: "ladder",
    owner: "product-feed",
    accepted: [],
  },
  notify: { order: "ladder", owner: "product-attention", accepted: [] },
  rollup: {
    order: "ladder",
    owner: "canvas-lead",
    accepted: [
      { disagreement: "merged blocked > blocked", why: "the blocked tier holds a declared block and a stop together, one group in the MemberSeverity view" },
      { disagreement: "merged ready > ready", why: "the ready tier asks for a glance either way: review and done are one group in the MemberSeverity view" },
      { disagreement: "merged working > working", why: "a retrying seat is still at work; the rollup has no degraded tier" },
      { disagreement: "merged idle > idle", why: "resting and offline seats are calm alike, one idle group in the MemberSeverity view" },
    ],
  },
  occupancy: {
    order: "ladder",
    owner: "canvas-lead",
    accepted: [
      { disagreement: "merged working > working", why: "a retrying seat reads working, since it is still at work; occupancy's only degraded state is a stall" },
      { disagreement: "merged idle > idle", why: "a seat in an unknown state shows idle, since occupancy has no offline state; an exited seat reads gone" },
    ],
  },
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
    status: "decided",
    decided: "canvas-lead 2026-10-17: occupancy reads OCCUPANCY_FROM_NEED (93ed70f5d)",
  },
  { surface: "occupancy", causes: ["usage_limit_waking"], before: "not modelled", status: "decided", decided: "canvas-lead 2026-10-17: occupancy reads OCCUPANCY_FROM_NEED (93ed70f5d)" },
  { surface: "occupancy", causes: ["starting"], before: "idle (seat state unknown)", status: "decided", decided: "canvas-lead 2026-10-17: occupancy reads OCCUPANCY_FROM_NEED (93ed70f5d)" },
  {
    surface: "rollup",
    causes: ["seat_blocked", "seat_escalated", "seat_feedback"],
    before: "not shown: declared signals never reach the rollup",
    status: "decided",
    decided: "canvas-lead 2026-10-17: the rollup reads ROLLUP_FROM_NEED (fab41b592)",
  },
  { surface: "rollup", causes: ["usage_limit", "auth_error", "crash", "unexpected_exit"], before: "idle", status: "decided", decided: "canvas-lead 2026-10-17: the rollup reads ROLLUP_FROM_NEED (fab41b592)" },
  { surface: "rollup", causes: ["starting"], before: "idle (seat state unknown)", status: "decided", decided: "canvas-lead 2026-10-17: the rollup reads ROLLUP_FROM_NEED (fab41b592)" },
  {
    surface: "rollup",
    causes: ["awareness_waiting", "awareness_approval", "awareness_answer"],
    before: "not shown: the AI's reading never reached the rollup",
    status: "decided",
    decided: "pty-lead 2026-10-17: the rollup's escalated tier holds them, with a declared escalation",
  },
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
