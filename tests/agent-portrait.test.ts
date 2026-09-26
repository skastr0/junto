import { describe, expect, it } from "vitest";
import {
  portraitOptions,
  portraitDataUri,
  portraitDetailFor,
  portraitGenome,
  portraitSvg,
} from "../src/shared/agent-portrait";
import { THEME_MODES, themeRuntime } from "../src/shared/theme";

const seeds = Array.from({ length: 64 }, (_, index) => `node-${index}-${(index * 2654435761) >>> 0}`);

describe("agent portraits", () => {
  it("is deterministic per seed, mode, and detail", () => {
    for (const seed of seeds.slice(0, 8)) {
      for (const mode of THEME_MODES) {
        expect(portraitSvg({ seed, mode, detail: "card" })).toBe(portraitSvg({ seed, mode, detail: "card" }));
      }
    }
  });

  it("gives distinct seeds distinct characters", () => {
    const genomes = new Set(seeds.map((seed) => JSON.stringify(portraitGenome(seed))));
    expect(genomes.size).toBe(seeds.length);
    const looks = new Set(
      seeds.map((seed) => {
        const g = portraitGenome(seed);
        return `${g.bodyHue}|${g.shape}|${g.topper}|${g.eyes}`;
      }),
    );
    expect(looks.size).toBeGreaterThan(56);
  });

  it("never paints a body in the blocker hue", () => {
    for (const mode of THEME_MODES) {
      const crimson = themeRuntime(mode).crimson;
      for (const seed of seeds) {
        expect(portraitGenome(seed).bodyHue).not.toBe("crimson");
        expect(portraitSvg({ seed, mode, detail: "rich" })).not.toContain(`"${crimson}"`);
      }
    }
  });

  it("keeps filters off the node-size tiers", () => {
    expect(portraitSvg({ seed: "a", mode: "dark", detail: "glyph" })).not.toContain("<filter");
    expect(portraitSvg({ seed: "a", mode: "dark", detail: "card" })).not.toContain("<filter");
    expect(portraitSvg({ seed: "a", mode: "dark", detail: "rich" })).toContain("<filter");
  });

  it("differs between modes and picks detail by size", () => {
    expect(portraitSvg({ seed: "a", mode: "dark", detail: "card" })).not.toBe(
      portraitSvg({ seed: "a", mode: "bright", detail: "card" }),
    );
    expect(portraitDetailFor(18)).toBe("glyph");
    expect(portraitDetailFor(28)).toBe("glyph");
    expect(portraitDetailFor(48)).toBe("card");
    expect(portraitDetailFor(96)).toBe("rich");
    expect(portraitDataUri({ seed: "a", mode: "dark", detail: "glyph" })).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
  });

  it("frames a round porthole distinct from the tile", () => {
    for (const detail of ["glyph", "card", "rich"] as const) {
      const round = portraitSvg({ seed: "a", mode: "dark", detail, frame: "round" });
      expect(round).toMatch(/<clipPath id="t"><circle /);
      expect(round).not.toBe(portraitSvg({ seed: "a", mode: "dark", detail }));
    }
    expect(portraitSvg({ seed: "a", mode: "dark", detail: "card" })).toBe(
      portraitSvg({ seed: "a", mode: "dark", detail: "card", frame: "tile" }),
    );
  });

  it("grows variety so hundreds of seats rarely share a look", () => {
    const looks = new Set(
      Array.from({ length: 400 }, (_, index) => {
        const g = portraitGenome(`seat-${index}-${(index * 2654435761) >>> 0}`);
        return `${g.bodyHue}|${g.shape}|${g.topper}|${g.accessory}`;
      }),
    );
    expect(looks.size).toBeGreaterThan(340);
  });

  it("draws every new species, topper, pattern, and prop in both frames", () => {
    const traits = ["shape", "topper", "marking", "accessory"] as const;
    for (const trait of traits) {
      for (const option of portraitOptions()[trait]) {
        for (const frame of ["round", "bare"] as const) {
          const svg = portraitSvg({ seed: "cast", mode: "bright", detail: "card", frame, config: { [trait]: option } });
          expect(svg).toMatch(/^<svg [^>]*viewBox="[-\d. ]+">/);
          expect(svg).not.toContain("NaN");
        }
      }
    }
  });

  it("gives a bare frame no tile, no halo, and no frame clip", () => {
    const bare = portraitSvg({ seed: "a", mode: "dark", detail: "rich", frame: "bare" });
    expect(bare).not.toContain('clipPath id="t"');
    expect(bare).not.toContain("<filter");
    const { tile, halo } = { tile: /<rect [^>]*width="100" height="100" fill=/, halo: /r="36"/ };
    expect(bare).not.toMatch(tile);
    expect(bare).not.toMatch(halo);
  });

  it("lets a hat cover crown toppers and a shroom cap cover every topper", () => {
    const hatted = portraitSvg({ seed: "a", mode: "dark", detail: "card", config: { topper: "unicorn", accessory: "beanie" } });
    const bareHead = portraitSvg({ seed: "a", mode: "dark", detail: "card", config: { topper: "none", accessory: "beanie" } });
    expect(hatted).toBe(bareHead);
    const shroom = portraitSvg({ seed: "a", mode: "dark", detail: "card", config: { shape: "shroom", topper: "cat", accessory: "none" } });
    const shroomPlain = portraitSvg({ seed: "a", mode: "dark", detail: "card", config: { shape: "shroom", topper: "none", accessory: "none" } });
    expect(shroom).toBe(shroomPlain);
  });
});
