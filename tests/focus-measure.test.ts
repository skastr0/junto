import { describe, expect, it } from "vitest";
import {
  monoCellWidthPx,
  PROSE_MEASURE_CH,
  terminalFocusWidthPx,
  TERMINAL_FOCUS,
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
});
