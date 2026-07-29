import { describe, expect, it } from "vitest";
import { shouldNotifyPtyResize } from "../src/renderer/lib/terminal-resize";

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
