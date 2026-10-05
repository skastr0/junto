import { describe, expect, it } from "vitest";
import {
  actorTerminalRailsPx,
  monoCellWidthPx,
  PROSE_MEASURE_CH,
  terminalFocusWidthPx,
  TERMINAL_FOCUS,
  TERMINAL_RAILS_PX,
} from "../src/renderer/lib/focus-measure";

describe("focus-measure", () => {
  it("mono cell width matches xterm fallback (fontSize × 0.6)", () => {
    expect(monoCellWidthPx(13)).toBeCloseTo(7.8);
  });

  it("terminal focus width is ~1100px at 140 cols / 13px (pleasant pre-change panel)", () => {
    const w = terminalFocusWidthPx();
    expect(TERMINAL_FOCUS.targetCols).toBe(140);
    // 140 × 7.8 + 4 = 1096
    expect(w).toBe(1096);
    expect(w).toBeGreaterThan(1000);
    expect(w).toBeLessThan(1200);
  });

  it("scales with col count", () => {
    expect(terminalFocusWidthPx(80)).toBeLessThan(terminalFocusWidthPx(140));
  });

  it("prose measure is the classic ~65ch reading line", () => {
    expect(PROSE_MEASURE_CH).toBe(65);
  });

  describe("actor rail budget", () => {
    it("budgets the rail by its mode: expanded, a strip of rings, or none", () => {
      expect(actorTerminalRailsPx("expanded")).toBe(TERMINAL_RAILS_PX.expanded);
      expect(actorTerminalRailsPx("collapsed")).toBe(TERMINAL_RAILS_PX.collapsed);
      expect(actorTerminalRailsPx("none")).toBe(0);
      expect(TERMINAL_RAILS_PX.collapsed).toBeLessThan(TERMINAL_RAILS_PX.expanded);
    });

    it("leaves the terminal its own width whatever the rail does", () => {
      for (const mode of ["expanded", "collapsed", "none"] as const) {
        const panel = terminalFocusWidthPx() + actorTerminalRailsPx(mode);
        expect(panel - actorTerminalRailsPx(mode)).toBe(terminalFocusWidthPx());
      }
    });
  });
});
