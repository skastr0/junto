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
