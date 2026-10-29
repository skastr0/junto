// @vitest-environment jsdom
/**
 * Covered rings (mark-occlusion.ts): a moving mark wholly under an opaque
 * surface stops, a partly covered one keeps turning, and every change of the
 * surface uncovers first. The browser observers are stood in for, so each
 * reading is the one IntersectionObserver would deliver.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  boxWithin,
  COVER_RATIO,
  coversMark,
  isCovered,
  onCoverChange,
  opaqueColor,
  registerOpaqueSurface,
  SLACK,
  surfaceRootMargin,
  watchCoverable,
} from "../src/renderer/lib/mark-occlusion";

type Rect = { left: number; top: number; right: number; bottom: number };
type Reading = { target: Element; isIntersecting: boolean; intersectionRatio: number; boundingClientRect: Rect; rootBounds: Rect | null };

const ROOT: Rect = { left: 100, top: 100, right: 500, bottom: 400 };
/** A 50px mark wholly inside ROOT, or straddling its left edge by `out` px. */
const markBox = (out = 0): Rect => ({ left: 200 - (out ? 100 + out : 0), top: 200, right: 250 - (out ? 100 + out : 0), bottom: 250 });

class FakeIntersectionObserver {
  static all: FakeIntersectionObserver[] = [];
  readonly targets = new Set<Element>();
  disconnected = false;
  constructor(
    readonly callback: (entries: Reading[]) => void,
    readonly options: IntersectionObserverInit,
  ) {
    FakeIntersectionObserver.all.push(this);
  }
  observe(el: Element): void {
    this.targets.add(el);
  }
  unobserve(el: Element): void {
    this.targets.delete(el);
  }
  disconnect(): void {
    this.disconnected = true;
    this.targets.clear();
  }
  deliver(target: Element, ratio: number, out = 0): void {
    this.callback([{ target, isIntersecting: ratio > 0, intersectionRatio: ratio, boundingClientRect: markBox(out), rootBounds: ROOT }]);
  }
}

class FakeResizeObserver {
  static all: FakeResizeObserver[] = [];
  constructor(readonly callback: () => void) {
    FakeResizeObserver.all.push(this);
  }
  observe(): void {}
  disconnect(): void {}
}

const live = (): FakeIntersectionObserver => {
  const io = FakeIntersectionObserver.all.filter((o) => !o.disconnected).at(-1);
  if (!io) throw new Error("no live surface observer");
  return io;
};

let panel: HTMLElement;
let flips: HTMLElement[];
const releases: Array<() => void> = [];

beforeEach(() => {
  FakeIntersectionObserver.all = [];
  FakeResizeObserver.all = [];
  (globalThis as Record<string, unknown>).IntersectionObserver = FakeIntersectionObserver;
  (globalThis as Record<string, unknown>).ResizeObserver = FakeResizeObserver;
  panel = document.createElement("div");
  panel.style.backgroundColor = "rgb(240, 238, 230)";
  document.body.appendChild(panel);
  // The panel is what the pointer hits over any mark under it.
  document.elementFromPoint = () => panel;
  flips = [];
  onCoverChange((mark) => flips.push(mark));
});

afterEach(() => {
  for (const release of releases.splice(0)) release();
  document.body.replaceChildren();
});

const mark = (): HTMLElement => {
  const el = document.createElement("span");
  document.body.appendChild(el);
  releases.push(watchCoverable(el));
  return el;
};

const surface = (): ReturnType<typeof registerOpaqueSurface> => {
  const s = registerOpaqueSurface(panel);
  releases.push(s.release);
  // ResizeObserver fires once on observe: that is the first reading of the box.
  for (const ro of FakeResizeObserver.all) ro.callback();
  return s;
};

describe("covered rings", () => {
  it("a mark wholly under the opaque panel is covered, and only then", () => {
    const m = mark();
    surface();
    live().deliver(m, 1);
    expect(isCovered(m)).toBe(true);
    expect(flips).toEqual([m]);
  });

  it("a partly covered mark keeps turning", () => {
    const m = mark();
    surface();
    live().deliver(m, 0.6, 20);
    expect(isCovered(m)).toBe(false);
    live().deliver(m, 1);
    live().deliver(m, 0.95, 3);
    expect(isCovered(m)).toBe(false);
    expect(flips).toEqual([m, m]);
  });

  it("a mark wholly inside on the zoomed canvas reads 0.9999998 and is covered", () => {
    const m = mark();
    surface();
    live().deliver(m, 0.9999998);
    expect(isCovered(m)).toBe(true);
    // Straddling the root box by more than SLACK is partly out: it keeps turning.
    live().deliver(m, 0.995, SLACK + 1);
    expect(isCovered(m)).toBe(false);
  });

  it("a mark the panel draws, or one over the panel, is never covered", () => {
    const inside = document.createElement("span");
    panel.appendChild(inside);
    releases.push(watchCoverable(inside));
    surface();
    expect(live().targets.has(inside)).toBe(false);
    const over = mark();
    document.elementFromPoint = () => over;
    live().deliver(over, 1);
    expect(isCovered(over)).toBe(false);
  });

  it("closing the panel uncovers its marks in the same task", () => {
    const m = mark();
    const s = surface();
    live().deliver(m, 1);
    s.release();
    releases.splice(releases.indexOf(s.release), 1);
    expect(isCovered(m)).toBe(false);
    expect(flips).toEqual([m, m]);
  });

  it("a resize or a refresh uncovers first, then reads the box again", () => {
    const m = mark();
    const s = surface();
    const first = live();
    first.deliver(m, 1);
    s.refresh();
    expect(first.disconnected).toBe(true);
    expect(isCovered(m)).toBe(false);
    expect(live()).not.toBe(first);
    expect(live().targets.has(m)).toBe(true);
  });

  it("a panel still fading in, or see-through, covers nothing", () => {
    mark();
    panel.style.opacity = "0.4";
    surface();
    expect(FakeIntersectionObserver.all.filter((o) => !o.disconnected)).toHaveLength(0);
    panel.style.opacity = "1";
    panel.style.backgroundColor = "rgba(240, 238, 230, 0.7)";
    panel.dispatchEvent(new Event("animationend"));
    expect(FakeIntersectionObserver.all.filter((o) => !o.disconnected)).toHaveLength(0);
  });

  it("the observer's root box is the panel's box, less the inset, rounded inward", () => {
    expect(surfaceRootMargin({ left: 100, top: 50, right: 900, bottom: 650 }, { width: 1440, height: 900 }, 12))
      .toBe("-62px -552px -262px -112px");
    expect(surfaceRootMargin({ left: 48.2, top: 80, right: 1392, bottom: 884.5 }, { width: 1440, height: 900 }, 14))
      .toBe("-94px -62px -30px -63px");
    expect(FakeIntersectionObserver.all).toHaveLength(0);
  });

  it("a box inside the root box, give or take the slack", () => {
    expect(boxWithin(markBox(), ROOT, SLACK)).toBe(true);
    expect(boxWithin(markBox(SLACK), ROOT, SLACK)).toBe(true);
    expect(boxWithin(markBox(SLACK + 0.5), ROOT, SLACK)).toBe(false);
    expect(boxWithin(markBox(), null, SLACK)).toBe(false);
  });

  it("reads opacity from computed colours", () => {
    expect(opaqueColor("rgb(1, 2, 3)")).toBe(true);
    expect(opaqueColor("oklch(0.945 0.012 85)")).toBe(true);
    expect(opaqueColor("oklch(0.945 0.012 85 / 0.72)")).toBe(false);
    expect(opaqueColor("color(srgb 1 1 1 / 100%)")).toBe(true);
    expect(opaqueColor("rgba(0, 0, 0, 0.5)")).toBe(false);
    expect(opaqueColor("transparent")).toBe(false);
  });

  it("the reading rule: wholly inside, not the surface's own, and under it", () => {
    const base = { intersectionRatio: 1, withinBox: true, ownedBySurface: false, surfaceOnTop: true };
    expect(coversMark(base)).toBe(true);
    expect(coversMark({ ...base, intersectionRatio: COVER_RATIO })).toBe(true);
    expect(coversMark({ ...base, intersectionRatio: 0.98 })).toBe(false);
    expect(coversMark({ ...base, withinBox: false })).toBe(false);
    expect(coversMark({ ...base, ownedBySurface: true })).toBe(false);
    expect(coversMark({ ...base, surfaceOnTop: false })).toBe(false);
  });
});
