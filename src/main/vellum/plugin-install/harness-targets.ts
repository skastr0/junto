/**
 * Closed harness set for Fleet install UI / IPC (Tier-3 minimum + expand carefully).
 * Local string union — no import from @skastr0/prism-packager (Bun-only package).
 */

export const FLEET_PLUGIN_TARGETS = [
  "claude-code",
  "codex-cli",
  "grok",
  "hermes",
] as const;

export type FleetPluginTarget = (typeof FLEET_PLUGIN_TARGETS)[number];

export const isFleetPluginTarget = (value: string): value is FleetPluginTarget =>
  (FLEET_PLUGIN_TARGETS as ReadonlyArray<string>).includes(value);
