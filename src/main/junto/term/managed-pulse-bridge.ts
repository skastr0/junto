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

export type ManagedPulseReadyEvent = {
  readonly bindingId: string;
  readonly epoch: string;
};

export type ManagedPulseReadyListener = (
  event: ManagedPulseReadyEvent,
) => void;

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
const readyListeners = new Set<ManagedPulseReadyListener>();

export const setManagedPulseDeliver = (fn: ManagedPulseDeliver | undefined): void => {
  deliver = fn;
};

export const subscribeManagedPulseReady = (
  listener: ManagedPulseReadyListener,
): (() => void) => {
  readyListeners.add(listener);
  return () => {
    readyListeners.delete(listener);
  };
};

const publishManagedPulseReady = (event: ManagedPulseReadyEvent): void => {
  for (const listener of readyListeners) {
    try {
      listener(event);
    } catch (error) {
      console.error("[term] managed-pulse ready listener failed:", error);
    }
  }
};

/**
 * Turn an explicit transport guard into one readiness event.
 *
 * The event contains no prompt. Kernel remains the only owner of the durable
 * source identity and re-checks current intent, work state, actor locality,
 * and seat idleness before retrying delivery.
 */
export const scheduleManagedPulseReady = (
  event: ManagedPulseReadyEvent,
  delayMs: number,
  stillCurrent: () => boolean,
): (() => void) => {
  let active = true;
  const timer = setTimeout(() => {
    if (!active) return;
    active = false;
    if (stillCurrent()) publishManagedPulseReady(event);
  }, Math.max(0, delayMs));
  timer.unref?.();
  return () => {
    if (!active) return;
    active = false;
    clearTimeout(timer);
  };
};

export const managedPulseDeliver = (
  bindingId: string,
  message: string,
): Promise<boolean> => {
  if (!deliver) return Promise.resolve(false);
  return deliver(bindingId, message);
};
