/**
 * The set a broadcast reaches, and the guard on it. `msg.audience` answers it
 * and sends nothing; `msg.broadcast` reads it again at the send, inside the
 * send's own transaction, and is refused whole when its count or digest is
 * not the one the overseer named. A broadcast grants no authority an overseer
 * did not already have: it is the overseer's own mail over a set, one way.
 *
 * Who is in the set is decided by one function, `broadcastSet`
 * (src/shared/broadcast.ts), the one the window's Quick thread reads. This
 * file turns what the overseer typed into its picks, gives it each seat's
 * reading from what the core holds, and answers its result with a digest.
 *
 * A region is named by its name or its node id, one region a flag, never a
 * path: a name two regions share is refused, listing each with its node id
 * and the regions around it. Regions resolve on the overseer's own canvas
 * only. A single seat takes no limit; one command's `doing` and `needs` go on
 * every region pick in it.
 *
 * A limit of the guard: at the send, the canvas, its regions and so who they
 * hold are read again inside the send's transaction and checked against the
 * count and digest. The readings (`AudienceReadings`: what a seat is doing,
 * its open signals, whether it runs or sits elsewhere) are read just before
 * that transaction, so they can be a few milliseconds older than the set.
 */
import { createHash } from "node:crypto";
import { Result } from "effect";
import {
  broadcastSet,
  seatReading,
  type BroadcastPick,
  type BroadcastSeat,
  type SeatDoing,
  type SeatReading,
} from "@shared/broadcast";
import type { AgentSeatStateEvent } from "@shared/agent-seat-state";
import { asNodeId, regionName, type Canvas, type Node, type Region } from "@shared/model";
import { titleOf } from "@shared/model/title";
import { regionPathText, seatRegions } from "@shared/model/seat-identity";
import { isSeatKind } from "@shared/region-reach";
import type { AgentSeatState } from "@shared/wire/seat-activity";
import type { AgentSignal, SeatRaiseKind } from "@shared/wire/agent-signals";
import { BROADCAST_SEATS_MAX, BROADCAST_SET_DIGEST_LENGTH } from "@shared/overseer-control";
import type { TargetCandidate, WorkErrorBody } from "@shared/work-control";
import { findNode, resolveWorkTarget, type TargetCandidates } from "../work/authz";

/** What a broadcast's set is named by, as typed. */
export type BroadcastSelection = {
  readonly region?: ReadonlyArray<string>;
  readonly seat?: ReadonlyArray<string>;
  readonly doing?: ReadonlyArray<SeatDoing>;
  readonly needs?: ReadonlyArray<SeatRaiseKind>;
};

/** One pick, as the audience answers it: what it named, and what it reached. */
export type AudiencePick =
  | { readonly region: string; readonly regionId: string; readonly count: number; readonly unread: number }
  | { readonly seat: string; readonly nodeId: string; readonly count: number };

export type Audience = {
  /** Every seat reached, each once, in the order of the picks and by node id within a region. */
  readonly seats: ReadonlyArray<BroadcastSeat>;
  /** One per pick, in the order given. */
  readonly picks: ReadonlyArray<AudiencePick>;
  readonly count: number;
  /** Of `seats`, those not running now: they read it when they are back. */
  readonly notRunning: number;
  /** Of `seats`, those on another machine. */
  readonly elsewhere: number;
  /** Seats a doing limit could not read, none of them in `seats`: what they are doing is not known. */
  readonly unread: { readonly count: number; readonly seats: ReadonlyArray<BroadcastSeat> };
  /** A short digest of the set: the first hex characters of a sha256 over the sorted seat node ids. */
  readonly set: string;
};

/** What the core holds of each seat, read once for one set. */
export type AudienceReadings = {
  /** This machine's name, as a seat's `host` names it. */
  readonly machineName: string;
  /** A seat here, by its binding: undefined when nothing is bound, and then the seat is off. */
  readonly localState: (bindingId: string) => AgentSeatState | undefined;
  /** A seat on another machine, by its binding: its last reported event, and whether its link has held since. */
  readonly remoteState: (bindingId: string) => {
    readonly event: Pick<AgentSeatStateEvent, "state"> | undefined;
    readonly current: boolean;
  };
  /** The canvas's signals; the open ones of a seat's own, with no source, are what it needs. */
  readonly signals: ReadonlyArray<AgentSignal>;
};

/** The digest of a set of seats: order and repeats in the input do not change it. */
export const audienceDigest = (nodeIds: Iterable<string>): string =>
  createHash("sha256")
    .update([...new Set(nodeIds)].sort().join("\n"))
    .digest("hex")
    .slice(0, BROADCAST_SET_DIGEST_LENGTH);

const regionLine = (canvas: Canvas, region: Region): string => {
  const around = regionPathText(seatRegions(canvas, region.id));
  return `${regionName(region)} [${region.id}]${around === undefined ? "" : ` in ${around}`}`;
};

const regionCandidate = (region: Region): TargetCandidate => ({
  kind: "region",
  nodeId: region.id,
  name: regionName(region),
});

const regionsOf = (canvas: Canvas): ReadonlyArray<Region> =>
  [...canvas.nodes.values()]
    .filter((node): node is Region => node.kind === "region")
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/**
 * One region, by its node id or its name (any case). One flag is one region,
 * never a path: a name two regions share is refused listing each with its
 * node id and the regions around it.
 */
export const resolveBroadcastRegion = (canvas: Canvas, typed: string): Result.Result<Region, WorkErrorBody> => {
  const wanted = typed.trim();
  const byId = canvas.nodes.get(asNodeId(wanted));
  if (byId?.kind === "region") return Result.succeed(byId);
  const regions = regionsOf(canvas);
  const folded = wanted.toLowerCase();
  const named = regions.filter((region) => regionName(region).toLowerCase() === folded);
  const [only] = named;
  if (named.length === 1 && only !== undefined) return Result.succeed(only);
  if (named.length > 1) {
    return Result.fail({
      type: "InputError",
      message: `"${wanted}" names ${named.length} regions: ${named.map((region) => regionLine(canvas, region)).join("; ")}. Each --region is one region, never a path`,
      details: {
        path: "region",
        target: wanted,
        candidates: named.map(regionCandidate),
        hint: "each --region is one region by its name or node id, and several add up",
        next_step: "send again with the node id of the region you mean",
        retryable: false,
      },
    });
  }
  return Result.fail({
    type: "UnknownTarget",
    message: regions.length === 0
      ? `no region is called "${wanted}": this canvas has no regions`
      : `no region is called "${wanted}"; the regions are ${regions.map((region) => regionLine(canvas, region)).join("; ")}`,
    details: {
      path: "region",
      target: wanted,
      candidates: regions.map(regionCandidate),
      next_step: "send again with one of these names or node ids",
      retryable: false,
    },
  });
};

/** Every seat on the canvas, a peer row included: an overseer mails each one. */
const everySeat: TargetCandidates = (doc) =>
  [...doc.nodes.values()]
    .filter((node) => isSeatKind(node.kind))
    .map((node): TargetCandidate => ({ kind: node.kind, nodeId: node.id, name: titleOf(node) }));

const notASeat = (typed: string, kind: string): WorkErrorBody => ({
  type: "UnknownTarget",
  message: `"${typed}" is not a seat`,
  details: {
    path: "seat",
    target: typed,
    received: kind,
    hint: "a broadcast reaches seats: name a seat, or its region with --region",
    next_step: "junto overseer agent list shows the seats",
    retryable: false,
  },
});

/** One seat, by its name, node id or ref: any seat on the canvas, no edge needed. */
const resolveBroadcastSeat = (canvas: Canvas, callerId: string, typed: string): Result.Result<Node, WorkErrorBody> => {
  const resolved = resolveWorkTarget(canvas, callerId, typed, "msg.send", everySeat);
  if (Result.isFailure(resolved)) return Result.fail(resolved.failure);
  const node = resolved.success.itemId === undefined ? findNode(canvas, resolved.success.nodeId) : undefined;
  if (node === undefined || !isSeatKind(node.kind)) return Result.fail(notASeat(typed.trim(), node?.kind ?? "item"));
  return Result.succeed(node);
};

const stringField = (node: Node, key: "bindingId" | "host"): string | undefined => {
  const value = (node as Partial<Record<typeof key, unknown>>)[key];
  return typeof value === "string" ? value : undefined;
};

/**
 * One seat's reading from what the core holds. A seat here is always current,
 * and one with nothing bound is off. A seat on another machine is current only
 * while its machine's link has held since it reported; a peer row never is.
 */
const readingFrom = (canvasName: string, canvas: Canvas, readings: AudienceReadings) =>
  (nodeId: string): SeatReading => {
    const node = canvas.nodes.get(asNodeId(nodeId));
    const bindingId = node === undefined ? undefined : stringField(node, "bindingId");
    const host = node === undefined ? undefined : stringField(node, "host");
    const here = node !== undefined && node.kind !== "peer" && (host === undefined || host === readings.machineName);
    if (here) {
      const state = bindingId === undefined ? undefined : readings.localState(bindingId);
      return seatReading({ canvasName, nodeId, event: { state: state ?? "gone" }, current: true, signals: readings.signals });
    }
    const remote = bindingId === undefined ? { event: undefined, current: false } : readings.remoteState(bindingId);
    return seatReading({
      canvasName,
      nodeId,
      event: remote.event,
      current: node?.kind !== "peer" && remote.current,
      signals: readings.signals,
    });
  };

const tooMany = (count: number): WorkErrorBody => ({
  type: "InputError",
  message: `the set is ${count} seats, more than the ${BROADCAST_SEATS_MAX} one broadcast reaches. Nothing was sent`,
  details: {
    path: "region",
    expected: { atMost: BROADCAST_SEATS_MAX },
    received: { count },
    reason: "set_too_large",
    next_step: "narrow it with --doing or --needs, or name smaller regions",
    retryable: false,
  },
});

/**
 * The set a selection names on the overseer's canvas, with each pick's count,
 * its readings and its digest. An empty set is refused: there is nothing to
 * send. A set past `BROADCAST_SEATS_MAX` is refused whole.
 */
export const readAudience = (input: {
  readonly canvasName: string;
  readonly canvas: Canvas;
  readonly callerId: string;
  readonly selection: BroadcastSelection;
  readonly readings: AudienceReadings;
}): Result.Result<Audience, WorkErrorBody> => {
  const { canvas, selection } = input;
  const picks: Array<BroadcastPick> = [];
  const named: Array<{ readonly kind: "region"; readonly region: Region } | { readonly kind: "seat"; readonly node: Node }> = [];
  for (const typed of selection.region ?? []) {
    const region = resolveBroadcastRegion(canvas, typed);
    if (Result.isFailure(region)) return Result.fail(region.failure);
    picks.push({ kind: "region", regionId: region.success.id, doing: selection.doing ?? [], needs: selection.needs ?? [] });
    named.push({ kind: "region", region: region.success });
  }
  for (const typed of selection.seat ?? []) {
    const seat = resolveBroadcastSeat(canvas, input.callerId, typed);
    if (Result.isFailure(seat)) return Result.fail(seat.failure);
    picks.push({ kind: "seat", nodeId: seat.success.id });
    named.push({ kind: "seat", node: seat.success });
  }
  const set = broadcastSet({
    canvasName: input.canvasName,
    canvas,
    machineName: input.readings.machineName,
    picks,
    readingOf: readingFrom(input.canvasName, canvas, input.readings),
    // The overseer's own seat is never in its set.
    leaveOut: input.callerId,
  });
  const unread = { count: set.unread.length, seats: set.unread };
  if (set.count === 0) {
    return Result.fail({
      type: "InputError",
      message: unread.count === 0
        ? "the set is empty, so there is nothing to send"
        : `the set is empty, so there is nothing to send; ${unread.count} seats were left out because what they are doing is not known: ${unread.seats.map((seat) => seat.name).join(", ")}`,
      details: {
        path: (selection.region?.length ?? 0) > 0 ? "region" : "seat",
        received: { count: 0, ...(unread.count === 0 ? {} : { unread }) },
        reason: "set_empty",
        next_step: "name a region or a seat that holds other seats, or loosen --doing and --needs",
        retryable: false,
      },
    });
  }
  if (set.count > BROADCAST_SEATS_MAX) return Result.fail(tooMany(set.count));
  return Result.succeed({
    seats: set.seats,
    picks: set.picks.map((reached, index): AudiencePick => {
      const pick = named[index]!;
      return pick.kind === "region"
        ? { region: regionName(pick.region), regionId: pick.region.id, count: reached.count, unread: reached.unread }
        : { seat: titleOf(pick.node), nodeId: pick.node.id, count: reached.count };
    }),
    count: set.count,
    notRunning: set.notRunning,
    elsewhere: set.elsewhere,
    unread,
    set: audienceDigest(set.seats.map((seat) => seat.nodeId)),
  });
};

/**
 * The guard: the set read at the send is the one the overseer named, by count
 * and, when it sent one, by digest. Otherwise the whole broadcast is refused,
 * with the set as it is now, and nothing is sent.
 */
export const checkBroadcastSet = (
  audience: Audience,
  expected: { readonly expect: number; readonly set?: string },
): Result.Result<Audience, WorkErrorBody> => {
  const countDiffers = audience.count !== expected.expect;
  const setDiffers = expected.set !== undefined && expected.set !== audience.set;
  if (!countDiffers && !setDiffers) return Result.succeed(audience);
  const why = countDiffers
    ? `the set is ${audience.count} seats now, not the ${expected.expect} expected`
    : `the set is ${audience.set} now, not ${expected.set}: the same count, other seats`;
  return Result.fail({
    type: "Stale",
    message: `${why}. Nothing was sent`,
    details: {
      expected: { count: expected.expect, ...(expected.set === undefined ? {} : { set: expected.set }) },
      received: { count: audience.count, set: audience.set },
      reason: "set_changed",
      next_step: "look again with junto overseer msg audience, then send with its --expect and --set",
      retryable: true,
    },
  });
};
