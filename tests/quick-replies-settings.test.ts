import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUICK_REPLIES,
  DEFAULT_QUIET_NOTES,
  QUICK_REPLY_BOUNDS,
  Settings,
  SettingsPatch,
  applySettingsPatch,
  defaultSection,
  defaultSettings,
  feedSettings,
  quietNotesOf,
  sanitizeQuickReplies,
} from "../src/shared/settings";
import { decodeStoredSettings, preferencesFromSettings } from "../src/main/junto/settings/state-schema";

const decodePatch = Schema.decodeUnknownSync(SettingsPatch, { onExcessProperty: "error" });
const decodeSettings = Schema.decodeUnknownSync(Settings, { onExcessProperty: "error" });

describe("quick replies settings", () => {
  it("defaults to a short everyday set and resets to it", () => {
    expect(feedSettings(defaultSettings()).quickReplies).toEqual([
      "Yes",
      "Looks good",
      "Go on",
      "Not now",
      "I disagree",
      "Let's discuss",
    ]);
    expect(defaultSection("feed")).toEqual({
      quickReplies: [...DEFAULT_QUICK_REPLIES],
      quietNotes: [...DEFAULT_QUIET_NOTES],
    });
  });

  it("decodes rows written before quick replies as the defaults", () => {
    const settings = defaultSettings();
    const { feed: _feed, ...prefs } = preferencesFromSettings(settings);
    const decoded = decodeStoredSettings(1, prefs, settings.machine);
    expect(feedSettings(decoded).quickReplies).toEqual([...DEFAULT_QUICK_REPLIES]);
    expect(preferencesFromSettings(decoded).feed?.quickReplies).toEqual([...DEFAULT_QUICK_REPLIES]);
  });

  it("stores an edited, reordered list and keeps it through the stored row", () => {
    const next = applySettingsPatch(defaultSettings(), decodePatch({ feed: { quickReplies: ["Go on", "Ship it", "No"] } }));
    expect(feedSettings(next).quickReplies).toEqual(["Go on", "Ship it", "No"]);
    const stored = decodeStoredSettings(1, JSON.parse(JSON.stringify(preferencesFromSettings(next))), next.machine);
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

describe("quiet notes settings", () => {
  it("defaults to Acknowledged and Good", () => {
    expect(quietNotesOf(defaultSettings())).toEqual(["Acknowledged", "Good"]);
  });

  it("reads a feed row written before quiet notes as the defaults", () => {
    const settings = defaultSettings();
    const prefs = { ...preferencesFromSettings(settings), feed: { quickReplies: ["Go on"] } };
    const decoded = decodeStoredSettings(1, prefs, settings.machine);
    expect(feedSettings(decoded).quickReplies).toEqual(["Go on"]);
    expect(quietNotesOf(decoded)).toEqual([...DEFAULT_QUIET_NOTES]);
  });

  it("stores quiet notes without touching the quick replies, and the other way round", () => {
    const withReplies = applySettingsPatch(defaultSettings(), decodePatch({ feed: { quickReplies: ["Ship it"] } }));
    const withNotes = applySettingsPatch(withReplies, decodePatch({ feed: { quietNotes: ["Seen", "seen", "Noted"] } }));
    expect(feedSettings(withNotes).quickReplies).toEqual(["Ship it"]);
    expect(quietNotesOf(withNotes)).toEqual(["Seen", "Noted"]);
    const again = applySettingsPatch(withNotes, decodePatch({ feed: { quickReplies: ["Yes"] } }));
    expect(quietNotesOf(again)).toEqual(["Seen", "Noted"]);
    const stored = decodeStoredSettings(1, JSON.parse(JSON.stringify(preferencesFromSettings(again))), again.machine);
    expect(quietNotesOf(stored)).toEqual(["Seen", "Noted"]);
  });

  it("keeps an emptied list empty, not back on the defaults", () => {
    const next = applySettingsPatch(defaultSettings(), decodePatch({ feed: { quietNotes: [] } }));
    expect(quietNotesOf(next)).toEqual([]);
  });

  it("refuses a multi-line or blank quiet note at the wire", () => {
    expect(() => decodePatch({ feed: { quietNotes: ["one\ntwo"] } })).toThrow();
    expect(() => decodePatch({ feed: { quietNotes: [""] } })).toThrow();
  });
});
