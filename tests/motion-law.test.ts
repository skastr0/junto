/**
 * Motion law: the rings are painted live, every display frame, and nothing
 * may slow, step, throttle or still them to save frames.
 *
 * Animation has never been where this app's time goes. On 2026-10-09 a
 * performance pass stepped the rings once a second (0a59c634c) on an
 * unmeasured guess, and the seat rings jerked like a clock hand. This file
 * is the lock against that happening again. Weakening, skipping or deleting
 * any assertion here needs the operator's own sign-off, named in the commit;
 * a performance finding is never that sign-off.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  liveRingCount,
  resetLiveRingsForTests,
  ringFrameAt,
  startLiveRing,
} from "../src/renderer/lib/activity-live";
import { RING_CYCLE_FRAMES, RING_FRAME_MS } from "../src/renderer/lib/activity-rings";
import { surfaceMotionLive$ } from "../src/renderer/lib/surface-motion";

const root = resolve(__dirname, "..");
const read = (rel: string): string => readFileSync(join(root, rel), "utf8");

const filesUnder = (dir: string): string[] =>
  readdirSync(join(root, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    return statSync(join(root, rel)).isDirectory() ? filesUnder(rel) : [rel];
  });

describe("motion law: rings flow at the display's rate", () => {
  it("the phase is continuous: every display frame of a cycle draws a new pose", () => {
    const vsync = 1000 / 60;
    const frames = Math.round((RING_CYCLE_FRAMES * RING_FRAME_MS) / vsync);
    const poses = new Set<number>();
    for (let i = 0; i < frames; i += 1) poses.add(ringFrameAt(i * vsync));
    expect(poses.size).toBe(frames);
    expect(Number.isInteger(ringFrameAt(vsync))).toBe(false);
  });

  it("the tempo holds: a working ring laps in 1.44 s, every loop cycles in 2.88 s", () => {
    expect(RING_FRAME_MS).toBeLessThanOrEqual(90);
    expect(RING_CYCLE_FRAMES * RING_FRAME_MS).toBeLessThanOrEqual(2880);
  });

  it("the live painter runs on requestAnimationFrame, with no timer and no rounding", () => {
    const source = read("src/renderer/lib/activity-live.ts");
    expect(source).toMatch(/requestAnimationFrame\(frame\)/);
    expect(source).not.toMatch(/\bset(Interval|Timeout)\s*\(/);
    const phase = source.match(/export const ringFrameAt = [^\n]*/)?.[0] ?? "";
    expect(phase).not.toBe("");
    expect(phase).not.toMatch(/Math\.(floor|round|trunc|ceil)/);
  });

  it("no frame-stamping clock comes back to step the rings", () => {
    for (const rel of filesUnder("src/renderer")) {
      if (!/\.(ts|tsx|css)$/.test(rel)) continue;
      const source = read(rel);
      expect(source, rel).not.toMatch(/data-mark-frame|dataset\.markFrame|attention-clock/);
    }
    const sheet = [read("src/renderer/lib/activity-atlas.ts"), read("src/renderer/components/factory-minimap.css")];
    for (const css of sheet) expect(css).not.toMatch(/steps\(/);
  });
});

describe("motion law: the live loop paints every frame", () => {
  type Callback = (t: number) => void;
  let queue: Callback[] = [];
  let paints = 0;
  const saved: Record<string, unknown> = {};

  const fakeCtx = new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === "clearRect") return () => (paints += 1);
        return () => undefined;
      },
      set: () => true,
    },
  );

  const fakeMark = () => {
    const attrs = new Map<string, string>();
    return {
      attrs,
      prepend: () => undefined,
      closest: () => null,
      getBoundingClientRect: () => ({ width: 52 }),
      setAttribute: (k: string, v: string) => attrs.set(k, v),
      removeAttribute: (k: string) => attrs.delete(k),
    };
  };

  beforeEach(() => {
    const g = globalThis as Record<string, unknown>;
    for (const key of ["document", "requestAnimationFrame", "cancelAnimationFrame", "window"]) saved[key] = g[key];
    g.document = {
      createElement: () => ({
        hidden: false,
        width: 0,
        height: 0,
        className: "",
        setAttribute: () => undefined,
        remove: () => undefined,
        getContext: () => fakeCtx,
      }),
    };
    g.window = { devicePixelRatio: 2 };
    g.requestAnimationFrame = (cb: Callback) => {
      queue.push(cb);
      return queue.length;
    };
    g.cancelAnimationFrame = () => {
      queue = [];
    };
  });

  afterEach(() => {
    resetLiveRingsForTests();
    surfaceMotionLive$.set(true);
    const g = globalThis as Record<string, unknown>;
    for (const [key, value] of Object.entries(saved)) g[key] = value;
    queue = [];
    paints = 0;
  });

  const runFrames = (n: number, from = 0): void => {
    for (let i = 0; i < n; i += 1) {
      const next = queue.shift();
      if (!next) return;
      next(from + i * (1000 / 120));
    }
  };

  it("repaints a working ring on every display frame, at 120 Hz as at 60", () => {
    const el = fakeMark();
    startLiveRing(el as unknown as HTMLElement, { ring: "work", tone: "cyan", theme: "dark", land: false });
    const first = paints;
    runFrames(120);
    expect(paints - first).toBe(120);
    expect(queue.length).toBe(1);
    expect(el.attrs.has("data-mark-live")).toBe(true);
  });

  it("pauses only for a hidden window or reduced motion, and resumes", () => {
    const el = fakeMark();
    startLiveRing(el as unknown as HTMLElement, { ring: "halt", tone: "crimson", theme: "dark", land: false });
    surfaceMotionLive$.set(false);
    runFrames(5);
    const paused = paints;
    runFrames(5);
    expect(paints).toBe(paused);
    expect(el.attrs.has("data-mark-live")).toBe(false);
    surfaceMotionLive$.set(true);
    runFrames(10);
    expect(paints - paused).toBe(10);
    expect(liveRingCount()).toBe(1);
  });
});
