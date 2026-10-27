/**
 * Connectors on the pad: the four ports a hovered shape shows, the shape a
 * dragged edge snaps to, and the edge a release writes. Pure; the editor
 * owns the gesture.
 */
import type { Pad, PadEdge, PadElementId, PadPoint, PadShape, PadSide } from "@shared/pad";
import { anchorPoint } from "@shared/pad-geom";

/** A port's reach on screen, in view pixels: generous, so a port is easy to grab. */
export const PORT_VIEW_PX = 10;
/** How near a dragged edge must come to a shape to snap to it, in view pixels. */
export const SNAP_VIEW_PX = 24;

const SIDES: ReadonlyArray<PadSide> = ["top", "right", "bottom", "left"];

export type PadPort = { readonly side: PadSide; readonly at: PadPoint };

/** Where edges join a shape: the middle of each side of its box. */
export const shapePorts = (shape: PadShape): ReadonlyArray<PadPort> =>
  SIDES.map((side) => ({ side, at: anchorPoint(shape, side) }));

/** The port of this shape within reach of the point, nearest first. */
export const portOf = (shape: PadShape, point: PadPoint, reach: number): PadSide | undefined => {
  let best: { readonly side: PadSide; readonly d: number } | undefined;
  for (const port of shapePorts(shape)) {
    const d = Math.hypot(point.x - port.at.x, point.y - port.at.y);
    if (d <= reach && (!best || d < best.d)) best = { side: port.side, d };
  }
  return best?.side;
};

const byZDesc = (shapes: ReadonlyArray<PadShape>): PadShape[] =>
  shapes
    .map((shape, index) => ({ shape, index }))
    .sort((a, b) => b.shape.z - a.shape.z || b.index - a.index)
    .map((entry) => entry.shape);

const nearBox = (shape: PadShape, point: PadPoint, slop: number): boolean =>
  point.x >= shape.x - slop &&
  point.x <= shape.x + shape.w + slop &&
  point.y >= shape.y - slop &&
  point.y <= shape.y + shape.h + slop;

/** A port under the point on any shape, topmost first: where an edge starts in the select tool. */
export const portAt = (
  pad: Pad,
  point: PadPoint,
  reach: number,
): { readonly shape: PadShape; readonly side: PadSide } | undefined => {
  for (const shape of byZDesc(pad.shapes)) {
    const side = portOf(shape, point, reach);
    if (side) return { shape, side };
  }
  return undefined;
};

export type SnapTarget = {
  readonly shape: PadShape;
  /** Set when the point sits on one of the shape's ports; else the route picks the side. */
  readonly side?: PadSide;
};

/**
 * The shape a dragged edge would land on: a port in reach pins the side,
 * otherwise any shape whose box the point is near takes it and the route
 * chooses the side. The edge's own start never counts.
 */
export const snapTarget = (
  pad: Pad,
  point: PadPoint,
  from: PadElementId,
  reach: { readonly port: number; readonly snap: number },
): SnapTarget | undefined => {
  const candidates = byZDesc(pad.shapes).filter((shape) => shape.id !== from);
  for (const shape of candidates) {
    const side = portOf(shape, point, reach.port);
    if (side) return { shape, side };
  }
  for (const shape of candidates) {
    if (nearBox(shape, point, 0)) return { shape };
  }
  for (const shape of candidates) {
    if (nearBox(shape, point, reach.snap)) return { shape };
  }
  return undefined;
};

/**
 * The edge a release writes, or undefined when it would join a shape to
 * itself or repeat an edge already drawn between the same two sides.
 */
export const connectEdge = (
  pad: Pad,
  id: PadElementId,
  from: PadElementId,
  fromSide: PadSide | undefined,
  target: SnapTarget,
): PadEdge | undefined => {
  if (target.shape.id === from) return undefined;
  const repeat = pad.edges.some(
    (edge) =>
      edge.from === from &&
      edge.to === target.shape.id &&
      edge.fromSide === fromSide &&
      edge.toSide === target.side,
  );
  if (repeat) return undefined;
  return {
    id,
    from,
    to: target.shape.id,
    ...(fromSide ? { fromSide } : {}),
    ...(target.side ? { toSide: target.side } : {}),
  };
};
