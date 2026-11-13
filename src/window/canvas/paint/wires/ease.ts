/**
 * CSS `cubic-bezier()` timing, solved the way browsers solve it: for a time
 * fraction x, find the curve parameter whose x is x (Newton first, bisection
 * when Newton stalls), then return that parameter's y. The control points are
 * the theme's `EASING` numbers, so a wire's motion here and the DOM's
 * `var(--ease-*)` are one curve.
 *
 * Pure. No DOM.
 */

export type Bezier = readonly [x1: number, y1: number, x2: number, y2: number];

const EPSILON = 1e-7;

/** The easing as a function of the time fraction, 0 to 1 in, progress out. */
export const cubicBezier = (curve: Bezier): ((x: number) => number) => {
  const [x1, y1, x2, y2] = curve;
  // Polynomial coefficients of B(t) = ((a t + b) t + c) t, per axis.
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number): number => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number): number => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number): number => (3 * ax * t + 2 * bx) * t + cx;
  const solve = (x: number): number => {
    let t = x;
    for (let i = 0; i < 8; i += 1) {
      const error = sampleX(t) - x;
      if (Math.abs(error) < EPSILON) return t;
      const slope = slopeX(t);
      if (Math.abs(slope) < 1e-6) break;
      t -= error / slope;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    while (lo < hi) {
      const value = sampleX(t);
      if (Math.abs(value - x) < EPSILON) return t;
      if (x > value) lo = t;
      else hi = t;
      const next = (lo + hi) / 2;
      if (next === t) break;
      t = next;
    }
    return t;
  };
  return (x: number): number => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return sampleY(solve(x));
  };
};
