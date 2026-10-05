import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  KEYBOARD_BOUNDS,
  Settings,
  SettingsPatch,
  applySettingsPatch,
  defaultSection,
  defaultSettings,
  keyboardSettings,
  sanitizeKeyOverrides,
} from "../src/shared/settings";
import { decodeStoredSettings, preferencesFromSettings } from "../src/main/junto/settings/state-schema";

const decodePatch = Schema.decodeUnknownSync(SettingsPatch, { onExcessProperty: "error" });
const decodeSettings = Schema.decodeUnknownSync(Settings, { onExcessProperty: "error" });

describe("keyboard settings", () => {
  it("stores nothing by default: every shortcut is on the key table's own chord", () => {
    expect(keyboardSettings(defaultSettings()).overrides).toEqual({});
    expect(defaultSection("keyboard")).toEqual({ overrides: {} });
  });

  it("decodes rows written before shortcuts could be changed as the defaults", () => {
    const settings = defaultSettings();
    const { keyboard: _keyboard, ...prefs } = preferencesFromSettings(settings);
    expect(keyboardSettings(decodeStoredSettings(1, prefs, settings.station)).overrides).toEqual({});
  });

  it("keeps a changed shortcut through the stored row", () => {
    const next = applySettingsPatch(
      defaultSettings(),
      decodePatch({ keyboard: { overrides: { "feed.open": ["Cmd+J"], "search.slash": [] } } }),
    );
    expect(keyboardSettings(next).overrides).toEqual({ "feed.open": ["Cmd+J"], "search.slash": [] });
    const stored = decodeStoredSettings(1, JSON.parse(JSON.stringify(preferencesFromSettings(next))), next.station);
    expect(keyboardSettings(stored).overrides).toEqual({ "feed.open": ["Cmd+J"], "search.slash": [] });
    expect(decodeSettings(next)).toEqual(next);
  });

  it("replaces the whole map on a write, so a shortcut left out is back on its default", () => {
    const first = applySettingsPatch(defaultSettings(), decodePatch({ keyboard: { overrides: { "feed.open": ["Cmd+J"] } } }));
    const second = applySettingsPatch(first, decodePatch({ keyboard: { overrides: { "git.review": ["Cmd+U"] } } }));
    expect(keyboardSettings(second).overrides).toEqual({ "git.review": ["Cmd+U"] });
  });

  it("drops a shortcut the key table does not have, and repeats", () => {
    expect(sanitizeKeyOverrides({ "gone.shortcut": ["Cmd+J"], "feed.open": ["Cmd+J", "Cmd+J"] })).toEqual({
      "feed.open": ["Cmd+J"],
    });
  });

  it("refuses a chord that is not written as modifiers and one key", () => {
    for (const chord of ["", "Cmd+", "Cmd K", "Meta+K", "Cmd+K+", "x".repeat(KEYBOARD_BOUNDS.maxChordChars + 1)]) {
      expect(() => decodePatch({ keyboard: { overrides: { "feed.open": [chord] } } })).toThrow();
    }
    expect(() =>
      decodePatch({ keyboard: { overrides: { "feed.open": ["Cmd+A", "Cmd+B", "Cmd+D", "Cmd+E", "Cmd+F"] } } }),
    ).toThrow();
  });
});
