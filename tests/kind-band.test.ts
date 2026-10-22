import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BAND_PERIOD_FRAMES,
  BAND_PERIOD_MS,
  bandPeriodsDivideThePhase,
  kindBandLayers,
  type BandMotion,
  type KindState,
} from "../src/renderer/lib/kind-band";
import { KIND_ICON_KINDS } from "../src/shared/kind-icon";
import { MARK_PHASE_MS, RING_FRAME_MS } from "../src/shared/wire/rings";
import { SeatUrgency } from "../src/shared/wire/urgency";
import { THEME_MODES } from "../src/shared/theme";

const css = readFileSync(join(resolve(__dirname, ".."), "src/renderer/components/nodes/kind-seat.css"), "utf8");
const G = SeatUrgency.group;
const STATES: readonly KindState[] = [G.resting, G.working, G.waiting, G.blocked, G.done, G.offline];
const MOTIONS = Object.keys(BAND_PERIOD_FRAMES) as BandMotion[];

describe("the ledger band", () => {
  it("every period is a whole number of ring frames that divides the ring's phase cycle", () => {
    expect(bandPeriodsDivideThePhase()).toBe(true);
    for (const motion of MOTIONS) {
      expect(BAND_PERIOD_MS[motion]).toBe(BAND_PERIOD_FRAMES[motion] * RING_FRAME_MS);
      expect(MARK_PHASE_MS % BAND_PERIOD_MS[motion], motion).toBe(0);
    }
  });

  it("a node has at most one moving band part in any state, and only a moving ring state has one", () => {
    for (const kind of KIND_ICON_KINDS) {
      for (const mode of THEME_MODES) {
        for (const state of STATES) {
          const layers = kindBandLayers(kind, state, mode);
          const moving = layers.filter((layer) => layer.motion !== undefined);
          expect(moving.length, `${kind} ${state} ${mode}`).toBeLessThanOrEqual(1);
          if (state === G.resting || state === G.offline) expect(moving, `${kind} ${state}`).toHaveLength(0);
        }
      }
    }
  });

  it("every band has still art under it and every layer draws something", () => {
    for (const kind of KIND_ICON_KINDS) {
      for (const state of STATES) {
        const layers = kindBandLayers(kind, state, "dark");
        expect(layers.length, `${kind} ${state}`).toBeGreaterThanOrEqual(1);
        for (const layer of layers) expect(layer.svg, `${kind} ${state}`).toMatch(/<(path|circle|rect)/);
        expect(layers.some((layer) => layer.motion === undefined)).toBe(true);
      }
    }
  });

  it("a task band with a ledger draws its arcs under the track", () => {
    const layers = kindBandLayers("task", G.resting, "dark", { kind: "task", finished: 6, open: 0, asks: 0, stuck: 0, backlog: 8 });
    expect(layers.length).toBeGreaterThanOrEqual(2);
  });

  it("the ledger moves with the board: a task band redraws its arcs as tasks move", () => {
    const board = { kind: "task" as const, finished: 6, open: 3, asks: 1, stuck: 0, backlog: 4 };
    const before = kindBandLayers("task", G.waiting, "dark", board)[1]!.svg;
    const after = kindBandLayers("task", G.waiting, "dark", { ...board, finished: 7, open: 2 })[1]!.svg;
    expect(before).not.toBe(after);
    expect(kindBandLayers("task", G.done, "dark", board)[1]!.svg).toMatch(/stroke-linecap/);
  });

  it("the sheet animates transform and opacity only, forever, on the ring's clock, with no steps", () => {
    const frames = new Map<string, string>();
    for (const m of css.matchAll(/@keyframes ([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)) frames.set(m[1]!, m[2]!);
    expect(frames.size).toBeGreaterThan(0);
    for (const [name, body] of frames) {
      for (const decl of body.matchAll(/([a-z-]+)\s*:/g)) {
        expect(["transform", "opacity"], `${name}: ${decl[1]!}`).toContain(decl[1]);
      }
    }
    expect(css).not.toMatch(/steps\(/);
    expect(css).toMatch(/animation-iteration-count:\s*infinite/);
    expect(css).toMatch(/animation-delay:\s*var\(--mark-t0/);
    // The sheet and the table agree: each motion is declared once, at its period.
    for (const motion of MOTIONS) {
      const rule = new RegExp(`\\[data-motion="${motion}"\\]\\s*\\{[^}]*animation-duration:\\s*(\\d+)ms`).exec(css);
      expect(rule, motion).not.toBeNull();
      expect(Number(rule![1]), motion).toBe(BAND_PERIOD_MS[motion]);
    }
  });

  it("a moving part runs only while the ring runs: on screen, motion on", () => {
    expect(css).toMatch(/\.kind-band__layer\[data-motion\]\s*\{\s*display:\s*none/);
    expect(css).toContain('html:not([data-surface-motion="paused"]) .junto-mark[data-mark-visible] .kind-band__layer[data-motion]');
  });

  it("the ring is the one blocked signal: no second ring round the pill", () => {
    expect(css).toMatch(/\.junto-node:has\(\.kind-seat\)\.junto-blocker::after[^{]*\{\s*display:\s*none/);
  });

  it("at far and overview a kind seat is its ring alone", () => {
    expect(css).toMatch(/html:is\(\[data-canvas-tier="far"\], \[data-canvas-tier="overview"\]\) \.kind-band\s*\{\s*display:\s*none/);
  });
});
