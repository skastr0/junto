import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../src/shared/settings";

let systemLight = false;
let onSystemChange: (() => void) | undefined;
let dataset: Record<string, string>;
const addEventListener = vi.fn((_event: string, listener: () => void) => {
  onSystemChange = listener;
});

beforeEach(() => {
  vi.resetModules();
  systemLight = false;
  onSystemChange = undefined;
  dataset = {};
  addEventListener.mockClear();
  vi.stubGlobal("document", { documentElement: { dataset } });
  vi.stubGlobal("window", {
    matchMedia: () => ({ get matches() { return systemLight; }, addEventListener }),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("renderer theme settings", () => {
  it("applies a loaded preference immediately and starts only once", async () => {
    const { state$ } = await import("../src/renderer/lib/state");
    const { startThemeMode, themeMode$ } = await import("../src/renderer/lib/theme-mode");
    state$.settings.appearance.theme.set("bright");

    startThemeMode();
    startThemeMode();

    expect(themeMode$.peek()).toBe("bright");
    expect(dataset.theme).toBe("bright");
    expect(addEventListener).toHaveBeenCalledOnce();
  });

  it("uses ordinary settings hydration to replace the initial system preference", async () => {
    const { state$ } = await import("../src/renderer/lib/state");
    const { startThemeMode, themeMode$ } = await import("../src/renderer/lib/theme-mode");
    startThemeMode();
    expect(themeMode$.peek()).toBe("dark");

    const saved = defaultSettings();
    state$.settings.set({ ...saved, appearance: { ...saved.appearance, theme: "bright" } });
    expect(themeMode$.peek()).toBe("bright");
    expect(dataset.theme).toBe("bright");

    state$.settings.appearance.theme.set("dark");
    expect(themeMode$.peek()).toBe("dark");
    expect(dataset.theme).toBeUndefined();
  });

  it("follows system appearance only when that preference is selected", async () => {
    const { state$ } = await import("../src/renderer/lib/state");
    const { startThemeMode, themeMode$ } = await import("../src/renderer/lib/theme-mode");
    startThemeMode();
    systemLight = true;
    onSystemChange?.();
    expect(themeMode$.peek()).toBe("bright");

    state$.settings.appearance.theme.set("dark");
    onSystemChange?.();
    expect(themeMode$.peek()).toBe("dark");
  });
});
