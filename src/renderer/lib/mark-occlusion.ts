/**
 * Covered rings: a moving mark wholly under an opaque surface (the working
 * panel) cannot be seen, so its parts stop as an offscreen mark's do. The
 * operator authorized this as the motion law's third exception (signal
 * 01M630R3Y59C42SSY754K3ADZZ). A mark partly under a surface, or over it,
 * keeps turning.
 *
 * Nothing here runs per frame. Each opaque surface gets an
 * IntersectionObserver whose root box is the surface's own box (the
 * rootMargin cuts the viewport down to it, less the corner radius and
 * SLACK), so the browser itself reports a mark going wholly inside the
 * surface or coming partly out, through pan, scroll and moves. A mark on the
 * zoomed canvas reads 0.9999998, not 1, when wholly inside, so a reading
 * covers at a ratio of 0.99 with the mark's box inside the root box give or
 * take SLACK; a mark partly out of the surface itself has crossed SLACK and
 * the radius, far more than 1%, so it fires a reading and keeps turning.
 * The centre hit test runs only inside those readings. The box is read again when the
 * surface opens, ends its entrance, resizes, or the window or the surface's
 * frame resizes. Every reading first uncovers every mark in the same task,
 * so a ring the surface no longer hides never waits for the observer.
 */

type Box = { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };
type Size = { readonly width: number; readonly height: number };

/** Px the root box sits inside the surface past its corner radius; a covered mark may straddle it by this much. */
export const SLACK = 2;
/** The ratio a covering reading needs; the observer fires on crossing it. */
export const COVER_RATIO = 0.99;

/** The rootMargin that cuts a viewport of `viewport` down to `box`, inset by `inset` on every side (rounded inward). */
export const surfaceRootMargin = (box: Box, viewport: Size, inset: number): string =>
  [box.top + inset, viewport.width - box.right + inset, viewport.height - box.bottom + inset, box.left + inset]
    .map((cut) => `${String(-Math.ceil(cut))}px`)
    .join(" ");

/** True when `mark` lies inside `root`, give or take `slack` px on each side. */
export const boxWithin = (mark: Box, root: Box | null, slack: number): boolean =>
  root !== null &&
  mark.left >= root.left - slack &&
  mark.top >= root.top - slack &&
  mark.right <= root.right + slack &&
  mark.bottom <= root.bottom + slack;

/** True when a computed CSS colour has no transparency. */
export const opaqueColor = (css: string): boolean => {
  const value = css.trim().toLowerCase();
  if (value === "" || value === "transparent") return false;
  const slash = /\/\s*([\d.]+)(%?)\s*\)$/.exec(value);
  if (slash) return Number(slash[1]) >= (slash[2] === "%" ? 100 : 1);
  const rgba = /^rgba\(.*,\s*([\d.]+)\s*\)$/.exec(value);
  if (rgba) return Number(rgba[1]) >= 1;
  return true;
};

/**
 * Whether one observer reading covers a mark: wholly inside the surface's box,
 * not drawn by the surface itself, and under it (the surface is what the
 * pointer would hit at the mark's centre).
 */
export const coversMark = (reading: {
  readonly intersectionRatio: number;
  /** The mark's box inside the root box, give or take SLACK. */
  readonly withinBox: boolean;
  readonly ownedBySurface: boolean;
  readonly surfaceOnTop: boolean;
}): boolean =>
  reading.intersectionRatio >= COVER_RATIO && reading.withinBox && !reading.ownedBySurface && reading.surfaceOnTop;

/** An opaque surface only hides what is under it once it is fully drawn. */
const isOpaqueSurface = (el: HTMLElement): boolean => {
  if (!opaqueColor(getComputedStyle(el).backgroundColor)) return false;
  for (let at: Element | null = el; at; at = at.parentElement) {
    const opacity = getComputedStyle(at).opacity;
    if (opacity !== "" && Number(opacity) < 1) return false;
  }
  return true;
};

const surfaceOnTop = (surface: HTMLElement, mark: HTMLElement): boolean => {
  // The hit test passes over a mark that takes no pointer: never count one as covered.
  if (getComputedStyle(mark).pointerEvents === "none") return false;
  const r = mark.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return hit !== null && surface.contains(hit);
};

type Surface = { readonly el: HTMLElement; io: IntersectionObserver | undefined; readonly covered: Set<HTMLElement> };

const marks = new Set<HTMLElement>();
const surfaces = new Set<Surface>();
let listener: ((mark: HTMLElement) => void) | undefined;

/** One listener (ActivityMark): told each time a mark's covered state flips. */
export const onCoverChange = (fn: (mark: HTMLElement) => void): void => {
  listener = fn;
};

export const isCovered = (mark: HTMLElement): boolean => {
  for (const s of surfaces) if (s.covered.has(mark)) return true;
  return false;
};

const setCovered = (s: Surface, mark: HTMLElement, on: boolean): void => {
  const was = isCovered(mark);
  if (on) s.covered.add(mark);
  else s.covered.delete(mark);
  if (isCovered(mark) !== was) listener?.(mark);
};

const uncoverAll = (s: Surface): void => {
  for (const mark of [...s.covered]) setCovered(s, mark, false);
};

const read = (s: Surface): void => {
  s.io?.disconnect();
  s.io = undefined;
  uncoverAll(s);
  if (!s.el.isConnected || typeof IntersectionObserver !== "function" || !isOpaqueSurface(s.el)) return;
  const style = getComputedStyle(s.el);
  const radius = Math.max(
    ...[style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius].map(
      (v) => Number.parseFloat(v) || 0,
    ),
  );
  const root = document.documentElement;
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const mark = entry.target as HTMLElement;
        if (!marks.has(mark)) continue;
        const withinBox = boxWithin(entry.boundingClientRect, entry.rootBounds, SLACK);
        const inside = entry.intersectionRatio >= COVER_RATIO && withinBox;
        setCovered(s, mark, coversMark({
          intersectionRatio: entry.intersectionRatio,
          withinBox,
          ownedBySurface: s.el.contains(mark),
          surfaceOnTop: inside && surfaceOnTop(s.el, mark),
        }));
      }
    },
    {
      rootMargin: surfaceRootMargin(s.el.getBoundingClientRect(), { width: root.clientWidth, height: root.clientHeight }, radius + SLACK),
      threshold: [COVER_RATIO, 1],
    },
  );
  s.io = io;
  for (const mark of marks) if (!s.el.contains(mark)) io.observe(mark);
};

const readAll = (): void => {
  for (const s of surfaces) read(s);
};

/** A moving mark that a surface may cover. Returns its release. */
export const watchCoverable = (mark: HTMLElement): (() => void) => {
  marks.add(mark);
  for (const s of surfaces) if (!s.el.contains(mark)) s.io?.observe(mark);
  return () => {
    marks.delete(mark);
    for (const s of surfaces) {
      s.io?.unobserve(mark);
      s.covered.delete(mark);
    }
  };
};

export type OpaqueSurface = {
  /** Read the box again: layout moved the surface without resizing it. */
  readonly refresh: () => void;
  readonly release: () => void;
};

/** An opaque surface (the working panel) whose box hides the rings under it. */
export const registerOpaqueSurface = (el: HTMLElement): OpaqueSurface => {
  const s: Surface = { el, io: undefined, covered: new Set() };
  surfaces.add(s);
  const refresh = (): void => read(s);
  // Fires once on observe, then on every size change of the surface or its frame.
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(refresh) : undefined;
  ro?.observe(el);
  if (el.parentElement) ro?.observe(el.parentElement);
  if (!ro) refresh();
  const onAnimationEnd = (event: AnimationEvent): void => {
    if (event.target === el) refresh();
  };
  el.addEventListener("animationend", onAnimationEnd);
  if (surfaces.size === 1) window.addEventListener("resize", readAll);
  return {
    refresh,
    release: () => {
      ro?.disconnect();
      el.removeEventListener("animationend", onAnimationEnd);
      s.io?.disconnect();
      s.io = undefined;
      surfaces.delete(s);
      if (surfaces.size === 0) window.removeEventListener("resize", readAll);
      for (const mark of [...s.covered]) {
        s.covered.delete(mark);
        if (!isCovered(mark)) listener?.(mark);
      }
    },
  };
};
