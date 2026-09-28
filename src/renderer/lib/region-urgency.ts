// Urgency: the seat states that ask for the operator, and how they climb to
// the regions holding the seat.
//
// A seat is urgent when it is blocked, needs the operator (needs input,
// wants you, waiting on you) or has work ready for review. The reading is the
// one the seat's ring draws (ringCells in activity-atlas.ts: halt, call,
// wait), published per seat by the live seat (AgentSeat) into seatUrgency$,
// so a region, the minimap and the ring can never disagree.
//
// A region with urgent seats directly in it speaks for them plainly (reach
// "direct", the worst of its own seats). A region with none, but urgent work
// in a region nested in it, says so quietly (reach "held", the worst held
// below), so an outer region says "something in here needs you" without
// shouting over the region that holds the seat.

import { observable } from "@legendapp/state";
import type { AgentSignalKind } from "@shared/agent-signals";
import type { ThreadHealthTone } from "@shared/thread-health";

export type Urgency = "blocked" | "needs-you" | "review";

export type RegionUrgency = {
  readonly urgency: Urgency;
  /** Urgent seats sit directly in this region, or only in regions nested in it. */
  readonly reach: "direct" | "held";
};

const RANK: Readonly<Record<Urgency, number>> = { blocked: 0, "needs-you": 1, review: 2 };

export const worseUrgency = (a: Urgency | undefined, b: Urgency | undefined): Urgency | undefined =>
  a === undefined ? b : b === undefined ? a : RANK[a] <= RANK[b] ? a : b;

/**
 * A seat's urgency from the ring's inputs, in the ring's order: a stoppage or
 * a declared blocker is blocked; a dialog waiting for input, a request for
 * the operator or a fresh waiting reading needs you; a declared review
 * request is review.
 */
export const seatUrgencyOfRing = (input: {
  readonly glyph: string;
  readonly signal?: AgentSignalKind | undefined;
  readonly health?: ThreadHealthTone | undefined;
  readonly healthStale?: boolean;
}): Urgency | undefined => {
  if (input.glyph === "halt" || input.signal === "blocked") return "blocked";
  if (input.glyph === "call" || input.signal === "escalate") return "needs-you";
  if (input.signal === "feedback") return "review";
  if (input.health === "waiting" && input.healthStale !== true) return "needs-you";
  return undefined;
};

/** Each live seat's urgency, by node id (AgentSeat publishes; absent when calm). */
export const seatUrgency$ = observable<Record<string, Urgency>>({});

/** Set or clear one seat's urgency, writing only on change. */
export const publishSeatUrgency = (nodeId: string, urgency: Urgency | undefined): void => {
  const was = seatUrgency$[nodeId].peek();
  if (was === urgency) return;
  if (urgency === undefined) seatUrgency$[nodeId].delete();
  else seatUrgency$[nodeId].set(urgency);
};

/**
 * Region urgencies from urgent seats. `regionOf` names a seat's innermost
 * region, `parentOf` a region's enclosing one.
 */
export const regionUrgencies = (
  seats: Iterable<{ readonly id: string; readonly urgency: Urgency }>,
  regionOf: (seatId: string) => string | undefined,
  parentOf: (regionId: string) => string | undefined,
): ReadonlyMap<string, RegionUrgency> => {
  const direct = new Map<string, Urgency>();
  const held = new Map<string, Urgency>();
  for (const seat of seats) {
    const home = regionOf(seat.id);
    if (home === undefined || home === "") continue;
    direct.set(home, worseUrgency(direct.get(home), seat.urgency)!);
    const seen = new Set<string>([home]);
    for (let up = parentOf(home); up !== undefined && !seen.has(up); up = parentOf(up)) {
      seen.add(up);
      held.set(up, worseUrgency(held.get(up), seat.urgency)!);
    }
  }
  const out = new Map<string, RegionUrgency>();
  for (const id of new Set([...direct.keys(), ...held.keys()])) {
    const mine = direct.get(id);
    out.set(id, mine !== undefined ? { urgency: mine, reach: "direct" } : { urgency: held.get(id)!, reach: "held" });
  }
  return out;
};

/** Region urgencies for the open canvas, by region id (RegionUrgencyGate publishes). */
export const regionUrgency$ = observable<Record<string, RegionUrgency>>({});

/** Publish, touching only the regions whose urgency changed. */
export const publishRegionUrgencies = (next: ReadonlyMap<string, RegionUrgency>): void => {
  const current = regionUrgency$.peek();
  for (const id of Object.keys(current)) {
    if (!next.has(id)) regionUrgency$[id].delete();
  }
  for (const [id, value] of next) {
    const was = current[id];
    if (was?.urgency !== value.urgency || was.reach !== value.reach) regionUrgency$[id].set(value);
  }
};
