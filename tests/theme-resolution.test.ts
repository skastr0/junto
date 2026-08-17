import { describe, expect, it } from "vitest";
import { colorFgBgFor, resolveThemeMode } from "../src/shared/theme";

describe("theme resolution — one rule for main and renderer", () => {
  it("an explicit preference wins and never consults the OS", () => {
    expect(resolveThemeMode("bright", true)).toBe("bright");
    expect(resolveThemeMode("dark", false)).toBe("dark");
  });

  it("system follows the OS, which is what that preference means", () => {
    expect(resolveThemeMode("system", true)).toBe("dark");
    expect(resolveThemeMode("system", false)).toBe("bright");
  });

  it("an absent preference resolves like system rather than assuming dark", () => {
    expect(resolveThemeMode(undefined, false)).toBe("bright");
  });

  it("a bright app spawns harnesses with a light COLORFGBG hint", () => {
    expect(colorFgBgFor(resolveThemeMode("bright", true))).toBe("0;15");
    expect(colorFgBgFor(resolveThemeMode("dark", false))).toBe("15;0");
  });
});
