import { describe, expect, it } from "vitest";
import { contrastRatio, semanticTokens, themeRuntime, THEME_MODES } from "../src/shared/theme";
import { LABEL_COLOURS } from "../src/shared/theme/primitives";

describe("label colour tokens (0.11, 03, C3)", () => {
  it("names the eight colours the contract stores", () => {
    expect(LABEL_COLOURS).toEqual(["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"]);
  });

  it.each(THEME_MODES)("gives every colour a mark, a fill, a stroke and a word in %s", (mode) => {
    const tokens = semanticTokens(mode);
    for (const name of LABEL_COLOURS) {
      for (const part of ["", "-fill", "-stroke", "-fg"]) expect(tokens[`label-${name}${part}`]).toBeDefined();
    }
  });

  it.each(THEME_MODES)("keeps the word readable on its fill over every surface in %s", (mode) => {
    const t = themeRuntime(mode);
    const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
    for (const name of LABEL_COLOURS) {
      for (const surface of ["ground", "raise", "raise-2", "inset", "well"]) {
        const [m, s] = [rgb(t[`label-${name}`]!), rgb(t[surface]!)];
        const fill = `#${m.map((v, i) => Math.round(v! * 0.18 + s[i]! * 0.82).toString(16).padStart(2, "0")).join("")}`;
        expect(contrastRatio(t[`label-${name}-fg`]!, fill)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
