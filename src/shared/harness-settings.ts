/**
 * Apply Settings → Agents defaults to managed-seat launch choices.
 * Cascade / explicit picker choices always win over stored defaults.
 */

import { isHarnessId, templateFor, type HarnessId } from "./managed-terminal-templates";
import {
  checkParam,
  paramsOfTemplate,
  resolveParams,
  type ParamLayers,
  type ParamValues,
} from "./harness-domain/params";
import {
  harnessPrefsFor,
  harnessUserEnabled,
  machineHarnessPrefsFor,
  type HarnessInstancePrefs,
  type Settings,
} from "./settings";
import { HARNESS_SETTINGS_ENABLED } from "./features";
import { Result } from "effect";

export type LaunchChoiceSlice = {
  readonly model?: string;
  readonly effort?: string;
  readonly permissionMode?: string;
  readonly extraArgs?: readonly string[];
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
    ...(prefs.extraArgs && prefs.extraArgs.length > 0
      ? { extraArgs: prefs.extraArgs }
      : {}),
    // Explicit non-empty choice wins.
    ...(choices.model?.trim() ? { model: choices.model.trim() } : {}),
    ...(choices.effort?.trim() ? { effort: choices.effort.trim() } : {}),
    ...(choices.permissionMode?.trim()
      ? { permissionMode: choices.permissionMode.trim() }
      : {}),
    // An explicit list wins whole, including an empty one (no extras).
    ...(choices.extraArgs !== undefined ? { extraArgs: choices.extraArgs } : {}),
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

const prefsValues = (prefs: Omit<HarnessInstancePrefs, "enabled" | "recentModels">): ParamValues => ({
  ...(prefs.model ? { model: prefs.model } : {}),
  ...(prefs.effort ? { effort: prefs.effort } : {}),
  ...(prefs.permissionMode ? { permissionMode: prefs.permissionMode } : {}),
  ...(prefs.extraArgs !== undefined ? { extraArgs: prefs.extraArgs } : {}),
});

/**
 * The two Settings layers for one harness on one machine: the app-wide
 * default and that machine's override. `resolveParams` orders them under the
 * seat and the launch; a key set in neither is left to the harness.
 */
export const harnessSettingLayers = (
  settings: Settings | undefined,
  machine: string,
  harness: HarnessId | string,
): ParamLayers => ({
  harnessDefault: prefsValues(harnessPrefsFor(settings, harness)),
  machineDefault: prefsValues(machineHarnessPrefsFor(settings, machine, harness)),
});

/**
 * What a new seat on `machine` starts with: the explicit choices, then that
 * machine's override, then the app-wide default, resolved by the harness
 * domain. A Settings value the harness no longer accepts is not passed; an
 * explicit choice is the picker's to check. With no machine (a profile not
 * yet placed), only the app-wide default applies.
 */
export const resolveHarnessLaunchDefaults = (
  settings: Settings | undefined,
  harness: HarnessId | string,
  machine: string | undefined,
  choices: LaunchChoiceSlice = {},
): LaunchChoiceSlice => {
  if (!HARNESS_SETTINGS_ENABLED || !isHarnessId(harness)) return mergeHarnessLaunchDefaults(settings, harness, choices);
  const params = paramsOfTemplate(templateFor(harness));
  const stored = harnessSettingLayers(settings, machine ?? "", harness);
  const resolved = resolveParams(params, {
    harnessDefault: stored.harnessDefault ?? {},
    ...(machine ? { machineDefault: stored.machineDefault ?? {} } : {}),
    launch: choices,
  });
  const out: { model?: string; effort?: string; permissionMode?: string; extraArgs?: readonly string[] } = {};
  for (const key of ["model", "effort", "permissionMode"] as const) {
    const value = resolved.values[key];
    const layer = resolved.from[key];
    if (value === undefined || layer === undefined) continue;
    if (layer !== "launch" && Result.isFailure(checkParam(params, { key, value, layer }))) continue;
    out[key] = value;
  }
  if (resolved.values.extraArgs !== undefined) out.extraArgs = resolved.values.extraArgs;
  return out;
};
