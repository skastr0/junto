import { KEY_TABLE, chordKeyCaps, chordOfKey, chordsFor, type KeyEventLike, type ShortcutId } from "../../shared/key-table";
import { keyboardSettings } from "../../shared/settings";
import { isMac } from "./platform";
import { state$ } from "./state";

/**
 * For a screen that handles its own keys: is this keydown the chord the key
 * table gives that key? The screen keeps its handler; the chord comes from
 * the table, so Cmd is Cmd on macOS and Control is left to the shell.
 *
 * They take any row of the table, not only a surface's: a header button shows
 * the chord of the app shortcut it stands for (`keyCaps("quickOpen.open")`).
 */
export const keyIs = (event: KeyEventLike, id: ShortcutId, mac: boolean = isMac()): boolean => {
  const def = KEY_TABLE.find((row) => row.id === id);
  const chord = chordOfKey(event);
  if (!def || chord === null) return false;
  return chordsFor(def, mac, keyboardSettings(state$.settings.peek()).overrides).includes(chord);
};

const ARIA_KEY: Readonly<Record<string, string>> = { Cmd: "Meta", Ctrl: "Control" };

/** The key's chords as an aria-keyshortcuts value ("Meta+Enter"). */
export const keyAria = (id: ShortcutId, mac: boolean = isMac()): string | undefined => {
  const def = KEY_TABLE.find((row) => row.id === id);
  if (!def) return undefined;
  const chords = chordsFor(def, mac, keyboardSettings(state$.settings.peek()).overrides);
  return chords.length === 0
    ? undefined
    : chords.map((chord) => chord.split("+").map((part) => ARIA_KEY[part] ?? part).join("+")).join(" ");
};

/**
 * The key's first chord as the caps to draw ("⌘", "P" on macOS; "Ctrl", "P"
 * elsewhere), for a title or a hint beside the control it works on.
 */
export const keyCaps = (id: ShortcutId, mac: boolean = isMac()): readonly string[] | undefined => {
  const def = KEY_TABLE.find((row) => row.id === id);
  if (!def) return undefined;
  const chord = chordsFor(def, mac, keyboardSettings(state$.settings.peek()).overrides)[0];
  return chord === undefined ? undefined : chordKeyCaps(chord, mac);
};
