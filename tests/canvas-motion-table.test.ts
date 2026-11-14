// Section 10's motion lock, canvas side: the engine's motion table is built
// from RING_MOTION and BAND_PERIOD_MS and holds no numbers of its own. Every
// period a ring or band quad carries must be one the shared tables name —
// a literal tempo in canvas code fails here.

import { describe, expect, it } from "vitest";
import {
  ActivityGlyph,
  RING_MOTION,
  ringState,
  type LoopRing,
} from "../src/shared/wire/rings";
import { BAND_PERIOD_MS, type BandMotion } from "../src/window/lib/kind-band";
import { bandMotion, ringQuads } from "../src/window/canvas/paint/motion";
import type { Quad, QuadMotion, Rect } from "../src/window/canvas/contract";

const CARD: Rect = { x: 0, y: 0, width: 216, height: 56 };

/** Every period the shared ring table names. */
const RING_PERIODS: ReadonlySet<number> = new Set(
  (Object.keys(RING_MOTION) as LoopRing[]).flatMap((ring) => {
    const motion = RING_MOTION[ring];
    return [motion.spin?.lapMs, motion.pulse?.ms].filter((ms): ms is number => ms !== undefined);
  }),
);

const periodOf = (motion: QuadMotion | undefined): number | undefined =>
  motion !== undefined && "periodMs" in motion ? motion.periodMs : undefined;

const quadsOf = (glyph: (typeof ActivityGlyph.Type)[]): ReadonlyArray<Quad> =>
  glyph.flatMap((name) => {
    const state = ringState({ glyph: name, tone: "cyan" });
    const { under, over } = ringQuads(state, 0, CARD, { kind: "board" }, "lock", 0);
    return [...under, ...over];
  });

describe("motion lock: the canvas motion table holds no numbers of its own", () => {
  it("every ring quad's period is a RING_MOTION number", () => {
    const periods = quadsOf([...ActivityGlyph.literals])
      .map((quad) => periodOf(quad.motion))
      .filter((ms): ms is number => ms !== undefined);
    expect(periods.length).toBeGreaterThan(0);
    for (const ms of periods) {
      expect(RING_PERIODS.has(ms), `period ${ms} is not in RING_MOTION`).toBe(true);
    }
  });

  it("the turning rings still turn, and a pulse still pulses", () => {
    const kinds = quadsOf([...ActivityGlyph.literals])
      .map((quad) => quad.motion?.kind)
      .filter((kind) => kind !== undefined);
    expect(kinds).toContain("turn");
    expect(kinds.some((kind) => kind === "send" || kind === "beat" || kind === "breathe")).toBe(true);
  });

  it("every band motion's period is a BAND_PERIOD_MS number", () => {
    const bands = Object.keys(BAND_PERIOD_MS) as BandMotion[];
    expect(bands.length).toBeGreaterThan(0);
    for (const band of bands) {
      const motion = bandMotion(band);
      expect(periodOf(motion), band).toBe(BAND_PERIOD_MS[band]);
    }
  });
});
