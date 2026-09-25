import { describe, expect, it } from "vitest";
import {
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
});
