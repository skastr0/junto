import { describe, expect, it } from "vitest";
import {
  MAX_PAN_FRAME_MS,
  PAN_BLOCKING_SURFACE_SELECTOR,
  PAN_BOOST_MULTIPLIER,
  PAN_RAMP_MS,
  PAN_SPEED_PX_PER_SECOND,
  canvasOwnsKeyboard,
  panKeyFor,
  panModifiersAllow,
  panVectorFor,
  panViewportDelta,
} from "../src/renderer/lib/canvas-keyboard-pan";

const focusOn = (matches: string[]) => ({
  closest: (selector: string) =>
    selector
      .split(",")
      .map((part) => part.trim())
      .some((part) => matches.includes(part))
      ? {}
      : null,
});

const canvasDocument = ({
  surface = null as string | null,
  active = null as ReturnType<typeof focusOn> | null,
} = {}) => ({
  querySelector: () => surface,
  activeElement: active,
  body: null,
});

describe("panKeyFor", () => {
  it("claims WASD and the arrows in either case", () => {
    expect(panKeyFor("w")).toBe("w");
    expect(panKeyFor("D")).toBe("d");
    expect(panKeyFor("ArrowLeft")).toBe("arrowleft");
  });

  it("leaves every other key alone", () => {
    for (const key of ["e", "Enter", " ", "Escape", "1", "Shift"]) {
      expect(panKeyFor(key)).toBeNull();
    }
  });
});

describe("panModifiersAllow", () => {
  it("allows a bare press and a Shift boost", () => {
    expect(panModifiersAllow({})).toBe(true);
    expect(panModifiersAllow({ metaKey: false, ctrlKey: false, altKey: false })).toBe(true);
  });

  it("yields every command chord", () => {
    expect(panModifiersAllow({ metaKey: true })).toBe(false);
    expect(panModifiersAllow({ ctrlKey: true })).toBe(false);
    expect(panModifiersAllow({ altKey: true })).toBe(false);
  });
});

describe("canvasOwnsKeyboard", () => {
  it("owns the keyboard on a bare canvas", () => {
    expect(canvasOwnsKeyboard(canvasDocument())).toBe(true);
  });

  it("yields while a focus modal, dialog, or menu is open", () => {
    expect(canvasOwnsKeyboard(canvasDocument({ surface: "[data-focus-surface]" }))).toBe(false);
  });

  it("does not count the permanently docked add-item trigger as an open menu", () => {
    expect(PAN_BLOCKING_SURFACE_SELECTOR).toContain(":not(.node-deck-host--docked)");
  });

  it("yields to any focused field", () => {
    for (const holder of ["input", "textarea", "select", "[contenteditable='true']"]) {
      expect(canvasOwnsKeyboard(canvasDocument({ active: focusOn([holder]) }))).toBe(false);
    }
  });

  it("yields to a focused terminal and to xyflow node keyboard handling", () => {
    expect(canvasOwnsKeyboard(canvasDocument({ active: focusOn([".xterm"]) }))).toBe(false);
    expect(canvasOwnsKeyboard(canvasDocument({ active: focusOn([".react-flow__node"]) }))).toBe(false);
  });

  it("keeps the keyboard when focus sits on an inert element", () => {
    expect(canvasOwnsKeyboard(canvasDocument({ active: focusOn(["div"]) }))).toBe(true);
  });

  it("fails closed without a document", () => {
    expect(canvasOwnsKeyboard(null)).toBe(false);
    expect(canvasOwnsKeyboard(undefined)).toBe(false);
  });
});

describe("panVectorFor", () => {
  it("is still with nothing held", () => {
    expect(panVectorFor([])).toEqual({ x: 0, y: 0 });
  });

  it("points the camera the way the key reads", () => {
    expect(panVectorFor(["d"])).toEqual({ x: 1, y: 0 });
    expect(panVectorFor(["w"])).toEqual({ x: 0, y: -1 });
    expect(panVectorFor(["arrowdown"])).toEqual({ x: 0, y: 1 });
  });

  it("cancels opposing keys", () => {
    expect(panVectorFor(["a", "d"])).toEqual({ x: 0, y: 0 });
  });

  it("normalizes diagonals so they are not faster", () => {
    const diagonal = panVectorFor(["w", "d"]);
    expect(Math.hypot(diagonal.x, diagonal.y)).toBeCloseTo(1, 10);
  });
});

describe("panViewportDelta", () => {
  const full = { frameMs: MAX_PAN_FRAME_MS, heldMs: PAN_RAMP_MS };
  const fullStep = PAN_SPEED_PX_PER_SECOND * (MAX_PAN_FRAME_MS / 1000);

  it("moves the viewport opposite the camera", () => {
    const delta = panViewportDelta({ vector: { x: 1, y: 0 }, ...full });
    expect(delta.x).toBeCloseTo(-fullStep, 6);
    expect(delta.y).toBeCloseTo(0, 10);
  });

  it("ramps a tap below full speed", () => {
    const tap = panViewportDelta({ vector: { x: 1, y: 0 }, frameMs: 16, heldMs: 16 });
    const glide = panViewportDelta({ vector: { x: 1, y: 0 }, frameMs: 16, heldMs: PAN_RAMP_MS });
    expect(Math.abs(tap.x)).toBeLessThan(Math.abs(glide.x));
    expect(Math.abs(tap.x)).toBeGreaterThan(0);
  });

  it("flies faster with Shift", () => {
    const delta = panViewportDelta({ vector: { x: 0, y: 1 }, ...full, boost: true });
    expect(delta.y).toBeCloseTo(-fullStep * PAN_BOOST_MULTIPLIER, 6);
  });

  it("does not teleport after a stalled frame", () => {
    const stalled = panViewportDelta({ vector: { x: 1, y: 0 }, frameMs: 5000, heldMs: 5000 });
    expect(Math.abs(stalled.x)).toBeCloseTo(fullStep, 6);
  });

  it("stays put with no direction held", () => {
    expect(panViewportDelta({ vector: { x: 0, y: 0 }, ...full })).toEqual({ x: 0, y: 0 });
  });
});
