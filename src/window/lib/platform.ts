import { getJuntoApi } from "./junto-api";

/**
 * Renderer platform marker for copy and shortcut hints. Reads the preload
 * bridge's `platform` (authoritative, from the main process); falls back to
 * `navigator.platform` when the bridge is down (tests, early boot).
 */
export const rendererPlatform = (): NodeJS.Platform => {
  const api = getJuntoApi();
  if (api?.platform) return api.platform;
  const hint = typeof navigator === "undefined" ? "" : navigator.platform;
  return /win/i.test(hint) ? "win32" : /mac/i.test(hint) ? "darwin" : "linux";
};

/** True on macOS — the only platform where the ⌘ glyph is literal. */
export const isMac = (): boolean => rendererPlatform() === "darwin";

/**
 * Platform-true hint for a Cmd-or-Ctrl shortcut: "⌘" on macOS, "Ctrl" elsewhere.
 */
export const modKeyGlyph = (): string => (isMac() ? "⌘" : "Ctrl");
