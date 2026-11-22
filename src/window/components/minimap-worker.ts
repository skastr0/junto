/**
 * The minimap's cards and dots, drawn off the window's main thread into the
 * map's canvas (transferred here as an OffscreenCanvas). At 100x the draw is
 * some 35,000 paths, 62 ms on the Mac mini: here it holds no frame of the
 * window's. The window sends the packed map when the rectangles or their
 * colours change, and the placement when the viewBox, the size or the pixel
 * ratio change; the worker draws the latest of both once per frame.
 */
import { drawMap, type MapPaint, type MinimapWorkerMessage, type PackedMap } from "./minimap-draw";

let canvas: OffscreenCanvas | undefined;
let map: PackedMap | undefined;
let paint: { readonly paint: MapPaint; readonly pixelWidth: number; readonly pixelHeight: number } | undefined;
let scheduled = false;

const draw = (): void => {
  scheduled = false;
  if (canvas === undefined || map === undefined || paint === undefined) return;
  if (canvas.width !== paint.pixelWidth) canvas.width = paint.pixelWidth;
  if (canvas.height !== paint.pixelHeight) canvas.height = paint.pixelHeight;
  const context = canvas.getContext("2d");
  if (context === null) return;
  drawMap(context, map, paint.paint);
};

const schedule = (): void => {
  if (scheduled) return;
  scheduled = true;
  // Messages that arrive while a draw runs are all read before the next one.
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(draw);
  else setTimeout(draw, 0);
};

self.onmessage = (event: MessageEvent<MinimapWorkerMessage>): void => {
  const message = event.data;
  if (message.kind === "canvas") canvas = message.canvas;
  else if (message.kind === "map") map = message.map;
  else paint = { paint: message.paint, pixelWidth: message.pixelWidth, pixelHeight: message.pixelHeight };
  schedule();
};
