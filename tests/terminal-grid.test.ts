import { describe, expect, it } from "vitest";
import {
  autoGridShape,
  fitGridShape,
  GRID_MIN_FONT_PX,
  gridFontSize,
  gridOverflowCopy,
  gridPageRange,
  gridShapeKey,
  gridShapesFor,
  layoutGrid,
  parseGridChoice,
  pickableGridShapes,
} from "../src/renderer/lib/terminal-grid";

const PREFS = { fontSize: 13, lineHeight: 1 };
const LANDSCAPE = { width: 1800, height: 1000 };

const keys = (shapes: ReadonlyArray<{ rows: number; cols: number }>) => shapes.map(gridShapeKey);

describe("grid shapes", () => {
  it("lists only shapes with no empty row or column", () => {
    expect(keys(gridShapesFor(1))).toEqual(["1x1"]);
    expect(keys(gridShapesFor(4))).toEqual(["4x1", "2x2", "1x4"]);
    expect(keys(gridShapesFor(6))).toEqual(["6x1", "3x2", "2x3", "1x6"]);
    expect(gridShapesFor(0)).toEqual([]);
  });

  it("parses explicit choices and rejects junk", () => {
    expect(parseGridChoice("2x3")).toEqual({ rows: 2, cols: 3 });
    expect(parseGridChoice("auto")).toBeNull();
    expect(parseGridChoice("0x3")).toBeNull();
  });
});

describe("auto shape", () => {
  it("fits every agent, wide before tall on a landscape area", () => {
    expect(gridShapeKey(autoGridShape(2, LANDSCAPE, PREFS)!)).toBe("1x2");
    expect(gridShapeKey(autoGridShape(4, LANDSCAPE, PREFS)!)).toBe("2x2");
    expect(gridShapeKey(autoGridShape(5, LANDSCAPE, PREFS)!)).toBe("2x3");
    expect(gridShapeKey(autoGridShape(6, LANDSCAPE, PREFS)!)).toBe("2x3");
    for (const n of [7, 8, 9]) {
      expect(gridShapeKey(autoGridShape(n, LANDSCAPE, PREFS)!)).toBe("3x3");
    }
  });

  it("turns tall on a portrait area", () => {
    expect(gridShapeKey(autoGridShape(6, { width: 1000, height: 1800 }, PREFS)!)).toBe("3x2");
  });

  it("keeps growing past nine", () => {
    const shape = autoGridShape(12, LANDSCAPE, PREFS)!;
    expect(shape.rows * shape.cols).toBeGreaterThanOrEqual(12);
  });
});

describe("grid font", () => {
  it("keeps the operator's size when the target fits and never grows past it", () => {
    expect(gridFontSize({ width: 4000, height: 4000 }, PREFS)).toBe(13);
  });

  it("shrinks for small cells but never below the minimum", () => {
    const small = gridFontSize({ width: 500, height: 250 }, PREFS);
    expect(small).toBeLessThan(13);
    expect(small).toBeGreaterThanOrEqual(GRID_MIN_FONT_PX);
    expect(gridFontSize({ width: 50, height: 20 }, PREFS)).toBe(GRID_MIN_FONT_PX);
  });

  it("gives a 3x3 grid on a laptop-sized area a smaller, readable font", () => {
    const fitted = fitGridShape({ width: 1400, height: 800 }, { rows: 3, cols: 3 }, PREFS);
    expect(fitted.fontSize).toBeLessThan(13);
    expect(fitted.readable).toBe(true);
  });
});

describe("layout and paging", () => {
  it("shows everyone on one page while cells stay readable", () => {
    const layout = layoutGrid({ count: 9, area: LANDSCAPE, prefs: PREFS, choice: "auto" })!;
    expect(layout.pageSize).toBe(9);
    expect(layout.pageCount).toBe(1);
    expect(layout.readable).toBe(true);
  });

  it("pages only when every-agent cells would be unreadable", () => {
    const area = { width: 900, height: 500 };
    const layout = layoutGrid({ count: 20, area, prefs: PREFS, choice: "auto" })!;
    expect(layout.pageSize).toBeLessThan(20);
    expect(layout.readable).toBe(true);
    expect(layout.pageCount).toBe(Math.ceil(20 / layout.pageSize));
    expect(fitGridShape(area, layout.shape, PREFS).readable).toBe(true);
  });

  it("honours an explicit shape on one page and reports readability", () => {
    const layout = layoutGrid({ count: 4, area: LANDSCAPE, prefs: PREFS, choice: "4x1" })!;
    expect(gridShapeKey(layout.shape)).toBe("4x1");
    expect(layout.pageCount).toBe(1);
  });

  it("offers only readable shapes that hold everyone", () => {
    const offered = keys(pickableGridShapes(6, { width: 1400, height: 700 }, PREFS));
    expect(offered).toContain("2x3");
    expect(offered).not.toContain("6x1");
  });

  it("says plainly what a page shows", () => {
    expect(gridOverflowCopy(gridPageRange(0, 9, 14), 14)).toBe("showing 1 to 9 of 14");
    expect(gridOverflowCopy(gridPageRange(1, 9, 14), 14)).toBe("showing 10 to 14 of 14");
    expect(gridOverflowCopy(gridPageRange(0, 6, 6), 6)).toBeNull();
    expect(gridPageRange(9, 9, 14)).toEqual({ start: 9, end: 14 });
  });

  it("returns nothing for an empty selection or an unmeasured area", () => {
    expect(layoutGrid({ count: 0, area: LANDSCAPE, prefs: PREFS, choice: "auto" })).toBeNull();
    expect(layoutGrid({ count: 3, area: { width: 0, height: 0 }, prefs: PREFS, choice: "auto" })).toBeNull();
  });
});
