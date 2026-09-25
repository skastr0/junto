import { Result } from "effect";
import { describe, expect, it } from "vitest";
import { decodePatchInput } from "../src/main/junto/settings/patch";
import { decodeStoredSettings, preferencesFromSettings } from "../src/main/junto/settings/state-schema";
import { applySettingsPatch, defaultSettings } from "../src/shared/settings";

// Portrait overrides moved to junto.db portrait_overrides (state migration
// 4 -> 5). The settings copy is deprecated: never written, never read, and a
// row that holds it keeps it byte for byte through every settings write.
describe("deprecated settings portraits", () => {
  it("offers no patch path and no default", () => {
    expect(Result.isSuccess(decodePatchInput({ portraits: { bySeat: { a: { shape: "toast" } } } }))).toBe(false);
    expect(defaultSettings()).not.toHaveProperty("portraits");
    expect(preferencesFromSettings(defaultSettings())).not.toHaveProperty("portraits");
  });

  it("carries a stored copy through decode, other patches, and persist untouched", () => {
    const legacy = {
      ...JSON.parse(JSON.stringify(preferencesFromSettings(defaultSettings()))),
      portraits: { bySeat: { a: { shape: "toast", temperament: 0.5 }, b: { shape: "cloud-from-a-later-build" } } },
    };
    const decoded = decodeStoredSettings(1, legacy, defaultSettings().station);
    const patched = applySettingsPatch(decoded, { appearance: { theme: "bright" } });
    const stored = JSON.parse(JSON.stringify(preferencesFromSettings(patched)));
    expect(stored.portraits).toEqual(legacy.portraits);
    expect(stored.appearance.theme).toBe("bright");
  });
});
