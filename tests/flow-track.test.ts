/**
 * The flows track: chevrons laid along a wire's straight runs, phased round
 * every corner, sliding on the compositor and never faded.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { roundedOrthogonalPath } from "../src/shared/wire-route";
import {
  flattenWirePath,
  TRACK_PERIOD,
  TRACK_PERIOD_MS,
  TRACK_SCALE,
  TRACK_WIDTH,
  trackClearances,
  trackHeight,
  trackFit,
  trackRuns,
  trackTile,
  WIRE_WIDTH,
} from "../src/renderer/lib/flow-track";

const css = readFileSync(join(resolve(__dirname, ".."), "src/renderer/components/edges/flow-track.css"), "utf8");

describe("flow track geometry", () => {
  it("is half again a wire's weight", () => {
    expect(TRACK_WIDTH).toBeCloseTo(WIRE_WIDTH * 1.5);
  });

  it("lays one run per straight stretch, source to target, with the distance walked to it", () => {
    const d = roundedOrthogonalPath([{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 120 }, { x: 60, y: 120 }], 8);
    const runs = trackRuns(d, TRACK_PERIOD);
    expect(runs.map((r) => Math.round(r.angle))).toEqual([0, 90, 180]);
    expect(runs[0]).toMatchObject({ x: 0, y: 0, at: 0 });
    expect(runs[0]!.length).toBeCloseTo(192);
    expect(runs[1]!.x).toBeCloseTo(200);
    expect(runs[1]!.y).toBeCloseTo(8);
    // The corner between them is walked, not laid: the next run starts past it.
    expect(runs[1]!.at).toBeGreaterThan(192 + 8);
    expect(runs[1]!.at).toBeLessThan(192 + 16);
    expect(runs[2]!.at).toBeGreaterThan(runs[1]!.at + runs[1]!.length);
  });

  it("points right to left when the dependency runs that way", () => {
    expect(trackRuns("M 300,40 L 20,40", TRACK_PERIOD)).toEqual([{ x: 300, y: 40, length: 280, angle: 180, at: 0 }]);
  });

  it("reads React Flow's smooth step grammar too", () => {
    const points = flattenWirePath("M10 20L50 20Q55 20 55 25L55 80");
    expect(points[0]).toEqual({ x: 10, y: 20 });
    expect(points.at(-1)).toEqual({ x: 55, y: 80 });
    expect(trackRuns("M10 20L50 20Q55 20 55 25L55 80", TRACK_PERIOD).map((r) => Math.round(r.angle))).toEqual([0, 90]);
  });

  it("skips stretches shorter than a period", () => {
    expect(trackRuns("M 0,0 L 10,0", TRACK_PERIOD)).toEqual([]);
  });

  it("keeps one run through a zero-length piece", () => {
    expect(trackRuns("M 554.5,497.8 L 415.5,497.8 L 415.5,497.8 L 276.5,497.8", TRACK_PERIOD)).toEqual([
      { x: 554.5, y: 497.8, length: 278, angle: 180, at: 0 },
    ]);
  });

  it("rides a lane stitch narrower than `jog` straight through, and steps at a wider one", () => {
    // The loom's 7-unit stitch between two lanes, rounded at both corners.
    const stitch = "M 281.5,90.8 L 413,90.8 Q 417,90.8 417,94 L 417,94.6 Q 417,97.8 421,97.8 L 560,97.8";
    expect(trackRuns(stitch, TRACK_PERIOD, 0).length).toBe(2);
    expect(trackRuns(stitch, TRACK_PERIOD, 6.2).length).toBe(2);
    const ridden = trackRuns(stitch, TRACK_PERIOD, trackHeight(3) / 2);
    expect(ridden).toHaveLength(1);
    expect(ridden[0]).toMatchObject({ x: 281.5, y: 90.8, angle: 0, at: 0 });
    expect(ridden[0]!.length).toBeCloseTo(278.5);
    // A real turn is never a stitch.
    const turn = roundedOrthogonalPath([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 120 }], 8);
    expect(trackRuns(turn, TRACK_PERIOD, 100)).toHaveLength(2);
  });

  it("finds the room beside each run: the nearest run alongside it on any track", () => {
    const room = trackClearances({
      in: [{ x: 304, y: 469.8, length: 364, angle: 0, at: 0 }],
      out: [{ x: 554.5, y: 497.8, length: 278, angle: 180, at: 0 }],
      // In line with `out` but past its end: not alongside anything.
      on: [{ x: 781.5, y: 497.8, length: 379, angle: 0, at: 0 }],
      // Crossing, not alongside.
      down: [{ x: 400, y: 300, length: 400, angle: 90, at: 0 }],
    });
    expect(room).toEqual({ in: [28], out: [28], on: [Infinity], down: [Infinity] });
  });

  it("draws crowded chevrons smaller to fit the room, keeping a stroke of ground between tracks", () => {
    expect(trackFit(1)).toBe(1);
    expect(trackFit(3)).toBe(3);
    expect(trackFit(1, 28)).toBe(1);
    for (const scale of [TRACK_SCALE.mid, TRACK_SCALE.far, TRACK_SCALE.overview]) {
      const fit = trackFit(scale, 28);
      expect(fit).toBeLessThanOrEqual(scale);
      expect(trackHeight(fit) + TRACK_WIDTH * fit).toBeLessThanOrEqual(28 + 1e-9);
    }
    // Mid has the room; far and overview shrink to it.
    expect(trackFit(TRACK_SCALE.mid, 28)).toBe(TRACK_SCALE.mid);
    expect(trackFit(TRACK_SCALE.far, 28)).toBeLessThan(TRACK_SCALE.far);
    // Never smaller than near, however tight.
    expect(trackFit(5, 2)).toBe(1);
    // The spacing stays the tier's: only the chevron shrinks.
    expect(decodeURIComponent(trackTile(5, 2))).toContain(`width="${TRACK_PERIOD * 5}"`);
  });

  it("grows as the camera pulls back, so a chevron keeps its size on screen", () => {
    expect(TRACK_SCALE.near).toBe(1);
    expect(TRACK_SCALE.mid).toBeGreaterThan(TRACK_SCALE.near);
    expect(TRACK_SCALE.far).toBeGreaterThan(TRACK_SCALE.mid);
    expect(TRACK_SCALE.overview).toBeGreaterThan(TRACK_SCALE.far);
    expect(decodeURIComponent(trackTile(3))).toContain(`stroke-width="${TRACK_WIDTH * 3}"`);
  });
});

describe("flow track motion and paint", () => {
  const keyframes = /@keyframes junto-flow-track \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";

  it("slides with transform alone, on the compositor", () => {
    expect(keyframes).not.toBe("");
    for (const decl of keyframes.matchAll(/([a-z-]+)\s*:/g)) expect(decl[1]).toBe("transform");
    expect(css).not.toMatch(/stroke-dashoffset|steps\(/);
  });

  it("loops forever at an even pace, every run on one clock", () => {
    expect(css).toContain(
      `[data-track-visible] > .junto-flow-track__mover {\n  animation: junto-flow-track ${TRACK_PERIOD_MS}ms linear var(--flow-track-t0, 0ms) infinite;`,
    );
  });

  it("stills only under reduced motion or a hidden window", () => {
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.junto-flow-track__run\[data-track-visible\] > \.junto-flow-track__mover \{ animation: none; \}/);
    expect(css).toMatch(/data-surface-motion="paused"\] \.junto-flow-track__run > \.junto-flow-track__mover \{\s*animation-play-state: paused;/);
  });

  it("is never faded", () => {
    expect(css.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/opacity/);
  });
});
