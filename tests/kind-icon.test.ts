import { describe, expect, it } from "vitest";
import { KIND_ICON_KINDS, kindIconSrc, kindIconSvg } from "../src/shared/kind-icon";
import { THEME_MODES } from "../src/shared/theme";

describe("kind icons", () => {
  it("every kind has an icon in both themes, a round tile with something drawn on it", () => {
    expect(KIND_ICON_KINDS).toHaveLength(9);
    for (const kind of KIND_ICON_KINDS) {
      for (const mode of THEME_MODES) {
        const svg = kindIconSvg(kind, mode, 34);
        expect(svg, `${kind} ${mode}`).toMatch(/^<svg [^>]*viewBox="0 0 100 100"/);
        expect(svg.match(/<(path|circle)/g)?.length, `${kind} ${mode}`).toBeGreaterThan(4);
        expect(svg).not.toMatch(/undefined|NaN/);
      }
    }
  });

  it("is deterministic and cached per kind, mode and size tier", () => {
    for (const kind of KIND_ICON_KINDS) {
      expect(kindIconSrc(kind, "dark", 34)).toBe(kindIconSrc(kind, "dark", 34));
      expect(kindIconSrc(kind, "dark", 34)).not.toBe(kindIconSrc(kind, "bright", 34));
    }
    // The outline and the misregistration scale with the size tier.
    expect(kindIconSrc("task", "dark", 24)).not.toBe(kindIconSrc("task", "dark", 34));
    expect(kindIconSrc("task", "dark", 34)).not.toBe(kindIconSrc("task", "dark", 84));
    expect(kindIconSrc("task", "dark", 40)).toBe(kindIconSrc("task", "dark", 34));
  });

  it("is a plain icon: no face is ever drawn", () => {
    for (const kind of KIND_ICON_KINDS) {
      const svg = kindIconSvg(kind, "dark", 84);
      // A face needs eyes: two small filled dots side by side on the body. None of the icons draws a
      // circle of eye size (radius under 2) that is not a lone accent.
      const eyes = [...svg.matchAll(/<circle [^>]*r="([\d.]+)"/g)].filter((m) => Number(m[1]) < 2);
      expect(eyes.length, kind).toBeLessThan(2);
    }
  });

  it("each kind wears its own hue: no two kinds share a body tile", () => {
    const tiles = new Set(KIND_ICON_KINDS.map((kind) => /<circle cx="50" cy="50" r="50" fill="([^"]+)"/.exec(kindIconSvg(kind, "dark", 34))?.[1]));
    // File and Note both take the gold token, at two chroma levels, so they still differ.
    expect(tiles.size).toBe(KIND_ICON_KINDS.length);
  });
});
