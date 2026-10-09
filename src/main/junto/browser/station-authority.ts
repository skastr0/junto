import { findHostById, hostsSnapshot } from "../hosts/snapshot";
import type { BrowserHostCapabilityAuthority } from "./host-capability";

export interface BrowserHostCapabilityAuthorityLease {
  readonly authority: BrowserHostCapabilityAuthority;
  readonly close: () => void;
}

export interface BrowserMachineList {
  readonly findHost: BrowserHostCapabilityAuthority["findHost"];
  readonly hosts: () => ReadonlyArray<{ readonly id: string; readonly isThisMachine: boolean }>;
}

const defaultMachineList: BrowserMachineList = {
  findHost: findHostById,
  hosts: hostsSnapshot,
};

/**
 * This machine is the one row the machine list marks as its own. The list is
 * read on every admission, so the browser sees a hydrated or changed list at
 * once and holds no copy of the name.
 */
export const prepareBrowserHostCapabilityAuthority = async (
  machines: BrowserMachineList = defaultMachineList,
): Promise<BrowserHostCapabilityAuthorityLease> =>
  Object.freeze({
    authority: Object.freeze({
      findHost: machines.findHost,
      machineName: () => machines.hosts().find((host) => host.isThisMachine)?.id,
    }),
    close: () => undefined,
  });

/** Production barrier used by browser composition before adapter creation. */
export const prepareDefaultBrowserHostCapabilityAuthority =
  (): Promise<BrowserHostCapabilityAuthorityLease> =>
    prepareBrowserHostCapabilityAuthority();
