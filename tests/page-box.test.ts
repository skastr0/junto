import { describe, expect, it } from "vitest";
import {
  PAGE_BOX_MIN_CSS_PX,
  captureCrop,
  decodePageViewport,
  dragRect,
  pageBoxOf,
  viewportRectOf,
  type PageViewport,
} from "../src/shared/page-box";

const viewport: PageViewport = { width: 800, height: 600, scroll: { x: 0, y: 1200 }, devicePixelRatio: 2 };
const capture = { width: 1600, height: 1200 };

describe("page box geometry", () => {
  it("normalises a drag in any direction and clamps it to the viewport", () => {
    expect(dragRect({ x: 300, y: 200 }, { x: 100, y: 50 }, viewport)).toEqual({ x: 100, y: 50, w: 200, h: 150 });
    expect(dragRect({ x: -40, y: 590 }, { x: 900, y: 700 }, viewport)).toEqual({ x: 0, y: 590, w: 800, h: 10 });
  });

  it("stores the box in page coordinates with the scroll it was drawn at", () => {
    const result = pageBoxOf({ x: 100, y: 50 }, { x: 300, y: 200 }, viewport, capture);
    expect(result).toEqual({
      ok: true,
      box: {
        rect: { x: 100, y: 1250, w: 200, h: 150 },
        scroll: { x: 0, y: 1200 },
        crop: { x: 200, y: 100, w: 400, h: 300 },
      },
    });
  });

  it("refuses a drag smaller than the minimum on either side", () => {
    const thin = pageBoxOf({ x: 10, y: 10 }, { x: 300, y: 10 + PAGE_BOX_MIN_CSS_PX - 1 }, viewport, capture);
    expect(thin).toEqual({ ok: false, refusal: { kind: "too_small", min: PAGE_BOX_MIN_CSS_PX } });
  });

  it("cuts the crop outward to whole capture pixels and never past the capture", () => {
    expect(captureCrop({ x: 10.25, y: 0.5, w: 20.5, h: 10 }, 1.5, { width: 100, height: 100 })).toEqual({
      x: 15,
      y: 0,
      w: 32,
      h: 16,
    });
    expect(captureCrop({ x: 790, y: 590, w: 20, h: 20 }, 2, capture)).toEqual({ x: 1580, y: 1180, w: 20, h: 20 });
    // A ratio the page reports wrongly reads as 1.
    expect(captureCrop({ x: 1, y: 2, w: 3, h: 4 }, 0, capture)).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  });

  it("draws a stored box back where it sits now, or nowhere when it is out of view", () => {
    const rect = { x: 100, y: 1250, w: 200, h: 150 };
    expect(viewportRectOf(rect, { ...viewport, scroll: { x: 0, y: 1000 } })).toEqual({ x: 100, y: 250, w: 200, h: 150 });
    expect(viewportRectOf(rect, { ...viewport, scroll: { x: 0, y: 0 } })).toBeUndefined();
    expect(viewportRectOf(rect, { ...viewport, scroll: { x: 0, y: 1400 } })).toBeUndefined();
  });

  it("believes a reported viewport only when every part is a bounded finite number", () => {
    expect(decodePageViewport(viewport)).toEqual(viewport);
    expect(decodePageViewport({ ...viewport, extra: 1 })).toEqual(viewport);
    expect(decodePageViewport(null)).toBeUndefined();
    expect(decodePageViewport({ ...viewport, width: 0 })).toBeUndefined();
    expect(decodePageViewport({ ...viewport, height: Number.NaN })).toBeUndefined();
    expect(decodePageViewport({ ...viewport, scroll: { x: -240, y: 0 } })).toEqual({ ...viewport, scroll: { x: -240, y: 0 } });
    expect(decodePageViewport({ ...viewport, scroll: { x: 0, y: -1 } })).toBeUndefined();
    expect(decodePageViewport({ ...viewport, scroll: "0,0" })).toBeUndefined();
    expect(decodePageViewport({ ...viewport, devicePixelRatio: 0 })).toBeUndefined();
    expect(decodePageViewport({ ...viewport, devicePixelRatio: 9 })).toBeUndefined();
  });
});
