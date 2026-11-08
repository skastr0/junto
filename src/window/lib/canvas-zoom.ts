// Canvas zoom, callable from outside the canvas (the app menu, shortcuts).
//
// The camera belongs to React Flow, which only the canvas can reach. A caller
// asks here; the canvas (Canvas.tsx) hears the request and moves its camera.
// With no canvas mounted a request is simply not heard.

import { observable } from "@legendapp/state";

export type CanvasZoomKind = "in" | "out" | "reset";

/** The latest request. `seq` makes two identical requests in a row distinct. */
export const canvasZoomRequest$ = observable<{ readonly kind: CanvasZoomKind; readonly seq: number } | null>(null);

let seq = 0;

const request = (kind: CanvasZoomKind): void => {
  seq += 1;
  canvasZoomRequest$.set({ kind, seq });
};

/** One step closer, about the centre of the view. */
export const zoomCanvasIn = (): void => request("in");

/** One step further out, about the centre of the view. */
export const zoomCanvasOut = (): void => request("out");

/** Back to 100 percent, keeping the centre of the view where it is. */
export const resetCanvasZoom = (): void => request("reset");
