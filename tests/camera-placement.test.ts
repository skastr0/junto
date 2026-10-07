/**
 * Where the camera sits when a canvas opens: on its named regions, else its
 * regions, else its first cluster, worked out from positions and drawn sizes
 * alone.
 */
import { describe, expect, it } from "vitest";
import { openingAnchors, openingViewport, type PlacedNode } from "../src/renderer/lib/camera-placement";

const card = (id: string, x: number, y: number, width = 216, height = 56): PlacedNode => ({
  id, type: "text", position: { x, y }, style: { width, height },
});
const region = (id: string, x: number, y: number, width: number, height: number): PlacedNode => ({
  id, type: "group", position: { x, y }, style: { width, height, pointerEvents: "none" } as PlacedNode["style"],
});

const names: Record<string, string> = { main: "main", side: "new region", blank: "", generic: "unnamed region" };
const nameOf = (node: PlacedNode): string => names[node.id] ?? "";
const pane = { width: 1200, height: 800 };

describe("what a canvas opens on", () => {
  it("is its named regions when it has any", () => {
    const nodes = [region("main", 0, 0, 900, 600), region("side", 2000, 0, 400, 300), card("a", 5000, 5000)];
    expect(openingAnchors(nodes, nameOf).map((node) => node.id)).toEqual(["main"]);
  });

  it("is all its regions when none is named", () => {
    const nodes = [region("side", 0, 0, 400, 300), region("blank", 900, 0, 400, 300), region("generic", 0, 900, 400, 300), card("a", 5000, 5000)];
    expect(openingAnchors(nodes, nameOf).map((node) => node.id)).toEqual(["side", "blank", "generic"]);
  });

  it("is its first cluster of cards when it has no region", () => {
    const nodes = Array.from({ length: 40 }, (_, index) => card(`n${index}`, index * 280, 0));
    expect(openingAnchors(nodes, nameOf)).toHaveLength(24);
    expect(openingAnchors(nodes, nameOf)[0]?.id).toBe("n0");
  });
});

describe("the camera as a canvas opens", () => {
  it("is nothing while there is nothing to show or nowhere to show it", () => {
    expect(openingViewport([], nameOf, pane, 0.15)).toBeUndefined();
    expect(openingViewport([card("a", 0, 0)], nameOf, { width: 0, height: 800 }, 0.15)).toBeUndefined();
  });

  it("holds the named region whole inside the pane", () => {
    const nodes = [region("main", 100, 200, 900, 600), card("far", 9000, 9000)];
    const viewport = openingViewport(nodes, nameOf, pane, 0.15)!;
    const left = 100 * viewport.zoom + viewport.x;
    const top = 200 * viewport.zoom + viewport.y;
    const right = 1000 * viewport.zoom + viewport.x;
    const bottom = 800 * viewport.zoom + viewport.y;
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(right).toBeLessThanOrEqual(pane.width);
    expect(bottom).toBeLessThanOrEqual(pane.height);
    // The far card is not what it opens on.
    expect(9000 * viewport.zoom + viewport.x).toBeGreaterThan(pane.width);
  });

  it("never zooms past what reads: closer for loose cards than for regions", () => {
    expect(openingViewport([card("a", 0, 0)], nameOf, pane, 0.15)!.zoom).toBe(1.35);
    expect(openingViewport([region("main", 0, 0, 200, 100)], nameOf, pane, 0.15)!.zoom).toBe(1.15);
  });

  it("never zooms out past the canvas's limit", () => {
    const nodes = [region("main", 0, 0, 90000, 60000)];
    expect(openingViewport(nodes, nameOf, pane, 0.15)!.zoom).toBe(0.15);
  });

  it("needs no measurement: the size a card is drawn at comes with it", () => {
    const tall = [card("a", 0, 0, 200, 2000)];
    const short = [card("a", 0, 0, 200, 20)];
    expect(openingViewport(tall, nameOf, pane, 0.15)!.zoom).toBeLessThan(openingViewport(short, nameOf, pane, 0.15)!.zoom);
  });
});
