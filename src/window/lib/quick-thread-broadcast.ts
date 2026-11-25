/**
 * Broadcast in Quick thread: a region as a recipient, with limits
 * (artifact 01M8599VXYM3Q47PPX716AF9S1). What is chosen is a pick: a region
 * and the two kinds of limit on it, or a single seat. The seats a pick
 * reaches are never kept, only read (`broadcastSet`, shared/broadcast.ts), so
 * a region always means the seats it holds now.
 *
 * This file is the choice itself, pure: the words of the limits (the feed's
 * own words, from the wire), how a typed limit becomes an option, how a pick
 * merges with another of the same region, and the lines the confirm and the
 * receipt say. The set of seats is the shared function's; nothing here
 * decides who is reached.
 */
import { SEAT_DOING, SEAT_NEEDS, type BroadcastSeat, type SeatDoing, type SeatNeed } from "@shared/broadcast";
import { FEED_KIND_LABEL } from "@shared/wire/operator-feed";
import { fuzzyMatch } from "@shared/fuzzy-match";
import type { QuickThreadRegion } from "./quick-thread";

/** A region chosen as a recipient, with its limits. Empty is no limit. */
export type RegionPick = {
  readonly regionId: string;
  readonly doing: ReadonlyArray<SeatDoing>;
  readonly needs: ReadonlyArray<SeatNeed>;
};

/** One limit, of either kind. */
export type Limit = { readonly group: "doing"; readonly value: SeatDoing } | { readonly group: "needs"; readonly value: SeatNeed };

/** The words of a limit as the operator reads them: "working", "waiting on you". The feed's, for what a seat needs. */
export const limitWord = (limit: Limit): string => (limit.group === "doing" ? limit.value : FEED_KIND_LABEL[limit.value]);

const capital = (word: string): string => `${word.charAt(0).toUpperCase()}${word.slice(1)}`;

/** The same, to start a line or a chip: "Working", "Waiting on you". */
export const limitLabel = (limit: Limit): string => capital(limitWord(limit));

// Blocked, Waiting on you, Ready for review: the order of the feed's chips, not of the wire's list.
const NEEDS_ORDER: ReadonlyArray<SeatNeed> = ["blocked", "escalate", "feedback"];
const orderedNeeds = (needs: ReadonlyArray<SeatNeed>): ReadonlyArray<SeatNeed> => NEEDS_ORDER.filter((need) => needs.includes(need));
const orderedDoing = (doing: ReadonlyArray<SeatDoing>): ReadonlyArray<SeatDoing> => SEAT_DOING.filter((one) => doing.includes(one));

/** The two groups of limits as the popover lists them: "Doing", then "Needs you". */
export const LIMIT_GROUPS: ReadonlyArray<{ readonly group: "doing" | "needs"; readonly heading: string; readonly limits: ReadonlyArray<Limit> }> = [
  { group: "doing", heading: "Doing", limits: SEAT_DOING.map((value): Limit => ({ group: "doing", value })) },
  { group: "needs", heading: "Needs you", limits: NEEDS_ORDER.map((value): Limit => ({ group: "needs", value })) },
];

/** Every limit, in the order the popover lists them. */
export const LIMITS: ReadonlyArray<Limit> = LIMIT_GROUPS.flatMap((group) => group.limits);

export const sameLimit = (a: Limit, b: Limit): boolean => a.group === b.group && a.value === b.value;

export const pickHas = (pick: RegionPick, limit: Limit): boolean =>
  limit.group === "doing" ? pick.doing.includes(limit.value) : pick.needs.includes(limit.value);

/** The limits a pick holds, in the order the token says them. */
export const limitsOf = (pick: RegionPick): ReadonlyArray<Limit> => [
  ...orderedDoing(pick.doing).map((value): Limit => ({ group: "doing", value })),
  ...orderedNeeds(pick.needs).map((value): Limit => ({ group: "needs", value })),
];

/** The pick with one limit chosen or let go. */
export const toggleLimit = (pick: RegionPick, limit: Limit): RegionPick => {
  const on = pickHas(pick, limit);
  if (limit.group === "doing") {
    return { ...pick, doing: on ? pick.doing.filter((one) => one !== limit.value) : orderedDoing([...pick.doing, limit.value]) };
  }
  return { ...pick, needs: on ? pick.needs.filter((one) => one !== limit.value) : orderedNeeds([...pick.needs, limit.value]) };
};

/**
 * A region chosen again: with a limit it adds that limit to the region's own
 * pick, never a second pick; with none it changes nothing (the region is
 * already a recipient as wide as it was).
 */
export const chooseRegion = (picks: ReadonlyArray<RegionPick>, regionId: string, limit?: Limit): ReadonlyArray<RegionPick> => {
  const held = picks.find((pick) => pick.regionId === regionId);
  if (held === undefined) {
    const fresh: RegionPick = { regionId, doing: [], needs: [] };
    return [...picks, limit === undefined ? fresh : toggleLimit(fresh, limit)];
  }
  if (limit === undefined || pickHas(held, limit)) return picks;
  return picks.map((pick) => (pick === held ? toggleLimit(pick, limit) : pick));
};

// ---- A typed limit ----

/** The limit a query ends in and what is left of it: "junto working" is working and "junto". */
export const typedLimit = (query: string): { readonly limit: Limit; readonly rest: string } | undefined => {
  const text = query.trimEnd().toLowerCase();
  if (text === "") return undefined;
  // The longest word first, so "ready for review" is not read as a shorter one.
  const words = LIMITS.map((limit) => ({ limit, word: limitWord(limit).toLowerCase() })).sort((a, b) => b.word.length - a.word.length);
  for (const { limit, word } of words) {
    if (!text.endsWith(word)) continue;
    const before = text.slice(0, text.length - word.length);
    // A whole word: "network" does not end in "off" for this.
    if (before !== "" && !/\s$/.test(before)) continue;
    return { limit, rest: before.trim() };
  }
  return undefined;
};

/**
 * The regions a typed limit offers, each with that limit on it and the count
 * it alone would reach ("Junto, working", 12 seats), for the list to rank
 * first. `countOf` is the set's: this file decides no one's reach.
 */
export const limitedRegionOptions = (
  regions: ReadonlyArray<QuickThreadRegion>,
  query: string,
  countOf: (regionId: string, limit: Limit) => number,
): ReadonlyArray<QuickThreadRegion> => {
  const typed = typedLimit(query);
  if (typed === undefined) return [];
  const matched =
    typed.rest === ""
      ? regions
      : regions.filter((region) => fuzzyMatch(typed.rest, { identity: [region.name] }) !== null);
  return matched.map((region) => ({ ...region, limit: typed.limit, seats: countOf(region.id, typed.limit) }));
};

// ---- What a pick says ----

const joined = (parts: ReadonlyArray<string>): string => parts.join(", ");

/** The region token's words: "Junto, working, ready for review". The count is the token's own, drawn beside. */
export const regionTokenText = (name: string, pick: RegionPick): string =>
  joined([name, ...limitsOf(pick).map((limit) => limitWord(limit))]);

/** The same for a screen reader, with the count: "Junto, working, 12 seats". */
export const regionTokenSpoken = (name: string, pick: RegionPick, seats: number): string =>
  `${regionTokenText(name, pick)}, ${seats === 1 ? "1 seat" : `${seats} seats`}`;

const seatsWord = (count: number): string => (count === 1 ? "1 seat" : `${count} seats`);

/** The confirm's question. */
export const confirmQuestion = (count: number): string => `Send to ${seatsWord(count)}?`;

/** "Each gets its own thread. 3 get it when they are back." The second sentence only when some are not running. */
export const confirmDetail = (later: number): string => {
  const first = "Each gets its own thread.";
  if (later === 0) return first;
  return `${first} ${later === 1 ? "1 gets it" : `${later} get it`} when ${later === 1 ? "it is" : "they are"} back.`;
};

/** The left-out line, only with a doing limit and seats whose machine cannot be read. */
export const leftOutLine = (count: number): string =>
  count === 1
    ? "1 is left out: its machine is out of reach right now, so what it is doing is not known."
    : `${count} are left out: their machine is out of reach right now, so what they are doing is not known.`;

/** The seats that straddle a chosen region's edge, which are not members and so not in the send. */
export const crossLine = (region: string, count: number): string =>
  count === 1
    ? `1 seat crosses the edge of ${region} and is not included.`
    : `${count} seats cross the edge of ${region} and are not included.`;

/** The confirm said once when it opens, for the live line: the question, the detail, the edge lines and what is left out. */
export const confirmSpoken = (count: number, later: number, unread: number, crossing: ReadonlyArray<string> = []): string =>
  [confirmQuestion(count), confirmDetail(later), ...crossing, unread > 0 ? leftOutLine(unread) : undefined]
    .filter((line) => line !== undefined)
    .join(" ");

/** The send button's own words. */
export const sendToCount = (count: number): string => `Send to ${count}`;

/** Names to show, grouped by the region each sits in. A seat in no region is grouped under no name. */
export type SeatGroup = { readonly region: string; readonly seats: ReadonlyArray<BroadcastSeat> };

export const groupByRegion = (seats: ReadonlyArray<BroadcastSeat>, regionOf: (nodeId: string) => string | undefined): ReadonlyArray<SeatGroup> => {
  const groups = new Map<string, BroadcastSeat[]>();
  for (const seat of seats) {
    const name = regionOf(seat.nodeId) ?? "";
    groups.set(name, [...(groups.get(name) ?? []), seat]);
  }
  return [...groups].map(([region, held]) => ({ region, seats: held }));
};

/** The seats not sent, one line per reason they share, as the seat-by-seat flow says it: "Not sent to @a, @b. Reason." */
export type NotSentReason = { readonly reason: string; readonly names: string };

/** The receipt of a send with a region, as three counted lines: not sent, have it, get it when they are back. */
export type BroadcastReceipt = {
  readonly notSent: ReadonlyArray<BroadcastSeat>;
  /** Why the seats not sent got nothing, one line to a shared reason. */
  readonly reasons: ReadonlyArray<NotSentReason>;
  readonly have: ReadonlyArray<BroadcastSeat>;
  readonly later: ReadonlyArray<BroadcastSeat>;
};

export const broadcastReceipt = (
  seats: ReadonlyArray<BroadcastSeat>,
  outcome: {
    readonly sent: ReadonlyArray<{ readonly seatId: string; readonly arrival: "arrived" | "waiting" }>;
    readonly failed: ReadonlyArray<{ readonly seatId: string; readonly message: string }>;
  },
): BroadcastReceipt => {
  const arrival = new Map(outcome.sent.map((entry) => [entry.seatId, entry.arrival]));
  const failed = new Map(outcome.failed.map((entry) => [entry.seatId, entry.message]));
  const notSent = seats.filter((seat) => failed.has(seat.nodeId));
  const byReason = new Map<string, string[]>();
  for (const seat of notSent) {
    const reason = failed.get(seat.nodeId) ?? "";
    byReason.set(reason, [...(byReason.get(reason) ?? []), `@${seat.name}`]);
  }
  return {
    notSent,
    reasons: [...byReason].map(([reason, names]) => ({ reason, names: names.join(", ") })),
    have: seats.filter((seat) => arrival.get(seat.nodeId) === "arrived"),
    later: seats.filter((seat) => arrival.get(seat.nodeId) === "waiting"),
  };
};

/** The receipt in one sentence for a screen reader. */
export const broadcastReceiptSpoken = (receipt: BroadcastReceipt): string => {
  const lines = [
    receipt.notSent.length > 0 ? `${receipt.notSent.length} not sent` : undefined,
    receipt.have.length > 0 ? `${receipt.have.length} have it` : undefined,
    receipt.later.length > 0 ? `${receipt.later.length} get it when they are back` : undefined,
  ].filter((line): line is string => line !== undefined);
  return `${lines.join(". ")}.`;
};
