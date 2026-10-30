import { FLEET_UI_ENABLED } from "@shared/features";
import { state$ } from "./state";

// Opening the Machines window. The window and everything it reads load only
// when it opens, so a build with the flag off carries none of it.

let windowChunk: Promise<unknown> | null = null;

/** Warm the window's code before the operator clicks. */
export const prefetchMachinesWindow = (): void => {
  if (!__JUNTO_FLEET_UI_ENABLED__) return;
  if (!FLEET_UI_ENABLED) return;
  if (windowChunk) return;
  windowChunk = import("../components/machines/MachinesWindow").catch(() => {
    windowChunk = null;
  });
};

/**
 * Open the Machines window, on `machine` when one is named (the authority
 * banner's chips open the machine they stand for). The shelf selection is the
 * window's own; the request is read once, when the window mounts.
 */
export const openMachines = (machine?: string): void => {
  if (!FLEET_UI_ENABLED) return;
  prefetchMachinesWindow();
  state$.machinesRequested.set(machine ?? "");
  state$.machinesOpen.set(true);
};

export const closeMachines = (): void => {
  state$.machinesOpen.set(false);
};
