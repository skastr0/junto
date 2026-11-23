/**
 * Quick thread's picker, as data: every seat on the canvas whichever machine
 * it runs on, the regions that hold any, one ranked list for what is typed,
 * and a region that narrows the list and is never a recipient.
 */
import { describe, expect, it } from "vitest";
import { asCanvasName, canvasFromOpened } from "../src/shared/model";
import {
  quickThreadCatalog,
  quickThreadOptionKey,
  quickThreadOptions,
  type QuickThreadOption,
} from "../src/window/lib/quick-thread";
import { region, seat, taskBoard } from "./support/model-nodes";

const at = (x: number, y: number) => ({ x, y, width: 100, height: 60 });

// Product holds Design and one seat of its own; Engine stands beside it; one seat is outside every region.
const canvas = canvasFromOpened({
  canvas: asCanvasName("quick-thread-model"),
  seq: 0,
  wires: [],
  nodes: [
    region("r-product", { x: 0, y: 0, width: 1000, height: 600 }, { label: "Product", color: "violet" }),
    region("r-design", { x: 20, y: 20, width: 400, height: 300 }, { label: "Design System" }),
    region("r-engine", { x: 2000, y: 0, width: 600, height: 400 }, { label: "Engine" }),
    region("r-empty", { x: 4000, y: 0, width: 300, height: 300 }, { label: "Parking" }),
    seat("s-design", { ...at(40, 40), label: "product-design" }),
    seat("s-type", { ...at(200, 40), label: "product-typography" }),
    seat("s-lead", { ...at(600, 40), label: "product-lead" }),
    seat("s-pty", { ...at(2100, 40), label: "pty-lead", host: "mac-mini" as never }),
    seat("s-free", { ...at(6000, 40), label: "design-scout" }),
    taskBoard("t-1", at(620, 300)),
  ],
});

const names = (options: ReadonlyArray<QuickThreadOption>) => options.map((option) => `${option.kind}:${option.name}`);

describe("what the picker chooses from", () => {
  const catalog = quickThreadCatalog(canvas, ["s-pty", "s-lead"]);

  it("offers every seat, a seat on another machine like any other, the recently visited first", () => {
    expect(catalog.seats.map((entry) => entry.name)).toEqual([
      "pty-lead",
      "product-lead",
      "design-scout",
      "product-design",
      "product-typography",
    ]);
  });

  it("says where each seat sits", () => {
    const design = catalog.seats.find((entry) => entry.id === "s-design");
    expect(design?.region).toBe("Design System");
    expect(design?.path).toBe("Product / Design System");
    expect(design?.regionIds).toEqual(["r-product", "r-design"]);
    const free = catalog.seats.find((entry) => entry.id === "s-free");
    expect(free?.region).toBeUndefined();
    expect(free?.path).toBe("");
  });

  it("offers the regions that hold a seat, each with how many, and none that holds none", () => {
    expect(catalog.regions.map((entry) => [entry.name, entry.seats])).toEqual([
      ["Design System", 2],
      ["Engine", 1],
      ["Product", 3],
    ]);
    expect(catalog.regions.find((entry) => entry.id === "r-design")?.outer).toEqual(["Product"]);
    expect(catalog.regions.find((entry) => entry.id === "r-product")?.color).toBe("violet");
  });
});

describe("the list for what is typed", () => {
  const catalog = quickThreadCatalog(canvas, []);

  it("is the seats alone with nothing typed", () => {
    const options = quickThreadOptions(catalog, "");
    expect(options.every((option) => option.kind === "seat")).toBe(true);
    expect(options.length).toBe(5);
  });

  it("ranks seats and regions in one list, fuzzy over a seat's name and where it sits", () => {
    const options = quickThreadOptions(catalog, "design");
    // The seat whose name starts with it, the region, the seat with it in its name, then the seat that only sits there.
    expect(names(options)).toEqual([
      "seat:design-scout",
      "region:Design System",
      "seat:product-design",
      "seat:product-typography",
    ]);
  });

  it("finds a seat by its region", () => {
    expect(names(quickThreadOptions(catalog, "engine"))).toEqual(["region:Engine", "seat:pty-lead"]);
  });

  it("finds a seat by a few letters of its name", () => {
    expect(names(quickThreadOptions(catalog, "ptyl"))).toEqual(["seat:pty-lead"]);
    expect(quickThreadOptions(catalog, "zzzz")).toEqual([]);
  });

  it("narrowed to a region is that region's seats, and no region", () => {
    expect(names(quickThreadOptions(catalog, "", "r-product"))).toEqual([
      "seat:product-design",
      "seat:product-lead",
      "seat:product-typography",
    ]);
    expect(names(quickThreadOptions(catalog, "typo", "r-product"))).toEqual(["seat:product-typography"]);
    expect(quickThreadOptions(catalog, "lead", "r-design")).toEqual([]);
  });

  it("keys a seat and a region apart", () => {
    const keys = quickThreadOptions(catalog, "design").map(quickThreadOptionKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("region:r-design");
    expect(keys).toContain("seat:s-design");
  });
});
