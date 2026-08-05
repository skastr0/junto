import type { ITheme } from "@xterm/xterm";
import type { ThemeMode } from "@shared/theme";
import { themeFor } from "./theme";

/**
 * The house xterm theme — one terminal look for every surface (native
 * terminal, herdr terminal, anything future), projected per mode from the
 * token source. Ground, ink text, amber cursor; selection is a quiet amber
 * wash, never a khaki highlight. On paper the cursor and selection use the
 * contrast-safe foreground amber.
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
  };
};

/** Dark-mode projection — the default, kept for single-mode call sites. */
export const VELLUM_XTERM_THEME: ITheme = xtermThemeFor("dark");

/** One mono stack for every terminal surface (13px house cell). */
export const VELLUM_XTERM_FONT_FAMILY =
  "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace";

export const VELLUM_XTERM_FONT_SIZE = 13;
