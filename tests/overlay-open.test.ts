// @vitest-environment jsdom
/**
 * The top bar stops being a window drag region while an overlay is open, and
 * says so with one counted attribute on <html> (lib/overlay-open.ts), not a
 * :has() on the root. The modal stack holds it for every modal and dialog; a
 * panel under the bar crosses none of it and does not.
 */
import { afterEach, describe, expect, it } from "vitest";
import { holdOverlay, overlaysOpen, resetOverlays } from "../src/window/lib/overlay-open";
import { pushModal, resetModalStack } from "../src/window/lib/modal-stack";

const marked = (): string | null => document.documentElement.getAttribute("data-junto-overlay");
const entry = (coversBar?: boolean) => ({
  layer: "operator" as const,
  container: () => null,
  trap: false,
  onEscape: () => true,
  onClose: () => undefined,
  ...(coversBar === undefined ? {} : { coversBar }),
});

afterEach(() => {
  resetModalStack();
  resetOverlays();
});

describe("the overlay mark on the document", () => {
  it("is set while anything is open and gone when the last one closes: two overlays do not clear each other", () => {
    expect(marked()).toBeNull();
    const first = holdOverlay();
    const second = holdOverlay();
    expect(marked()).toBe("open");
    first();
    expect(marked()).toBe("open");
    first();
    expect(overlaysOpen()).toBe(1);
    second();
    expect(marked()).toBeNull();
  });

  it("is held by every modal on the stack, and let go as each leaves", () => {
    const a = pushModal(entry());
    const b = pushModal(entry());
    expect(marked()).toBe("open");
    a.leave();
    expect(marked()).toBe("open");
    b.leave();
    expect(marked()).toBeNull();
  });

  it("is not held by a panel under the bar, which crosses none of it", () => {
    const under = pushModal(entry(false));
    expect(marked()).toBeNull();
    const over = pushModal(entry());
    expect(marked()).toBe("open");
    over.leave();
    expect(marked()).toBeNull();
    under.leave();
  });
});
