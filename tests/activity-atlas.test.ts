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
  it("every state moves except resting and stopped", () => {
    for (const glyph of ["work", "call", "halt", "done", "live", "dot"] as const) {
      expect(ring({ glyph }).core.motion).toBe("loop");
    }
    expect(ring({ glyph: "rest", tone: "steel" }).core.motion).toBe("still");
    expect(ring({ glyph: "off", tone: "steel" }).core.motion).toBe("still");
  });

  it("done draws itself once from its land row, then glints", () => {
    const done = ring({ glyph: "done" });
    expect(done.ring).toBe("done");
    expect(done.core.motion).toBe("loop");
    expect(done.core.land).toBeDefined();
    expect(done.core.land).not.toBe(done.core.row);
  });

  it("a frozen done shows its resting frame, not its first", () => {
    const sealed = ring({ glyph: "done", animate: false });
    expect(sealed.core.motion).toBe("still");
    expect(sealed.core.col).toBe(LAND_FRAMES);
    expect(sealed.core.land).toBeUndefined();
  });

  it("call and halt outrank a trouble reading", () => {
    expect(ring({ glyph: "call", health: "trouble", healthValue: "stuck" }).ring).toBe("call");
    expect(ring({ glyph: "halt", health: "trouble", healthValue: "thrashing" }).ring).toBe("halt");
  });
});

describe("ringCells: waiting on you circles", () => {
  it("a declared escalate or feedback orbits a seat that is not working", () => {
    expect(ring({ glyph: "rest", tone: "steel", signal: "escalate" }).ring).toBe("wait");
    expect(ring({ glyph: "done", tone: "green", signal: "feedback" }).ring).toBe("wait");
    expect(ring({ glyph: "rest", tone: "steel", signal: "escalate" }).core.row).not.toBe(
      ring({ glyph: "rest", tone: "steel", signal: "feedback" }).core.row,
    );
  });

  it("a declared blocked beats as halt", () => {
    expect(ring({ glyph: "rest", tone: "steel", signal: "blocked" }).ring).toBe("halt");
  });

  it("work keeps its lap under a signal", () => {
    expect(ring({ glyph: "work", signal: "escalate" }).ring).toBe("work");
  });

  it("a fresh waiting reading orbits; a stale one does not", () => {
    expect(ring({ glyph: "rest", tone: "steel", health: "waiting" }).ring).toBe("wait");
    expect(ring({ glyph: "rest", tone: "steel", health: "waiting", healthStale: true }).ring).toBe("rest");
  });

  it("reduced motion freezes the orbit at a pose that still reads", () => {
    const frozen = ring({ glyph: "rest", tone: "steel", signal: "escalate", animate: false });
    expect(frozen.ring).toBe("wait");
    expect(frozen.core.motion).toBe("still");
  });
});

describe("ringCells: trouble bends the ring, in amber", () => {
  it("stuck runs backwards, thrashing and looping snake", () => {
    expect(ring({ glyph: "work", health: "trouble", healthValue: "stuck" }).ring).toBe("reverse");
    expect(ring({ glyph: "work", health: "trouble", healthValue: "thrashing" }).ring).toBe("snake");
    expect(ring({ glyph: "work", health: "trouble", healthValue: "looping" }).ring).toBe("snake");
  });

  it("a settled ring fractures, and grinds", () => {
    const fractured = ring({ glyph: "rest", tone: "steel", health: "trouble", healthValue: "confused" });
    expect(fractured.ring).toBe("fracture");
    expect(fractured.core.motion).toBe("loop");
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
      if (core.land !== undefined) expect(core.land).toBeLessThan(MARK_ATLAS_ROWS);
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

  it("the land animation has no fill, so the loop takes over when it ends", () => {
    const rule = markAtlasCss()
      .split("\n")
      .find((line) => line.startsWith(".junto-mark[data-mark-land]{"));
    expect(rule).toBeDefined();
    expect(rule).not.toMatch(/\b(both|forwards)\b/);
  });

  it("names the hue each ring is drawn in, for the far tier's disc", () => {
    expect(ringCells({ glyph: "work", tone: "cyan", animate: true }).hue).toBe("cyan");
    expect(ringCells({ glyph: "rest", tone: "steel", animate: true, signal: "escalate" }).hue).toBe("amber");
    expect(ringCells({ glyph: "rest", tone: "steel", animate: true, signal: "feedback" }).hue).toBe("cyan");
    expect(ringCells({ glyph: "rest", tone: "steel", animate: true, signal: "blocked" }).hue).toBe("crimson");
    expect(ringCells({ glyph: "done", tone: "steel", animate: true }).hue).toBe("green");
    expect(ringCells({ glyph: "work", tone: "cyan", animate: true, health: "trouble" }).hue).toBe("amber");
    expect(ringCells({ glyph: "rest", tone: "steel", animate: true }).hue).toBe("steel");
  });
});
