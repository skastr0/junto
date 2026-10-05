import { describe, expect, it } from "vitest";
import { WINDOW_CLOSE_GUARD_MS, frontCloseFor } from "../src/renderer/lib/front-close";

describe("frontCloseFor", () => {
  it("closes one layer when something is in front", () => {
    expect(frontCloseFor(true, 5000, null)).toBe("layer");
    expect(frontCloseFor(true, 5000, 4990)).toBe("layer");
  });

  it("closes the window from the canvas when nothing was closed lately", () => {
    expect(frontCloseFor(false, 5000, null)).toBe("window");
    expect(frontCloseFor(false, 5000, 5000 - WINDOW_CLOSE_GUARD_MS)).toBe("window");
  });

  it("holds a press that overshoots a layer close, so hammering never closes the window", () => {
    expect(frontCloseFor(false, 5000, 4999)).toBe("held");
    expect(frontCloseFor(false, 5000, 5000 - WINDOW_CLOSE_GUARD_MS + 1)).toBe("held");
  });
});
