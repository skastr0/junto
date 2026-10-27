import { describe, expect, it } from "vitest";
import { ARTIFACT_MAX_TITLE_LENGTH } from "../src/shared/artifact";
import {
  boxByArrow,
  boxFromDrag,
  boxPixels,
  cropOf,
  EXTRACT_MAX_SIDE,
  extractTitle,
  fileViewKindOf,
  fitZoom,
  KEYBOARD_BOX,
  MIN_BOX_PX,
  NUDGE,
  PAGE_GUTTER,
  pageAtScroll,
  parsePageInput,
  ZOOM_MAX,
  ZOOM_MIN,
  zoomIn,
  zoomOut,
} from "../src/renderer/components/file-view/file-view-model";

describe("file viewer kind", () => {
  it("previews a PDF and an image, and offers the default app for anything else", () => {
    expect(fileViewKindOf("docs/sample.pdf")).toBe("pdf");
    expect(fileViewKindOf("img/Gradient.PNG")).toBe("image");
    expect(fileViewKindOf("icons/mark.svg")).toBe("image");
    expect(fileViewKindOf("src/index.html")).toBe("other");
    expect(fileViewKindOf("Makefile")).toBe("other");
  });
});

describe("zoom", () => {
  it("steps along the ladder from a zoom between steps, and stops at its ends", () => {
    expect(zoomIn(1)).toBe(1.1);
    expect(zoomIn(0.93)).toBe(1);
    expect(zoomOut(0.93)).toBe(0.9);
    expect(zoomIn(ZOOM_MAX)).toBe(ZOOM_MAX);
    expect(zoomOut(ZOOM_MIN)).toBe(ZOOM_MIN);
  });

  it("fits a surface to the pane inside its gutters, under a ceiling when given", () => {
    expect(fitZoom(612, 612 * 2 + PAGE_GUTTER * 2)).toBe(2);
    expect(fitZoom(320, 2000, 1)).toBe(1);
    expect(fitZoom(612, 0)).toBe(1);
  });
});

describe("a box drawn on a surface", () => {
  it("is fractions of the surface, whichever way the drag went", () => {
    const box = boxFromDrag({ x: 300, y: 150 }, { x: 100, y: 50 }, 400, 200);
    expect(box).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    expect(boxPixels(box!, 800, 400)).toEqual({ left: 200, top: 100, width: 400, height: 200 });
  });

  it("is clamped to the surface when the drag leaves it", () => {
    expect(boxFromDrag({ x: -50, y: -10 }, { x: 500, y: 100 }, 400, 200)).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
  });

  it("is nothing for a click or a sliver", () => {
    expect(boxFromDrag({ x: 10, y: 10 }, { x: 10, y: 10 }, 400, 200)).toBeUndefined();
    expect(boxFromDrag({ x: 10, y: 10 }, { x: 10 + MIN_BOX_PX - 1, y: 80 }, 400, 200)).toBeUndefined();
  });
});

describe("the crop an extract takes", () => {
  it("renders a box at twice the page's size, in whole pixels", () => {
    expect(cropOf({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, 612, 792, 2)).toEqual({ x: 306, y: 792, w: 612, h: 396, scale: 2 });
  });

  it("never passes the page's edge and is at least one pixel", () => {
    const crop = cropOf({ x: 0.999, y: 0.999, w: 0.001, h: 0.001 }, 100, 100, 1);
    expect(crop.x + crop.w).toBeLessThanOrEqual(100);
    expect(crop.y + crop.h).toBeLessThanOrEqual(100);
    expect(crop.w).toBeGreaterThanOrEqual(1);
  });

  it("drops the scale so a huge box stays under the largest side", () => {
    const crop = cropOf({ x: 0, y: 0, w: 1, h: 1 }, 5000, 3000, 2);
    expect(crop.w).toBeLessThanOrEqual(EXTRACT_MAX_SIDE);
    expect(crop.scale).toBeLessThan(1);
  });
});

describe("pages", () => {
  const tops = [
    { top: 24, height: 792 },
    { top: 832, height: 792 },
  ];

  it("names the page under the middle of the pane", () => {
    expect(pageAtScroll(tops, 0, 600)).toBe(1);
    expect(pageAtScroll(tops, 700, 600)).toBe(2);
    expect(pageAtScroll(tops, 99_999, 600)).toBe(2);
    expect(pageAtScroll([], 0, 600)).toBe(1);
  });

  it("reads a typed page only when it names one", () => {
    expect(parsePageInput(" 2 ", 2)).toBe(2);
    expect(parsePageInput("3", 2)).toBeUndefined();
    expect(parsePageInput("0", 2)).toBeUndefined();
    expect(parsePageInput("1.5", 2)).toBeUndefined();
    expect(parsePageInput("two", 2)).toBeUndefined();
  });

  it("titles an extract by the file's name and page, never its folders", () => {
    expect(extractTitle("docs/sample.pdf", 2)).toBe("sample.pdf, page 2");
    expect(extractTitle("img/gradient.png")).toBe("gradient.png");
  });

  it("cuts a name too long for a title before its extension, keeping the page", () => {
    const long = `docs/${"q".repeat(250)}.pdf`;
    const title = extractTitle(long, 12);
    expect(title.length).toBeLessThanOrEqual(ARTIFACT_MAX_TITLE_LENGTH);
    expect(title.endsWith("\u2026.pdf, page 12")).toBe(true);
    expect(extractTitle(`${"w".repeat(240)}.png`).endsWith("\u2026.png")).toBe(true);
    expect(extractTitle(`${"w".repeat(240)}.png`).length).toBe(ARTIFACT_MAX_TITLE_LENGTH);
  });
});

describe("a box from the keyboard", () => {
  it("moves by arrows and stays whole on the surface", () => {
    const moved = boxByArrow(KEYBOARD_BOX, "ArrowRight", false)!;
    expect(moved.x).toBeCloseTo(KEYBOARD_BOX.x + NUDGE);
    expect(moved.w).toBe(KEYBOARD_BOX.w);
    let box = KEYBOARD_BOX;
    for (let press = 0; press < 100; press += 1) box = boxByArrow(box, "ArrowDown", false)!;
    expect(box.y + box.h).toBeCloseTo(1);
  });

  it("resizes with Shift, never under one step and never past the edge", () => {
    let box = KEYBOARD_BOX;
    for (let press = 0; press < 100; press += 1) box = boxByArrow(box, "ArrowLeft", true)!;
    expect(box.w).toBeCloseTo(NUDGE);
    for (let press = 0; press < 100; press += 1) box = boxByArrow(box, "ArrowRight", true)!;
    expect(box.x + box.w).toBeCloseTo(1);
    expect(boxByArrow(box, "Enter", false)).toBeUndefined();
  });
});
