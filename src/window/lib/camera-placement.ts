import { getViewportForBounds, type Viewport } from "@xyflow/react";

// Where the camera sits when a canvas opens. Worked out from where the cards
// are and the size each is drawn at, both of which are known the moment the
// cards exist, so the camera is set once, at once, and is where it will stay
// before anyone can touch the canvas. Nothing here waits for a card to be
// measured and nothing glides.

/** What placing the camera needs to know of a card. */
export type PlacedNode = {
  readonly id: string;
  readonly type?: string | undefined;
  readonly position: { readonly x: number; readonly y: number };
  readonly style?: { readonly width?: unknown; readonly height?: unknown } | undefined;
};

type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

const PADDING = 0.18;
/** A canvas of loose cards opens on its first cluster, not on all of it. */
const FIRST_CLUSTER = 24;
/** Region names that say nothing, so the region is not something to open on. */
const UNNAMED = new Set(["", "n", "new region", "unnamed region"]);

const rectOf = (node: PlacedNode): Rect => ({
  x: node.position.x,
  y: node.position.y,
  width: Number(node.style?.width) || 0,
  height: Number(node.style?.height) || 0,
});

const around = (rects: ReadonlyArray<Rect>): Rect => {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
};

/**
 * What a canvas opens on: its named regions when it has any, else all its
 * regions, else its first cluster of cards. Regions are the map; a dense
 * canvas shown whole is unreadable.
 */
export const openingAnchors = <N extends PlacedNode>(
  nodes: ReadonlyArray<N>,
  nameOf: (node: N) => string,
): ReadonlyArray<N> => {
  const regions = nodes.filter((node) => node.type === "group");
  const named = regions.filter((region) => !UNNAMED.has(nameOf(region).trim().toLowerCase()));
  return named.length > 0 ? named : regions.length > 0 ? regions : nodes.slice(0, FIRST_CLUSTER);
};

/**
 * The camera for a canvas as it opens, or nothing while there is nothing to
 * show or the pane has no size yet.
 */
export const openingViewport = <N extends PlacedNode>(
  nodes: ReadonlyArray<N>,
  nameOf: (node: N) => string,
  pane: { readonly width: number; readonly height: number },
  minZoom: number,
): Viewport | undefined => {
  if (nodes.length === 0 || pane.width <= 0 || pane.height <= 0) return undefined;
  const anchors = openingAnchors(nodes, nameOf);
  const hasRegions = anchors.some((node) => node.type === "group");
  return getViewportForBounds(
    around(anchors.map(rectOf)),
    pane.width,
    pane.height,
    minZoom,
    hasRegions ? 1.15 : 1.35,
    PADDING,
  );
};
