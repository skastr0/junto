/**
 * The per-seat preamble feed: which note a seat's bubble shows, and when.
 *
 * Pure. Every source (the agent's own preamble, its tool calls, signals, the
 * AI's reading, mail, control state) arrives as one PreambleEvent; the feed
 * decides, per seat:
 *
 *   - coalesce: the same kind of news within a short window updates the
 *     bubble in place and counts ("checking mail x3") instead of flickering;
 *   - dwell: a bubble stays readable for a moment before anything quieter
 *     replaces it; a louder note replaces it at once;
 *   - rate: a token bucket per seat keeps a busy seat lively but not noisy;
 *     quiet news beyond it folds into "+N more" on what is showing;
 *   - trail: the note it replaced lingers faded beneath for a few seconds.
 *
 * The caller owns the clock and a single timer; `nextDeadline` says when to
 * call `tick` next.
 */

import type { PreambleAction, PreambleEvent, PreambleProvenance, PreambleTone } from "@shared/preamble";

export type PreambleItem = {
  readonly id: string;
  readonly nodeId: string;
  readonly text: string;
  readonly provenance: PreambleProvenance;
  readonly action: PreambleAction;
  readonly tone: PreambleTone;
  readonly expiresAt: number;
  /** Coalesced repeats of the same news (1 = once). */
  readonly count: number;
  /** Quieter notes folded in while rate-limited. */
  readonly more: number;
  readonly shownAt: number;
};

export type SeatBubble = {
  readonly current: PreambleItem;
  /** What it replaced, faded beneath until `previousUntil`. */
  readonly previous?: PreambleItem;
  readonly previousUntil?: number;
};

type SeatFeed = {
  readonly bubble?: SeatBubble;
  /** A quieter note waiting for the current one's dwell to end. */
  readonly pending?: PreambleItem;
  readonly tokens: number;
  readonly refilledAt: number;
};

export type FeedState = ReadonlyMap<string, SeatFeed>;

export const FEED_TUNING = {
  /** Same-kind news within this window coalesces in place. */
  coalesceMs: 4_000,
  /** A bubble is readable for at least this long before quieter news replaces it. */
  dwellMs: 1_600,
  /** The replaced note lingers faded for this long. */
  trailMs: 3_500,
  /** Token bucket per seat. */
  bucket: 4,
  refillMs: 2_500,
} as const;

/** Louder notes replace at once and spend no token: the agent's words, signals, the operator. */
const PRIORITY: Readonly<Record<PreambleAction, number>> = {
  say: 3,
  signal: 3,
  "signal-clear": 3,
  state: 2,
  health: 2,
  "mail-in": 1,
  "mail-out": 1,
  tool: 0,
};

const LOUD = 2;

const priorityOf = (item: Pick<PreambleItem, "action" | "provenance">): number =>
  item.provenance === "operator" ? 3 : PRIORITY[item.action];

/** Default tone per action when a source does not name one. */
const TONE: Readonly<Record<PreambleAction, PreambleTone>> = {
  say: "second",
  tool: "steel",
  signal: "amber",
  "signal-clear": "green",
  health: "amber",
  "mail-in": "violet",
  "mail-out": "violet",
  state: "cyan",
};

export const itemOf = (event: PreambleEvent, now: number): PreambleItem => {
  const action = event.action ?? "say";
  return {
    id: event.preambleId,
    nodeId: event.nodeId,
    text: event.text,
    provenance: event.provenance ?? "agent",
    action,
    tone: event.tone ?? TONE[action],
    expiresAt: event.expiresAt,
    count: 1,
    more: 0,
    shownAt: now,
  };
};

const sameNews = (a: PreambleItem, b: PreambleItem): boolean =>
  a.action === b.action && a.provenance === b.provenance && a.text === b.text;

const refill = (feed: SeatFeed, now: number): SeatFeed => {
  const earned = Math.floor((now - feed.refilledAt) / FEED_TUNING.refillMs);
  if (earned <= 0) return feed;
  return {
    ...feed,
    tokens: Math.min(FEED_TUNING.bucket, feed.tokens + earned),
    refilledAt: feed.refilledAt + earned * FEED_TUNING.refillMs,
  };
};

const show = (feed: SeatFeed, item: PreambleItem, now: number): SeatFeed => {
  const prior = feed.bubble?.current;
  const bubble: SeatBubble =
    prior !== undefined && prior.expiresAt > now
      ? { current: item, previous: prior, previousUntil: Math.min(prior.expiresAt, now + FEED_TUNING.trailMs) }
      : { current: item };
  return { ...feed, bubble, pending: undefined };
};

/** Feed one event in. Returns the new state (the input is not mutated). */
export const feedPreamble = (state: FeedState, event: PreambleEvent, now: number): FeedState => {
  if (event.expiresAt <= now) return state;
  const incoming = itemOf(event, now);
  const out = new Map(state);
  let feed = refill(
    state.get(event.nodeId) ?? { tokens: FEED_TUNING.bucket, refilledAt: now },
    now,
  );
  const current = feed.bubble?.current;
  const live = current !== undefined && current.expiresAt > now;

  // Coalesce: the same news again updates in place and counts.
  if (live && sameNews(current, incoming) && now - current.shownAt < FEED_TUNING.coalesceMs) {
    feed = {
      ...feed,
      bubble: {
        ...feed.bubble!,
        current: {
          ...current,
          id: incoming.id,
          count: current.count + 1,
          expiresAt: Math.max(current.expiresAt, incoming.expiresAt),
        },
      },
    };
    out.set(event.nodeId, feed);
    return out;
  }

  const loud = priorityOf(incoming) >= LOUD;
  if (!loud && feed.tokens <= 0) {
    // Over the rate: quiet news folds into what is showing.
    if (live) {
      feed = { ...feed, bubble: { ...feed.bubble!, current: { ...current, more: current.more + 1 } } };
      out.set(event.nodeId, feed);
    }
    return out;
  }

  if (!loud) feed = { ...feed, tokens: feed.tokens - 1 };
  // Quieter news, or more of the same quiet news, waits out the dwell; the
  // agent's next words, a signal or the operator replace at once.
  const pIn = priorityOf(incoming);
  const pCur = live ? priorityOf(current) : 0;
  const dwelling =
    live && now - current.shownAt < FEED_TUNING.dwellMs && (pIn < pCur || (pIn === pCur && pIn < LOUD));
  if (dwelling) {
    // Hold the newest quieter note until the current one has been readable.
    out.set(event.nodeId, { ...feed, pending: incoming });
    return out;
  }
  out.set(event.nodeId, show(feed, incoming, now));
  return out;
};

/** Dismiss a seat's bubble (the operator's close), optionally only a given id. */
export const dismissSeat = (state: FeedState, nodeId: string, id?: string): FeedState => {
  const feed = state.get(nodeId);
  if (feed?.bubble === undefined) return state;
  if (id !== undefined && feed.bubble.current.id !== id) return state;
  const out = new Map(state);
  out.set(nodeId, { ...feed, bubble: undefined, pending: undefined });
  return out;
};

/** Advance time: release pending notes, expire bubbles and trails. */
export const tickFeed = (state: FeedState, now: number): FeedState => {
  let changed = false;
  const out = new Map<string, SeatFeed>();
  for (const [nodeId, feed] of state) {
    let next = feed;
    const current = next.bubble?.current;
    if (next.pending !== undefined) {
      if (next.pending.expiresAt <= now) {
        next = { ...next, pending: undefined };
      } else if (current === undefined || current.expiresAt <= now || now - current.shownAt >= FEED_TUNING.dwellMs) {
        next = show(next, { ...next.pending, shownAt: now }, now);
      }
    }
    const bubble = next.bubble;
    if (bubble !== undefined) {
      if (bubble.current.expiresAt <= now) {
        next = { ...next, bubble: undefined };
      } else if (bubble.previous !== undefined && (bubble.previousUntil ?? 0) <= now) {
        next = { ...next, bubble: { current: bubble.current } };
      }
    }
    // A seat with nothing showing and a full bucket carries no state.
    const idle =
      next.bubble === undefined &&
      next.pending === undefined &&
      refill(next, now).tokens >= FEED_TUNING.bucket;
    if (next !== feed || idle) changed = true;
    if (!idle) out.set(nodeId, next);
  }
  return changed ? out : state;
};

/** When `tickFeed` next has work to do, or undefined when nothing is pending. */
export const nextDeadline = (state: FeedState): number | undefined => {
  let soonest: number | undefined;
  const consider = (at: number | undefined): void => {
    if (at === undefined) return;
    if (soonest === undefined || at < soonest) soonest = at;
  };
  for (const feed of state.values()) {
    const current = feed.bubble?.current;
    consider(current?.expiresAt);
    consider(feed.bubble?.previousUntil);
    if (feed.pending !== undefined) {
      consider(current === undefined ? feed.pending.shownAt : current.shownAt + FEED_TUNING.dwellMs);
    }
    if (feed.bubble === undefined && feed.pending === undefined) {
      // Forget a spent bucket once it would be full again.
      consider(feed.refilledAt + (FEED_TUNING.bucket - feed.tokens) * FEED_TUNING.refillMs);
    }
  }
  return soonest;
};
