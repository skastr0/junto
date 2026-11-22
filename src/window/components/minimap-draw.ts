/**
 * The minimap's drawing, shared by its worker and the window: the cards and
 * seat dots packed into flat arrays with colours already resolved, and the
 * one function that draws them into a 2D context, the window's or a worker's
 * OffscreenCanvas. Nothing here touches the DOM.
 */

/** A seat's dot radius floor, in map pixels; a seat with an urgency rings wider. */
export const SEAT_DOT_PX = 2.2;
export const URGENT_DOT_PX = 3;

/** What `drawMap` draws, in the SVG's order. Colours are indices into `palette`. */
export type PackedMap = {
  readonly count: number;
  /** x, y, width, height per rectangle, in board units. */
  readonly boxes: Float64Array;
  /** 0 a card, 1 a seat, 2 a seat with an urgency. */
  readonly kinds: Uint8Array;
  readonly fills: Uint16Array;
  /** A card's stroke; a seat's rim. */
  readonly strokes: Uint16Array;
  readonly palette: ReadonlyArray<string>;
};

export type MapPaint = {
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  /** The map's size in CSS pixels. */
  readonly width: number;
  readonly height: number;
  readonly ratio: number;
  /** Board units per map pixel. */
  readonly unit: number;
  readonly strokeWidth: number;
  readonly radius: number;
};

export type MapContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Draw the map's cards and dots, in the SVG's order: cards, then seats over them. */
export const drawMap = (context: MapContext, map: PackedMap, paint: MapPaint): void => {
  const { box, width, height, ratio, unit } = paint;
  const { boxes, kinds, fills, strokes, palette } = map;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, context.canvas.width, context.canvas.height);
  const unitsPerPixel = Math.max(box.width / Math.max(width, 1), box.height / Math.max(height, 1));
  if (!(unitsPerPixel > 0) || !Number.isFinite(unitsPerPixel)) return;
  // The viewBox's own placement (xMidYMid meet), at the device's pixel ratio.
  const scale = 1 / unitsPerPixel;
  const x = (width - box.width * scale) / 2 - box.x * scale;
  const y = (height - box.height * scale) / 2 - box.y * scale;
  // A colour is parsed each time it is set: set it only when it changes.
  let fill = -1;
  let stroke = -1;
  // Cards in device pixels, as the SVG's crispEdges drew them: a pixel is the
  // card's when its centre is inside it, so each edge rounds to a pixel line.
  const k = scale * ratio;
  context.lineWidth = paint.strokeWidth * k;
  for (let i = 0; i < map.count; i += 1) {
    if (kinds[i] !== 0) continue;
    const bx = boxes[i * 4]!;
    const by = boxes[i * 4 + 1]!;
    const x0 = Math.round(x * ratio + bx * k);
    const y0 = Math.round(y * ratio + by * k);
    const w = Math.round(x * ratio + (bx + boxes[i * 4 + 2]!) * k) - x0;
    const h = Math.round(y * ratio + (by + boxes[i * 4 + 3]!) * k) - y0;
    if (w <= 0 || h <= 0) continue;
    context.beginPath();
    const r = Math.min(paint.radius * k, w / 2, h / 2);
    if (r >= 0.5) context.roundRect(x0, y0, w, h, r);
    else context.rect(x0, y0, w, h);
    if (fills[i] !== fill) context.fillStyle = palette[(fill = fills[i]!)]!;
    context.fill();
    if (strokes[i] !== stroke) context.strokeStyle = palette[(stroke = strokes[i]!)]!;
    context.stroke();
  }
  context.setTransform(k, 0, 0, k, x * ratio, y * ratio);
  context.lineWidth = 0.8 * unit;
  for (let i = 0; i < map.count; i += 1) {
    const kind = kinds[i]!;
    if (kind === 0) continue;
    const w = boxes[i * 4 + 2]!;
    const h = boxes[i * 4 + 3]!;
    context.beginPath();
    const radius = Math.max(Math.min(w, h) / 2, (kind === 2 ? URGENT_DOT_PX : SEAT_DOT_PX) * unit);
    context.arc(boxes[i * 4]! + w / 2, boxes[i * 4 + 1]! + h / 2, radius, 0, Math.PI * 2);
    if (fills[i] !== fill) context.fillStyle = palette[(fill = fills[i]!)]!;
    context.fill();
    if (strokes[i] !== stroke) context.strokeStyle = palette[(stroke = strokes[i]!)]!;
    context.stroke();
  }
};

/** The window's messages to the minimap worker. */
export type MinimapWorkerMessage =
  | { readonly kind: "canvas"; readonly canvas: OffscreenCanvas }
  | { readonly kind: "map"; readonly map: PackedMap }
  | { readonly kind: "paint"; readonly paint: MapPaint; readonly pixelWidth: number; readonly pixelHeight: number };
