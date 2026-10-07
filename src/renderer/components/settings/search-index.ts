/**
 * Settings search: every setting by its name, what it says about itself, and
 * the page it lives on. Pages whose settings come from a table (shortcuts,
 * experimental features, sound families) read that table; the rest are listed
 * here, and tests/settings-search-index.test.ts holds each listed name to the
 * page that draws it.
 */
import { experimentalFeatureSpec } from "@shared/feature-catalog";
import { experimentalFeatureKeys } from "@shared/features";
import { KEY_TABLE } from "@shared/key-table";
import { SOUND_CATEGORIES } from "@shared/settings";
import { CATEGORY_LABEL } from "../../lib/sound/cues";

export type SettingEntry = {
  /** The page's key in the section list. */
  readonly section: string;
  /** The setting's name as its row shows it; also the row's anchor. */
  readonly name: string;
  readonly description: string;
};

const entry = (section: string, name: string, description: string): SettingEntry => ({
  section,
  name,
  description,
});

/** Settings whose names are written on their page. */
export const LISTED_SETTINGS: ReadonlyArray<SettingEntry> = [
  entry("appearance", "Theme", "Auto, dark or bright. Auto follows your system's light or dark setting"),
  entry(
    "appearance",
    "Interface size",
    "Makes text, buttons and spacing larger or smaller together",
  ),
  entry(
    "appearance",
    "Agent terminal colours",
    "What an open agent terminal does when you switch between dark and bright",
  ),

  entry("terminal", "Scroll sensitivity", "lines per wheel notch"),
  entry("terminal", "Font size", "cell size in px"),
  entry("terminal", "Font family", "font stack for terminal cells, monospace first"),
  entry("terminal", "Cursor style", "how the cursor is drawn"),
  entry("terminal", "Scrollback", "lines kept above the viewport"),
  entry(
    "terminal",
    "Copy selection automatically",
    "selecting text otherwise replaces the system clipboard",
  ),
  entry("terminal", "Cursor blink", "blink while the terminal is visible"),
  entry("terminal", "Minimum contrast", "ratio enforced per cell"),
  entry("terminal", "Line height", "multiple of font size"),
  entry("terminal", "Letter spacing", "extra px per cell"),
  entry("terminal", "Screen reader mode", "expose terminal output to the screen reader"),
  entry("terminal", "Bell", "what happens when a program rings the bell"),

  entry("feed", "New quick reply", "One-click answers offered when an agent is waiting on you"),

  entry("notifications", "Send notifications", "Whether Junto reaches you while it is in the background"),
  entry("notifications", "Blocked", "An agent is stuck and cannot go on without you"),
  entry("notifications", "Needs you", "An agent asked a question, wants a decision, or is waiting at a prompt"),
  entry("notifications", "Stopped", "An agent's process ended with an error"),
  entry("notifications", "Finished", "An agent finished and you have not looked yet"),
  entry("notifications", "Badge", "How many agents are waiting on you, on the Junto icon"),
  entry("notifications", "Bounce when blocked", "The icon bounces once when an agent is blocked"),

  entry("offboard", "Cache window", "how long a still agent stays cheap to give a turn"),
  entry("offboard", "Idle nudge", "asks a still agent to offboard and continue, once per idle stretch"),
  entry("offboard", "Auto offboard", "ends a still agent's session by itself: no agent turn, no notes"),
  entry("offboard", "Worth cutting: work time", "time spent working before a session is worth ending"),
  entry("offboard", "Worth cutting: session size", "transcript size before a session is worth ending"),

  entry("companion", "Pair a phone", "Answer agents and send them mail from your phone"),
  entry("companion", "Paired phones", "Phones that can reach this Mac"),

  entry("station", "This machine's host id", "How this installation is identified across the fleet"),
  entry("station", "Allow remote managed installs", "Deploy and update Junto on enrolled Remotes"),
  entry("station", "Prefer supervised runtime", "Preference only, does not install the supervisor"),

  entry("updates", "Installed version", "currently running Junto"),
  entry("updates", "Application updates", "Check for and install a newer Junto"),

  entry("audio", "All sounds", "The level and switch for every sound together"),

  entry("browser", "Max warm sessions", "concurrent warm browser pages"),

  entry("harnesses", "Offer in palette", "off hides this harness even when the CLI is installed"),
  entry("harnesses", "Default model", "the model a new seat of this harness starts with"),
  entry("harnesses", "Default effort", "the effort a new seat of this harness starts with"),
  entry("harnesses", "Default permission mode", "the permission mode a new seat of this harness starts with"),

  entry("advanced", "Introduction", "the short tour from first launch"),
  entry("advanced", "Logs explorer", "show the developer logs panel in the top bar"),
  entry("advanced", "Agent tool directories", "extra directories searched for agent CLIs"),
  entry("advanced", "Start Junto at login", "macOS Login Items"),
  entry("advanced", "App version", "currently running Junto"),
  entry("advanced", "Platform", "OS and architecture"),
  entry("advanced", "Backup", "restore Junto's state from a verified backup"),
];

/** Every setting on the pages this build shows. */
export const settingsIndex = (sections: ReadonlyArray<string>): ReadonlyArray<SettingEntry> => {
  const shown = new Set(sections);
  return [
    ...LISTED_SETTINGS,
    ...KEY_TABLE.map((def) => entry("keyboard", def.name, def.does)),
    ...SOUND_CATEGORIES.map((category) =>
      entry("audio", CATEGORY_LABEL[category].title, CATEGORY_LABEL[category].hint),
    ),
    ...experimentalFeatureKeys().flatMap((key) => {
      const spec = experimentalFeatureSpec(key);
      return spec ? [entry("experimental", spec.title, spec.description)] : [];
    }),
  ].filter((item) => shown.has(item.section));
};

export type SettingHit = SettingEntry & { readonly sectionLabel: string };

/**
 * Settings matching every word typed, in the setting's name, its description
 * or its page's name. Names that start with the text come first, then names
 * that hold it, then the rest, each in page order.
 */
export const searchSettings = (
  entries: ReadonlyArray<SettingEntry>,
  sectionLabels: Readonly<Record<string, string>>,
  query: string,
): ReadonlyArray<SettingHit> => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const whole = words.join(" ");
  const rank = (item: SettingEntry): number => {
    const name = item.name.toLowerCase();
    if (name.startsWith(whole)) return 0;
    if (name.includes(whole)) return 1;
    return 2;
  };
  return entries
    .map((item) => ({ ...item, sectionLabel: sectionLabels[item.section] ?? item.section }))
    .filter((item) => {
      const text = `${item.name} ${item.description} ${item.sectionLabel}`.toLowerCase();
      return words.every((word) => text.includes(word));
    })
    .map((item, order) => ({ item, order, rank: rank(item) }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map(({ item }) => item);
};
