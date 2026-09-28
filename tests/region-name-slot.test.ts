import { describe, expect, it } from "vitest";
import {
  nameFontSize,
  REGION_NAME_MAX_PX,
  REGION_NAME_MIN_PX,
  regionNameSlot,
  sameNameSlot,
  type SlotRect,
} from "../src/renderer/lib/region-name-slot";

const rect = (x: number, y: number, width: number, height: number): SlotRect => ({ x, y, width, height });

/** The slot back in flow coordinates. */
const placed = (region: SlotRect, slot: SlotRect): SlotRect => rect(region.x + slot.x, region.y + slot.y, slot.width, slot.height);

const overlaps = (a: SlotRect, b: SlotRect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const inside = (outer: SlotRect, inner: SlotRect): boolean =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

describe("nameFontSize", () => {
  it("fits the label inside the slot's width", () => {
    const size = nameFontSize(900, 560, "Build floor");
    expect(size * "Build floor".length * 0.68).toBeLessThanOrEqual(900);
    expect(size).toBeGreaterThan(60);
  });

  it("leaves breathing room above and below the name", () => {
    expect(nameFontSize(4000, 200, "Ops")).toBeLessThanOrEqual(200 * 0.6);
  });

  it("never grows past the ceiling", () => {
    expect(nameFontSize(20_000, 20_000, "Ops")).toBe(REGION_NAME_MAX_PX);
  });
});

describe("regionNameSlot", () => {
  it("fills an empty region's body, under its title bar", () => {
    const region = rect(0, 0, 1000, 600);
    const slot = regionNameSlot(region, [], [], "Payments");
    expect(slot.y).toBeGreaterThanOrEqual(24);
    expect(inside(region, placed(region, slot))).toBe(true);
    expect(slot.width).toBeGreaterThan(900);
    expect(slot.fontSize).toBeGreaterThan(100);
  });

  it("stays clear of every region nested in it", () => {
    const region = rect(0, 0, 2000, 1400);
    const children = [rect(40, 80, 900, 500), rect(1000, 80, 900, 500), rect(40, 640, 900, 500)];
    const slot = placed(region, regionNameSlot(region, children, [], "Platform"));
    for (const child of children) expect(overlaps(slot, child)).toBe(false);
    // The open quarter is the best ground.
    expect(slot.x).toBeGreaterThanOrEqual(940);
    expect(slot.y).toBeGreaterThanOrEqual(580);
  });

  it("goes round the cards in it when a legible name still fits", () => {
    const region = rect(0, 0, 1200, 700);
    const cards = [rect(40, 96, 184, 56), rect(330, 96, 184, 56), rect(620, 96, 184, 56), rect(40, 236, 184, 56)];
    const slot = placed(region, regionNameSlot(region, [], cards, "Search"));
    for (const card of cards) expect(overlaps(slot, card)).toBe(false);
    expect(regionNameSlot(region, [], cards, "Search").fontSize).toBeGreaterThanOrEqual(REGION_NAME_MIN_PX);
  });

  it("sits over cards rather than shrink below legible, but never over a child region", () => {
    const region = rect(0, 0, 600, 400);
    const cards = Array.from({ length: 12 }, (_, i) => rect(20 + (i % 3) * 190, 30 + Math.floor(i / 3) * 90, 184, 56));
    const child = rect(20, 300, 300, 90);
    const slot = regionNameSlot(region, [child], cards, "Crowded");
    expect(slot.fontSize).toBeGreaterThanOrEqual(REGION_NAME_MIN_PX);
    expect(overlaps(placed(region, slot), child)).toBe(false);
  });

  it("never lets a nested name overlap its parent's", () => {
    // Three levels, packed the way operators pack them.
    const outer = rect(0, 0, 3000, 2000);
    const mid = [rect(60, 100, 1300, 1800), rect(1450, 100, 1300, 900)];
    const inner = [rect(100, 160, 600, 700), rect(740, 160, 580, 700), rect(100, 900, 1200, 900)];
    const names: SlotRect[] = [placed(outer, regionNameSlot(outer, mid, [], "Junto"))];
    names.push(placed(mid[0]!, regionNameSlot(mid[0]!, inner, [], "Harnesses 1.1")));
    names.push(placed(mid[1]!, regionNameSlot(mid[1]!, [], [], "Release 1.2")));
    for (const box of inner) names.push(placed(box, regionNameSlot(box, [], [], "Seats")));
    for (let i = 0; i < names.length; i += 1) {
      for (let j = i + 1; j < names.length; j += 1) {
        expect(overlaps(names[i]!, names[j]!), `${String(i)} and ${String(j)}`).toBe(false);
      }
    }
  });

  it("is deterministic and compares by value", () => {
    const region = rect(10, 20, 800, 500);
    const a = regionNameSlot(region, [rect(40, 80, 300, 200)], [], "Docs");
    const b = regionNameSlot(region, [rect(40, 80, 300, 200)], [], "Docs");
    expect(sameNameSlot(a, b)).toBe(true);
    expect(sameNameSlot(a, { ...b, fontSize: b.fontSize + 1 })).toBe(false);
    expect(sameNameSlot(undefined, undefined)).toBe(true);
  });
});
