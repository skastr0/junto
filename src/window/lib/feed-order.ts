/**
 * The needs-you feed's signal order, as the window draws it (parts 7 and 8):
 * which cards are one chain and each one's place in it ("3 of 10"), a chain
 * drawn together where its first card stands, the fold that keeps ten raised
 * in order to three rows, the Depends on line a waiting card carries, and
 * the card the W key and that line go to.
 *
 * Pure. What a signal comes after and whether it is ready are the core's
 * (signalOrderOf over signalReadiness); the order to act is urgency.ts's.
 * Nothing here decides either: it only reads the fields a FeedItem carries.
 */
import type { FeedItem } from "@shared/operator-feed";

/** The feed's id for a signal's card. */
export const signalItemId = (signalId: string): string => `signal:${signalId}`;

/** A card waits while a signal it comes after is still open; one that names none is ready. */
export const feedItemWaits = (item: Pick<FeedItem, "ready">): boolean => item.ready === false;

/** A card's place in its chain: the chain, and where it stands in the order drawn. */
export type FeedChainPlace = {
  /** The chain's first card as drawn: the same for every card of it. */
  readonly chainId: string;
  /** 1 for the first. */
  readonly index: number;
  readonly size: number;
};

/**
 * The chains among `items`, in the order given: cards joined by what they
 * depend on, either way, when both are here. A card in no chain has no place.
 */
export const feedChainPlaces = (items: ReadonlyArray<FeedItem>): ReadonlyMap<string, FeedChainPlace> => {
  const bySignal = new Map<string, string>();
  for (const item of items) if (item.signalId !== undefined) bySignal.set(item.signalId, item.itemId);
  const parent = new Map<string, string>(items.map((item) => [item.itemId, item.itemId] as const));
  const rootOf = (id: string): string => {
    let at = id;
    while (parent.get(at) !== at) at = parent.get(at)!;
    // Flatten the path, so a chain of fifty reads in a few steps.
    let step = id;
    while (parent.get(step) !== at) {
      const next = parent.get(step)!;
      parent.set(step, at);
      step = next;
    }
    return at;
  };
  for (const item of items) {
    for (const signalId of item.dependsOn ?? []) {
      const other = bySignal.get(signalId);
      if (other === undefined || other === item.itemId) continue;
      const a = rootOf(item.itemId);
      const b = rootOf(other);
      if (a !== b) parent.set(b, a);
    }
  }
  const members = new Map<string, string[]>();
  for (const item of items) {
    const root = rootOf(item.itemId);
    members.set(root, [...(members.get(root) ?? []), item.itemId]);
  }
  const places = new Map<string, FeedChainPlace>();
  for (const chain of members.values()) {
    if (chain.length < 2) continue;
    chain.forEach((itemId, at) => places.set(itemId, { chainId: chain[0]!, index: at + 1, size: chain.length }));
  }
  return places;
};

/**
 * In the order to act, each chain drawn together where its first card
 * stands, its cards in the order given: the next in a chain sits right under
 * the one before it, so when that one is answered the next takes its place.
 */
export const groupFeedChains = (items: ReadonlyArray<FeedItem>): FeedItem[] => {
  const places = feedChainPlaces(items);
  const byChain = new Map<string, FeedItem[]>();
  for (const item of items) {
    const place = places.get(item.itemId);
    if (place !== undefined) byChain.set(place.chainId, [...(byChain.get(place.chainId) ?? []), item]);
  }
  const out: FeedItem[] = [];
  for (const item of items) {
    const place = places.get(item.itemId);
    if (place === undefined) out.push(item);
    else if (place.chainId === item.itemId) out.push(...byChain.get(place.chainId)!);
  }
  return out;
};

/** A row the list draws: a card, or the fold that stands for the rest of a chain. */
export type FeedRow =
  | { readonly kind: "card"; readonly item: FeedItem }
  | { readonly kind: "fold"; readonly chainId: string; readonly count: number; readonly firstId: string };

/**
 * A fold's name for a screen reader: what it shows, in which chain (the card
 * before it), and that it is the way in. A headline is a whole sentence, so it
 * comes last, after a colon.
 */
export const foldName = (count: number, before: FeedRow | undefined): string =>
  `Show ${String(count)} more ${count === 1 ? "signal" : "signals"} in this order${
    before?.kind === "card" ? `, after: ${before.item.text}` : ""
  }`;

/**
 * The rows of `items` with each chain folded after its next waiting card:
 * its ready cards, the first that waits, then one row for the rest. A chain
 * any of whose cards is in `unfolded` is drawn whole.
 */
export const foldFeedChains = (
  items: ReadonlyArray<FeedItem>,
  places: ReadonlyMap<string, FeedChainPlace>,
  unfolded: ReadonlySet<string>,
): FeedRow[] => {
  const open = new Set<string>();
  for (const item of items) {
    const place = places.get(item.itemId);
    if (place !== undefined && unfolded.has(item.itemId)) open.add(place.chainId);
  }
  const shownWaiting = new Set<string>();
  const folded = new Map<string, FeedItem[]>();
  const rows: FeedRow[] = [];
  for (const item of items) {
    const place = places.get(item.itemId);
    if (place === undefined || open.has(place.chainId)) {
      rows.push({ kind: "card", item });
      continue;
    }
    const rest = folded.get(place.chainId);
    if (rest !== undefined) {
      rest.push(item);
      continue;
    }
    rows.push({ kind: "card", item });
    if (!feedItemWaits(item)) continue;
    if (shownWaiting.has(place.chainId)) continue;
    shownWaiting.add(place.chainId);
    folded.set(place.chainId, []);
  }
  // The fold stands right under the last card shown of its chain; one with nothing left behind it is no row.
  const out: FeedRow[] = [];
  for (const row of rows) {
    out.push(row);
    if (row.kind !== "card") continue;
    const place = places.get(row.item.itemId);
    if (place === undefined) continue;
    const rest = folded.get(place.chainId);
    if (rest === undefined || rest.length === 0) continue;
    const lastShown = [...rows].reverse().find((one) => one.kind === "card" && places.get(one.item.itemId)?.chainId === place.chainId);
    if (lastShown !== row) continue;
    out.push({ kind: "fold", chainId: place.chainId, count: rest.length, firstId: rest[0]!.itemId });
  }
  return out;
};

/** The ids of every card a chain's fold stands for. */
export const foldedItemIds = (items: ReadonlyArray<FeedItem>, rows: ReadonlyArray<FeedRow>): ReadonlySet<string> => {
  const shown = new Set(rows.flatMap((row) => (row.kind === "card" ? [row.item.itemId] : [])));
  return new Set(items.filter((item) => !shown.has(item.itemId)).map((item) => item.itemId));
};

/**
 * The card a waiting card goes to, for its Depends on link and the W key:
 * of the signals it still waits on, the first in `inOrder` (the feed as
 * drawn, folded cards included). Undefined on a ready card, or when none of
 * them is here.
 */
export const waitsOnTarget = (item: FeedItem, inOrder: ReadonlyArray<FeedItem>): FeedItem | undefined => {
  if (!feedItemWaits(item)) return undefined;
  const waiting = new Set(item.waitingOn ?? []);
  return inOrder.find((other) => other.signalId !== undefined && waiting.has(other.signalId));
};

/** The one line under a waiting card's sentence, or a ready card's that waits only on signals not here. */
export type FeedDependsLine =
  | {
      readonly kind: "waiting";
      /** The card its link goes to; undefined when the open signal it waits on is not in the feed. */
      readonly first: FeedItem | undefined;
      /** Other open signals it waits on. */
      readonly more: number;
      /** Signals it comes after that are not here yet. */
      readonly notHere: number;
    }
  | { readonly kind: "not-here"; readonly count: number };

export const feedDependsLineOf = (item: FeedItem, inOrder: ReadonlyArray<FeedItem>): FeedDependsLine | undefined => {
  const notHere = item.notReceived?.length ?? 0;
  if (feedItemWaits(item)) {
    const first = waitsOnTarget(item, inOrder);
    return { kind: "waiting", first, more: Math.max(0, (item.waitingOn?.length ?? 0) - 1), notHere };
  }
  return notHere > 0 ? { kind: "not-here", count: notHere } : undefined;
};

/** "and 1 more", "and 1 not here yet", "and 2 more, 1 not here yet": the line's faint end, or "". */
export const dependsTail = (line: Extract<FeedDependsLine, { kind: "waiting" }>): string => {
  const parts = [
    ...(line.more > 0 ? [`${String(line.more)} more`] : []),
    ...(line.notHere > 0 ? [`${String(line.notHere)} not here yet`] : []),
  ];
  return parts.length === 0 ? "" : `and ${parts.join(", ")}`;
};

/** The line of a card that waits only on signals not here: it is drawn ready, and says why. */
export const notHereWords = (count: number): string =>
  count === 1 ? "Depends on a signal not here yet. Ready now." : `Depends on ${String(count)} signals not here yet. Ready now.`;
