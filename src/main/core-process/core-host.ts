/**
 * The core's end of the host operations (Wave 3): its one handle on Electron
 * main. A core service that needs what only Electron has (a window's pixels,
 * the clipboard, the terminal process) calls `host.call(name, input)`.
 *
 * Only the core loads this module. Its entry asks over its port; a windowless
 * core has no Electron, so it installs `noWindowHost` and every call refuses
 * with that reason. A call before either is a boot-order bug, so it throws.
 * The protocol is `host-ops.ts`; main's end is `main-side/host-op-bodies.ts`.
 */
import { HostCallError, type HostClient } from "./host-ops";

let client: HostClient | undefined;

export const host: HostClient = {
  call: (name, input) => {
    if (client === undefined) {
      return Promise.reject(new Error(`Junto core asked main for ${name} before its boot chose a host`));
    }
    return client.call(name, input);
  },
};

/** Core boot only: where every host call goes from now on. */
export const useHostClient = (next: HostClient): void => {
  client = next;
};

/** The windowless core's host: there is no Electron, so every call refuses and says why. */
export const noWindowHost: HostClient = {
  call: (name) => Promise.reject(new HostCallError(name, "NoWindowHost", `${name} needs the Junto app; this core runs without a window`)),
};
