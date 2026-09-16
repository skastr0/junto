/**
 * What an IPC settings result says about the operator's theme preference.
 *
 * Main owns the resolved theme for every seat on every canvas, including seats
 * woken with no surface. The preference reaches it from two shapes: the stored
 * `Settings` (boot prime, subscribe) and a `SettingsOpResult` (the get/patch
 * handlers). The second used to be read through an `unknown` cast for a field
 * the result does not have, so every renderer `settingsGet` quietly pushed
 * `undefined` over the value main had primed at boot and the resolved theme
 * fell back to the OS reading — a stored `bright` on a dark Mac then spawned
 * harnesses with `COLORFGBG=15;0`.
 *
 * A failed op carries no settings and must leave the resolved theme alone,
 * which is why this is a decision rather than a `string | undefined`.
 */

import type { SettingsOpResult } from "@shared/settings";

export type ThemePublishDecision =
  | { readonly kind: "publish"; readonly preference: string | undefined }
  | { readonly kind: "leave" };

export const themePublishDecision = (
  op: SettingsOpResult,
): ThemePublishDecision => {
  if (!op.ok || op.settings === undefined) return { kind: "leave" };
  return { kind: "publish", preference: op.settings.appearance.theme };
};
