/**
 * The app's theme, held in main.
 *
 * Main is the source of truth. The resolved mode is global information: it
 * applies to every seat on every canvas, including canvases that are not
 * currently rendered and seats woken with no surface attached. A renderer is a
 * consumer of this value, never its owner — a surface that happens to be open
 * must not be what decides what a spawning harness is told.
 *
 * Inputs: the operator's stored preference (`settings.appearance.theme`) and,
 * only when that preference is "system", the OS reading. The preference ->
 * mode rule lives in `@shared/theme` (`resolveThemeMode`) so main and the
 * renderer cannot drift, exactly as `colorFgBgFor` is the single spawn-hint
 * mapping.
 */

import { createRequire } from "node:module";
import { resolveThemeMode, type ThemeMode } from "@shared/theme";

// The bundled ESM main has no ambient require. The CJS machine core resolves
// from its installed file, not the build path.
const require = createRequire(typeof __filename === "string" ? __filename : import.meta.url);

/**
 * Junto's own default until a preference has been read. Deliberately
 * the same initial value the renderer starts from, so nothing observes a
 * different theme depending on which side asked first.
 */
let current: ThemeMode = "dark";
let preference: string | undefined;

const listeners = new Set<(mode: ThemeMode) => void>();

/**
 * The OS reading once main has said it. Before that, main's own `nativeTheme`
 * is read; a process without one stays on the dark default.
 */
let systemDark: boolean | undefined;

/** OS reading — consulted only to resolve the "system" preference. */
const systemPrefersDark = (): boolean => {
  if (systemDark !== undefined) return systemDark;
  try {
    // Lazy require so this module stays importable outside Electron main
    // (unit tests, CLI tooling).
    const electron = require("electron") as {
      readonly nativeTheme?: { readonly shouldUseDarkColors?: boolean };
    };
    const dark = electron.nativeTheme?.shouldUseDarkColors;
    if (typeof dark === "boolean") return dark;
  } catch {
    // not running under Electron
  }
  return true;
};

const recompute = (): void => {
  const next = resolveThemeMode(preference, systemPrefersDark());
  if (next === current) return;
  current = next;
  for (const listener of listeners) {
    try {
      listener(next);
    } catch {
      // a bad consumer must not break theme propagation
    }
  }
};

/** The resolved theme. Every consumer in main reads this and nothing else. */
export const currentThemeMode = (): ThemeMode => current;

/** Record the operator's stored preference (`dark` | `bright` | `system`). */
export const setThemePreference = (next: string | undefined): void => {
  preference = next;
  recompute();
};

/**
 * Record the OS reading main sees. A utility process has no `nativeTheme`, so
 * the core is told; main's own reading is the default until it is.
 */
export const setSystemPrefersDark = (dark: boolean): void => {
  systemDark = dark;
  recompute();
};

/** Re-resolve after an OS appearance change (only matters when "system"). */
export const refreshThemeFromSystem = (): void => {
  recompute();
};

export const onThemeModeChange = (listener: (mode: ThemeMode) => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
