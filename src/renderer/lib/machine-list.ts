import { machineCommand, type MachineCommandAnswer } from "./machine-commands";
import type { MachineFacts } from "./machines";
import { state$ } from "./state";

/**
 * Read the machine list from the owner, and keep what the rest of the window
 * reads from it: every machine, for its label, and which of them are set up,
 * for the pickers. One read serves the canvas and the Machines window. A
 * refused read changes nothing: the last list stands.
 *
 * This module is loaded only where the machines surface is on
 * (lib/machines.ts), so a build without it carries no owner command client.
 */
export const readMachineList = async (): Promise<MachineCommandAnswer<"machine.list">> => {
  const listed = await machineCommand("machine.list", {});
  if (!listed.ok) return listed;
  const facts: Record<string, MachineFacts> = {};
  for (const item of listed.data.machines) {
    facts[item.machine.id] = { setUp: item.setUp, needsUpdate: item.needsUpdate };
  }
  state$.machines.set(listed.data.machines.map((item) => item.machine));
  state$.machineFacts.set(facts);
  return listed;
};
