import { KEY_TABLE, chordOfKey, chordsFor, type KeyEventLike, type SurfaceKeyId } from "../../shared/key-table";
import { keyboardSettings } from "../../shared/settings";
import { isMac } from "./platform";
import { state$ } from "./state";

/**
 * For a screen that handles its own keys: is this keydown the chord the key
 * table gives that key? The screen keeps its handler; the chord comes from
 * the table, so Cmd is Cmd on macOS and Control is left to the shell.
 */
export const keyIs = (event: KeyEventLike, id: SurfaceKeyId, mac: boolean = isMac()): boolean => {
  const def = KEY_TABLE.find((row) => row.id === id);
  const chord = chordOfKey(event);
  if (!def || chord === null) return false;
  return chordsFor(def, mac, keyboardSettings(state$.settings.peek()).overrides).includes(chord);
};

const ARIA_KEY: Readonly<Record<string, string>> = { Cmd: "Meta", Ctrl: "Control" };

/** The key's chords as an aria-keyshortcuts value ("Meta+Enter"). */
export const keyAria = (id: SurfaceKeyId, mac: boolean = isMac()): string | undefined => {
  const def = KEY_TABLE.find((row) => row.id === id);
  if (!def) return undefined;
  const chords = chordsFor(def, mac, keyboardSettings(state$.settings.peek()).overrides);
  return chords.length === 0
    ? undefined
    : chords.map((chord) => chord.split("+").map((part) => ARIA_KEY[part] ?? part).join("+")).join(" ");
};
