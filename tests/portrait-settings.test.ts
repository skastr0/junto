import { Result } from "effect";
import { describe, expect, it } from "vitest";
import { applyAndValidatePatch, decodePatchInput } from "../src/main/junto/settings/patch";
import { decodeStoredSettings, preferencesFromSettings } from "../src/main/junto/settings/state-schema";
import { PORTRAIT_PREFS_MAX_SEATS, applySettingsPatch, defaultSettings } from "../src/shared/settings";

describe("portrait settings", () => {
  it("sets, replaces, and resets one seat without touching others", () => {
    let settings = applySettingsPatch(defaultSettings(), {
      portraits: { bySeat: { a: { shape: "toast", temperament: 0.5 }, b: { eyes: "dot" } } },
    });
    settings = applySettingsPatch(settings, { portraits: { bySeat: { a: { topper: "cat" } } } });
    expect(settings.portraits?.bySeat).toEqual({ a: { topper: "cat" }, b: { eyes: "dot" } });
    settings = applySettingsPatch(settings, { portraits: { bySeat: { b: null, a: {} } } });
    expect(settings.portraits?.bySeat).toEqual({});
  });

  it("caps customized seats so the settings row stays bounded", () => {
    const bySeat = Object.fromEntries(
      Array.from({ length: PORTRAIT_PREFS_MAX_SEATS + 5 }, (_, index) => [`seat-${index}`, { eyes: "dot" }]),
    );
    const settings = applySettingsPatch(defaultSettings(), { portraits: { bySeat } });
    expect(Object.keys(settings.portraits?.bySeat ?? {})).toHaveLength(PORTRAIT_PREFS_MAX_SEATS);
  });

  it("decodes patches strictly and survives a persist round trip", () => {
    const patch = decodePatchInput({ portraits: { bySeat: { a: { mouth: "grin", blush: false } } } });
    expect(Result.isSuccess(patch)).toBe(true);
    expect(Result.isSuccess(decodePatchInput({ portraits: { bySeat: { a: { hat: "top" } } } }))).toBe(false);
    expect(Result.isSuccess(decodePatchInput({ portraits: { bySeat: { a: { temperament: 2 } } } }))).toBe(false);
    if (!Result.isSuccess(patch)) return;
    const merged = applyAndValidatePatch(defaultSettings(), patch.success);
    expect(Result.isSuccess(merged)).toBe(true);
    if (!Result.isSuccess(merged)) return;
    const stored = JSON.parse(JSON.stringify(preferencesFromSettings(merged.success)));
    const restored = decodeStoredSettings(1, stored, merged.success.station);
    expect(restored.portraits?.bySeat.a).toEqual({ mouth: "grin", blush: false });
  });

  it("admits rows written before the section and keeps unknown trait values", () => {
    const legacy = JSON.parse(JSON.stringify(preferencesFromSettings(defaultSettings())));
    delete legacy.portraits;
    expect(decodeStoredSettings(1, legacy, defaultSettings().station).portraits).toEqual({ bySeat: {} });
    const future = { ...legacy, portraits: { bySeat: { a: { shape: "cloud-from-a-later-build" } } } };
    expect(decodeStoredSettings(1, future, defaultSettings().station).portraits?.bySeat.a?.shape).toBe(
      "cloud-from-a-later-build",
    );
  });
});
