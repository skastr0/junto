import { describe, expect, it } from "vitest";
import {
  edgePhase,
  FLEET_COLORS,
  FLEET_GLYPHS,
  hostColor,
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

  it("keeps the first 6 hosts on the first orbit (radius 260)", () => {
    const layout = orbitLayout(ids(6));
    for (const id of ids(6)) {
      expect(radiusOf(layout[id]!)).toBeCloseTo(260, 6);
    }
  });

  it("overflows the 7th host onto the second orbit (radius 520)", () => {
    const layout = orbitLayout(ids(7));
    for (const id of ids(6)) {
      expect(radiusOf(layout[id]!)).toBeCloseTo(260, 6);
    }
    expect(radiusOf(layout["host-07"]!)).toBeCloseTo(520, 6);
  });

  it("overflows the 19th host onto the third orbit (radius 780)", () => {
    const layout = orbitLayout(ids(19));
    expect(radiusOf(layout["host-19"]!)).toBeCloseTo(780, 6);
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

describe("edgePhase", () => {
  it("maps unknown to a faint gray dashed hairline", () => {
    expect(edgePhase("unknown")).toEqual({
      hue: "#6b6f76",
      dash: "4 6",
      animated: false,
      width: 1,
    });
  });

  it("maps probing to an animated cyan dash", () => {
    expect(edgePhase("probing")).toEqual({
      hue: HUE.cyan,
      dash: "2 6",
      animated: true,
      width: 1,
    });
  });

  it("maps reachable to a solid green stroke", () => {
    expect(edgePhase("reachable")).toEqual({
      hue: GREEN,
      dash: null,
      animated: false,
      width: 1.5,
    });
  });

  it("maps unreachable to a crimson dash", () => {
    expect(edgePhase("unreachable")).toEqual({
      hue: HUE.crimson,
      dash: "6 4",
      animated: false,
      width: 1,
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

  it("exposes 8 colors and the lucide glyph names", () => {
    expect(FLEET_COLORS).toHaveLength(8);
    expect(FLEET_GLYPHS).toEqual([
      "server",
      "laptop",
      "cpu",
      "satellite",
      "rocket",
      "globe",
      "star",
      "orbit",
      "radar",
    ]);
  });
});
