import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LISTED_SETTINGS,
  searchSettings,
  type SettingEntry,
} from "../src/renderer/components/settings/search-index";

const ROOT = join(process.cwd(), "src", "renderer", "components");

/** The file that draws each page whose settings are listed by hand. */
const PAGE_SOURCE: Readonly<Record<string, string>> = {
  appearance: "SettingsPanel.tsx",
  terminal: "settings/TerminalSettingsSection.tsx",
  feed: "settings/QuickRepliesSettingsSection.tsx",
  notifications: "settings/NotificationSettingsSection.tsx",
  offboard: "settings/OffboardSettingsSection.tsx",
  companion: "settings/CompanionSettingsSection.tsx",
  station: "SettingsPanel.tsx",
  updates: "SettingsPanel.tsx",
  audio: "settings/SoundSettingsSection.tsx",
  browser: "SettingsPanel.tsx",
  harnesses: "settings/HarnessesSettingsSection.tsx",
  advanced: "SettingsPanel.tsx",
};

describe("settings search index", () => {
  test("every listed setting is named on the page it points to", () => {
    const missing = LISTED_SETTINGS.filter((item) => {
      const file = PAGE_SOURCE[item.section];
      return file === undefined || !readFileSync(join(ROOT, file), "utf8").includes(item.name);
    }).map((item) => `${item.section}: ${item.name}`);
    expect(missing).toEqual([]);
  });

  const entries: ReadonlyArray<SettingEntry> = [
    { section: "terminal", name: "Font size", description: "cell size in px" },
    { section: "terminal", name: "Scrollback", description: "lines kept above the viewport" },
    { section: "appearance", name: "Interface size", description: "larger or smaller text" },
    { section: "audio", name: "All sounds", description: "every sound together" },
  ];
  const labels = { terminal: "Terminal", appearance: "Appearance", audio: "Sound" };
  const names = (query: string): ReadonlyArray<string> =>
    searchSettings(entries, labels, query).map((hit) => hit.name);

  test("nothing typed finds nothing", () => {
    expect(names("  ")).toEqual([]);
  });

  test("finds a setting by its name, its description and its page", () => {
    expect(names("scrollback")).toEqual(["Scrollback"]);
    expect(names("viewport")).toEqual(["Scrollback"]);
    expect(names("terminal")).toEqual(["Font size", "Scrollback"]);
  });

  test("a name that starts with the text comes before one that only holds it", () => {
    expect(names("size")).toEqual(["Font size", "Interface size"]);
    expect(names("interface")).toEqual(["Interface size"]);
    expect(names("s")[0]).toBe("Scrollback");
  });

  test("every word typed must match, in any field", () => {
    expect(names("terminal size")).toEqual(["Font size"]);
    expect(names("sound size")).toEqual([]);
  });

  test("a hit carries its page's name", () => {
    expect(searchSettings(entries, labels, "all sounds")[0]?.sectionLabel).toBe("Sound");
  });
});
