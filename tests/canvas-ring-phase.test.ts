// Section 10's phase test, formula level: at a frozen clock the canvas ring's
// angle is the DOM ring's angle. The DOM spin part is `junto-mark-turn` —
// rotate(0) to rotate(360), linear, infinite, delayed by --mark-t0 =
// -wall % MARK_PHASE_MS (ActivityMark.tsx syncPhase) — so its angle at wall
// time t is 360 * ((t mod lapMs) / lapMs), reversed when ccw. The canvas reads
// the same wall clock through sampleMotion; this holds the two together for
// every turning ring, sampled across the shared phase cycle.

import { describe, expect, it } from "vitest";
import { LoopRing, MARK_PHASE_MS, RING_MOTION } from "../src/shared/wire/rings";
import { sampleMotion } from "../src/window/canvas/paint/motion";
import type { QuadMotion } from "../src/window/canvas/contract";

/** The DOM rule: activity-atlas.ts motionCss + ActivityMark.tsx syncPhase. */
const domSpinAngle = (wallMs: number, lapMs: number, ccw: boolean | undefined): number => {
  const p = ((wallMs % lapMs) + lapMs) % lapMs / lapMs;
  const angle = 360 * (ccw === true ? 1 - p : p);
  return angle === 360 ? 0 : angle;
};

const turnMotionOf = (ring: (typeof LoopRing.Type)[]): ReadonlyArray<readonly [string, QuadMotion]> =>
  ring.flatMap((name) => {
    const motion = RING_MOTION[name];
    if (motion.spin === undefined) return [];
    const spin = motion.spin;
    return [
      [
        name,
        {
          kind: "turn",
          periodMs: spin.lapMs,
          ...(spin.ccw === true ? { ccw: true } : {}),
          ...(spin.fade === true ? { fade: true } : {}),
        },
      ] as const,
    ];
  });

describe("ring phase: canvas angle equals the DOM angle at a frozen clock", () => {
  const turning = turnMotionOf([...LoopRing.literals]);

  it("covers every ring that turns", () => {
    expect(turning.map(([name]) => name).sort()).toEqual(
      ["fracture", "glint", "reverse", "snake", "wait", "work"].sort(),
    );
  });

  for (const [name, motion] of turning) {
    it(`${name} shows the same angle across the phase cycle`, () => {
      const spin = RING_MOTION[name as (typeof LoopRing.Type)].spin!;
      // Frozen clocks: the cycle boundary, mid-lap, and a spread of wall times.
      const walls = [0, 1, MARK_PHASE_MS / 2, MARK_PHASE_MS - 1, MARK_PHASE_MS, MARK_PHASE_MS + 7_919];
      for (const wall of walls) {
        const got = sampleMotion(motion, wall).angle;
        const want = domSpinAngle(wall, spin.lapMs, spin.ccw);
        // --mark-t0 rounds to whole ms; the shortest lap is 1440 ms, so the
        // rounding can move the angle at most ~0.13 degrees.
        expect(Math.abs(got - want), `${name} at wall ${wall}`).toBeLessThan(0.2);
      }
    });
  }
});
