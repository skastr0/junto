import { describe, expect, it } from "vitest";
import {
  cellsForPane,
  ptyNotifyDelayMs,
  ptyNotifyShouldRetry,
  PTY_NOTIFY_RETRY_CAP,
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
    expect(ptyNotifyDelayMs(UNKNOWN_TERMINAL_GEOMETRY, 0)).toBe(0);
    expect(ptyNotifyDelayMs({ cols: 83, rows: 49 }, 0)).toBeGreaterThan(0);
  });

  it("backs off after a failed notify even when acked is still unknown", () => {
    expect(ptyNotifyDelayMs(UNKNOWN_TERMINAL_GEOMETRY, 0)).toBe(0);
    const first = ptyNotifyDelayMs(UNKNOWN_TERMINAL_GEOMETRY, 1);
    const second = ptyNotifyDelayMs(UNKNOWN_TERMINAL_GEOMETRY, 2);
    const third = ptyNotifyDelayMs(UNKNOWN_TERMINAL_GEOMETRY, 3);
    const fourth = ptyNotifyDelayMs(UNKNOWN_TERMINAL_GEOMETRY, 4);
    const fifth = ptyNotifyDelayMs(UNKNOWN_TERMINAL_GEOMETRY, 5);
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
    expect(fourth).toBeGreaterThan(third);
    expect(fifth).toBeGreaterThan(fourth);
    expect(ptyNotifyDelayMs(UNKNOWN_TERMINAL_GEOMETRY, 6)).toBe(fifth);
    expect(ptyNotifyDelayMs(UNKNOWN_TERMINAL_GEOMETRY, 20)).toBe(fifth);
  });

  it("stops retrying the child after the hop-down cap", () => {
    expect(ptyNotifyShouldRetry(0)).toBe(true);
    expect(ptyNotifyShouldRetry(PTY_NOTIFY_RETRY_CAP - 1)).toBe(true);
    expect(ptyNotifyShouldRetry(PTY_NOTIFY_RETRY_CAP)).toBe(false);
    expect(ptyNotifyShouldRetry(PTY_NOTIFY_RETRY_CAP + 3)).toBe(false);
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
