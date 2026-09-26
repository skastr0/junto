/**
 * The per-seat preamble feed: which note a seat's bubble shows, and when.
 *
 * Pure. Every source (the agent's own preamble, its tool calls, signals, the
 * AI's reading, mail, control state) arrives as one PreambleEvent; the feed
 * decides, per seat:
 *
 *   - dedupe: news the seat is showing, or showed within the last minute,
 *     is not news again; a repeat only keeps the showing note up longer;
 *   - dwell: a bubble stays readable before anything as loud or quieter
 *     replaces it (the newest such note waits its turn); only a louder note,
 *     a signal or the operator, replaces it at once;
 *   - rate: a token bucket per seat caps the quiet news (mail, deliverables);
 *     news beyond it is dropped, not queued or counted;
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
  /** News shown recently (dedupe key to when it was last shown or repeated). */
  readonly seen: ReadonlyMap<string, number>;
};

export type FeedState = ReadonlyMap<string, SeatFeed>;

export const FEED_TUNING = {
  /** The same news again within this window is not news. */
  dedupeMs: 60_000,
  /** A bubble is readable for at least this long before as-loud news replaces it. */
  dwellMs: 2_500,
  /** The replaced note lingers faded for this long. */
  trailMs: 3_500,
  /** Token bucket per seat, for quiet news only. */
  bucket: 3,
  refillMs: 4_000,
} as const;

/** Louder notes replace at once and spend no token: the agent's words, signals, the operator. */
const PRIORITY: Readonly<Record<PreambleAction, number>> = {
  say: 3,
  signal: 3,
  "signal-clear": 3,
  "mail-failed": 2,
  state: 2,
  health: 2,
  "mail-in": 1,
  "mail-out": 1,
  tool: 1,
};

const LOUD = 2;

const priorityOf = (item: Pick<PreambleItem, "action" | "provenance">): number =>
  item.provenance === "operator" ? 3 : PRIORITY[item.action];

/** Default tone per action when a source does not name one. */
const TONE: Readonly<Record<PreambleAction, PreambleTone>> = {
  say: "second",
  tool: "indigo",
  signal: "amber",
  "signal-clear": "green",
  "mail-failed": "crimson",
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
    shownAt: now,
  };
};

/** One piece of news: who said what, however often it arrives. */
const newsKey = (item: Pick<PreambleItem, "action" | "provenance" | "text">): string =>
  `${item.provenance}\u0000${item.action}\u0000${item.text.toLowerCase()}`;

const refill = (feed: SeatFeed, now: number): SeatFeed => {
  const earned = Math.floor((now - feed.refilledAt) / FEED_TUNING.refillMs);
  if (earned <= 0) return feed;
  return {
    ...feed,
    tokens: Math.min(FEED_TUNING.bucket, feed.tokens + earned),
    refilledAt: feed.refilledAt + earned * FEED_TUNING.refillMs,
  };
};

/** Forget news older than the dedupe window. */
const forget = (seen: ReadonlyMap<string, number>, now: number): ReadonlyMap<string, number> => {
  let out: Map<string, number> | undefined;
  for (const [key, at] of seen) {
    if (now - at < FEED_TUNING.dedupeMs) continue;
    out ??= new Map(seen);
    out.delete(key);
  }
  return out ?? seen;
};

const remember = (seen: ReadonlyMap<string, number>, item: PreambleItem, now: number): ReadonlyMap<string, number> =>
  new Map(seen).set(newsKey(item), now);

const show = (feed: SeatFeed, item: PreambleItem, now: number): SeatFeed => {
  const prior = feed.bubble?.current;
  const bubble: SeatBubble =
    prior !== undefined && prior.expiresAt > now
      ? { current: item, previous: prior, previousUntil: Math.min(prior.expiresAt, now + FEED_TUNING.trailMs) }
      : { current: item };
  return { ...feed, bubble, pending: undefined, seen: remember(feed.seen, item, now) };
};

/** Feed one event in. Returns the new state (the input is not mutated). */
export const feedPreamble = (state: FeedState, event: PreambleEvent, now: number): FeedState => {
  if (event.expiresAt <= now) return state;
  const incoming = itemOf(event, now);
  const out = new Map(state);
  let feed = refill(
    state.get(event.nodeId) ?? { tokens: FEED_TUNING.bucket, refilledAt: now, seen: new Map() },
    now,
  );
  feed = { ...feed, seen: forget(feed.seen, now) };
  const current = feed.bubble?.current;
  const live = current !== undefined && current.expiresAt > now;
  const key = newsKey(incoming);

  // Dedupe: the showing note again only keeps it up; recent news is silent.
  if (live && newsKey(current) === key) {
    feed = {
      ...feed,
      bubble: { ...feed.bubble!, current: { ...current, expiresAt: Math.max(current.expiresAt, incoming.expiresAt) } },
      seen: remember(feed.seen, current, now),
    };
    out.set(event.nodeId, feed);
    return out;
  }
  if (feed.seen.has(key) || (feed.pending !== undefined && newsKey(feed.pending) === key)) {
    out.set(event.nodeId, feed);
    return out;
  }

  const loud = priorityOf(incoming) >= LOUD;
  if (!loud) {
    // Over the rate, quiet news is dropped: a late note describes nothing.
    if (feed.tokens <= 0) {
      out.set(event.nodeId, feed);
      return out;
    }
    feed = { ...feed, tokens: feed.tokens - 1 };
  }
  // As-loud or quieter news waits out the dwell; a louder note replaces at once.
  const dwelling =
    live && now - current.shownAt < FEED_TUNING.dwellMs && priorityOf(incoming) <= priorityOf(current);
  if (dwelling) {
    // Hold only the newest waiting note, unless a louder one already waits.
    const keep = feed.pending !== undefined && priorityOf(feed.pending) > priorityOf(incoming);
    out.set(event.nodeId, keep ? feed : { ...feed, pending: incoming });
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
    const seen = forget(next.seen, now);
    if (seen !== next.seen) next = { ...next, seen };
    // A seat with nothing showing, a full bucket and no recent news carries no state.
    const idle =
      next.bubble === undefined &&
      next.pending === undefined &&
      next.seen.size === 0 &&
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
      // Forget a spent bucket once it would be full again, and recent news
      // once it is old: one wake per seat, when the last of it lapses.
      let forgetAt = feed.refilledAt + (FEED_TUNING.bucket - feed.tokens) * FEED_TUNING.refillMs;
      for (const at of feed.seen.values()) forgetAt = Math.max(forgetAt, at + FEED_TUNING.dedupeMs);
      consider(forgetAt);
    }
  }
  return soonest;
};
