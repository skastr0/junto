/**
 * Canvas wire path — the polyline a wire runs along, for a canvas drawn away
 * from the desktop window (the phone's projection).
 *
 * Same geometry the desktop paints: sides from the wire's authored sides, else
 * from where the two cards sit (wireSides); the route from routeWire with the
 * desktop's per-wire clearance; and where routeWire answers null for an open
 * field, the corners of the smooth step the desktop falls back to (xyflow
 * getSmoothStepPath, offset 20, borderRadius 8). The receiver rounds every
 * corner by `radius`.
 *
 * Pure geometry. No React / xyflow.
 */
import {
  routeWire,
  simplifyPolyline,
  type WireDirection,
  type WirePoint,
  type WireRect,
} from "./wire-route";
import { wireSides } from "./wire-sides";

export type WirePathInput = {
  readonly from: WireRect;
  readonly to: WireRect;
  readonly fromSide?: WireDirection;
  readonly toSide?: WireDirection;
  /** The other cards on the canvas. A rect equal to either end is ignored. */
  readonly obstacles: ReadonlyArray<WireRect>;
};

export type WirePath = {
  readonly points: WirePoint[];
  readonly radius: 8;
};

/** The desktop's per-wire route (loom-view planStandaloneRoutes). */
const PADDING = 14;
const RADIUS = 8;
/** xyflow getSmoothStepPath's default run straight out of a handle. */
const STEP_OFFSET = 20;
const MAX_POINTS = 256;

const DIRECTION: Readonly<Record<WireDirection, WirePoint>> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
};

const anchorOn = (rect: WireRect, side: WireDirection): WirePoint => {
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

const sameRect = (a: WireRect, b: WireRect): boolean =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/**
 * The points xyflow's getSmoothStepPath bends through (its getPoints, at
 * stepPosition 0.5 with no centre given), source and target included.
 */
const smoothStepPoints = (
  source: WirePoint,
  sourceSide: WireDirection,
  target: WirePoint,
  targetSide: WireDirection,
): WirePoint[] => {
  const offset = STEP_OFFSET;
  const sourceDir = DIRECTION[sourceSide];
  const targetDir = DIRECTION[targetSide];
  const sourceGapped = { x: source.x + sourceDir.x * offset, y: source.y + sourceDir.y * offset };
  const targetGapped = { x: target.x + targetDir.x * offset, y: target.y + targetDir.y * offset };
  const dir =
    sourceSide === "left" || sourceSide === "right"
      ? { x: sourceGapped.x < targetGapped.x ? 1 : -1, y: 0 }
      : { x: 0, y: sourceGapped.y < targetGapped.y ? 1 : -1 };
  const axis: "x" | "y" = dir.x !== 0 ? "x" : "y";
  const opposite: "x" | "y" = axis === "x" ? "y" : "x";
  const currDir = dir[axis];
  let points: WirePoint[];
  const sourceGapOffset = { x: 0, y: 0 };
  const targetGapOffset = { x: 0, y: 0 };

  if (sourceDir[axis] * targetDir[axis] === -1) {
    const centerX =
      axis === "x"
        ? sourceGapped.x + (targetGapped.x - sourceGapped.x) * 0.5
        : (sourceGapped.x + targetGapped.x) / 2;
    const centerY =
      axis === "x"
        ? (sourceGapped.y + targetGapped.y) / 2
        : sourceGapped.y + (targetGapped.y - sourceGapped.y) * 0.5;
    const verticalSplit = [
      { x: centerX, y: sourceGapped.y },
      { x: centerX, y: targetGapped.y },
    ];
    const horizontalSplit = [
      { x: sourceGapped.x, y: centerY },
      { x: targetGapped.x, y: centerY },
    ];
    if (sourceDir[axis] === currDir) {
      points = axis === "x" ? verticalSplit : horizontalSplit;
    } else {
      points = axis === "x" ? horizontalSplit : verticalSplit;
    }
  } else {
    const sourceTarget = [{ x: sourceGapped.x, y: targetGapped.y }];
    const targetSource = [{ x: targetGapped.x, y: sourceGapped.y }];
    if (axis === "x") {
      points = sourceDir.x === currDir ? targetSource : sourceTarget;
    } else {
      points = sourceDir.y === currDir ? sourceTarget : targetSource;
    }
    if (sourceSide === targetSide) {
      const diff = Math.abs(source[axis] - target[axis]);
      if (diff <= offset) {
        const gapOffset = Math.min(offset - 1, offset - diff);
        if (sourceDir[axis] === currDir) {
          sourceGapOffset[axis] = (sourceGapped[axis] > source[axis] ? -1 : 1) * gapOffset;
        } else {
          targetGapOffset[axis] = (targetGapped[axis] > target[axis] ? -1 : 1) * gapOffset;
        }
      }
    } else {
      const isSameDir = sourceDir[axis] === targetDir[opposite];
      const sourceGtTarget = sourceGapped[opposite] > targetGapped[opposite];
      const sourceLtTarget = sourceGapped[opposite] < targetGapped[opposite];
      const flip =
        (sourceDir[axis] === 1 && ((!isSameDir && sourceGtTarget) || (isSameDir && sourceLtTarget))) ||
        (sourceDir[axis] !== 1 && ((!isSameDir && sourceLtTarget) || (isSameDir && sourceGtTarget)));
      if (flip) points = axis === "x" ? sourceTarget : targetSource;
    }
  }

  const gappedSource = { x: sourceGapped.x + sourceGapOffset.x, y: sourceGapped.y + sourceGapOffset.y };
  const gappedTarget = { x: targetGapped.x + targetGapOffset.x, y: targetGapped.y + targetGapOffset.y };
  return [source, gappedSource, ...points, gappedTarget, target];
};

/** The polyline a wire from `from` to `to` runs along, and the radius its corners round by. */
export const wirePath = (input: WirePathInput): WirePath => {
  const computed =
    input.fromSide && input.toSide ? undefined : wireSides(input.from, input.to);
  const fromSide = input.fromSide ?? computed!.source;
  const toSide = input.toSide ?? computed!.target;
  const source = anchorOn(input.from, fromSide);
  const target = anchorOn(input.to, toSide);
  const obstacles = input.obstacles.filter(
    (rect) => !sameRect(rect, input.from) && !sameRect(rect, input.to),
  );
  const routed = routeWire({
    source,
    target,
    obstacles,
    padding: PADDING,
    borderRadius: RADIUS,
    sourceDirection: fromSide,
    targetDirection: toSide,
  });
  if (routed && routed.points.length <= MAX_POINTS) {
    return { points: routed.points.map(({ x, y }) => ({ x, y })), radius: RADIUS };
  }
  // Corners only: the receiver rounds them, as getBend does on the desktop.
  // Exact merge, so a sub-pixel step xyflow draws stays square.
  const corners = simplifyPolyline(smoothStepPoints(source, fromSide, target, toSide), 0);
  return { points: corners.map(({ x, y }) => ({ x, y })), radius: RADIUS };
};
