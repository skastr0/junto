/**
 * Broadcast: the seats one message from the operator, or from an overseer,
 * reaches (artifact 01M8599VXYM3Q47PPX716AF9S1). The operator picks regions,
 * each with limits, and single seats beside them; this says which seats that
 * choice reaches, each once, in an order that does not change between two
 * readings of the same choice. Pure, so the window, the core at the send and
 * the overseer command all read the set the same way.
 *
 * A region holds every seat inside its rectangle, the seats of the regions
 * inside it among them. A region's two limits are read apart: what the seat
 * is doing (`SEAT_DOING`, urgency.ts `doingOf`) and what it needs from the
 * operator (its open signals, `SEAT_RAISE_KINDS`). Within a limit any of the
 * chosen matches; across the two, both must; a limit with nothing chosen is
 * no limit. A single seat takes no limit.
 *
 * A seat this machine holds no current reading for (its machine is out of
 * reach, or it never reported) is not known to be doing anything: a doing
 * limit cannot hold it, so it is left out of the set and named apart as
 * unread, never dropped in silence. With no doing limit it is counted as any
 * other seat.
 */
import type { AgentSeatStateEvent } from "./agent-seat-state";
import { asNodeId, regionMembers, type Canvas, type Node } from "./model";
import { titleOf } from "./model/title";
import { isSeatKind } from "./region-reach";
import { isSeatRaiseKind, type AgentSignal, type SeatRaiseKind } from "./wire/agent-signals";
import { doingOf, Level, type SeatDoing, type UrgencyLevel } from "./wire/urgency";

export { SEAT_DOING, type SeatDoing } from "./wire/urgency";
export { SEAT_RAISE_KINDS as SEAT_NEEDS, type SeatRaiseKind as SeatNeed } from "./wire/agent-signals";

/** One seat as Broadcast reads it: what it is doing, when that is known, and every open signal of its own. */
export type SeatReading = {
  /** Absent when this machine holds no current reading of the seat. */
  readonly doing?: SeatDoing;
  /** Its open signals' kinds, every one, so a seat waiting on you and ready for review matches both. */
  readonly needs: ReadonlyArray<SeatRaiseKind>;
};

/** A seat's activity on the ladder, from its state event; the event's `state` is its status's own projection. */
const activityLevel = (state: AgentSeatStateEvent["state"]): UrgencyLevel => {
  switch (state) {
    case "working":
    case "attention":
      return Level.working;
    case "idle":
      return Level.resting;
    case "unknown":
    case "gone":
      return Level.offline;
  }
};

/**
 * The reading of one seat from what this machine holds: its last state event
 * (a seat here, or one another machine reported), whether that event is
 * current (a seat on another machine is current only while its link holds
 * and it has reported since this core started; a seat here always is), and
 * the canvas's signals.
 */
export const seatReading = (input: {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly event: Pick<AgentSeatStateEvent, "state"> | undefined;
  readonly current: boolean;
  readonly signals: Iterable<AgentSignal>;
}): SeatReading => {
  const needs = new Set<SeatRaiseKind>();
  for (const signal of input.signals) {
    if (signal.state !== "open" || signal.canvasName !== input.canvasName || signal.nodeId !== input.nodeId) continue;
    if (signal.source === undefined && isSeatRaiseKind(signal.kind)) needs.add(signal.kind);
  }
  const doing = input.event !== undefined && input.current ? doingOf(activityLevel(input.event.state)) : undefined;
  return { ...(doing === undefined ? {} : { doing }), needs: [...needs] };
};

/** One recipient as chosen, in the order chosen. */
export type BroadcastPick =
  | {
      readonly kind: "region";
      readonly regionId: string;
      /** Empty: no limit on what the seat is doing. */
      readonly doing: ReadonlyArray<SeatDoing>;
      /** Empty: no limit on what it needs from the operator. */
      readonly needs: ReadonlyArray<SeatRaiseKind>;
    }
  | { readonly kind: "seat"; readonly nodeId: string };

/** A seat the set holds. */
export type BroadcastSeat = {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly name: string;
  /** Running now: it reads the message when it lands. Otherwise it reads it when it is back. */
  readonly running: boolean;
  /** It sits on another machine. */
  readonly elsewhere: boolean;
};

export type BroadcastSet = {
  /** Every seat reached, each once: in the order of the picks, and by node id within a region. */
  readonly seats: ReadonlyArray<BroadcastSeat>;
  /**
   * Seats a region holds that a doing limit could not read, in the same
   * order, none of them in `seats`: what they are doing is not known.
   */
  readonly unread: ReadonlyArray<BroadcastSeat>;
  /** Each pick in the order given: the seats it reaches as limited, and those it left out unread. */
  readonly picks: ReadonlyArray<{ readonly count: number; readonly unread: number }>;
  readonly count: number;
  /** Of `seats`, those not running now. */
  readonly notRunning: number;
  /** Of `seats`, those on another machine. */
  readonly elsewhere: number;
  /**
   * Per region picked, in the order picked, the seats that cross its edge:
   * the frame overlaps the region's but is not wholly inside it, so the seat
   * is not a member. They are not in `seats` (and a seat another pick reached
   * is not listed here: it is included). Empty unless `crossersOf` is given.
   */
  readonly crossing: ReadonlyArray<{ readonly regionId: string; readonly seats: ReadonlyArray<BroadcastSeat> }>;
};

const byNodeId = (a: Node, b: Node): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const matches = (pick: Extract<BroadcastPick, { readonly kind: "region" }>, reading: SeatReading): "in" | "out" | "unread" => {
  if (pick.needs.length > 0 && !reading.needs.some((need) => pick.needs.includes(need))) return "out";
  if (pick.doing.length === 0) return "in";
  if (reading.doing === undefined) return "unread";
  return pick.doing.includes(reading.doing) ? "in" : "out";
};

/**
 * The seats a choice reaches. `machineName` is this machine's, to tell a seat
 * elsewhere; `readingOf` gives each seat's reading (`seatReading`);
 * `leaveOut` is a seat never in the set, the overseer's own.
 */
export const broadcastSet = (input: {
  readonly canvasName: string;
  readonly canvas: Pick<Canvas, "nodes">;
  readonly machineName: string;
  readonly picks: ReadonlyArray<BroadcastPick>;
  readonly readingOf: (nodeId: string) => SeatReading;
  readonly leaveOut?: string;
  /** The nodes that cross a region's edge (model/canvas.ts `regionCrossers`); without it no seat is reported as crossing. */
  readonly crossersOf?: (region: Node) => ReadonlyArray<Node>;
}): BroadcastSet => {
  const { canvas, canvasName } = input;
  const seats: BroadcastSeat[] = [];
  const unread: BroadcastSeat[] = [];
  const reached = new Set<string>();
  const unreadAt = new Map<string, number>();
  const readings = new Map<string, SeatReading>();
  const readingOf = (nodeId: string): SeatReading => {
    let reading = readings.get(nodeId);
    if (reading === undefined) readings.set(nodeId, (reading = input.readingOf(nodeId)));
    return reading;
  };
  const seatOf = (node: Node): BroadcastSeat => {
    const doing = readingOf(node.id).doing;
    return {
      canvasName,
      nodeId: node.id,
      name: titleOf(node),
      running: doing !== undefined && doing !== "off",
      elsewhere: node.kind === "peer" || ("host" in node && node.host !== input.machineName),
    };
  };
  const reach = (node: Node): void => {
    if (reached.has(node.id)) return;
    reached.add(node.id);
    seats.push(seatOf(node));
  };
  const isSeat = (node: Node | undefined): node is Node => node !== undefined && isSeatKind(node.kind) && node.id !== input.leaveOut;

  const picks = input.picks.map((pick) => {
    if (pick.kind === "seat") {
      const node = canvas.nodes.get(asNodeId(pick.nodeId));
      if (!isSeat(node)) return { count: 0, unread: 0 };
      reach(node);
      return { count: 1, unread: 0 };
    }
    const region = canvas.nodes.get(asNodeId(pick.regionId));
    if (region?.kind !== "region") return { count: 0, unread: 0 };
    let count = 0;
    let left = 0;
    for (const node of [...regionMembers(canvas, region)].filter(isSeat).sort(byNodeId)) {
      const read = matches(pick, readingOf(node.id));
      if (read === "in") {
        count += 1;
        reach(node);
      } else if (read === "unread") {
        left += 1;
        if (!unreadAt.has(node.id)) {
          unreadAt.set(node.id, unread.length);
          unread.push(seatOf(node));
        }
      }
    }
    return { count, unread: left };
  });

  // A seat another pick reached is in the set, so it is not left out.
  const leftOut = unread.filter((seat) => !reached.has(seat.nodeId));
  // Seats that cross a picked region's edge are told apart, each region once, none that the set reaches.
  const crossing: Array<{ readonly regionId: string; readonly seats: ReadonlyArray<BroadcastSeat> }> = [];
  const told = new Set<string>();
  if (input.crossersOf !== undefined) {
    for (const pick of input.picks) {
      if (pick.kind !== "region" || told.has(pick.regionId)) continue;
      const region = canvas.nodes.get(asNodeId(pick.regionId));
      if (region?.kind !== "region") continue;
      told.add(pick.regionId);
      const across = input.crossersOf(region).filter(isSeat).filter((node) => !reached.has(node.id));
      if (across.length > 0) crossing.push({ regionId: pick.regionId, seats: across.map(seatOf) });
    }
  }
  return {
    seats,
    unread: leftOut,
    picks,
    count: seats.length,
    notRunning: seats.filter((seat) => !seat.running).length,
    elsewhere: seats.filter((seat) => seat.elsewhere).length,
    crossing,
  };
};
