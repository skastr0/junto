import { describe, expect, it } from "vitest";
import {
  cellsForPane,
  ptyNotifyDelayMs,
  shouldNotifyPtyResize,
  shouldPaintView,
  UNKNOWN_TERMINAL_GEOMETRY,
} from "../src/renderer/lib/terminal-resize";

describe("terminal PTY resize policy", () => {
  it("does not signal a child PTY for a same-geometry renderer repaint", () => {
    expect(
      shouldNotifyPtyResize(
        { cols: 137, rows: 39 },
        { cols: 137, rows: 39 },
      ),
    ).toBe(false);
  });

  it("paints the view from the pane even when the child has not acked", () => {
    expect(
      shouldPaintView({ cols: 80, rows: 24 }, { cols: 83, rows: 49 }),
    ).toBe(true);
    expect(
      shouldNotifyPtyResize(UNKNOWN_TERMINAL_GEOMETRY, { cols: 83, rows: 49 }),
    ).toBe(true);
  });

  it("retries the child while acked lags the pane", () => {
    expect(
      shouldNotifyPtyResize({ cols: 80, rows: 24 }, { cols: 83, rows: 49 }),
    ).toBe(true);
    expect(
      shouldNotifyPtyResize({ cols: 83, rows: 49 }, { cols: 83, rows: 49 }),
    ).toBe(false);
  });

  it("notifies immediately after attach, then coalesces pin/focus hops", () => {
    expect(ptyNotifyDelayMs(UNKNOWN_TERMINAL_GEOMETRY)).toBe(0);
    expect(ptyNotifyDelayMs({ cols: 83, rows: 49 })).toBeGreaterThan(0);
  });

  it("signals a child PTY when either measured dimension changes", () => {
    expect(
      shouldNotifyPtyResize(
        { cols: 137, rows: 39 },
        { cols: 136, rows: 39 },
      ),
    ).toBe(true);
    expect(
      shouldNotifyPtyResize(
        { cols: 137, rows: 39 },
        { cols: 137, rows: 38 },
      ),
    ).toBe(true);
  });
});

describe("cellsForPane", () => {
  const cell = { cellW: 8, cellH: 16, padX: 16, padY: 12 };

  it("uses the host box, not a frozen xterm grid", () => {
    const small = cellsForPane({
      hostWidth: 94 * 8 + 16,
      hostHeight: 48 * 16 + 12,
      ...cell,
    });
    const large = cellsForPane({
      hostWidth: 167 * 8 + 16,
      hostHeight: 49 * 16 + 12,
      ...cell,
    });
    expect(small).toMatchObject({ cols: 94, rows: 48 });
    expect(large).toMatchObject({ cols: 167, rows: 49 });
    expect(large?.cols).toBeGreaterThan(small?.cols ?? 0);
  });

  it("rejects a parked or unmeasured host", () => {
    expect(
      cellsForPane({ hostWidth: 1, hostHeight: 1, ...cell }),
    ).toBeNull();
    expect(
      cellsForPane({
        hostWidth: 800,
        hostHeight: 600,
        cellW: 0,
        cellH: 16,
        padX: 16,
        padY: 12,
      }),
    ).toBeNull();
  });
});
