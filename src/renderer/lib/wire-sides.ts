/**
 * Wire sides — which socket a wire leaves and enters by.
 *
 * A card has a socket on each side. Which pair a wire uses is not authored:
 * it is read off where the two cards sit, so a wire leaves by the side that
 * faces its far end and never doubles back around its own card. Moving a card
 * moves its wires to the sockets that now face each other.
 *
 * Every pair of sides is scored and the cheapest wins. The score is the
 * length of the run, a charge per corner, and a heavy charge for a socket
 * that faces away from the far end (the wire would have to wrap the card).
 * So two cards in a row join by their facing sides in a straight line, and
 * two cards on a diagonal join by one corner: out along the longer axis, in
 * by the side that faces back.
 *
 * Paint and geometry only. Pure: no React / xyflow / observables.
 */
import type { WireDirection } from "./wire-route";

export type WireSideRect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type WireSides = {
  readonly source: WireDirection;
  readonly target: WireDirection;
};

const SIDES: ReadonlyArray<WireDirection> = ["right", "bottom", "left", "top"];

const NORMAL: Readonly<Record<WireDirection, { readonly x: number; readonly y: number }>> = {
  right: { x: 1, y: 0 },
  left: { x: -1, y: 0 },
  bottom: { x: 0, y: 1 },
  top: { x: 0, y: -1 },
};

/** The run a wire needs straight out of a socket before it may turn. */
const CLEARANCE = 40;
/** A socket facing away from the far end: the wire wraps its own card. */
const WRAP_COST = 600;
/**
 * One corner, in the same unit as a pixel of run. Set above half a seat's
 * width, so on a diagonal one corner into the middle of a side beats two
 * corners into the nearer end.
 */
const CORNER_COST = 110;
/** Leaving across the shorter axis: only ever a tie-break between two equal corners. */
const MINOR_AXIS_COST = 4;
/** Two sockets count as in line when they are this close across the run. */
const IN_LINE = 1;

const anchorOf = (rect: WireSideRect, side: WireDirection): { readonly x: number; readonly y: number } => {
  switch (side) {
    case "left":
      return { x: rect.x, y: rect.y + rect.height / 2 };
    case "right":
      return { x: rect.x + rect.width, y: rect.y + rect.height / 2 };
    case "top":
      return { x: rect.x + rect.width / 2, y: rect.y };
    case "bottom":
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height };
  }
};

const horizontal = (side: WireDirection): boolean => side === "left" || side === "right";

/** The socket pair for a wire from `source` to `target`, by where the two cards sit. */
export const wireSides = (source: WireSideRect, target: WireSideRect): WireSides => {
  const acrossX = target.x + target.width / 2 - (source.x + source.width / 2);
  const acrossY = target.y + target.height / 2 - (source.y + source.height / 2);
  const majorHorizontal = Math.abs(acrossX) >= Math.abs(acrossY);

  let best: WireSides = { source: "right", target: "left" };
  let bestCost = Number.POSITIVE_INFINITY;
  for (const from of SIDES) {
    const start = anchorOf(source, from);
    const out = NORMAL[from];
    for (const to of SIDES) {
      const end = anchorOf(target, to);
      const into = NORMAL[to];
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      // How far the far socket lies ahead of each socket's own outward face.
      const aheadOfSource = dx * out.x + dy * out.y;
      const aheadOfTarget = -(dx * into.x + dy * into.y);
      let cost = Math.abs(dx) + Math.abs(dy);
      if (aheadOfSource < CLEARANCE) cost += WRAP_COST + (CLEARANCE - aheadOfSource);
      if (aheadOfTarget < CLEARANCE) cost += WRAP_COST + (CLEARANCE - aheadOfTarget);
      const facing = out.x === -into.x && out.y === -into.y;
      const sameWay = out.x === into.x && out.y === into.y;
      const offLine = Math.abs(horizontal(from) ? dy : dx);
      const corners = facing ? (offLine <= IN_LINE ? 0 : 2) : sameWay ? 2 : 1;
      cost += corners * CORNER_COST;
      if (horizontal(from) !== majorHorizontal) cost += MINOR_AXIS_COST;
      if (cost < bestCost) {
        bestCost = cost;
        best = { source: from, target: to };
      }
    }
  }
  return best;
};
