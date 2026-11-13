/**
 * The page's one GPU device keeper. It is made the first time the GPU canvas
 * mounts and kept for the page's life, so turning the switch on and off with
 * the app open reuses one device instead of making one per mount. Loss and
 * recovery are the keeper's (engine/device.ts).
 */

import { createDeviceKeeper, type DeviceKeeper } from "../engine/device";

let keeper: DeviceKeeper | undefined;

export const pageDeviceKeeper = (): DeviceKeeper => {
  keeper ??= createDeviceKeeper(typeof navigator === "undefined" ? undefined : navigator.gpu);
  return keeper;
};

/** Tests only: drop the keeper so the next mount makes a fresh one. */
export const resetPageDeviceKeeperForTest = (): void => {
  keeper?.dispose();
  keeper = undefined;
};
