import { makeThisMachine, type RemoteHost } from "../../src/shared/remote-hosts";
import { setHostsSnapshot } from "../../src/main/junto/hosts/snapshot";
import { THIS_MACHINE } from "./machines";

/**
 * Put this machine's own row in the machine list, as hydration does at boot.
 * Main-process code that asks which machine this is refuses until the row is
 * there. Pass the other machines a test needs after it.
 */
export const seedThisMachine = (others: ReadonlyArray<RemoteHost> = []): void => {
  setHostsSnapshot([makeThisMachine(THIS_MACHINE), ...others]);
};

/** The machine list before hydration: no machine is known. */
export const clearMachines = (): void => {
  setHostsSnapshot([]);
};
