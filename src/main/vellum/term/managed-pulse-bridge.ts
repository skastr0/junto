/**
 * Bridge so KernelService can deliver pulses to ManagedTerminalDrive without
 * a circular import (drive is constructed in ipc boot after Kernel starts).
 */

import type { WritePromptOptions } from "./drive";

export type ManagedPulseDeliver = (
  bindingId: string,
  message: string,
) => Promise<boolean>;

export type ManagedPromptWriter = (
  bindingId: string,
  message: string,
  options: WritePromptOptions,
) => Promise<boolean>;

/**
 * Pulses never enter the drive's raw-text queue. A refused write returns to
 * the kernel's source-aware retry plane, which re-checks the current edge and
 * station route before trying again.
 */
export const makeManagedPulseDeliver = (
  writePrompt: ManagedPromptWriter,
  isReady: (bindingId: string) => boolean,
): ManagedPulseDeliver =>
  (bindingId, message) =>
    writePrompt(bindingId, message, {
      ready: isReady(bindingId),
      queueIfBusy: false,
    });

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
