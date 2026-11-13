/**
 * The fallback elbow: the wire drawn when the router answers null (an open
 * field) or while a card is dragged. Today it is React Flow's
 * `getSmoothStepPath` with `borderRadius: 8` and its defaults, `offset: 20`
 * and `stepPosition: 0.5` (WireEdge.tsx:83-94); this is that path as points,
 * so the GPU canvas draws the same elbow without React Flow.
 *
 * `elbowPoints` is `getPoints` from @xyflow/system 0.0.79 (index.js:1184-1305)
 * line for line: the corners, and the label point React Flow returns beside
 * the path. `elbowPath` is the path string `getSmoothStepPath` builds from
 * them (`getBend`, index.js:1306-1323), which the flow track and the pulse
 * planner read for parity with today's paint.
 *
 * Pure geometry. No React, no React Flow.
 */

import type { WireDirection } from "@shared/wire-route";
import type { Point } from "../../contract";

/** React Flow's default run straight out of a handle before the first bend. */
export const ELBOW_OFFSET = 20;
/** The corner radius Junto passes (WireEdge.tsx:93). */
export const ELBOW_RADIUS = 8;

export type ElbowInput = {
  readonly source: Point;
  readonly sourceSide: WireDirection;
  readonly target: Point;
  readonly targetSide: WireDirection;
};

export type Elbow = {
  /** Source to target, every corner, no duplicates React Flow would skip. */
  readonly points: ReadonlyArray<Point>;
  /** React Flow's `labelX`, `labelY`. */
  readonly label: Point;
};

const DIRECTION: Readonly<Record<WireDirection, Point>> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
};

type Mutable = { x: number; y: number };

export const elbowPoints = (input: ElbowInput, offset = ELBOW_OFFSET): Elbow => {
  const { source, target, sourceSide, targetSide } = input;
  const sourceDir = DIRECTION[sourceSide];
  const targetDir = DIRECTION[targetSide];
  const sourceGapped = { x: source.x + sourceDir.x * offset, y: source.y + sourceDir.y * offset };
  const targetGapped = { x: target.x + targetDir.x * offset, y: target.y + targetDir.y * offset };
  const dir =
    sourceSide === "left" || sourceSide === "right"
      ? { x: sourceGapped.x < targetGapped.x ? 1 : -1, y: 0 }
      : { x: 0, y: sourceGapped.y < targetGapped.y ? 1 : -1 };
  const axis: "x" | "y" = dir.x !== 0 ? "x" : "y";
  const currDir = dir[axis];
  let points: Point[];
  let centerX: number;
  let centerY: number;
  const sourceGapOffset: Mutable = { x: 0, y: 0 };
  const targetGapOffset: Mutable = { x: 0, y: 0 };

  if (sourceDir[axis] * targetDir[axis] === -1) {
    // Opposite handles: the default case, split at stepPosition 0.5.
    if (axis === "x") {
      centerX = sourceGapped.x + (targetGapped.x - sourceGapped.x) * 0.5;
      centerY = (sourceGapped.y + targetGapped.y) / 2;
    } else {
      centerX = (sourceGapped.x + targetGapped.x) / 2;
      centerY = sourceGapped.y + (targetGapped.y - sourceGapped.y) * 0.5;
    }
    const verticalSplit = [
      { x: centerX, y: sourceGapped.y },
      { x: centerX, y: targetGapped.y },
    ];
    const horizontalSplit = [
      { x: sourceGapped.x, y: centerY },
      { x: targetGapped.x, y: centerY },
    ];
    if (sourceDir[axis] === currDir) points = axis === "x" ? verticalSplit : horizontalSplit;
    else points = axis === "x" ? horizontalSplit : verticalSplit;
  } else {
    // x from source and y from target, or the other way round.
    const sourceTarget = [{ x: sourceGapped.x, y: targetGapped.y }];
    const targetSource = [{ x: targetGapped.x, y: sourceGapped.y }];
    if (axis === "x") points = sourceDir.x === currDir ? targetSource : sourceTarget;
    else points = sourceDir.y === currDir ? sourceTarget : targetSource;
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
    }
    if (sourceSide !== targetSide) {
      const opposite: "x" | "y" = axis === "x" ? "y" : "x";
      const isSameDir = sourceDir[axis] === targetDir[opposite];
      const sourceGt = sourceGapped[opposite] > targetGapped[opposite];
      const sourceLt = sourceGapped[opposite] < targetGapped[opposite];
      const flip =
        (sourceDir[axis] === 1 && ((!isSameDir && sourceGt) || (isSameDir && sourceLt))) ||
        (sourceDir[axis] !== 1 && ((!isSameDir && sourceLt) || (isSameDir && sourceGt)));
      if (flip) points = axis === "x" ? sourceTarget : targetSource;
    }
    const sourceGapPoint = { x: sourceGapped.x + sourceGapOffset.x, y: sourceGapped.y + sourceGapOffset.y };
    const targetGapPoint = { x: targetGapped.x + targetGapOffset.x, y: targetGapped.y + targetGapOffset.y };
    const first = points[0]!;
    const maxXDistance = Math.max(Math.abs(sourceGapPoint.x - first.x), Math.abs(targetGapPoint.x - first.x));
    const maxYDistance = Math.max(Math.abs(sourceGapPoint.y - first.y), Math.abs(targetGapPoint.y - first.y));
    // The label sits on the longest segment.
    if (maxXDistance >= maxYDistance) {
      centerX = (sourceGapPoint.x + targetGapPoint.x) / 2;
      centerY = first.y;
    } else {
      centerX = first.x;
      centerY = (sourceGapPoint.y + targetGapPoint.y) / 2;
    }
  }

  const gappedSource = { x: sourceGapped.x + sourceGapOffset.x, y: sourceGapped.y + sourceGapOffset.y };
  const gappedTarget = { x: targetGapped.x + targetGapOffset.x, y: targetGapped.y + targetGapOffset.y };
  const head = points[0]!;
  const tail = points[points.length - 1]!;
  return {
    points: [
      { x: source.x, y: source.y },
      ...(gappedSource.x !== head.x || gappedSource.y !== head.y ? [gappedSource] : []),
      ...points,
      ...(gappedTarget.x !== tail.x || gappedTarget.y !== tail.y ? [gappedTarget] : []),
      { x: target.x, y: target.y },
    ],
    label: { x: centerX, y: centerY },
  };
};

/** `getBend`'s corner: none when the three points are in line, else rounded by the shorter half leg. */
export const elbowBend = (a: Point, b: Point, c: Point, size = ELBOW_RADIUS): number | null => {
  if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) return null;
  return Math.min(Math.hypot(b.x - a.x, b.y - a.y) / 2, Math.hypot(c.x - b.x, c.y - b.y) / 2, size);
};

/** The path string `getSmoothStepPath` returns for these points, character for character. */
export const elbowPath = (points: ReadonlyArray<Point>, size = ELBOW_RADIUS): string => {
  if (points.length === 0) return "";
  let path = `M${points[0]!.x} ${points[0]!.y}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const c = points[i + 1]!;
    const bend = elbowBend(a, b, c, size);
    if (bend === null) {
      path += `L${b.x} ${b.y}`;
    } else if (a.y === b.y) {
      const xDir = a.x < c.x ? -1 : 1;
      const yDir = a.y < c.y ? 1 : -1;
      path += `L ${b.x + bend * xDir},${b.y}Q ${b.x},${b.y} ${b.x},${b.y + bend * yDir}`;
    } else {
      const xDir = a.x < c.x ? 1 : -1;
      const yDir = a.y < c.y ? -1 : 1;
      path += `L ${b.x},${b.y + bend * yDir}Q ${b.x},${b.y} ${b.x + bend * xDir},${b.y}`;
    }
  }
  const last = points[points.length - 1]!;
  path += `L${last.x} ${last.y}`;
  return path;
};
