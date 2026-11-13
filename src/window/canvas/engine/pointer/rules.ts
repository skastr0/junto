/**
 * Today's numbers for the hands (section 15), each with the line it was read
 * at, and the small geometry the pointer machine needs: handle points, verb
 * landing zones, resize rules, rectangle tests. Pure, no state.
 */

import { holdsSeatRing } from "@shared/node-geometry";
import type { HandleSide, NodeId, Point, Rect, Size } from "../../contract";

/** A drag, a marquee and a connect start after this many screen pixels (rf-system:2247-2256, rf-react:1474). */
export const DRAG_THRESHOLD_PX = 1;

/** `connectionRadius={42}`, board units (Canvas.tsx:1845; rf-system:2486). */
export const CONNECT_SNAP_RADIUS = 42;

/** Landing zones bleed past the card (NodeShell.tsx:67). */
export const VERB_ZONE_BLEED = 16;

/**
 * Handle dots sit on each side's midpoint, the source dot 2 units outward and
 * the target dot 3 units inward (styles.css:1509-1516). Snapping measures to
 * these points.
 */
export const HANDLE_SOURCE_OUTSET = 2;
export const HANDLE_TARGET_INSET = 3;

export const HANDLE_SIDES: ReadonlyArray<HandleSide> = ["top", "right", "bottom", "left"];

/** Handle ids as React Flow carries them today: `s-<side>`, `t-<side>` (lib/flow-edges.ts:52-54). */
export const handleId = (role: "source" | "target", side: HandleSide): string => `${role === "source" ? "s" : "t"}-${side}`;

/** A landing zone's handle id (lib/edge-mutations.ts:71-75). */
export const verbHandleId = (verb: string): string => `verb:${verb}`;

/** Cards with no connect handles: regions, labels, git and files (TextNode.tsx:282; GroupNode has none). */
export const hasHandles = (kind: string | undefined): boolean =>
  kind !== undefined && kind !== "region" && kind !== "label" && kind !== "git" && kind !== "files";

const NORMAL: Readonly<Record<HandleSide, Point>> = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};

/** The board point a handle snaps at. */
export const handlePoint = (rect: Rect, side: HandleSide, role: "source" | "target"): Point => {
  const mid =
    side === "top"
      ? { x: rect.x + rect.width / 2, y: rect.y }
      : side === "right"
        ? { x: rect.x + rect.width, y: rect.y + rect.height / 2 }
        : side === "bottom"
          ? { x: rect.x + rect.width / 2, y: rect.y + rect.height }
          : { x: rect.x, y: rect.y + rect.height / 2 };
  const shift = role === "source" ? HANDLE_SOURCE_OUTSET : -HANDLE_TARGET_INSET;
  return { x: mid.x + NORMAL[side].x * shift, y: mid.y + NORMAL[side].y * shift };
};

export type VerbZone = {
  readonly verb: string;
  /** What the zone covers, bleed included. */
  readonly area: Rect;
  /** Where the zone's handle snaps from outside it (its outer side's midpoint). */
  readonly snap: Point;
};

/**
 * The two-verb choice (NodeShell.tsx:89-152): when the pair offers exactly two
 * verbs, the card's left half takes the first and its right half the second,
 * each bleeding 16 units past the card's top, bottom and outer side. A pair
 * with one verb or none shows no zones.
 */
export const verbZones = (rect: Rect, verbs: ReadonlyArray<string>): ReadonlyArray<VerbZone> => {
  const [first, second] = verbs;
  if (verbs.length !== 2 || first === undefined || second === undefined) return [];
  const half = rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const top = rect.y - VERB_ZONE_BLEED;
  const height = rect.height + 2 * VERB_ZONE_BLEED;
  return [
    { verb: first, area: { x: rect.x - VERB_ZONE_BLEED, y: top, width: half + VERB_ZONE_BLEED, height }, snap: { x: rect.x - VERB_ZONE_BLEED, y: cy } },
    { verb: second, area: { x: rect.x + half, y: top, width: half + VERB_ZONE_BLEED, height }, snap: { x: rect.x + rect.width + VERB_ZONE_BLEED, y: cy } },
  ];
};

/** What a card's resize handles may do. */
export type ResizeRule = { readonly kind: "fixed" } | { readonly kind: "free"; readonly min: Size };

export const CARD_MIN_SIZE: Size = { width: 170, height: 72 };
/** Bare cards (labels): NodeShell.tsx:495-496, TextNode.tsx:283. */
export const BARE_MIN_SIZE: Size = { width: 48, height: 24 };
/** GroupNode.tsx:354. */
export const REGION_MIN_SIZE: Size = { width: 320, height: 180 };

/**
 * The resize rule by kind (section 4 of the interaction inventory): regions
 * 320 by 180; seats and kind seats are fixed (TextNode.tsx:281); image and
 * page cards are fixed (FileNode.tsx:121, LinkNode.tsx:75, 95); labels are
 * bare, 48 by 24; every other card 170 by 72.
 */
export const resizeRuleFor = (kind: string | undefined): ResizeRule => {
  if (kind === undefined) return { kind: "fixed" };
  if (kind === "region") return { kind: "free", min: REGION_MIN_SIZE };
  if (kind === "file" || kind === "page" || kind === "link" || holdsSeatRing(kind)) return { kind: "fixed" };
  if (kind === "label") return { kind: "free", min: BARE_MIN_SIZE };
  return { kind: "free", min: CARD_MIN_SIZE };
};

/** A resize handle: a corner, or one of the four edge lines (rf-system:3115-3116). */
export type ResizeDirection = "nw" | "ne" | "se" | "sw" | "n" | "e" | "s" | "w";

/**
 * The rectangle after a resize, as XYResizer works it out (rf-system:3188-3242,
 * no aspect lock, no maximum): the pointer's board travel floored, the size
 * clamped at the minimum, and a handle on the left or top keeping the opposite
 * edge where it was.
 */
export const resizedRect = (start: Rect, direction: ResizeDirection, travel: Point, min: Size): Rect => {
  const affectsX = direction.includes("w");
  const affectsY = direction.includes("n");
  const horizontal = affectsX || direction.includes("e");
  const vertical = affectsY || direction.includes("s");
  const dx = horizontal ? Math.floor(travel.x) : 0;
  const dy = vertical ? Math.floor(travel.y) : 0;
  const width = Math.max(min.width, start.width + (affectsX ? -dx : dx));
  const height = Math.max(min.height, start.height + (affectsY ? -dy : dy));
  return {
    x: affectsX ? start.x + start.width - width : start.x,
    y: affectsY ? start.y + start.height - height : start.y,
    width,
    height,
  };
};

export const contains = (rect: Rect, at: Point): boolean =>
  at.x >= rect.x && at.x <= rect.x + rect.width && at.y >= rect.y && at.y <= rect.y + rect.height;

/** Overlap with area above zero: the marquee's `SelectionMode.Partial` (rf-system:354-379). */
export const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

export const rectBetween = (a: Point, b: Point): Rect => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  width: Math.abs(a.x - b.x),
  height: Math.abs(a.y - b.y),
});

export const around = (at: Point, slop: number): Rect => ({ x: at.x - slop, y: at.y - slop, width: slop * 2, height: slop * 2 });

export const boundsOf = (rects: ReadonlyArray<Rect>): Rect | undefined => {
  if (rects.length === 0) return undefined;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.width);
    y1 = Math.max(y1, r.y + r.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
};

export const sameIds = (a: ReadonlyArray<NodeId>, b: ReadonlyArray<NodeId>): boolean => {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
};
