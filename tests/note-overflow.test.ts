// @vitest-environment jsdom
/**
 * A note whose text runs past its box fades over its last line, and only
 * that note (lib/note-overflow.ts): a note that fits is never marked, so its
 * text is never masked, and the fade covers exactly one line at the cut.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

type Callback = (entries: ReadonlyArray<{ readonly target: Element }>) => void;
const observers: Array<{ readonly callback: Callback; readonly targets: Set<Element> }> = [];

vi.stubGlobal(
  "ResizeObserver",
  class {
    private readonly entry: { readonly callback: Callback; readonly targets: Set<Element> };
    constructor(callback: Callback) {
      this.entry = { callback, targets: new Set() };
      observers.push(this.entry);
    }
    observe(target: Element) { this.entry.targets.add(target); }
    unobserve(target: Element) { this.entry.targets.delete(target); }
    disconnect() { this.entry.targets.clear(); }
  },
);

const { watchNoteOverflow } = await import("../src/renderer/lib/note-overflow");

/** A note box of `client` px holding text `scroll` px tall, with one block. */
const note = (client: number, scroll: number) => {
  const el = document.createElement("div");
  el.append(document.createElement("p"));
  const size = { client, scroll };
  Object.defineProperty(el, "clientHeight", { get: () => size.client });
  Object.defineProperty(el, "scrollHeight", { get: () => size.scroll });
  return { el, size };
};

const resize = (target: Element) => {
  for (const observer of observers) if (observer.targets.has(target)) observer.callback([{ target }]);
};

afterEach(() => {
  document.body.replaceChildren();
});

it("marks a note whose text overflows, and leaves one that fits unmarked", () => {
  const long = note(60, 90);
  const fits = note(60, 60);
  const releaseLong = watchNoteOverflow(long.el);
  const releaseFits = watchNoteOverflow(fits.el);
  expect(long.el.hasAttribute("data-overflows")).toBe(true);
  expect(fits.el.hasAttribute("data-overflows")).toBe(false);
  releaseLong();
  releaseFits();
});

it("follows the box and the blocks inside it, and lets go on release", () => {
  const { el, size } = note(60, 60);
  const release = watchNoteOverflow(el);
  expect(el.hasAttribute("data-overflows")).toBe(false);
  // An image lands in a block: the text grows, the box does not.
  size.scroll = 80;
  resize(el.firstElementChild!);
  expect(el.hasAttribute("data-overflows")).toBe(true);
  // The note is made taller: everything fits again.
  size.client = 100;
  resize(el);
  expect(el.hasAttribute("data-overflows")).toBe(false);
  size.client = 60;
  resize(el);
  expect(el.hasAttribute("data-overflows")).toBe(true);
  release();
  expect(el.hasAttribute("data-overflows")).toBe(false);
  expect(observers.some((observer) => observer.targets.has(el))).toBe(false);
});

it("fades exactly one line, at the bottom, and only on a marked note", () => {
  const css = readFileSync(join(__dirname, "../src/renderer/styles.css"), "utf8");
  expect(css).toMatch(/\.note-md\[data-overflows\] \{\s*mask-image: linear-gradient\(to bottom, var\(--color-ground\) calc\(100% - 1lh\), transparent\);\s*\}/);
  // No other rule masks a note.
  expect(css.match(/\.note-md[^{]*\{[^}]*mask-image/g)).toHaveLength(1);
});
