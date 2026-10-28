// @vitest-environment jsdom
/**
 * Panel size memory is the operator's drag and nothing else.
 *
 * The 0.10.1 bug: terminal modals came back permanently thinner. WorkFocusShell
 * (and FocusSurface for resizable documents) recorded EVERY size the panel took
 * with a ResizeObserver and forced it back as an inline px width on each later
 * open. One chain: remembered content width 1100 with the 248px actor rail,
 * but a frame of 1248; a render before the terminal view opens has no rail, the
 * panel is squeezed to the frame, the observer records the squeezed width, and
 * the rail's return takes its 248 out of that: 1000, and the memory never grows
 * back when the window does.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clampToFrame, inResizeGrip, RESIZE_GRIP_PX, watchOperatorResize } from "../src/renderer/lib/operator-resize";

const root = resolve(__dirname, "..");
const read = (rel: string): string => readFileSync(join(root, rel), "utf8");

const RECT = { left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 } as DOMRect;

describe("operator resize: only a drag on the grip is remembered", () => {
  let panel: HTMLDivElement;
  let size: { width: number; height: number };
  let stop: () => void;
  const onResize = vi.fn();
  const onReset = vi.fn();

  const press = (target: Element, x: number, y: number): void => {
    target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: x, clientY: y }));
  };
  const release = (): void => void window.dispatchEvent(new MouseEvent("pointerup"));
  const gripX = RECT.right - 5;
  const gripY = RECT.bottom - 5;

  beforeEach(() => {
    onResize.mockReset();
    onReset.mockReset();
    size = { width: 1000, height: 600 };
    panel = document.createElement("div");
    panel.getBoundingClientRect = () => RECT;
    Object.defineProperty(panel, "offsetWidth", { get: () => size.width });
    Object.defineProperty(panel, "offsetHeight", { get: () => size.height });
    document.body.append(panel);
    stop = watchOperatorResize(panel, { onResize, onReset });
  });
  afterEach(() => {
    stop();
    panel.remove();
  });

  it("a panel squeezed or reflowed with no press on the grip records nothing", () => {
    size = { width: 840, height: 600 };
    release();
    press(panel, 400, 300);
    size = { width: 700, height: 600 };
    release();
    expect(onResize).not.toHaveBeenCalled();
  });

  it("a press on the grip that ends at a new size records that size once", () => {
    press(panel, gripX, gripY);
    size = { width: 900, height: 600 };
    size = { width: 880, height: 600 };
    release();
    release();
    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenCalledWith({ width: 880, height: 600 });
  });

  it("a press on the grip that moves nothing is not a resize", () => {
    press(panel, gripX, gripY);
    release();
    expect(onResize).not.toHaveBeenCalled();
  });

  it("the maximized box is never recorded", () => {
    const frame = document.createElement("div");
    frame.dataset.maximized = "true";
    document.body.append(frame);
    frame.append(panel);
    press(panel, gripX, gripY);
    size = { width: 1400, height: 600 };
    release();
    expect(onResize).not.toHaveBeenCalled();
  });

  it("a double click on the grip forgets the size; elsewhere it does not", () => {
    const dbl = (target: Element, x: number, y: number): void =>
      void target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: x, clientY: y }));
    dbl(panel, 400, 300);
    expect(onReset).not.toHaveBeenCalled();
    const child = document.createElement("div");
    panel.append(child);
    dbl(child, gripX, gripY);
    expect(onReset).not.toHaveBeenCalled();
    dbl(panel, gripX, gripY);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("stops listening when cleaned up", () => {
    stop();
    press(panel, gripX, gripY);
    size = { width: 500, height: 600 };
    release();
    expect(onResize).not.toHaveBeenCalled();
  });
});

describe("operator resize: the grip and the frame", () => {
  it("the grip is the bottom-right corner of the panel", () => {
    expect(inResizeGrip(RECT, RECT.right - 1, RECT.bottom - 1)).toBe(true);
    expect(inResizeGrip(RECT, RECT.right - RESIZE_GRIP_PX - 1, RECT.bottom - 1)).toBe(false);
    expect(inResizeGrip(RECT, RECT.right - 1, RECT.bottom - RESIZE_GRIP_PX - 1)).toBe(false);
  });

  it("a remembered size is clamped to the frame and never shrinks the memory itself", () => {
    expect(clampToFrame(1348, 1248)).toBe(1248);
    expect(clampToFrame(1100, 1500)).toBe(1100);
    expect(clampToFrame(1100, 0)).toBe(1100);
  });
});

describe("operator resize: no surface remembers a size by watching the box", () => {
  it.each(["src/renderer/components/workbench/WorkFocusShell.tsx", "src/renderer/components/FocusSurface.tsx"])(
    "%s never feeds size memory from a ResizeObserver",
    (rel) => {
      const source = read(rel);
      expect(source).not.toMatch(/new ResizeObserver/);
      expect(source).toContain("watchOperatorResize");
    },
  );

  it("a remembered terminal width is clamped to the frame where it is restored", () => {
    expect(read("src/renderer/components/workbench/WorkFocusShell.tsx")).toMatch(
      /clampToFrame\(stored\.width \+ terminalRailsPx, frame\)/,
    );
  });

  it("resizable document sizes are kept per surface, not per shared measure", () => {
    const source = read("src/renderer/components/FocusSurface.tsx");
    // Kept in view state by the surface's label (0.11, 04, V3), never by measure.
    expect(source).toContain("writeSurfaceSize(label, ");
    expect(source).toContain("surfaceSize(label)");
    expect(source).not.toMatch(/[sS]urfaceSize\(measure/);
  });
});
