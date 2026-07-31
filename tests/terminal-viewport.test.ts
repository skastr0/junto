import { afterEach, describe, expect, it } from "vitest";
import {
  bookmarkFromBuffer,
  clearTerminalViewportBookmarks,
  resolveViewportRestore,
  storeTerminalViewport,
  takeTerminalViewport,
} from "../src/renderer/lib/terminal-viewport";

afterEach(() => {
  clearTerminalViewportBookmarks();
});

describe("bookmarkFromBuffer", () => {
  it("marks bottom when viewportY >= baseY", () => {
    expect(bookmarkFromBuffer("e1", 40, 40)).toEqual({
      epoch: "e1",
      viewportY: 40,
      wasAtBottom: true,
    });
    expect(bookmarkFromBuffer("e1", 12, 40).wasAtBottom).toBe(false);
  });
});

describe("resolveViewportRestore", () => {
  it("returns bottom when the user was following output", () => {
    expect(
      resolveViewportRestore(
        { epoch: "e1", viewportY: 40, wasAtBottom: true },
        50,
      ),
    ).toBe("bottom");
  });

  it("clamps a mid-scroll viewport to the new baseY", () => {
    expect(
      resolveViewportRestore(
        { epoch: "e1", viewportY: 100, wasAtBottom: false },
        40,
      ),
    ).toBe(40);
    expect(
      resolveViewportRestore(
        { epoch: "e1", viewportY: -5, wasAtBottom: false },
        40,
      ),
    ).toBe(0);
  });
});

describe("store/takeTerminalViewport", () => {
  it("returns a same-epoch bookmark once", () => {
    storeTerminalViewport(
      "bind-1",
      bookmarkFromBuffer("e1", 12, 40),
    );
    expect(takeTerminalViewport("bind-1", "e1")).toEqual({
      epoch: "e1",
      viewportY: 12,
      wasAtBottom: false,
    });
    expect(takeTerminalViewport("bind-1", "e1")).toBeUndefined();
  });

  it("never restores across a changed epoch", () => {
    storeTerminalViewport(
      "bind-1",
      bookmarkFromBuffer("e-old", 12, 40),
    );
    expect(takeTerminalViewport("bind-1", "e-new")).toBeUndefined();
    // Mismatched bookmark is consumed so it cannot apply later.
    expect(takeTerminalViewport("bind-1", "e-old")).toBeUndefined();
  });
});
