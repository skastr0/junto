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
 *   due        the operator's work, marked urgent or past its due time
 *   review     a seat asked to have its work reviewed
 *   todo       the operator's open work, not yet due
 *   done       a turn settled and nobody has read it
 *   notice     something happened; the operator reads it and clears it
 *   degraded   retrying, stalled, the AI's advisory readings
 *   working    in flight
 *   resting    idle
 *   offline    exited, unknown, not running
 *
 * The rank is the ladder as a number, higher more urgent (12 blocked, 0
 * offline), the direction every wire already speaks. compareUrgency compares
 * urgency only; each caller names its own tie rule.
 *
 * Imports nothing but effect and sibling wire modules, so the phone syncs it.
 */
import { type Brand, Schema } from "effect";
import type { AgentSignalKind, WorkTiming } from "./agent-signals";
import type { FeedItemKind } from "./operator-feed";
import type { RingForm } from "./rings";

const LADDER = [
  "blocked",
  "stopped",
  "waiting",
  "escalated",
  "due",
  "review",
  "todo",
  "done",
  "notice",
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
  notice: Level.notice,
  work: Level.todo,
} as const satisfies Record<AgentSignalKind, UrgencyLevel>;

const FEED_LEVEL = {
  blocked: Level.blocked,
  stopped: Level.stopped,
  attention: Level.waiting,
  escalate: Level.escalated,
  // The AI reading the operator as awaited ranks with a declared escalation.
  health: Level.escalated,
  feedback: Level.review,
  notice: Level.notice,
  work: Level.todo,
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

/**
 * A declared signal's level. A work signal is `due` once whoever raised it
 * marked it urgent or its due time has passed, `todo` before; pass its
 * timing (and the moment to judge it) to read that. Other kinds ignore both.
 */
export const levelOfSignal = (
  kind: AgentSignalKind,
  timing?: WorkTiming,
  nowMs: number = Date.now(),
): UrgencyLevel =>
  kind === "work" && (timing?.urgent === true || (timing?.dueAt !== undefined && timing.dueAt <= nowMs))
    ? Level.due
    : SIGNAL_LEVEL[kind];
/** An operator feed item's level. */
export const levelOfFeedItem = (kind: FeedItemKind): UrgencyLevel => FEED_LEVEL[kind];
/**
 * The level a ring form stands for. A surface that knows the seat's signal or
 * need ranks from that instead; the form is what is left once it is drawn.
 */
export const levelOfRing = (form: RingForm): UrgencyLevel => RING_LEVEL[form];

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
 * What a seat is doing, read apart from what it needs from the operator, so a
 * seat at work with an open signal is both working and waiting (Broadcast's
 * limits, src/shared/broadcast.ts). Read from the seat's activity alone: work
 * in flight, a turn paused on a dialog among it, is working; a settled seat
 * is idle; one that has exited or failed to start is off.
 */
export const SEAT_DOING = ["working", "idle", "off"] as const;
export type SeatDoing = (typeof SEAT_DOING)[number];

export const doingOf = (level: UrgencyLevel): SeatDoing =>
  level === Level.offline || level === Level.stopped ? "off" : level === Level.resting || level === Level.done ? "idle" : "working";

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
  name: Parameters<typeof Schema.brand<B>>[0],
  names: G,
  levels: { readonly [K in G[number]]: readonly LadderName[] },
  order: "ladder" | "own" = "ladder",
): UrgencyView<G[number], B> => {
  type Group = G[number] & Brand.Brand<B>;
  const Group = Schema.Literals(names).pipe(Schema.brand<B>(name));
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
  waiting: ["waiting", "escalated", "due"],
  review: ["review", "todo"],
  done: ["done", "notice"],
  working: ["degraded", "working"],
  resting: ["resting"],
  offline: ["offline"],
});

/** A region's urgency badge; calm shows nothing. */
export const RegionUrgency = defineView("RegionUrgency", ["blocked", "needs-you", "review", "calm"], {
  blocked: ["blocked", "stopped"],
  "needs-you": ["waiting", "escalated", "due"],
  review: ["review", "todo"],
  calm: ["done", "notice", "degraded", "working", "resting", "offline"],
});

/**
 * A machine's row in the Machines badge, its popover, and the card a stopped
 * seat shows when its machine is why it cannot run. Broken outranks needs
 * you, which outranks a fix in flight; a sleeping machine is its own tier
 * below that, and a quiet machine shows no row. The operator's own work rungs,
 * review through notice, share needs-you: neither describes a machine, and
 * both want the operator's look.
 */
export const MachineRowUrgency = defineView(
  "MachineRowUrgency",
  ["broken", "needs-you", "working", "asleep", "quiet"],
  {
    broken: ["blocked", "stopped"],
    "needs-you": ["waiting", "escalated", "due", "review", "todo", "done", "notice"],
    working: ["degraded", "working"],
    asleep: ["resting"],
    quiet: ["offline"],
  },
);

/** A region rollup member's tier. */
export const MemberSeverity = defineView("MemberSeverity", ["blocked", "attention", "escalated", "ready", "working", "idle"], {
  blocked: ["blocked", "stopped"],
  attention: ["waiting"],
  escalated: ["escalated", "due"],
  ready: ["review", "todo", "done", "notice"],
  working: ["degraded", "working"],
  idle: ["resting", "offline"],
});

/** An in-app alert's kind; quiet raises none. */
export const AlertKind = defineView("AlertKind", ["blocked", "attention", "ready", "working", "quiet"], {
  blocked: ["blocked", "stopped"],
  attention: ["waiting", "escalated", "due"],
  ready: ["review", "todo", "done", "notice"],
  working: ["degraded", "working"],
  quiet: ["resting", "offline"],
});

/** What a sound cue is for, loudest first. */
export const CueUrgency = defineView("CueUrgency", ["stopped", "needs-you", "ready", "moving", "chrome"], {
  stopped: ["blocked", "stopped"],
  "needs-you": ["waiting", "escalated", "due"],
  ready: ["review", "todo", "done", "notice"],
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
    waiting: ["waiting", "escalated", "due"],
    working: ["degraded", "working"],
    review: ["review", "todo"],
    done: ["done", "notice"],
    resting: ["resting"],
    offline: ["offline"],
  },
  "own",
);

// --- the order to act ----------------------------------------------------------

/**
 * A signal can come after other signals (`dependsOn`, as a task depends on
 * others): the order the operator acts in. This is that order's one home,
 * beside the ladder it lifts.
 *
 * Whether a signal is ready, and what it still waits on, is not decided
 * here: an entry carries `ready` and `waitingOn` as the one function beside
 * AgentSignal in agent-signals.ts reads them. This file only orders by them.
 * The order advises; it never hides or locks a signal.
 */
export type ActEntry = {
  readonly id: string;
  readonly rank: UrgencyRank;
  /** Every signal it comes after is closed, however it closed. */
  readonly ready: boolean;
  /** The signals it comes after that are still open. */
  readonly waitingOn: ReadonlyArray<string>;
};

/** Where an open signal stands in the order to act. */
export type ActPlace = {
  readonly ready: boolean;
  /**
   * Its own rank, lifted to the most urgent of the open signals that wait on
   * it, however far down the chain: an urgent signal stuck behind a quiet one
   * lifts the quiet one.
   */
  readonly rank: UrgencyRank;
  /** Steps down its open chain from a signal that waits on none: 0 when it waits on none here. */
  readonly depth: number;
};

/**
 * Each entry's place. A loop cannot be raised (a signal names only earlier
 * ones), but one read here is taken as one step: every signal in it shares
 * the loop's depth and its most urgent rank, so the answer never hangs and
 * never depends on the order the entries come in. A signal waited on that is
 * not among the entries lifts and deepens nothing; a signal naming itself
 * waits on nothing; an id given twice is its last entry.
 *
 * It follows every id an entry names: the bound of eight a signal may come
 * after is the schema's (agent-signals.ts), not this walk's. No recursion, so
 * a chain of any length reads in a stack of one frame.
 */
export const placesToAct = (entries: Iterable<ActEntry>): ReadonlyMap<string, ActPlace> => {
  const open = new Map<string, ActEntry>();
  for (const entry of entries) open.set(entry.id, entry);
  const ids = [...open.keys()].sort();
  const holds = new Map<string, string[]>();
  for (const id of ids) holds.set(id, [...new Set(open.get(id)!.waitingOn)].filter((before) => before !== id && open.has(before)).sort());

  // The loops, one group each (Tarjan, with its own stack): a group is
  // emitted only after every group it waits on.
  const groupOf = new Map<string, number>();
  const groups: string[][] = [];
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let counter = 0;
  for (const root of ids) {
    if (index.has(root)) continue;
    const frames: Array<{ readonly id: string; next: number }> = [{ id: root, next: 0 }];
    index.set(root, counter);
    low.set(root, counter++);
    stack.push(root);
    onStack.add(root);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const before = holds.get(frame.id)!;
      if (frame.next < before.length) {
        const to = before[frame.next++]!;
        if (!index.has(to)) {
          index.set(to, counter);
          low.set(to, counter++);
          stack.push(to);
          onStack.add(to);
          frames.push({ id: to, next: 0 });
        } else if (onStack.has(to)) {
          low.set(frame.id, Math.min(low.get(frame.id)!, index.get(to)!));
        }
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent !== undefined) low.set(parent.id, Math.min(low.get(parent.id)!, low.get(frame.id)!));
      if (low.get(frame.id) !== index.get(frame.id)) continue;
      const group: string[] = [];
      for (;;) {
        const member = stack.pop()!;
        onStack.delete(member);
        groupOf.set(member, groups.length);
        group.push(member);
        if (member === frame.id) break;
      }
      groups.push(group);
    }
  }

  // Depth in emit order (what a group waits on comes first), rank in reverse
  // (what waits on a group comes first), each over the groups, not the ids.
  const depth = groups.map(() => 0);
  const rank = groups.map((group) => Math.max(...group.map((id) => open.get(id)!.rank)) as UrgencyRank);
  for (let at = 0; at < groups.length; at++) {
    for (const id of groups[at]!) {
      for (const before of holds.get(id)!) {
        const from = groupOf.get(before)!;
        if (from !== at) depth[at] = Math.max(depth[at]!, depth[from]! + 1);
      }
    }
  }
  for (let at = groups.length - 1; at >= 0; at--) {
    for (const id of groups[at]!) {
      for (const before of holds.get(id)!) {
        const to = groupOf.get(before)!;
        if (to !== at && rank[at]! > rank[to]!) rank[to] = rank[at]!;
      }
    }
  }
  const places = new Map<string, ActPlace>();
  for (const [id, entry] of open) {
    const at = groupOf.get(id)!;
    places.set(id, { ready: entry.ready, rank: rank[at]!, depth: depth[at]! });
  }
  return places;
};

/**
 * The order to act, most actionable first: ready before waiting, then the
 * lifted rank, then down the chain. Zero leaves the tie to the caller, who
 * names its own (the feed's is oldest first, so a batch raised first to last
 * reads first to last).
 */
export const compareToAct = (a: ActPlace, b: ActPlace): number =>
  Number(b.ready) - Number(a.ready) || b.rank - a.rank || a.depth - b.depth;

/**
 * Items in an order of the caller's (newest first, say) that never puts a
 * signal ahead of an open one it waits on: a chain reads top to bottom
 * wherever it lands, and between signals in no order the caller's compare
 * decides. Stable; a loop is cut by taking the caller's first.
 */
export const keepingOrderToAct = <T>(
  items: ReadonlyArray<T>,
  entryOf: (item: T) => Pick<ActEntry, "id" | "waitingOn">,
  compare: (a: T, b: T) => number,
): T[] => {
  const ids = new Set(items.map((item) => entryOf(item).id));
  const left = [...items].sort(compare);
  const placed = new Set<string>();
  const out: T[] = [];
  while (left.length > 0) {
    const free = left.findIndex((item) => {
      const entry = entryOf(item);
      return entry.waitingOn.every((id) => id === entry.id || !ids.has(id) || placed.has(id));
    });
    const [next] = left.splice(free === -1 ? 0 : free, 1);
    placed.add(entryOf(next!).id);
    out.push(next!);
  }
  return out;
};
