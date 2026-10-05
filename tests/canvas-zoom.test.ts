import { describe, expect, it } from "vitest";
import { canvasZoomRequest$, resetCanvasZoom, zoomCanvasIn, zoomCanvasOut } from "../src/renderer/lib/canvas-zoom";

describe("canvas zoom requests", () => {
  it("publishes each call as its kind", () => {
    zoomCanvasIn();
    expect(canvasZoomRequest$.peek()?.kind).toBe("in");
    zoomCanvasOut();
    expect(canvasZoomRequest$.peek()?.kind).toBe("out");
    resetCanvasZoom();
    expect(canvasZoomRequest$.peek()?.kind).toBe("reset");
  });

  it("notifies a listener for the same call twice in a row", () => {
    let heard = 0;
    const off = canvasZoomRequest$.onChange(() => {
      heard += 1;
    });
    zoomCanvasIn();
    zoomCanvasIn();
    off();
    expect(heard).toBe(2);
  });
});
