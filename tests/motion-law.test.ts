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

  // Operator signal 01M63W6RQY1YT2Q65MCM0N3YQ8: motion no one can see stops.
  it("a parked pane's spinners stop: the pane is opacity 0 and off screen", () => {
    const css = read("src/renderer/styles.css");
    expect(css).toMatch(/\.workbench-pane--parked \{[^}]*opacity: 0;/);
    expect(css).toMatch(/\.workbench-pane--parked :is\(\.session-load__spinner, \.content-media__spin, \.animate-spin\) \{\s*animation: none !important;/);
  });

  it("a reach preview ring on a card hidden at overview or in a cluster does not breathe", () => {
    const css = read("src/renderer/styles/reach-preview.css");
    expect(css).toMatch(
      /html\[data-canvas-tier="overview"\] \.react-flow__viewport \.react-flow__node:not\(\.react-flow__node-group\):not\(\.junto-flow-agent\):not\(:has\(\.kind-seat\)\)\[data-reach-preview\]::before \{ animation: none; \}/,
    );
    const cluster = read("src/renderer/components/SeatClusterLayer.tsx");
    expect(cluster).toMatch(/\{ visibility: hidden !important; \}/);
    expect(cluster).toMatch(/`\$\{node\}::before`\)\.join\(",\\n"\)\} \{ animation: none !important; \}/);
  });

  it("a media spinner on a card whose body is not drawn at far or overview stops", () => {
    const css = read("src/renderer/components/work/content-media.css").replace(/\s+/g, " ");
    // Each selector mirrors a hide rule; if a hide rule changes, so must this.
    const lod = read("src/renderer/styles/canvas-lod.css");
    expect(lod).toContain(
      `html:is([data-canvas-tier="far"], [data-canvas-tier="overview"]) .react-flow__viewport .junto-node:not([data-bare]):not(:is([data-node-kind="agent"], :has(.kind-seat))):not([data-look="spine"]) > * {\n  visibility: hidden;`,
    );
    for (const hidden of [
      `html:is([data-canvas-tier="far"], [data-canvas-tier="overview"]) .react-flow__viewport .junto-node:not([data-bare]):not(:is([data-node-kind="agent"], :has(.kind-seat))):not([data-look="spine"]) .content-media__spin`,
      `html:is([data-canvas-tier="far"], [data-canvas-tier="overview"]) .junto-node[data-look="spine"][data-node-kind="text"] .junto-node__body .content-media__spin`,
      `html[data-canvas-tier="overview"] .react-flow__viewport .react-flow__node:not(.react-flow__node-group):not(.junto-flow-agent):not(:has(.kind-seat)) .content-media__spin`,
    ]) {
      expect(css).toContain(hidden);
    }
    expect(css).toMatch(/\.react-flow__node:not\(\.react-flow__node-group\):not\(\.junto-flow-agent\):not\(:has\(\.kind-seat\)\) \.content-media__spin \{ animation: none !important; \}/);
  });

  it("a wire pulse starts only at near, the one tier that draws it", () => {
    expect(read("src/renderer/styles/canvas-lod-regions.css")).toMatch(
      /html:is\(\[data-canvas-tier="mid"\], \[data-canvas-tier="far"\], \[data-canvas-tier="overview"\]\) \.react-flow__viewport :is\(\.junto-edge-label, \.junto-wire-pulse, path\.junto-wire-pulse-hold\) \{\s*visibility: hidden;/,
    );
    const feed = read("src/renderer/components/edges/WirePulseFeed.tsx");
    expect(feed).toMatch(/const drawn = canvasTier\$\.peek\(\) === "near";/);
    expect(feed).toMatch(/if \(!drawn \|\| wirePulseScheduler\.fire\(target, event\.kind\) !== "dropped"\)/);
  });

  it("a browser tab scrolled out of the strip stops its spinner; a seen one spins", () => {
    const chrome = read("src/renderer/components/browser/BrowserChrome.tsx");
    expect(chrome).toMatch(/entry\.target\.toggleAttribute\("data-unseen", !entry\.isIntersecting\)/);
    expect(chrome).toMatch(/\{ root: list \}/);
    const css = read("src/renderer/components/browser/browser-chrome.css");
    expect(css).toMatch(/\.tab-strip__loading \{[^}]*animation: tab-strip-spin 0\.9s linear infinite;/);
    expect(css).toMatch(/\.tab-strip__tab\[data-unseen\] \.tab-strip__loading \{\s*animation: none;/);
  });

  it("the top bar's opening and saving pulses stop when the bar cuts them off", () => {
    const unseen = read("src/renderer/lib/unseen.ts");
    expect(unseen).toMatch(/entry\.target\.toggleAttribute\("data-unseen", !entry\.isIntersecting\)/);
    const bar = read("src/renderer/components/TopBar.tsx");
    expect(bar).toMatch(/<span ref=\{unseenRef\} className="station-context__loading"/);
    expect(bar).toMatch(/<div ref=\{unseenRef\} role="status" aria-live="polite" className=\{`station-save /);
    expect(read("src/renderer/styles.css")).toContain(
      ".station-context__loading[data-unseen], .station-save[data-unseen] .station-save__dot { animation: none; }",
    );
  });

  it("a minimap with no part in the window runs no ping", () => {
    expect(read("src/renderer/components/FactoryMinimap.tsx")).toMatch(/<div ref=\{unseenRef\} className="react-flow__panel react-flow__minimap/);
    expect(read("src/renderer/components/factory-minimap.css")).toContain(".react-flow__minimap[data-unseen] .junto-minimap-ping { animation: none; }");
  });

  it("a reach preview ring on a card off screen does not breathe", () => {
    const lib = read("src/renderer/lib/reach-preview.ts");
    expect(lib).toMatch(/el\.setAttribute\(MARK, change\);\s*if \(!unwatchers\.has\(el\)\) unwatchers\.set\(el, watchUnseen\(el\)\);/);
    expect(lib).not.toMatch(/el\.setAttribute\(MARK, change\);\s*\}/);
    expect(read("src/renderer/styles/reach-preview.css")).toContain(".react-flow__node[data-reach-preview][data-unseen]::before { animation: none; }");
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
