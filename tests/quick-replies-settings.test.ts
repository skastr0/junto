import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUICK_REPLIES,
  QUICK_REPLY_BOUNDS,
  Settings,
  SettingsPatch,
  applySettingsPatch,
  defaultSection,
  defaultSettings,
  feedSettings,
  sanitizeQuickReplies,
} from "../src/shared/settings";
import { decodeStoredSettings, preferencesFromSettings } from "../src/main/junto/settings/state-schema";

const decodePatch = Schema.decodeUnknownSync(SettingsPatch, { onExcessProperty: "error" });
const decodeSettings = Schema.decodeUnknownSync(Settings, { onExcessProperty: "error" });

describe("quick replies settings", () => {
  it("defaults to a short everyday set and resets to it", () => {
    expect(feedSettings(defaultSettings()).quickReplies).toEqual(["Yes", "No", "Continue", "Go on", "Stop doing this"]);
    expect(defaultSection("feed")).toEqual({ quickReplies: [...DEFAULT_QUICK_REPLIES] });
  });

  it("decodes rows written before quick replies as the defaults", () => {
    const settings = defaultSettings();
    const { feed: _feed, ...prefs } = preferencesFromSettings(settings);
    const decoded = decodeStoredSettings(1, prefs, settings.station);
    expect(feedSettings(decoded).quickReplies).toEqual([...DEFAULT_QUICK_REPLIES]);
    expect(preferencesFromSettings(decoded).feed?.quickReplies).toEqual([...DEFAULT_QUICK_REPLIES]);
  });

  it("stores an edited, reordered list and keeps it through the stored row", () => {
    const next = applySettingsPatch(defaultSettings(), decodePatch({ feed: { quickReplies: ["Go on", "Ship it", "No"] } }));
    expect(feedSettings(next).quickReplies).toEqual(["Go on", "Ship it", "No"]);
    const stored = decodeStoredSettings(1, JSON.parse(JSON.stringify(preferencesFromSettings(next))), next.station);
    expect(feedSettings(stored).quickReplies).toEqual(["Go on", "Ship it", "No"]);
    expect(decodeSettings(next)).toEqual(next);
  });

  it("allows an empty list", () => {
    const next = applySettingsPatch(defaultSettings(), decodePatch({ feed: { quickReplies: [] } }));
    expect(feedSettings(next).quickReplies).toEqual([]);
  });

  it("refuses multi-line, blank, oversized, or too many replies at the wire", () => {
    for (const quickReplies of [
      ["line one\nline two"],
      [" "],
      [""],
      [" padded"],
      ["x".repeat(QUICK_REPLY_BOUNDS.maxChars + 1)],
      Array.from({ length: QUICK_REPLY_BOUNDS.maxCount + 1 }, (_, i) => `reply ${i}`),
    ]) {
      expect(() => decodePatch({ feed: { quickReplies } })).toThrow();
    }
    expect(() => decodePatch({ feed: { quickReplies: ["Yes"], extra: true } })).toThrow();
  });

  it("sanitizes typed lines: trims, collapses spaces, drops blanks and repeats", () => {
    expect(sanitizeQuickReplies(["  Yes ", "yes", "", "Go   on", "Stop doing this"])).toEqual([
      "Yes",
      "Go on",
      "Stop doing this",
    ]);
    expect(sanitizeQuickReplies(Array.from({ length: 20 }, (_, i) => `r${i}`))).toHaveLength(QUICK_REPLY_BOUNDS.maxCount);
  });

  it("stays tiny next to the 64 KB settings ceiling", () => {
    const full = Array.from({ length: QUICK_REPLY_BOUNDS.maxCount }, (_, i) => `${i}`.padEnd(QUICK_REPLY_BOUNDS.maxChars, "x"));
    const next = applySettingsPatch(defaultSettings(), decodePatch({ feed: { quickReplies: full } }));
    expect(JSON.stringify(next.feed).length).toBeLessThan(2048);
  });
});
