import type { ITheme } from "@xterm/xterm";
import type { ThemeMode } from "@shared/theme";
// Re-export shared spawn/protocol helpers so terminal surfaces keep one import.
export { colorFgBgFor, schemeDsrFor } from "@shared/theme";
import { themeFor } from "./theme";

/**
 * Complete Vellum Command xterm theme — ground/ink/cursor/selection plus the
 * full 16-color ANSI table projected from the shared token source. One look for
 * every terminal surface (native + herdr). Never post-process the terminal with
 * brightness/inversion filters; semantic colors, diffs, and images stay honest.
 *
 * ANSI mapping (house hues, not stock VGA):
 *   black/white  ← well / ink-2 ladder
 *   red          ← crimson (blockers / errors)
 *   green        ← green (ok / success)
 *   yellow       ← gold (warnings / labels)
 *   blue         ← indigo (links / secondary)
 *   magenta      ← violet
 *   cyan         ← cyan (second role)
 *   bright*      ← hi/fg companions where they exist, else base
 */
export const xtermThemeFor = (mode: ThemeMode): ITheme => {
  const t = themeFor(mode);
  return {
    background: t.ground,
    foreground: t.ink,
    cursor: t["main-fg"],
    cursorAccent: t.ground,
    selectionBackground: t.selection,
    selectionInactiveBackground: t["selection-inactive"],
    // ANSI 0–7
    black: t.well,
    red: t.crimson,
    green: t.green,
    yellow: t.gold,
    blue: t.indigo,
    magenta: t.violet,
    cyan: t.cyan,
    white: t["ink-2"],
    // ANSI 8–15 (bright)
    brightBlack: t.faint,
    brightRed: t["crimson-fg"],
    brightGreen: t.green,
    brightYellow: t.amber,
    brightBlue: t.indigo,
    brightMagenta: t.violet,
    brightCyan: t["cyan-fg"],
    brightWhite: t.ink,
  };
};

/** Dark-mode projection — the default, kept for single-mode call sites. */
export const VELLUM_XTERM_THEME: ITheme = xtermThemeFor("dark");

/** One mono stack for every terminal surface (13px house cell). */
export const VELLUM_XTERM_FONT_FAMILY =
  "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace";

export const VELLUM_XTERM_FONT_SIZE = 13;
