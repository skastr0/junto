/**
 * The ring rules (ringCells) and the atlas layout they address.
 */
import { describe, expect, it } from "vitest";
import {
  LAND_FRAMES,
  MARK_ATLAS_COLS,
  MARK_ATLAS_ROWS,
  markAtlasCss,
  ringCells,
  type RingInput,
} from "../src/renderer/lib/activity-atlas";

const ring = (input: Partial<RingInput> & Pick<RingInput, "glyph">) =>
  ringCells({ tone: "cyan", animate: true, ...input });

describe("ringCells: control state owns the motion", () => {
  it("work loops, done lands once, stills never move", () => {
    expect(ring({ glyph: "work" }).core.motion).toBe("loop");
    expect(ring({ glyph: "done" }).core.motion).toBe("land");
    expect(ring({ glyph: "rest", tone: "steel" }).core.motion).toBe("still");
  });

  it("a frozen done shows its resting frame, not its first", () => {
    const sealed = ring({ glyph: "done", animate: false });
    expect(sealed.core.motion).toBe("still");
    expect(sealed.core.col).toBe(LAND_FRAMES);
  });

  it("call and halt outrank a trouble reading", () => {
    expect(ring({ glyph: "call", health: "trouble", healthValue: "stuck" }).ring).toBe("call");
    expect(ring({ glyph: "halt", health: "trouble", healthValue: "thrashing" }).ring).toBe("halt");
  });
});

describe("ringCells: trouble bends the ring, in amber", () => {
  it("stuck runs backwards, thrashing and looping snake", () => {
    expect(ring({ glyph: "work", health: "trouble", healthValue: "stuck" }).ring).toBe("reverse");
    expect(ring({ glyph: "work", health: "trouble", healthValue: "thrashing" }).ring).toBe("snake");
    expect(ring({ glyph: "work", health: "trouble", healthValue: "looping" }).ring).toBe("snake");
  });

  it("a settled ring fractures", () => {
    expect(ring({ glyph: "rest", tone: "steel", health: "trouble", healthValue: "confused" }).ring).toBe("fracture");
  });

  it("the bent ring uses the amber row, never the crimson one", () => {
    const halt = ring({ glyph: "halt", tone: "crimson" }).core.row;
    const bent = ring({ glyph: "work", tone: "crimson", health: "trouble", healthValue: "thrashing" }).core.row;
    expect(bent).not.toBe(halt);
    expect(bent).not.toBe(ring({ glyph: "work", tone: "crimson" }).core.row);
  });
});

describe("ringCells: the band says who waits on whom", () => {
  it("no reading and no signal draws no band", () => {
    expect(ring({ glyph: "work" }).band).toBeUndefined();
    expect(ring({ glyph: "work", health: "steady" }).band).toBeUndefined();
  });

  it("a declared blocked outranks a health waiting glow", () => {
    const declared = ring({ glyph: "rest", signal: "blocked", health: "waiting" }).band;
    const health = ring({ glyph: "rest", health: "waiting" }).band;
    expect(declared).toBeDefined();
    expect(health).toBeDefined();
    expect(declared).not.toEqual(health);
  });

  it("stale fades a reading but never a declared signal", () => {
    const fresh = ring({ glyph: "rest", signal: "escalate" }).band;
    const staleFlagOnly = ring({ glyph: "rest", signal: "escalate", healthStale: true }).band;
    expect(staleFlagOnly).toEqual(fresh);
    const good = ring({ glyph: "work", health: "good" }).band;
    const staleGood = ring({ glyph: "work", health: "good", healthStale: true }).band;
    expect(staleGood).not.toEqual(good);
  });

  it("exceeding is a distinct halo from good", () => {
    expect(ring({ glyph: "done", health: "good", healthValue: "exceeding" }).band).not.toEqual(
      ring({ glyph: "done", health: "good", healthValue: "going_well" }).band,
    );
  });
});

describe("atlas layout", () => {
  it("every addressed cell sits inside the atlas", () => {
    const inputs: RingInput[] = [];
    for (const glyph of ["work", "call", "halt", "done", "live", "dot", "rest", "off"] as const) {
      for (const tone of ["amber", "cyan", "green", "crimson", "steel"] as const) {
        for (const health of [undefined, "trouble", "waiting", "steady", "good"] as const) {
          for (const signal of [undefined, "blocked", "escalate", "feedback"] as const) {
            inputs.push({ glyph, tone, animate: true, health, healthValue: "thrashing", signal });
          }
        }
      }
    }
    for (const input of inputs) {
      const { core, band } = ringCells(input);
      for (const cell of [core, band]) {
        if (!cell) continue;
        expect(cell.col).toBeGreaterThanOrEqual(0);
        expect(cell.col).toBeLessThan(MARK_ATLAS_COLS);
        expect(cell.row).toBeGreaterThanOrEqual(0);
        expect(cell.row).toBeLessThan(MARK_ATLAS_ROWS);
      }
    }
  });

  it("the sheet has one frame rule per clock frame, gated on visibility", () => {
    const css = markAtlasCss();
    for (let frame = 0; frame < MARK_ATLAS_COLS; frame += 1) {
      expect(css).toContain(
        `html[data-mark-frame="${String(frame)}"] .junto-mark[data-mark-motion="loop"][data-mark-visible]`,
      );
    }
  });
});
