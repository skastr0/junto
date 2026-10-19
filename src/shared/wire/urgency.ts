/**
 * Seat urgency: the one ladder, and every view of it.
 *
 * This file is the only place an urgency order lives. A level, a rank, a
 * view's group: each is a branded Effect Schema value minted here, so a bare
 * string or number never stands in for one. tests/urgency-law.test.ts fails on
 * any order, rank or severity table declared anywhere else.
 *
 * The ladder, most urgent first:
 *
 *   blocked    a seat declared a blocker
 *   stopped    a usage limit, a sign-in error, a crash, an unexpected exit
 *   waiting    a proven dialog: permission, question, dialog
 *   escalated  a declared escalation; the AI reading the operator as awaited
 *   review     a seat asked to have its work reviewed
 *   done       a turn settled and nobody has read it
 *   degraded   retrying, stalled, the AI's advisory readings
 *   working    in flight
 *   resting    idle
 *   offline    exited, unknown, not running
 *
 * The rank is the ladder as a number, higher more urgent (9 blocked, 0
 * offline), the direction every wire already speaks. compareUrgency compares
 * urgency only; each caller names its own tie rule.
 *
 * Imports nothing but effect and sibling wire modules, so the phone syncs it.
 */
import { type Brand, Schema } from "effect";
import type { AgentSignalKind } from "./agent-signals";
import type { FeedItemKind } from "./operator-feed";
import type { RingForm } from "./rings";

const LADDER = [
  "blocked",
  "stopped",
  "waiting",
  "escalated",
  "review",
  "done",
  "degraded",
  "working",
  "resting",
  "offline",
] as const;
type LadderName = (typeof LADDER)[number];

export const UrgencyLevel = Schema.Literals(LADDER).pipe(Schema.brand("UrgencyLevel"));
export type UrgencyLevel = typeof UrgencyLevel.Type;

/** Higher is more urgent: 9 blocked .. 0 offline. The only urgency number. */
export const UrgencyRank = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: LADDER.length - 1 })).pipe(
  Schema.brand("UrgencyRank"),
);
export type UrgencyRank = typeof UrgencyRank.Type;

type LevelNamed<K extends LadderName> = Extract<UrgencyLevel, K>;

/** Every level by name, minted once: how code outside this module names one. */
export const Level: { readonly [K in LadderName]: LevelNamed<K> } = Object.fromEntries(
  LADDER.map((name) => [name, UrgencyLevel.make(name)]),
) as { readonly [K in LadderName]: LevelNamed<K> };

/** Every level, most urgent first. */
export const URGENCY_LADDER: readonly UrgencyLevel[] = LADDER.map((name) => Level[name]);

const RANKS: ReadonlyMap<UrgencyLevel, UrgencyRank> = new Map(
  URGENCY_LADDER.map((level, index) => [level, UrgencyRank.make(LADDER.length - 1 - index)]),
);

export const rankOf = (level: UrgencyLevel): UrgencyRank => RANKS.get(level)!;

/** Most urgent first, for sort. Urgency only: a tie returns 0 and the caller breaks it. */
export const compareUrgency = (a: UrgencyLevel, b: UrgencyLevel): number => rankOf(b) - rankOf(a);

/** The most urgent of some levels; undefined for none. */
export const worstOf = (levels: Iterable<UrgencyLevel>): UrgencyLevel | undefined => {
  let worst: UrgencyLevel | undefined;
  for (const level of levels) if (worst === undefined || rankOf(level) > rankOf(worst)) worst = level;
  return worst;
};

/** `level` is no more urgent than `ceiling`. */
export const atMost = (level: UrgencyLevel, ceiling: UrgencyLevel): boolean => rankOf(level) <= rankOf(ceiling);

// ── Kind maps ──────────────────────────────────────────────────────────────

const SIGNAL_LEVEL = {
  blocked: Level.blocked,
  escalate: Level.escalated,
  feedback: Level.review,
} as const satisfies Record<AgentSignalKind, UrgencyLevel>;

const FEED_LEVEL = {
  blocked: Level.blocked,
  stopped: Level.stopped,
  attention: Level.waiting,
  escalate: Level.escalated,
  // The AI reading the operator as awaited ranks with a declared escalation.
  health: Level.escalated,
  feedback: Level.review,
} as const satisfies Record<FeedItemKind, UrgencyLevel>;

const RING_LEVEL = {
  halt: Level.blocked,
  call: Level.waiting,
  wait: Level.escalated,
  done: Level.done,
  glint: Level.done,
  fracture: Level.degraded,
  snake: Level.degraded,
  reverse: Level.degraded,
  work: Level.working,
  dot: Level.resting,
  live: Level.resting,
  rest: Level.resting,
  off: Level.offline,
} as const satisfies Record<RingForm, UrgencyLevel>;

/** A declared signal's level. */
export const levelOfSignal = (kind: AgentSignalKind): UrgencyLevel => SIGNAL_LEVEL[kind];
/** An operator feed item's level. */
export const levelOfFeedItem = (kind: FeedItemKind): UrgencyLevel => FEED_LEVEL[kind];
/**
 * The level a ring form stands for. A surface that knows the seat's signal or
 * need ranks from that instead; the form is what is left once it is drawn.
 */
export const levelOfRing = (form: RingForm): UrgencyLevel => RING_LEVEL[form];

/** For layout only, such as picking a cluster's lead seat: the form's level's rank. */
export const ringFormRank = (form: RingForm): UrgencyRank => rankOf(levelOfRing(form));

// ── Predicates ─────────────────────────────────────────────────────────────

/** Something waits on the operator: blocked, stopped, waiting or escalated. */
export const waitsOnOperator = (level: UrgencyLevel): boolean => !atMost(level, Level.review);

/** Work wants a look, never input: review or done. */
export const wantsLook = (level: UrgencyLevel): boolean => atMost(level, Level.review) && !atMost(level, Level.degraded);

/**
 * Either of the two: the desktop rail and step keys, and the phone's
 * CompanionCanvas.needsYou.
 */
export const needsOperator = (level: UrgencyLevel): boolean => waitsOnOperator(level) || wantsLook(level);

/**
 * The ring keeps its seat out of a cluster: halt, call and wait, the forms
 * whose level waits on the operator. The desktop cluster layer and the phone
 * read it; it is the phone's "needs you".
 */
export const ringKeepsApart = (form: RingForm): boolean => waitsOnOperator(levelOfRing(form));

// ── Views ──────────────────────────────────────────────────────────────────

/**
 * A surface's coarser reading of the ladder: groups of adjacent levels, each
 * group a branded literal of its own. Checked when the module loads: every
 * level sits in exactly one group, and every group is a run of adjacent
 * levels. A view in ladder order lists its groups most urgent first; the one
 * view with its own order (the palette) is named as such.
 */
export type UrgencyView<G extends string, B extends string> = {
  readonly name: B;
  /** The view's groups as a schema, for a surface that decodes one. */
  readonly Group: Schema.Codec<G & Brand.Brand<B>, G>;
  /** Every group by name. */
  readonly group: { readonly [K in G]: Extract<G & Brand.Brand<B>, K> };
  /** Every group, in the view's order, most urgent first. */
  readonly groups: readonly (G & Brand.Brand<B>)[];
  readonly order: "ladder" | "own";
  groupOf(level: UrgencyLevel): G & Brand.Brand<B>;
  levelsOf(group: G & Brand.Brand<B>): readonly UrgencyLevel[];
  /** The group's most urgent level. */
  topOf(group: G & Brand.Brand<B>): UrgencyLevel;
};

export type ViewGroup<V> = V extends UrgencyView<infer G, infer B> ? G & Brand.Brand<B> : never;

const defineView = <const G extends readonly [string, ...string[]], const B extends string>(
  name: B,
  names: G,
  levels: { readonly [K in G[number]]: readonly LadderName[] },
  order: "ladder" | "own" = "ladder",
): UrgencyView<G[number], B> => {
  type Group = G[number] & Brand.Brand<B>;
  const Group = Schema.Literals(names).pipe(Schema.brand(name));
  const group = Object.fromEntries(names.map((value) => [value, Group.make(value as G[number])])) as unknown as UrgencyView<G[number], B>["group"];
  const groups = names.map((value) => group[value as G[number]]) as Group[];
  const byLevel = new Map<UrgencyLevel, Group>();
  const members = new Map<Group, readonly UrgencyLevel[]>();
  let last = -1;
  for (const value of groups) {
    const listed = levels[value as G[number]];
    const indices = listed.map((level) => LADDER.indexOf(level)).sort((a, b) => a - b);
    if (indices.length === 0) throw new Error(`urgency view ${name}: ${value} holds no level`);
    for (const [at, index] of indices.entries()) {
      if (at > 0 && index !== indices[at - 1]! + 1) throw new Error(`urgency view ${name}: ${value} is not a run of adjacent levels`);
    }
    if (order === "ladder" && indices[0]! !== last + 1) throw new Error(`urgency view ${name}: ${value} is out of ladder order`);
    last = indices.at(-1)!;
    const run = indices.map((index) => URGENCY_LADDER[index]!);
    for (const level of run) {
      if (byLevel.has(level)) throw new Error(`urgency view ${name}: ${level} is in two groups`);
      byLevel.set(level, value);
    }
    members.set(value, run);
  }
  for (const level of URGENCY_LADDER) if (!byLevel.has(level)) throw new Error(`urgency view ${name}: ${level} is in no group`);
  return {
    name,
    Group: Group as unknown as UrgencyView<G[number], B>["Group"],
    group,
    groups,
    order,
    groupOf: (level) => byLevel.get(level)!,
    levelsOf: (value) => members.get(value)!,
    topOf: (value) => members.get(value)![0]!,
  };
};

/**
 * Most urgent group first, for sort. A view in ladder order compares each
 * group's top level through compareUrgency; the palette compares by its own
 * group order.
 */
export const compareView =
  <G extends string, B extends string>(view: UrgencyView<G, B>) =>
  (a: G & Brand.Brand<B>, b: G & Brand.Brand<B>): number =>
    view.order === "ladder" ? compareUrgency(view.topOf(a), view.topOf(b)) : view.groups.indexOf(a) - view.groups.indexOf(b);

/** The seat rail, the step keys and the alerts. */
export const SeatUrgency = defineView("SeatUrgency", ["blocked", "waiting", "review", "done", "working", "resting", "offline"], {
  blocked: ["blocked", "stopped"],
  waiting: ["waiting", "escalated"],
  review: ["review"],
  done: ["done"],
  working: ["degraded", "working"],
  resting: ["resting"],
  offline: ["offline"],
});

/** A region's urgency badge; calm shows nothing. */
export const RegionUrgency = defineView("RegionUrgency", ["blocked", "needs-you", "review", "calm"], {
  blocked: ["blocked", "stopped"],
  "needs-you": ["waiting", "escalated"],
  review: ["review"],
  calm: ["done", "degraded", "working", "resting", "offline"],
});

/** A region rollup member's tier. */
export const MemberSeverity = defineView("MemberSeverity", ["blocked", "attention", "escalated", "ready", "working", "idle"], {
  blocked: ["blocked", "stopped"],
  attention: ["waiting"],
  escalated: ["escalated"],
  ready: ["review", "done"],
  working: ["degraded", "working"],
  idle: ["resting", "offline"],
});

/** An in-app alert's kind; quiet raises none. */
export const AlertKind = defineView("AlertKind", ["blocked", "attention", "ready", "working", "quiet"], {
  blocked: ["blocked", "stopped"],
  attention: ["waiting", "escalated"],
  ready: ["review", "done"],
  working: ["degraded", "working"],
  quiet: ["resting", "offline"],
});

/** What a sound cue is for, loudest first. */
export const CueUrgency = defineView("CueUrgency", ["stopped", "needs-you", "ready", "moving", "chrome"], {
  stopped: ["blocked", "stopped"],
  "needs-you": ["waiting", "escalated"],
  ready: ["review", "done"],
  moving: ["degraded", "working"],
  chrome: ["resting", "offline"],
});

/** A cue that takes the one attention slot, ducking the rest: stopped or needs you. */
export const takesAttentionSlot = (group: ViewGroup<typeof CueUrgency>): boolean =>
  group === CueUrgency.group.stopped || group === CueUrgency.group["needs-you"];

/**
 * The command palette's order of agents, the one view with its own order:
 * the seat rail's groups with work in flight moved above review.
 */
export const Palette = defineView(
  "Palette",
  ["blocked", "waiting", "working", "review", "done", "resting", "offline"],
  {
    blocked: ["blocked", "stopped"],
    waiting: ["waiting", "escalated"],
    working: ["degraded", "working"],
    review: ["review"],
    done: ["done"],
    resting: ["resting"],
    offline: ["offline"],
  },
  "own",
);
