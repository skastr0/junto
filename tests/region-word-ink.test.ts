import { describe, expect, it } from "vitest";
import { CANVAS_SWATCHES } from "../src/shared/canvas-colors";
import { THEME_MODES, themeRuntime } from "../src/shared/theme";
import { REGION_WORD_SHARE, regionWordContrast, regionWordShare } from "../src/renderer/lib/region-word-ink";

// Free hexes an operator could type that the theme's share does not carry:
// pale ones wash out on bright, dark ones sink into dark.
const BAD = ["#ffff66", "#f5f5f5", "#c8ff00", "#80ffff", "#202020", "#000080", "#3a0000", "#1b1b3a"];

describe("region word ink", () => {
  it("holds every preset, the main accent and steel at its theme's share, on every fill", () => {
    const tokens = [...CANVAS_SWATCHES.map((swatch) => swatch.token), "main", "steel"];
    for (const mode of THEME_MODES) {
      const theme = themeRuntime(mode);
      for (const token of tokens) {
        const contrast = regionWordContrast(theme[token]!, mode, REGION_WORD_SHARE[mode]);
        expect(contrast, `${token} in ${mode}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("lowers a bad free hex's share until its words read at 4.5:1, in both themes", () => {
    let lowered = 0;
    for (const mode of THEME_MODES) {
      for (const hex of BAD) {
        const share = regionWordShare(hex, mode);
        expect(regionWordContrast(hex, mode, share), `${hex} in ${mode}`).toBeGreaterThanOrEqual(4.5);
        if (share < REGION_WORD_SHARE[mode]) {
          lowered += 1;
          // As much of the colour as reads, not less: one point more fails.
          expect(regionWordContrast(hex, mode, share + 1), `${hex} in ${mode}`).toBeLessThan(4.5);
        }
      }
    }
    expect(lowered).toBeGreaterThanOrEqual(BAD.length);
  });

  it("fails the bad hexes at the theme's share, so the clamp is what saves them", () => {
    expect(regionWordContrast("#ffff66", "bright", REGION_WORD_SHARE.bright)).toBeLessThan(4.5);
    expect(regionWordContrast("#000080", "dark", REGION_WORD_SHARE.dark)).toBeLessThan(4.5);
  });

  it("leaves a readable hex at the theme's share, and a malformed one alone", () => {
    expect(regionWordShare("#509de8", "dark")).toBe(REGION_WORD_SHARE.dark);
    expect(regionWordShare("not-a-hex", "bright")).toBe(REGION_WORD_SHARE.bright);
  });
});
