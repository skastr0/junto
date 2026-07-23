import type { ITheme } from "@xterm/xterm";
import { GROUND, HUE, INK, withAlpha } from "./theme";

/**
 * The house xterm theme — one terminal look for every surface (native
 * terminal, herdr terminal, anything future). Deep-field ground, ink text,
 * amber cursor; selection is a quiet amber wash, never a khaki highlight.
 */
export const VELLUM_XTERM_THEME: ITheme = {
  background: GROUND,
  foreground: INK,
  cursor: HUE.amber,
  cursorAccent: GROUND,
  selectionBackground: withAlpha(HUE.amber, 0.28),
  selectionInactiveBackground: withAlpha(HUE.amber, 0.16),
};

/** One mono stack for every terminal surface (13px house cell). */
export const VELLUM_XTERM_FONT_FAMILY =
  "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace";

export const VELLUM_XTERM_FONT_SIZE = 13;
