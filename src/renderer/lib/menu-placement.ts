/**
 * Place a floating menu beside a screen rect without covering it when the
 * viewport allows: by default right of the rect, then below, left, above.
 * Side and end sides hug the rect's bottom-right corner; `align: "center"`
 * centres them on the rect instead, for a panel that grows out of one small
 * control. With no clear side, the menu sits at that corner, clamped into
 * the viewport.
 */
export type ScreenRect = {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
};

export type Size = { readonly width: number; readonly height: number };

export type Side = "right" | "below" | "left" | "above";

export type Align = "end" | "center";

const DEFAULT_SIDES: ReadonlyArray<Side> = ["right", "below", "left", "above"];

const GAP = 8;
const MARGIN = 8;

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(value, Math.max(min, max)));

export const placeBesideRect = (
  rect: ScreenRect,
  menu: Size,
  viewport: Size,
  sides: ReadonlyArray<Side> = DEFAULT_SIDES,
  align: Align = "end",
): { readonly x: number; readonly y: number } => {
  const maxX = viewport.width - menu.width - MARGIN;
  const maxY = viewport.height - menu.height - MARGIN;
  const alignedY = clamp(
    align === "center" ? (rect.top + rect.bottom - menu.height) / 2 : rect.bottom - menu.height,
    MARGIN,
    maxY,
  );
  const alignedX = clamp(
    align === "center" ? (rect.left + rect.right - menu.width) / 2 : rect.right - menu.width,
    MARGIN,
    maxX,
  );
  const at: Record<Side, { readonly x: number; readonly y: number }> = {
    right: { x: rect.right + GAP, y: alignedY },
    below: { x: alignedX, y: rect.bottom + GAP },
    left: { x: rect.left - GAP - menu.width, y: alignedY },
    above: { x: alignedX, y: rect.top - GAP - menu.height },
  };
  const fits = sides.map((side) => at[side]).find((point) =>
    point.x >= MARGIN && point.x <= maxX && point.y >= MARGIN && point.y <= maxY);
  return fits ?? { x: clamp(rect.right, MARGIN, maxX), y: clamp(rect.bottom, MARGIN, maxY) };
};

/** Top-left at the point (a right-click), clamped into the viewport. */
export const placeAtPoint = (
  point: { readonly x: number; readonly y: number },
  menu: Size,
  viewport: Size,
): { readonly x: number; readonly y: number } => ({
  x: clamp(point.x, MARGIN, viewport.width - menu.width - MARGIN),
  y: clamp(point.y, MARGIN, viewport.height - menu.height - MARGIN),
});
