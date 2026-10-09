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

export const openMachines = (): void => {
  if (!FLEET_UI_ENABLED) return;
  prefetchMachinesWindow();
  state$.machinesOpen.set(true);
};

export const closeMachines = (): void => {
  state$.machinesOpen.set(false);
};
