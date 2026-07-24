/**
 * Per-harness global config dirs relative to remote $HOME.
 * Mirrors prism packager HARNESSES[*].globalConfigPath (without ~/).
 */
import { join } from "node:path";
import type { FleetPluginTarget } from "./harness-targets";

export const FLEET_HARNESS_HOME_REL: Readonly<
  Record<FleetPluginTarget, string>
> = {
  "claude-code": ".claude",
  "codex-cli": ".codex",
  grok: ".grok",
  hermes: ".hermes",
};

/** Absolute apply root for a harness under a remote (or local) home. */
export const harnessApplyRoot = (
  home: string,
  target: FleetPluginTarget,
): string => {
  const rel = FLEET_HARNESS_HOME_REL[target];
  const base = home.replace(/\/+$/u, "");
  return join(base, rel);
};
