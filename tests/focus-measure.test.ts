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

  describe("actor rails budget", () => {
    const panelWidth = (open: {
      readonly ledger: boolean;
      readonly connections: boolean;
    }): number => terminalFocusWidthPx() + actorTerminalRailsPx(open);

    it("budgets the shared right pane once", () => {
      expect(actorTerminalRailsPx()).toBe(TERMINAL_RAILS_PX.rightPane);
    });

    it("keeps one pane width while its stacked sections collapse", () => {
      expect(actorTerminalRailsPx({ ledger: false, connections: false })).toBe(
        TERMINAL_RAILS_PX.rightPane,
      );
      expect(actorTerminalRailsPx({ ledger: true, connections: false })).toBe(
        TERMINAL_RAILS_PX.rightPane,
      );
    });

    it("leaves the terminal the same width whichever stacked sections are open", () => {
      const stageWidths = [
        { ledger: true, connections: true },
        { ledger: true, connections: false },
        { ledger: false, connections: true },
        { ledger: false, connections: false },
      ].map((open) => panelWidth(open) - actorTerminalRailsPx(open));

      expect(new Set(stageWidths).size).toBe(1);
      expect(stageWidths[0]).toBe(terminalFocusWidthPx());
    });

    it("keeps the panel stable when a right-pane section expands", () => {
      const collapsed = panelWidth({ ledger: false, connections: false });
      const oneOpen = panelWidth({ ledger: true, connections: false });
      const bothOpen = panelWidth({ ledger: true, connections: true });

      expect(oneOpen).toBe(collapsed);
      expect(bothOpen).toBe(oneOpen);
    });
  });
});
