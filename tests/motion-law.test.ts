/**
 * Motion law: rings move every display frame, nothing may slow, step,
 * throttle or still them to save frames, and the motion never runs on the
 * main thread.
 *
 * History. On 2026-10-09 a performance pass stepped the rings once a second
 * (0a59c634c) on an unmeasured guess, and the seat rings jerked like a clock
 * hand. Then the rings were painted live by a requestAnimationFrame loop on
 * the main thread, which lagged panning and the terminal stream. With the
 * operator's sign-off the rings now run on the compositor: still parts baked
 * once into the atlas, turned and faded with transform and opacity alone.
 * Weakening, skipping or deleting any assertion here needs the operator's
 * own sign-off, named in the commit; a performance finding is never that
 * sign-off.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { markAtlasCss, ringCells } from "../src/renderer/lib/activity-atlas";
import { coversMark } from "../src/renderer/lib/mark-occlusion";
import { MARK_PHASE_MS, RING_CYCLE_FRAMES, RING_FRAME_MS, RING_MOTION, type LoopRing } from "../src/shared/rings";

const root = resolve(__dirname, "..");
const read = (rel: string): string => readFileSync(join(root, rel), "utf8");

const filesUnder = (dir: string): string[] =>
  readdirSync(join(root, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    return statSync(join(root, rel)).isDirectory() ? filesUnder(rel) : [rel];
  });

const LOOPS = Object.keys(RING_MOTION) as LoopRing[];
const RING_SOURCES = [
  "src/shared/rings.ts",
  "src/renderer/lib/activity-atlas.ts",
  "src/renderer/lib/activity-rings.ts",
  "src/renderer/components/ActivityMark.tsx",
  "src/renderer/lib/mark-occlusion.ts",
];

/** Every @keyframes block in the ring sheet, by name. */
const keyframes = (css: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const m of css.matchAll(/@keyframes ([\w-]+)\{((?:[^{}]*\{[^{}]*\})*)\}/g)) out.set(m[1]!, m[2]!);
  return out;
};

describe("motion law: rings move on the compositor", () => {
  it("every moving ring has a part that moves: none is stilled", () => {
    for (const ring of LOOPS) {
      const motion = RING_MOTION[ring];
      expect(motion.spin ?? motion.pulse, ring).toBeDefined();
    }
  });

  it("ring keyframes animate transform and opacity only, never a repaint", () => {
    const frames = keyframes(markAtlasCss());
    expect(frames.size).toBeGreaterThan(0);
    for (const [name, body] of frames) {
      for (const decl of body.matchAll(/([a-z-]+)\s*:/g)) {
        expect(["transform", "opacity", "animation-timing-function"], `${name}: ${decl[1]!}`).toContain(decl[1]);
      }
    }
  });

  it("every ring part loops forever on one shared clock, with no steps", () => {
    const css = markAtlasCss();
    expect(css).toMatch(/\.junto-mark__part\{[^}]*animation-iteration-count:infinite/);
    expect(css).toMatch(/\.junto-mark__part\{[^}]*animation-delay:var\(--mark-t0/);
    expect(css).not.toMatch(/steps\(/);
    for (const ring of LOOPS) {
      const { spin, pulse } = RING_MOTION[ring];
      for (const ms of [spin?.lapMs, pulse?.ms]) {
        if (ms !== undefined) expect(MARK_PHASE_MS % ms, ring).toBe(0);
      }
    }
  });

  it("the tempo holds: a working ring laps in 1.44 s, every loop cycles in 2.88 s", () => {
    expect(RING_MOTION.work.spin?.lapMs).toBe(1440);
    expect(RING_FRAME_MS).toBeLessThanOrEqual(90);
    expect(RING_CYCLE_FRAMES * RING_FRAME_MS).toBeLessThanOrEqual(2880);
    expect(RING_MOTION.halt.pulse?.ms).toBe(1440);
    expect(RING_MOTION.dot.pulse?.ms).toBe(2880);
  });

  it("a moving mark carries its parts; only paused motion shows the rest pose", () => {
    for (const glyph of ["work", "call", "halt", "dot", "live", "done"] as const) {
      const { core } = ringCells({ glyph, tone: "cyan", animate: true });
      expect(core.parts, glyph).toBeDefined();
    }
    const css = markAtlasCss();
    expect(css).toContain(`html:not([data-surface-motion="paused"]) .junto-mark[data-mark-visible]>.junto-mark__part{display:block}`);
    expect(css).toMatch(/\.junto-mark__part\{display:none;/);
  });

  it("no main-thread frame loop or timer drives a ring", () => {
    for (const rel of RING_SOURCES) {
      const source = read(rel);
      expect(source, rel).not.toMatch(/requestAnimationFrame|\bset(Interval|Timeout)\s*\(/);
    }
    expect(() => read("src/renderer/lib/activity-live.ts")).toThrow();
  });

  // The operator's third exception (signal 01M630R3Y59C42SSY754K3ADZZ): a ring
  // no one can see because an opaque surface wholly covers it.
  it("a ring stops only when wholly covered: partly covered or over the surface, it keeps running", () => {
    const covered = { intersectionRatio: 1, withinBox: true, ownedBySurface: false, surfaceOnTop: true };
    expect(coversMark(covered)).toBe(true);
    // Partly covered: any part of the mark outside the surface's box, at any ratio.
    for (const ratio of [1, 0.999, 0.5, 0.01]) expect(coversMark({ ...covered, intersectionRatio: ratio, withinBox: false }), String(ratio)).toBe(false);
    for (const ratio of [0.98, 0.5, 0.01]) expect(coversMark({ ...covered, intersectionRatio: ratio }), String(ratio)).toBe(false);
    expect(coversMark({ ...covered, surfaceOnTop: false })).toBe(false);
    expect(coversMark({ ...covered, ownedBySurface: true })).toBe(false);
  });

  it("a ring shown again goes back on the shared clock in the same task", () => {
    const source = read("src/renderer/components/ActivityMark.tsx");
    expect(source).toMatch(/const showIfSeen = \(el: HTMLElement\): void => setVisible\(el, intersecting\.has\(el\) && !isCovered\(el\)\)/);
    expect(source).toMatch(/if \(on && !visible\.has\(el\)\) \{\s*syncPhase\(el\);/);
  });

  // A ring clipped to nothing has no compositor layer, so Blink ticks it on the
  // main thread and re-layerizes the whole board every frame (canvas-scale lab,
  // 2026-10-29: the attached terminal's screen-reader status, 53 full updates/s).
  it("no ring sits in a box that is never drawn", () => {
    const source = read("src/renderer/components/terminal/TerminalSurface.tsx");
    expect(source).toMatch(/attached \? "sr-only" : ""/);
    expect(source).toMatch(/\{attached \? null : \(\s*<ActivityMark/);
  });

  // A ring or run inside a margin but off screen is culled from paint and fails
  // the same way (canvas-scale lab, 2026-10-29: one such ring, 115/s). Operator
  // signal 01M63W6RQY1YT2Q65MCM0N3YQ8: an entering ring may show its rest pose
  // for a frame.
  it("a ring or track run moves only on screen: its observer has no margin", () => {
    for (const rel of ["src/renderer/components/ActivityMark.tsx", "src/renderer/components/edges/FlowTrack.tsx"]) {
      const source = read(rel);
      expect(source, rel).toMatch(/\{ rootMargin: "0px" \}/);
      expect(source, rel).not.toMatch(/rootMargin: "[1-9-]/);
      // A threshold above 0 would stop a ring that is partly on screen.
      expect(source, rel).not.toMatch(/threshold\s*:/);
    }
  });

  it("the motion law lets motion no one can see stop, and names where", () => {
    const law = read("AGENTS.md");
    expect(law).toMatch(/motion\s+no\s+one\s+can\s+see\s+may\s+stop/);
    expect(law).toMatch(/off\s+screen\s+or\s+clipped\s+to\s+nothing/);
    expect(law).toMatch(/rest\s+pose\s+for\s+one\s+frame/);
    expect(law).toMatch(/partly\s+on\s+screen,\s+keeps\s+turning\s+every\s+frame/);
    expect(law).toMatch(/hidden\s+window/);
    expect(law).toMatch(/reduced\s+motion/);
    expect(law).toMatch(/wholly\s+under\s+an\s+opaque\s+surface/);
  });

  it("the wire pulse travels on the compositor: transform alone, no stroke repaint", () => {
    const sheet = read("src/renderer/components/edges/wire-pulse.css");
    expect(sheet).not.toMatch(/stroke-dash(offset|array)/);
    for (const name of ["wire-pulse-forward", "wire-pulse-reverse"]) {
      const body = keyframes(sheet.replace(/\s+/g, " ").replace(/ ?([{}:;]) ?/g, "$1")).get(name);
      expect(body, name).toBeDefined();
      for (const decl of body!.matchAll(/([a-z-]+)\s*:/g)) expect(decl[1], name).toBe("transform");
    }
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
