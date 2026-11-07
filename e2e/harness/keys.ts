/**
 * The keys a spec presses, as this platform's app and editor read them. The
 * app binds its shortcuts on Cmd on macOS and on Ctrl elsewhere
 * (src/shared/key-table.ts, `mac` and `other`), so a spec never names Meta
 * for an app shortcut: it presses `mod("K")`, which is Meta+K on a Mac and
 * Control+K on Linux. `tests/e2e-app-modifier.test.ts` holds every spec to it.
 *
 * Some shortcuts have no chord off macOS (`other: []`: the switcher, mirrors,
 * zoom, close front, the rail): a step that needs one runs where `MAC`.
 */

/** True on macOS, where the app's modifier is Cmd. */
export const MAC = process.platform === "darwin";

/** The app's modifier as Playwright names it: Meta on macOS, Control elsewhere. */
export const MOD = MAC ? "Meta" : "Control";

/** A chord on the app's modifier: `mod("Shift+M")` is Meta+Shift+M on macOS, Control+Shift+M elsewhere. */
export const mod = (keys: string): string => `${MOD}+${keys}`;

/** The caret to the start of the text in an editor: Cmd+Up on macOS, Ctrl+Home elsewhere. */
export const TEXT_START = MAC ? "Meta+ArrowUp" : "Control+Home";

/** The caret to the end of the text in an editor: Cmd+Down on macOS, Ctrl+End elsewhere. */
export const TEXT_END = MAC ? "Meta+ArrowDown" : "Control+End";

/** Trash the focused row of a Files tree: Cmd+Backspace on macOS; Delete does it everywhere (FilesNode.tsx). */
export const TRASH_ROW = MAC ? "Meta+Backspace" : "Delete";
