import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import { actorDeliverySurfaceOf } from "@shared/actor-surface";
import type { SeatSessionEndReason } from "@shared/seat-sessions";
import type { SeatSessionObservation } from "./repository";

/** A managed agent seat's session as its node names it. */
type SeatOnNode = {
  readonly seatId: string;
  readonly harness: string;
  readonly bindingId: string;
  readonly sessionId?: string;
  readonly cwd?: string;
};

const seatOnNode = (node: CanvasNode): SeatOnNode | undefined => {
  const surface = actorDeliverySurfaceOf(node);
  if (surface?._tag !== "managedAgent") return undefined;
  const sessionId = node.ether?.terminal?.sessionId?.trim();
  const cwd = node.ether?.terminal?.launch?.cwd?.trim();
  return {
    seatId: node.id,
    harness: surface.harness,
    bindingId: surface.bindingId,
    ...(sessionId ? { sessionId } : {}),
    ...(cwd ? { cwd } : {}),
  };
};

const seatsOf = (doc: CanvasDoc | undefined): Map<string, SeatOnNode> => {
  const seats = new Map<string, SeatOnNode>();
  for (const node of doc?.nodes ?? []) {
    const seat = seatOnNode(node);
    if (seat) seats.set(seat.seatId, seat);
  }
  return seats;
};

export type SeatSessionTransition =
  /** The seat now runs this session; whatever it ran before ends for `endReason`. */
  | { readonly kind: "start"; readonly observation: SeatSessionObservation }
  /** The seat no longer names a session (a capture harness about to learn a new one). */
  | { readonly kind: "end"; readonly seatId: string; readonly sessionId: string; readonly reason: SeatSessionEndReason };

const endReasonBetween = (before: SeatOnNode | undefined, after: SeatOnNode): SeatSessionEndReason =>
  before !== undefined && (before.harness !== after.harness || before.bindingId !== after.bindingId)
    ? "reseat"
    : "replaced";

/**
 * What one canvas commit did to its seats' sessions: a session id that
 * appeared or changed starts a session, one that was cleared ends it. A seat
 * removed from the canvas keeps its history untouched.
 */
export const seatSessionTransitions = (
  previous: CanvasDoc | undefined,
  next: CanvasDoc | undefined,
): SeatSessionTransition[] => {
  const before = seatsOf(previous);
  const transitions: SeatSessionTransition[] = [];
  for (const after of seatsOf(next).values()) {
    const prior = before.get(after.seatId);
    if (prior?.sessionId === after.sessionId) continue;
    if (after.sessionId !== undefined) {
      transitions.push({
        kind: "start",
        observation: {
          seatId: after.seatId,
          sessionId: after.sessionId,
          harness: after.harness,
          ...(after.cwd ? { cwd: after.cwd } : {}),
          endReason: endReasonBetween(prior, after),
        },
      });
    } else if (prior?.sessionId !== undefined) {
      transitions.push({
        kind: "end",
        seatId: after.seatId,
        sessionId: prior.sessionId,
        reason: endReasonBetween(prior, after),
      });
    }
  }
  return transitions;
};

/** Every seat on a canvas that names a session: what boot records. */
export const seatSessionsOnCanvas = (doc: CanvasDoc): SeatSessionObservation[] =>
  [...seatsOf(doc).values()].flatMap((seat) =>
    seat.sessionId === undefined
      ? []
      : [{ seatId: seat.seatId, sessionId: seat.sessionId, harness: seat.harness, ...(seat.cwd ? { cwd: seat.cwd } : {}) }],
  );

/** The session one seat names on its node, if it is a managed agent seat. */
export const seatSessionOnNode = (node: CanvasNode): SeatSessionObservation | undefined => {
  const seat = seatOnNode(node);
  if (seat?.sessionId === undefined) return undefined;
  return { seatId: seat.seatId, sessionId: seat.sessionId, harness: seat.harness, ...(seat.cwd ? { cwd: seat.cwd } : {}) };
};
