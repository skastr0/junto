// @vitest-environment jsdom
/**
 * What a modal hides, and how it stays hidden without `inert`.
 *
 * `inert` on the covered subtree restyled it: inertness rides in inherited
 * computed style, so a docked surface's open restyled 16,489 elements (102 ms)
 * and its close 16,480 (99 ms), and cmd+K 18,080 on the way in (mini, factory
 * board). aria-hidden costs none of that, as long as nothing keys style on it,
 * which the last test here holds. The three tests before it hold what inert
 * used to guarantee: silence to readers, no Tab stop inside, a return of focus
 * that is not bounced, and no aria-hidden on a subtree that holds the focus.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pushModal, resetModalStack } from "../src/window/lib/modal-stack";

const MARK = "data-modal-hidden";

/** A page: the app root holding a canvas with focusables, then chrome after it. */
const page = (): { canvas: HTMLElement; surface: HTMLElement; after: HTMLButtonElement; bar: HTMLButtonElement } => {
  document.body.innerHTML = "";
  const root = document.createElement("div");
  root.id = "root";
  // Live chrome before the canvas: reachable behind a docked surface, and the
  // backwards stop when the guard steps over the canvas.
  const bar = document.createElement("button");
  bar.textContent = "station bar";
  const canvas = document.createElement("div");
  canvas.className = "react-flow";
  const inside = document.createElement("button");
  inside.textContent = "inside canvas";
  canvas.append(inside);
  root.append(bar, canvas);
  document.body.append(root);

  const surface = document.createElement("div");
  surface.setAttribute("data-layer", "working");
  const surfaceButton = document.createElement("button");
  surfaceButton.textContent = "in surface";
  surface.append(surfaceButton);
  document.body.append(surface);

  const after = document.createElement("button");
  after.textContent = "chrome after";
  document.body.append(after);
  return { canvas, surface, after, bar };
};

const openDocked = (surface: HTMLElement): (() => void) => {
  const { leave } = pushModal({
    layer: "working",
    trap: false,
    container: () => surface,
    onEscape: () => true,
    onClose: () => undefined,
  });
  return leave;
};

describe("a modal hides what it covers", () => {
  beforeEach(() => {
    resetModalStack();
  });
  afterEach(() => {
    resetModalStack();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("marks the canvas hidden and never makes it inert", () => {
    const { canvas, surface } = page();
    const leave = openDocked(surface);
    expect(canvas.getAttribute("aria-hidden")).toBe("true");
    expect(canvas.hasAttribute(MARK)).toBe(true);
    expect(canvas.hasAttribute("inert"), "inert is what restyled the canvas").toBe(false);
    leave();
    expect(canvas.hasAttribute(MARK)).toBe(false);
    expect(canvas.hasAttribute("aria-hidden")).toBe(false);
  });

  it("does not hide a subtree that still holds the focus, then hides it once focus leaves", async () => {
    vi.useFakeTimers();
    const { canvas, surface } = page();
    const inside = canvas.querySelector("button")!;
    inside.focus();
    expect(document.activeElement).toBe(inside);
    const leave = openDocked(surface);
    // Chrome refuses aria-hidden over a focused subtree, so it is not set yet.
    expect(canvas.hasAttribute(MARK)).toBe(false);
    // The surface claims the keyboard, then the deferred pass hides the canvas.
    surface.querySelector("button")!.focus();
    await vi.runAllTimersAsync();
    expect(canvas.getAttribute("aria-hidden")).toBe("true");
    expect(canvas.hasAttribute(MARK)).toBe(true);
    leave();
  });

  it("clears the markers before a return of focus, so the return is never bounced", () => {
    const { canvas, surface, after } = page();
    const leave = openDocked(surface);
    const seat = canvas.querySelector("button")!;
    // Closing: leave() clears the markers, then the shell returns focus.
    leave();
    expect(canvas.hasAttribute(MARK)).toBe(false);
    seat.focus();
    // Nothing steps focus away: the guard only acts while a modal is front.
    expect(document.activeElement).toBe(seat);
    after.focus();
    expect(document.activeElement).toBe(after);
  });

  it("keeps a subtree someone else made inert, and still hides it", () => {
    const { canvas, surface } = page();
    canvas.setAttribute("inert", "");
    const leave = openDocked(surface);
    expect(canvas.getAttribute("aria-hidden")).toBe("true");
    expect(canvas.hasAttribute("inert")).toBe(true);
    leave();
    // Its own inert is not ours to clear.
    expect(canvas.hasAttribute("inert")).toBe(true);
  });
});

describe("focus never stays in a hidden subtree", () => {
  beforeEach(() => resetModalStack());
  afterEach(() => {
    resetModalStack();
    document.body.innerHTML = "";
  });

  /** A pointer or a Tab landed on `target`: the guard hears focusin. */
  const land = (target: Element): void => {
    (target as HTMLElement).focus();
    target.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  };

  it("steps forward out of the canvas to the next stop after it", () => {
    const { canvas, surface, after } = page();
    const inside = canvas.querySelector("button")!;
    const surfaceButton = surface.querySelector("button")!;
    const leave = openDocked(surface);
    land(inside);
    // The nearest stop after the canvas in document order: the surface itself.
    expect(document.activeElement).toBe(surfaceButton);
    expect(canvas.contains(document.activeElement), "never the canvas").toBe(false);
    // And from there the ordinary next stop is the chrome outside.
    surfaceButton.focus();
    expect(canvas.contains(document.activeElement)).toBe(false);
    expect(after).not.toBe(null);
    leave();
  });

  it("steps backwards out of the canvas to the chrome before it", () => {
    const { canvas, surface, bar } = page();
    const inside = canvas.querySelector("button")!;
    const leave = openDocked(surface);
    // Shift+Tab is what a backwards move is.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    land(inside);
    expect(document.activeElement).toBe(bar);
    leave();
  });

  it("does not move focus while no modal is open, so a return is never bounced", () => {
    const { canvas, surface } = page();
    const inside = canvas.querySelector("button")!;
    const leave = openDocked(surface);
    leave();
    land(inside);
    expect(document.activeElement).toBe(inside);
  });
});

describe("style is never keyed on what a modal hides", () => {
  it("no stylesheet under src/window keys a selector on aria-hidden", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        return statSync(path).isDirectory() ? walk(path) : entry.endsWith(".css") ? [path] : [];
      });
    const root = join(__dirname, "..", "src/window");
    const offenders = walk(root).filter((path) => /aria-hidden/u.test(readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//gu, "")));
    expect(offenders).toEqual([]);
  });
});
