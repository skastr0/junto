/**
 * Bridge so KernelService can deliver pulses to ManagedTerminalDrive without
 * a circular import (drive is constructed in ipc boot after Kernel starts).
 */

export type ManagedPulseDeliver = (
  bindingId: string,
  message: string,
) => Promise<boolean>;

let deliver: ManagedPulseDeliver | undefined;

export const setManagedPulseDeliver = (fn: ManagedPulseDeliver | undefined): void => {
  deliver = fn;
};

export const managedPulseDeliver = (
  bindingId: string,
  message: string,
): Promise<boolean> => {
  if (!deliver) return Promise.resolve(false);
  return deliver(bindingId, message);
};
