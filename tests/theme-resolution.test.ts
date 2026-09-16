import { describe, expect, it } from "vitest";
import { colorFgBgFor, resolveThemeMode } from "../src/shared/theme";
import { defaultSettings, settingsOpFail, settingsOpOk } from "../src/shared/settings";
import { themePublishDecision } from "../src/main/junto/settings/theme-publish";

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

describe("theme preference published from an IPC settings result", () => {
  const withTheme = (theme: string) => {
    const base = defaultSettings();
    return { ...base, appearance: { ...base.appearance, theme } } as ReturnType<
      typeof defaultSettings
    >;
  };

  it("carries the stored preference, so a get never resets main to the OS", () => {
    // The regression: this result was read for a `value` field it does not
    // have, so every renderer settingsGet published undefined and a stored
    // bright spawned harnesses with the dark COLORFGBG hint.
    const op = settingsOpOk(withTheme("bright"));
    expect(themePublishDecision(op)).toEqual({
      kind: "publish",
      preference: "bright",
    });
    expect(
      colorFgBgFor(
        resolveThemeMode(
          (themePublishDecision(op) as { preference: string }).preference,
          true,
        ),
      ),
    ).toBe("0;15");
  });

  it("leaves the resolved theme alone when the op failed", () => {
    expect(themePublishDecision(settingsOpFail("validation", "nope"))).toEqual({
      kind: "leave",
    });
  });
});
