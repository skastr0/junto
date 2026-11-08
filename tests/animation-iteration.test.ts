// @vitest-environment jsdom
/**
 * A looping CSS animation never wakes the main thread: no listener for
 * animationiteration is registered in the window (animation-iteration.ts),
 * React's included, and nothing in the source listens for it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ITERATION_EVENT_TYPES, refuseAnimationIterationListeners } from "../src/window/lib/animation-iteration";

const SRC = join(__dirname, "..", "src");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(tsx?|css)$/.test(name) ? [path] : [];
  });

describe("animationiteration", () => {
  it("is refused on every target once installed, and other events still register", () => {
    // A subclass's prototype, so the test leaves jsdom's EventTarget alone.
    class Target extends EventTarget {}
    refuseAnimationIterationListeners(Target.prototype);
    const once = Target.prototype.addEventListener;
    refuseAnimationIterationListeners(Target.prototype); // never wrapped twice
    expect(Target.prototype.addEventListener).toBe(once);
    const target = new Target();
    const iteration = vi.fn();
    const end = vi.fn();
    for (const type of ITERATION_EVENT_TYPES) target.addEventListener(type, iteration);
    target.addEventListener("animationend", end);
    for (const type of ITERATION_EVENT_TYPES) target.dispatchEvent(new Event(type));
    target.dispatchEvent(new Event("animationend"));
    expect(iteration).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("is installed in the window entry before React makes a root", () => {
    const main = readFileSync(join(SRC, "window/main.tsx"), "utf8");
    const install = main.indexOf("refuseAnimationIterationListeners();");
    expect(install).toBeGreaterThan(0);
    expect(install).toBeLessThan(main.indexOf("createRoot(root)"));
  });

  it("has no listener anywhere in the source", () => {
    const users = files(SRC).filter((path) => {
      if (path.endsWith("animation-iteration.ts")) return false;
      return /onAnimationIteration|["'`]animationiteration["'`]|webkitAnimationIteration/i.test(readFileSync(path, "utf8"));
    });
    expect(users).toEqual([]);
  });
});
