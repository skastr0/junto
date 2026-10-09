import { hostsSnapshot } from "../hosts/snapshot";

/** Synchronous projection of the hydrated MachineRepository name. */
export const thisMachineName = (): string => {
  const own = hostsSnapshot().find((machine) => machine.isThisMachine);
  if (own === undefined) throw new Error("Junto has not loaded this machine's name yet");
  return own.id;
};
