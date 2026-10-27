import { describe, expect, it } from "vitest";
import { stepPane } from "../src/renderer/lib/pane-focus";

describe("stepping between panes", () => {
  it("moves one pane along and wraps at either end", () => {
    expect(stepPane(3, 0, 1)).toBe(1);
    expect(stepPane(3, 2, 1)).toBe(0);
    expect(stepPane(3, 0, -1)).toBe(2);
  });

  it("lands on the first or last pane when the keyboard is in none of them", () => {
    expect(stepPane(3, -1, 1)).toBe(0);
    expect(stepPane(3, -1, -1)).toBe(2);
    expect(stepPane(0, -1, 1)).toBe(-1);
  });
});
