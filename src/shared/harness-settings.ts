/**
 * Apply Settings → Agents defaults to managed-seat launch choices.
 * Cascade / explicit picker choices always win over stored defaults.
 */

import type { HarnessId } from "./managed-terminal-templates";
import {
  harnessPrefsFor,
  harnessUserEnabled,
  type HarnessInstancePrefs,
  type Settings,
} from "./settings";
import { HARNESS_SETTINGS_ENABLED } from "./features";

export type LaunchChoiceSlice = {
  readonly model?: string;
  readonly effort?: string;
  readonly permissionMode?: string;
};

/**
 * Merge operator harness defaults under explicit choices.
 * No-op when harnessSettings feature is off.
 */
export const mergeHarnessLaunchDefaults = (
  settings: Settings | undefined,
  harness: HarnessId | string,
  choices: LaunchChoiceSlice = {},
): LaunchChoiceSlice => {
  if (!HARNESS_SETTINGS_ENABLED) return choices;
  const prefs: HarnessInstancePrefs = harnessPrefsFor(settings, harness);
  return {
    ...(prefs.model ? { model: prefs.model } : {}),
    ...(prefs.effort ? { effort: prefs.effort } : {}),
    ...(prefs.permissionMode ? { permissionMode: prefs.permissionMode } : {}),
    // Explicit non-empty choice wins.
    ...(choices.model?.trim() ? { model: choices.model.trim() } : {}),
    ...(choices.effort?.trim() ? { effort: choices.effort.trim() } : {}),
    ...(choices.permissionMode?.trim()
      ? { permissionMode: choices.permissionMode.trim() }
      : {}),
  };
};

/** User fine-control hide when settings surface is live. */
export const harnessVisibleInPalette = (
  settings: Settings | undefined,
  harness: string,
): boolean => {
  if (!HARNESS_SETTINGS_ENABLED) return true;
  return harnessUserEnabled(settings, harness);
};
