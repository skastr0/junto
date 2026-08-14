import { describe, expect, it } from "vitest";
import {
  cellsForPane,
  shouldNotifyPtyResize,
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
