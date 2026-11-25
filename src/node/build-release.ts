import type { MachineRelease } from "@shared/machine-control";

/**
 * What this build says it is, for the far end of a link to show: the release
 * `version` its boot knows (the app's own, or the bundle's define) and when it
 * was built. Display only; build equality alone admits a link.
 */
export const buildRelease = (version: string | undefined): MachineRelease => ({
  ...(version === undefined ? {} : { version }),
  ...(typeof __JUNTO_BUILT_AT__ === "string" ? { builtAt: __JUNTO_BUILT_AT__ } : {}),
});
