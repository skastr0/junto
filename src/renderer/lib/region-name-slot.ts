// Where a region prints its name when the camera pulls back.
//
// Every region names itself across its own body in large condensed capitals
// (region-glance.ts), nested regions included. A name is only useful if it
// can be read, so it goes where nothing else is drawn: the largest clear
// rectangle inside the region, clear of the regions nested in it (they print
// their own names there) and, when there is room, of the cards sitting in it.
// A region's slot lies inside its own box and outside every child's box, so
// no two names can overlap, whatever the nesting.
//
// Pure geometry in flow units, computed once per projection (convert.ts) and
// memoised on the inputs, so a zoom never measures anything.

export type SlotRect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/** A name's place inside its region, relative to the region's top-left, and its type size. */
export type RegionNameSlot = SlotRect & { readonly fontSize: number };

/** Title bar height and frame width (styles.css --junto-region-titlebar, --junto-region-frame). */
const TITLEBAR = 24;
const FRAME = 12;
/** Clear ground kept between a name and what it avoids. */
const MARGIN = 16;
/** Advance width of one uppercase condensed glyph, letter-spacing included. */
const GLYPH_RATIO = 0.68;
/** Share of the slot's width the name may take. */
const WIDTH_SHARE = 0.9;
/** Share of the slot's height the name may take: the rest is breathing room. */
const HEIGHT_SHARE = 0.6;
/**
 * The smallest name worth printing: about 8px on screen at the far tier's
 * lowest zoom (0.2). A slot that cannot hold it still gets it.
 */
export const REGION_NAME_MIN_PX = 40;
export const REGION_NAME_MAX_PX = 240;

/**
 * The largest single line of `label` that fits a `width` x `height` box. A
 * box too short for the height share still takes a name at the floor size if
 * the line fits in it.
 */
export const nameFontSize = (width: number, height: number, label: string): number => {
  const chars = Math.max(label.trim().length, 3);
  const byHeight = Math.max(height * HEIGHT_SHARE, Math.min(height * 0.95, REGION_NAME_MIN_PX));
  const fit = Math.min((width * WIDTH_SHARE) / (chars * GLYPH_RATIO), byHeight);
  if (!Number.isFinite(fit) || fit <= 0) return 0;
  return Math.min(fit, REGION_NAME_MAX_PX);
};

type Interval = readonly [number, number];

/**
 * The clear rectangle inside `area` avoiding every obstacle that gives
 * `label` the largest type. Candidate top and bottom edges are the area's and
 * the obstacles'; for each band between two of them, the obstacles crossing
 * the band block intervals of x and the gaps between those are the
 * candidates. Ties go to the larger rectangle, so a name sits in open ground.
 */
const bestClearRect = (
  area: SlotRect,
  obstacles: ReadonlyArray<SlotRect>,
  label: string,
): { readonly rect: SlotRect; readonly fontSize: number } | undefined => {
  const left = area.x;
  const right = area.x + area.width;
  const top = area.y;
  const bottom = area.y + area.height;
  const edges = new Set<number>([top, bottom]);
  for (const o of obstacles) {
    if (o.y > top && o.y < bottom) edges.add(o.y);
    const end = o.y + o.height;
    if (end > top && end < bottom) edges.add(end);
  }
  const ys = [...edges].sort((a, b) => a - b);
  let best: { rect: SlotRect; fontSize: number; area: number } | undefined;
  for (let i = 0; i < ys.length - 1; i += 1) {
    for (let j = i + 1; j < ys.length; j += 1) {
      const y1 = ys[i]!;
      const y2 = ys[j]!;
      const blocked: Interval[] = [];
      for (const o of obstacles) {
        if (o.y < y2 && o.y + o.height > y1 && o.x < right && o.x + o.width > left) {
          blocked.push([Math.max(o.x, left), Math.min(o.x + o.width, right)]);
        }
      }
      blocked.sort((a, b) => a[0] - b[0]);
      let cursor = left;
      const consider = (x1: number, x2: number): void => {
        if (x2 - x1 <= 0) return;
        const fontSize = nameFontSize(x2 - x1, y2 - y1, label);
        const size = (x2 - x1) * (y2 - y1);
        if (best === undefined || fontSize > best.fontSize + 0.5 || (fontSize > best.fontSize - 0.5 && size > best.area)) {
          best = { rect: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }, fontSize, area: size };
        }
      };
      for (const [start, end] of blocked) {
        consider(cursor, start);
        cursor = Math.max(cursor, end);
      }
      consider(cursor, right);
    }
  }
  return best;
};

const grow = (rect: SlotRect, by: number): SlotRect => ({
  x: rect.x - by,
  y: rect.y - by,
  width: rect.width + by * 2,
  height: rect.height + by * 2,
});

/**
 * The slot for a region's name. `children` are the regions directly inside
 * it; `members` the cards directly inside it (not inside a child). Cards are
 * avoided when a legible name still fits around them; otherwise the name sits
 * over them, still clear of every child region.
 */
export const regionNameSlot = (
  region: SlotRect,
  children: ReadonlyArray<SlotRect>,
  members: ReadonlyArray<SlotRect>,
  label: string,
): RegionNameSlot => {
  const area: SlotRect = {
    x: region.x + FRAME,
    y: region.y + TITLEBAR,
    width: Math.max(0, region.width - FRAME * 2),
    height: Math.max(0, region.height - TITLEBAR - FRAME),
  };
  const walls = children.map((child) => grow(child, MARGIN));
  const clear = bestClearRect(area, [...walls, ...members.map((member) => grow(member, MARGIN))], label);
  // Printing over cards is the last resort: clear ground wins unless the
  // open slot gives a name clearly larger (a long name is width-bound either
  // way, so it keeps clear of the cards).
  const pick =
    clear !== undefined && clear.fontSize >= REGION_NAME_MIN_PX
      ? clear
      : (() => {
          const open = bestClearRect(area, walls, label);
          if (open === undefined) return clear;
          if (clear === undefined) return open;
          return open.fontSize > clear.fontSize * 1.25 ? open : clear;
        })();
  const rect = pick?.rect ?? area;
  return {
    x: Math.round(rect.x - region.x),
    y: Math.round(rect.y - region.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    fontSize: Math.round(Math.max(pick?.fontSize ?? 0, REGION_NAME_MIN_PX)),
  };
};

/** Structural equality for the projection's identity cache. */
export const sameNameSlot = (a: RegionNameSlot | undefined, b: RegionNameSlot | undefined): boolean =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height &&
    a.fontSize === b.fontSize);
