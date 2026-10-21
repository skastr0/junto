import { describe, expect, it, vi } from "vitest";
import { registerPageChromeKeys, runPageChromeKey } from "../src/renderer/lib/page-chrome-keys";

describe("page chrome keys", () => {
  it("with no page showing the key passes", () => {
    expect(runPageChromeKey("address")).toBe(false);
    expect(runPageChromeKey("reload")).toBe(false);
  });

  it("the page registered last is the page in front, and the one before takes over when it hides", () => {
    const back = { address: vi.fn(), reload: vi.fn() };
    const front = { address: vi.fn(), reload: vi.fn() };
    const unregisterBack = registerPageChromeKeys(back);
    const unregisterFront = registerPageChromeKeys(front);
    expect(runPageChromeKey("reload")).toBe(true);
    expect(front.reload).toHaveBeenCalledTimes(1);
    expect(back.reload).not.toHaveBeenCalled();
    unregisterFront();
    expect(runPageChromeKey("address")).toBe(true);
    expect(back.address).toHaveBeenCalledTimes(1);
    unregisterBack();
    unregisterBack();
    expect(runPageChromeKey("address")).toBe(false);
  });
});
