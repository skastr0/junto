import { observable } from "@legendapp/state";
import { resolveThemeMode, type ThemeMode } from "@shared/theme";
import { state$ } from "./state";

/**
 * Theme mode plumbing. `appearance.theme` (dark | bright | system) resolves
 * to a concrete mode; the resolved value rides `html[data-theme]` for CSS
 * (dark is the default projection, so the attribute is only set for bright)
 * and is published on `themeMode$` for runtime consumers that paint outside
 * CSS: xterm themes and the canvas-2D magnifier. The settings bridge supplies
 * the saved preference through the same settings projection used by the app.
 */
export const themeMode$ = observable<ThemeMode>("dark");

const MEDIA = "(prefers-color-scheme: light)";

const resolve = (): ThemeMode => {
  const pref = state$.settings.appearance.theme.peek();
  // Same rule main uses (shared/theme resolveThemeMode) so the two can never
  // drift. Main is the source of truth for spawned harnesses; this resolves
  // the identical inputs for what the renderer paints.
  return resolveThemeMode(pref, !window.matchMedia(MEDIA).matches);
};

const apply = (): void => {
  const mode = resolve();
  themeMode$.set(mode);
  const el = document.documentElement;
  if (mode === "dark") {
    delete el.dataset.theme;
  } else {
    el.dataset.theme = mode;
  }
};

let started = false;

/** Apply the theme preference to the document and keep it live. Idempotent. */
export const startThemeMode = (): void => {
  if (started) return;
  started = true;
  apply();
  state$.settings.appearance.theme.onChange(() => apply());
  window.matchMedia(MEDIA).addEventListener("change", () => apply());
};
