import { describe, expect, it } from "vitest";
import {
  discoveryLayout,
  ditherPixelSize,
  edgePhase,
  FLEET_COLORS,
  hostColor,
  ORBIT_BASE_RADIUS,
  orbitLayout,
} from "../src/renderer/lib/fleet-layout";
import { GREEN, HUE } from "../src/renderer/lib/theme";

const ids = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `host-${String(i + 1).padStart(2, "0")}`);

const radiusOf = (p: { x: number; y: number }): number =>
  Math.hypot(p.x, p.y);

describe("orbitLayout", () => {
  it("is deterministic for the same input", () => {
    const input = ["delta", "alpha", "charlie", "bravo"];
    expect(orbitLayout(input)).toEqual(orbitLayout([...input]));
  });

  it("is stable under input reordering (sorted by id)", () => {
    const a = orbitLayout(["delta", "alpha", "charlie", "bravo"]);
    const b = orbitLayout(["bravo", "delta", "alpha", "charlie"]);
    expect(a).toEqual(b);
    expect(Object.keys(a)).toEqual(["alpha", "bravo", "charlie", "delta"]);
  });

  it("keeps the first 6 hosts on the first orbit", () => {
    const layout = orbitLayout(ids(6));
    for (const id of ids(6)) {
      expect(radiusOf(layout[id]!)).toBeCloseTo(ORBIT_BASE_RADIUS, 6);
    }
  });

  it("overflows the 7th host onto the second orbit", () => {
    const layout = orbitLayout(ids(7));
    for (const id of ids(6)) {
      expect(radiusOf(layout[id]!)).toBeCloseTo(ORBIT_BASE_RADIUS, 6);
    }
    expect(radiusOf(layout["host-07"]!)).toBeCloseTo(ORBIT_BASE_RADIUS * 2, 6);
  });

  it("overflows the 19th host onto the third orbit", () => {
    const layout = orbitLayout(ids(19));
    expect(radiusOf(layout["host-19"]!)).toBeCloseTo(ORBIT_BASE_RADIUS * 3, 6);
  });

  it("startOrbit pushes the set outward by whole orbit rings", () => {
    const inner = orbitLayout(["alpha", "bravo"]);
    const outer = orbitLayout(["alpha", "bravo"], 2);
    expect(radiusOf(outer["alpha"]!)).toBeCloseTo(
      radiusOf(inner["alpha"]!) + ORBIT_BASE_RADIUS * 2,
      6,
    );
    expect(outer["alpha"]).toEqual({ x: inner["alpha"]!.x * 3, y: inner["alpha"]!.y * 3 });
  });

  it("keeps every pair of nodes at least 100px apart for N ≤ 19", () => {
    const all = ids(19);
    const layout = orbitLayout(all);
    for (let i = 0; i < all.length; i += 1) {
      for (let j = i + 1; j < all.length; j += 1) {
        const a = layout[all[i]!]!;
        const b = layout[all[j]!]!;
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(100);
      }
    }
  });
});

describe("discoveryLayout", () => {
  it("keeps visible peers in a centered four-row band", () => {
    const layout = discoveryLayout(ids(5), 800);
    expect(layout["host-01"]).toEqual({ x: 800, y: -345 });
    expect(layout["host-04"]).toEqual({ x: 800, y: 345 });
    expect(layout["host-05"]).toEqual({ x: 1030, y: 0 });
  });

  it("is stable under peer reordering", () => {
    expect(discoveryLayout(["bravo", "alpha"], 700)).toEqual(
      discoveryLayout(["alpha", "bravo"], 700),
    );
  });
});

describe("ditherPixelSize", () => {
  it("moves from fine to coarse in increasing cell sizes", () => {
    expect(ditherPixelSize("fine")).toBeLessThan(ditherPixelSize("balanced"));
    expect(ditherPixelSize("balanced")).toBeLessThan(ditherPixelSize("coarse"));
  });
});

describe("edgePhase", () => {
  it("maps unknown to a faint gray dashed hairline", () => {
    expect(edgePhase("unknown")).toEqual({
      hue: HUE.steel,
      dash: "3 7",
      animated: false,
      width: 1.1,
    });
  });

  it("maps probing to an animated cyan dash", () => {
    expect(edgePhase("probing")).toEqual({
      hue: HUE.cyan,
      dash: "2 7",
      animated: true,
      width: 1.35,
    });
  });

  it("maps reachable to a solid green stroke", () => {
    expect(edgePhase("reachable")).toEqual({
      hue: GREEN,
      dash: null,
      animated: false,
      width: 1.6,
    });
  });

  it("maps unreachable to a crimson dash", () => {
    expect(edgePhase("unreachable")).toEqual({
      hue: HUE.crimson,
      dash: "7 5",
      animated: false,
      width: 1.4,
    });
  });
});

describe("hostColor", () => {
  it("is deterministic and drawn from FLEET_COLORS", () => {
    const color = hostColor({ id: "remote-a" });
    expect(hostColor({ id: "remote-a" })).toBe(color);
    expect(FLEET_COLORS).toContain(color);
  });

  it("respects the appearance.color override", () => {
    expect(
      hostColor({ id: "remote-a", appearance: { color: "#123456" } }),
    ).toBe("#123456");
  });

  it("uses a model identity color before falling back to a host hash", () => {
    expect(hostColor({ id: "remote-a" }, HUE.steel)).toBe(HUE.steel);
  });

  it("exposes 8 fleet colors", () => {
    expect(FLEET_COLORS).toHaveLength(8);
  });
});
