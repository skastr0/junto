/**
 * Box drawing over a page (plan 06, B7). A page's view is native and paints
 * above the window, so the window cannot draw the box: an app-owned,
 * transparent view is laid over the page's view for the drag and removed
 * after it. The page never sees it. It loads one inline document with no
 * network, no preload and no node, and answers the box it drew through its
 * own script's result, so it needs no IPC of its own.
 *
 * Pointer and keys go to the overlay while it is up, so a drag here is not
 * the operator's input in the page and takes nothing over.
 */
import type { Rect } from "@shared/page-box";
import { PAGE_BOX_MIN_CSS_PX } from "@shared/page-box";

/** The overlay's own in-memory session: no cookies, no cache, nothing of any page. */
export const BOX_OVERLAY_PARTITION = "junto-box-overlay";

const OVERLAY_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
html,body{margin:0;height:100%;background:transparent;cursor:crosshair;user-select:none;overflow:hidden}
#box{position:fixed;display:none;box-sizing:border-box;border:2px solid #fff;outline:1px solid rgba(0,0,0,.6);box-shadow:0 0 0 100vmax rgba(0,0,0,.28)}
</style></head><body><div id="box"></div></body></html>`;

/** The overlay's document, as a URL it loads without the network. */
export const BOX_OVERLAY_URL = `data:text/html;charset=utf-8,${encodeURIComponent(OVERLAY_HTML)}`;

/**
 * Run in the overlay: resolves with the box the operator releases, in the
 * overlay's CSS pixels, or null on Escape. A drag smaller than the least box
 * is a click and drawing goes on. Only trusted input draws.
 */
export const BOX_OVERLAY_SCRIPT = `new Promise((resolve) => {
  const box = document.getElementById("box");
  const least = ${String(PAGE_BOX_MIN_CSS_PX)};
  let from;
  const rectTo = (event) => ({
    x: Math.min(from.x, event.clientX),
    y: Math.min(from.y, event.clientY),
    w: Math.abs(event.clientX - from.x),
    h: Math.abs(event.clientY - from.y),
  });
  const show = (r) => {
    box.style.display = "block";
    box.style.left = r.x + "px";
    box.style.top = r.y + "px";
    box.style.width = r.w + "px";
    box.style.height = r.h + "px";
  };
  addEventListener("pointerdown", (event) => {
    if (!event.isTrusted || event.button !== 0) return;
    from = { x: event.clientX, y: event.clientY };
    document.body.setPointerCapture(event.pointerId);
  });
  addEventListener("pointermove", (event) => {
    if (event.isTrusted && from !== undefined) show(rectTo(event));
  });
  addEventListener("pointerup", (event) => {
    if (!event.isTrusted || from === undefined) return;
    const r = rectTo(event);
    from = undefined;
    if (r.w >= least && r.h >= least) resolve(r);
    else box.style.display = "none";
  });
  addEventListener("keydown", (event) => {
    if (event.isTrusted && event.key === "Escape") resolve(null);
  });
})`;

/**
 * Pure: the box the overlay answered, in the page's CSS pixels, or undefined
 * for none (Escape) or an answer that is not four finite numbers. The overlay
 * draws in its own pixels; the page is zoomed by `zoom`.
 */
export const drawnBoxOf = (answer: unknown, zoom: number): Rect | undefined => {
  if (typeof answer !== "object" || answer === null || !Number.isFinite(zoom) || zoom <= 0) return undefined;
  const { x, y, w, h } = answer as Record<string, unknown>;
  const edges = [x, y, w, h];
  if (!edges.every((edge) => typeof edge === "number" && Number.isFinite(edge))) return undefined;
  const [left, top, width, height] = edges as [number, number, number, number];
  if (width <= 0 || height <= 0) return undefined;
  return { x: left / zoom, y: top / zoom, w: width / zoom, h: height / zoom };
};
