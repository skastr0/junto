import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  CANVAS_SWATCHES,
  canvasSwatchFor,
  normalizeHexColor,
  RECENT_COLORS_MAX,
  rememberCustomColor,
} from "../src/shared/canvas-colors";
import { AppearanceSettings, applySettingsPatch, defaultSettings } from "../src/shared/settings";
import { HUES } from "../src/shared/theme/primitives";
import { oklchToHex } from "../src/shared/theme/oklch";
import { accentColor, borderColor } from "../src/renderer/lib/theme";

describe("canvas palette", () => {
  it("keeps the six JSON Canvas presets as digits and adds a clear yellow", () => {
    expect(CANVAS_SWATCHES.filter((s) => /^[1-6]$/.test(s.value)).map((s) => s.value)).toEqual([
      "1", "2", "3", "4", "5", "6",
    ]);
    expect(canvasSwatchFor("#f1d438")?.label).toBe("yellow");
    expect(new Set(CANVAS_SWATCHES.map((s) => s.label)).size).toBe(CANVAS_SWATCHES.length);
  });

  it("stores each named hex as its token's dark value", () => {
    for (const swatch of CANVAS_SWATCHES) {
      if (!swatch.value.startsWith("#")) continue;
      const token = HUES.dark[swatch.token as keyof typeof HUES.dark];
      expect(oklchToHex(token), swatch.label).toBe(swatch.value);
      expect(HUES.bright[swatch.token as keyof typeof HUES.bright], swatch.label).toBeDefined();
    }
  });

  it("paints a palette colour with its theme token and a custom one as stored", () => {
    expect(accentColor("3")).toBe("var(--color-gold)");
    expect(accentColor("#F1D438")).toBe("var(--color-yellow)");
    expect(accentColor("#bb5577")).toBe("#bb5577");
    expect(accentColor(undefined)).toBe("var(--color-main)");
    expect(borderColor("#f1d438")).toBe("color-mix(in oklab, var(--color-yellow) 32%, transparent)");
    expect(borderColor("#bb5577")).toBe("#bb5577");
  });
});

describe("custom colours", () => {
  it("reads hex in any common spelling, and nothing else", () => {
    expect(normalizeHexColor("#F5C400")).toBe("#f5c400");
    expect(normalizeHexColor("f5c400")).toBe("#f5c400");
    expect(normalizeHexColor(" #b57 ")).toBe("#bb5577");
    expect(normalizeHexColor("teal")).toBeUndefined();
    expect(normalizeHexColor("#f5c40")).toBeUndefined();
    expect(normalizeHexColor("")).toBeUndefined();
  });

  it("remembers recent custom colours newest first, without palette colours or repeats", () => {
    expect(rememberCustomColor(["#111111", "#222222"], "#222222")).toEqual(["#222222", "#111111"]);
    expect(rememberCustomColor(["#111111"], "#F1D438")).toEqual(["#111111"]);
    const many = Array.from({ length: 9 }, (_, i) => `#00000${String(i)}`);
    expect(rememberCustomColor(many, "#abcdef")).toHaveLength(RECENT_COLORS_MAX);
  });

  it("is an optional appearance setting that a patch replaces and [] clears", () => {
    const withRecent = applySettingsPatch(defaultSettings(), {
      appearance: { recentColors: ["#bb5577", "#bb5577", "#f1d438"] },
    });
    expect(withRecent.appearance.recentColors).toEqual(["#bb5577"]);
    const themed = applySettingsPatch(withRecent, { appearance: { theme: "bright" } });
    expect(themed.appearance).toMatchObject({ theme: "bright", recentColors: ["#bb5577"] });
    const cleared = applySettingsPatch(themed, { appearance: { recentColors: [] } });
    expect(cleared.appearance.recentColors).toBeUndefined();
    expect("recentColors" in cleared.appearance).toBe(false);
  });

  it("decodes a stored row written before the key existed, and refuses a bad colour", () => {
    const row = { theme: "system", density: "comfortable", reduceMotion: false };
    expect(Schema.decodeUnknownSync(AppearanceSettings)(row)).toEqual(row);
    expect(() => Schema.decodeUnknownSync(AppearanceSettings)({ ...row, recentColors: ["teal"] })).toThrow();
  });
});
