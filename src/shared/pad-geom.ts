/**
 * Junto pad geometry. Numbers in, numbers out.
 */
import { Schema } from "effect";
import type {
  Pad,
  PadEdge,
  PadElementId,
  PadImage,
  PadInk,
  PadLayer,
  PadPin,
  PadPoint,
  PadShape,
  PadSide,
} from "./pad";

const FiniteNumber = Schema.Number.pipe(
  Schema.check(Schema.makeFilter(Number.isFinite, {
    message: "must be a finite number",
  })),
);

const NonNegative = FiniteNumber.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
);

export const Camera = Schema.Struct({
  x: FiniteNumber,
  y: FiniteNumber,
  zoom: FiniteNumber.pipe(Schema.check(Schema.isGreaterThan(0))),
});
export type Camera = typeof Camera.Type;

export const GeomRect = Schema.Struct({
  x: FiniteNumber,
  y: FiniteNumber,
  w: NonNegative,
  h: NonNegative,
});
export type GeomRect = typeof GeomRect.Type;

export type PadHit = {
  readonly id: PadElementId;
  readonly layer: PadLayer;
};

export const identityCamera: Camera = { x: 0, y: 0, zoom: 1 };

const EDGE_STUB = 16;
const PIN_MARKER_R = 8;

const fmtNum = (n: number): string => String(Object.is(n, -0) ? 0 : n);

const hypot = (dx: number, dy: number): number => Math.hypot(dx, dy);

export const viewToScene = (camera: Camera, view: PadPoint): PadPoint => ({
  x: camera.x + view.x / camera.zoom,
  y: camera.y + view.y / camera.zoom,
});

export const sceneToView = (camera: Camera, scene: PadPoint): PadPoint => ({
  x: (scene.x - camera.x) * camera.zoom,
  y: (scene.y - camera.y) * camera.zoom,
});

const rectOf = (item: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }): GeomRect => ({
  x: item.x,
  y: item.y,
  w: item.w,
  h: item.h,
});

const pointsBounds = (
  points: ReadonlyArray<PadPoint>,
  pad = 0,
): GeomRect => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return {
    x: minX - pad,
    y: minY - pad,
    w: Math.max(0, maxX - minX + pad * 2),
    h: Math.max(0, maxY - minY + pad * 2),
  };
};

const pinMarkerBounds = (pin: PadPin): GeomRect => ({
  x: pin.x - PIN_MARKER_R,
  y: pin.y - PIN_MARKER_R,
  w: PIN_MARKER_R * 2,
  h: PIN_MARKER_R * 2,
});

export const lookHereBounds = (pin: PadPin, margin: number): GeomRect => {
  if (pin.bounds) {
    return {
      x: pin.x - pin.bounds.w / 2,
      y: pin.y - pin.bounds.h / 2,
      w: pin.bounds.w,
      h: pin.bounds.h,
    };
  }
  return {
    x: pin.x - margin,
    y: pin.y - margin,
    w: margin * 2,
    h: margin * 2,
  };
};

const pinContentBounds = (pin: PadPin): GeomRect =>
  pin.bounds
    ? lookHereBounds(pin, 0)
    : pinMarkerBounds(pin);

const unionRects = (rects: ReadonlyArray<GeomRect>): GeomRect => {
  if (rects.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.w);
    maxY = Math.max(maxY, rect.y + rect.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
};

export const trianglePoints = (shape: PadShape): readonly [PadPoint, PadPoint, PadPoint] => [
  { x: shape.x + shape.w / 2, y: shape.y },
  { x: shape.x + shape.w, y: shape.y + shape.h },
  { x: shape.x, y: shape.y + shape.h },
];

export const anchorPoint = (shape: PadShape, side: PadSide): PadPoint => {
  switch (side) {
    case "top":
      return { x: shape.x + shape.w / 2, y: shape.y };
    case "right":
      return { x: shape.x + shape.w, y: shape.y + shape.h / 2 };
    case "bottom":
      return { x: shape.x + shape.w / 2, y: shape.y + shape.h };
    case "left":
      return { x: shape.x, y: shape.y + shape.h / 2 };
  }
};

const oppositeSide = (side: PadSide): PadSide => {
  switch (side) {
    case "top":
      return "bottom";
    case "right":
      return "left";
    case "bottom":
      return "top";
    case "left":
      return "right";
  }
};

const inferSide = (from: PadShape, to: PadShape): PadSide => {
  const dx = to.x + to.w / 2 - (from.x + from.w / 2);
  const dy = to.y + to.h / 2 - (from.y + from.h / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
};

const offsetSide = (point: PadPoint, side: PadSide, distance: number): PadPoint => {
  switch (side) {
    case "top":
      return { x: point.x, y: point.y - distance };
    case "right":
      return { x: point.x + distance, y: point.y };
    case "bottom":
      return { x: point.x, y: point.y + distance };
    case "left":
      return { x: point.x - distance, y: point.y };
  }
};

const isHorizontal = (side: PadSide): boolean => side === "left" || side === "right";

const collapsePoints = (points: ReadonlyArray<PadPoint>): PadPoint[] => {
  const out: PadPoint[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (last && last.x === point.x && last.y === point.y) continue;
    out.push(point);
  }
  return out;
};

export const routeEdge = (
  from: PadShape,
  to: PadShape,
  fromSide?: PadSide,
  toSide?: PadSide,
): PadPoint[] => {
  const startSide = fromSide ?? inferSide(from, to);
  const endSide = toSide ?? (from.id === to.id ? startSide : oppositeSide(inferSide(to, from)));
  const start = anchorPoint(from, startSide);
  const end = anchorPoint(to, endSide);

  if (from.id === to.id) {
    const out = offsetSide(start, startSide, EDGE_STUB);
    const ortho = isHorizontal(startSide)
      ? { x: 0, y: EDGE_STUB * 2 }
      : { x: EDGE_STUB * 2, y: 0 };
    return collapsePoints([
      start,
      out,
      { x: out.x + ortho.x, y: out.y + ortho.y },
      { x: start.x + ortho.x, y: start.y + ortho.y },
      start,
    ]);
  }

  const startOut = offsetSide(start, startSide, EDGE_STUB);
  const endOut = offsetSide(end, endSide, EDGE_STUB);
  if (isHorizontal(startSide) && isHorizontal(endSide)) {
    const midX = (startOut.x + endOut.x) / 2;
    return collapsePoints([
      start,
      startOut,
      { x: midX, y: startOut.y },
      { x: midX, y: endOut.y },
      endOut,
      end,
    ]);
  }
  if (!isHorizontal(startSide) && !isHorizontal(endSide)) {
    const midY = (startOut.y + endOut.y) / 2;
    return collapsePoints([
      start,
      startOut,
      { x: startOut.x, y: midY },
      { x: endOut.x, y: midY },
      endOut,
      end,
    ]);
  }
  if (isHorizontal(startSide)) {
    return collapsePoints([start, startOut, { x: endOut.x, y: startOut.y }, endOut, end]);
  }
  return collapsePoints([start, startOut, { x: startOut.x, y: endOut.y }, endOut, end]);
};

const isAxisAligned = (a: PadPoint, b: PadPoint): boolean =>
  a.x === b.x || a.y === b.y;

const isOrthogonalPolyline = (points: ReadonlyArray<PadPoint>): boolean => {
  for (let i = 1; i < points.length; i += 1) {
    if (!isAxisAligned(points[i - 1]!, points[i]!)) return false;
  }
  return true;
};

const polylinePath = (points: ReadonlyArray<PadPoint>): string => {
  const first = points[0];
  if (!first) return "";
  let d = `M ${fmtNum(first.x)} ${fmtNum(first.y)}`;
  for (let i = 1; i < points.length; i += 1) {
    const point = points[i]!;
    d += ` L ${fmtNum(point.x)} ${fmtNum(point.y)}`;
  }
  return d;
};

/** Midpoint-quadratic smooth. Endpoints stay put. Interior points are controls. */
const smoothPath = (points: ReadonlyArray<PadPoint>): string => {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return "";
  let d = `M ${fmtNum(first.x)} ${fmtNum(first.y)}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const point = points[i]!;
    const next = points[i + 1]!;
    d += ` Q ${fmtNum(point.x)} ${fmtNum(point.y)} ${fmtNum((point.x + next.x) / 2)} ${fmtNum((point.y + next.y) / 2)}`;
  }
  d += ` L ${fmtNum(last.x)} ${fmtNum(last.y)}`;
  return d;
};

export const strokePath = (
  points: ReadonlyArray<PadPoint>,
  _width: number,
): string => {
  if (points.length < 3 || isOrthogonalPolyline(points)) return polylinePath(points);
  return smoothPath(points);
};

const shapeById = (pad: Pad, id: string): PadShape | undefined =>
  pad.shapes.find((shape) => shape.id === id);

export const edgePoints = (pad: Pad, edge: PadEdge): PadPoint[] | undefined => {
  const from = shapeById(pad, edge.from);
  const to = shapeById(pad, edge.to);
  if (!from || !to) return undefined;
  return routeEdge(from, to, edge.fromSide, edge.toSide);
};

const elementBounds = (
  item: PadShape | PadImage | PadInk | PadPin,
): GeomRect => {
  if ("points" in item) return pointsBounds(item.points, item.width / 2);
  if ("mentions" in item) return pinContentBounds(item);
  return rectOf(item);
};

const edgeRect = (pad: Pad, edge: PadEdge): GeomRect | undefined => {
  const points = edgePoints(pad, edge);
  if (!points) return undefined;
  return pointsBounds(points);
};

export function boundsOf(item: PadShape | PadImage | PadInk | PadPin): GeomRect;
export function boundsOf(pad: Pad, id: string): GeomRect | undefined;
export function boundsOf(
  itemOrPad: PadShape | PadImage | PadInk | PadPin | Pad,
  id?: string,
): GeomRect | undefined {
  if (id !== undefined) {
    const pad = itemOrPad as Pad;
    const image = pad.images.find((candidate) => candidate.id === id);
    if (image) return rectOf(image);
    const shape = pad.shapes.find((candidate) => candidate.id === id);
    if (shape) return rectOf(shape);
    const ink = pad.inks.find((candidate) => candidate.id === id);
    if (ink) return pointsBounds(ink.points, ink.width / 2);
    const pin = pad.pins.find((candidate) => candidate.id === id);
    if (pin) return pinContentBounds(pin);
    const edge = pad.edges.find((candidate) => candidate.id === id);
    if (edge) return edgeRect(pad, edge);
    return undefined;
  }
  return elementBounds(itemOrPad as PadShape | PadImage | PadInk | PadPin);
}

export const contentBounds = (pad: Pad): GeomRect => {
  const rects: GeomRect[] = [
    ...pad.images.map(rectOf),
    ...pad.shapes.map(rectOf),
    ...pad.inks.map((ink) => pointsBounds(ink.points, ink.width / 2)),
    ...pad.pins.map(pinContentBounds),
  ];
  for (const edge of pad.edges) {
    const rect = edgeRect(pad, edge);
    if (rect) rects.push(rect);
  }
  return unionRects(rects);
};

export const rectsOverlap = (a: GeomRect, b: GeomRect): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

const pointInRect = (point: PadPoint, rect: GeomRect, slop: number): boolean =>
  point.x >= rect.x - slop &&
  point.x <= rect.x + rect.w + slop &&
  point.y >= rect.y - slop &&
  point.y <= rect.y + rect.h + slop;

const distToSegment = (point: PadPoint, a: PadPoint, b: PadPoint): number => {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const length2 = abx * abx + aby * aby;
  if (length2 === 0) return hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(
    0,
    Math.min(1, ((point.x - a.x) * abx + (point.y - a.y) * aby) / length2),
  );
  return hypot(point.x - (a.x + t * abx), point.y - (a.y + t * aby));
};

const distToPolyline = (point: PadPoint, points: ReadonlyArray<PadPoint>): number => {
  if (points.length === 0) return Infinity;
  if (points.length === 1) return hypot(point.x - points[0]!.x, point.y - points[0]!.y);
  let best = Infinity;
  for (let i = 1; i < points.length; i += 1) {
    best = Math.min(best, distToSegment(point, points[i - 1]!, points[i]!));
  }
  return best;
};

const pointInTriangle = (
  point: PadPoint,
  a: PadPoint,
  b: PadPoint,
  c: PadPoint,
): boolean => {
  const v0x = c.x - a.x;
  const v0y = c.y - a.y;
  const v1x = b.x - a.x;
  const v1y = b.y - a.y;
  const v2x = point.x - a.x;
  const v2y = point.y - a.y;
  const dot00 = v0x * v0x + v0y * v0y;
  const dot01 = v0x * v1x + v0y * v1y;
  const dot02 = v0x * v2x + v0y * v2y;
  const dot11 = v1x * v1x + v1y * v1y;
  const dot12 = v1x * v2x + v1y * v2y;
  const denom = dot00 * dot11 - dot01 * dot01;
  if (denom === 0) return false;
  const u = (dot11 * dot02 - dot01 * dot12) / denom;
  const v = (dot00 * dot12 - dot01 * dot02) / denom;
  return u >= 0 && v >= 0 && u + v <= 1;
};

const hitsShape = (shape: PadShape, point: PadPoint, slop: number): boolean => {
  if (shape.type === "ellipse") {
    const rx = shape.w / 2 + slop;
    const ry = shape.h / 2 + slop;
    if (rx <= 0 || ry <= 0) return false;
    const nx = (point.x - (shape.x + shape.w / 2)) / rx;
    const ny = (point.y - (shape.y + shape.h / 2)) / ry;
    return nx * nx + ny * ny <= 1;
  }
  if (shape.type === "triangle") {
    const [a, b, c] = trianglePoints(shape);
    if (pointInTriangle(point, a, b, c)) return true;
    return (
      distToSegment(point, a, b) <= slop ||
      distToSegment(point, b, c) <= slop ||
      distToSegment(point, c, a) <= slop
    );
  }
  return pointInRect(point, rectOf(shape), slop);
};

const hitsInk = (ink: PadInk, point: PadPoint, slop: number): boolean =>
  distToPolyline(point, ink.points) <= ink.width / 2 + slop;

const hitsPin = (pin: PadPin, point: PadPoint, slop: number): boolean =>
  hypot(point.x - pin.x, point.y - pin.y) <= PIN_MARKER_R + slop;

const sortZDesc = <T extends { readonly z: number }>(
  items: ReadonlyArray<T>,
): T[] =>
  items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => b.item.z - a.item.z || b.index - a.index)
    .map((entry) => entry.item);

export const hitTest = (
  pad: Pad,
  scenePt: PadPoint,
  slop = 0,
): PadHit | undefined => {
  const reach = slop > 0 ? slop : 0;
  for (let i = pad.pins.length - 1; i >= 0; i -= 1) {
    const pin = pad.pins[i]!;
    if (hitsPin(pin, scenePt, reach)) {
      return { id: pin.id, layer: "pin" };
    }
  }
  for (const ink of sortZDesc(pad.inks)) {
    if (hitsInk(ink, scenePt, reach)) {
      return { id: ink.id, layer: "ink" };
    }
  }
  for (const shape of sortZDesc(pad.shapes)) {
    if (hitsShape(shape, scenePt, reach)) {
      return { id: shape.id, layer: "shape" };
    }
  }
  for (let i = pad.edges.length - 1; i >= 0; i -= 1) {
    const edge = pad.edges[i]!;
    const points = edgePoints(pad, edge);
    if (points && distToPolyline(scenePt, points) <= reach) {
      return { id: edge.id, layer: "edge" };
    }
  }
  for (const image of sortZDesc(pad.images)) {
    if (pointInRect(scenePt, rectOf(image), reach)) {
      return { id: image.id, layer: "image" };
    }
  }
  return undefined;
};
