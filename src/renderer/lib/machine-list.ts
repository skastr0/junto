import type { MachinePeerStatus } from "@shared/machine-control";
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
  const before = state$.machineFacts.peek();
  const facts: Record<string, MachineFacts> = {};
  for (const item of listed.data.machines) {
    const name = item.machine.id;
    // What a machine said about itself stands only while it can still say it.
    const answered = item.setUp && !item.needsUpdate ? before[name] : undefined;
    facts[name] = {
      setUp: item.setUp,
      needsUpdate: item.needsUpdate,
      ...(answered?.reachable === undefined ? {} : { reachable: answered.reachable }),
      ...(answered?.harnesses === undefined ? {} : { harnesses: answered.harnesses }),
    };
  }
  state$.machines.set(listed.data.machines.map((item) => item.machine));
  state$.machineFacts.set(facts);
  return listed;
};

/** Keep what another machine said when it was asked about itself. */
export const noteMachineStatus = (name: string, status: MachinePeerStatus): void => {
  const known = state$.machineFacts[name].peek();
  if (known === undefined) return;
  state$.machineFacts[name].set({
    setUp: known.setUp,
    needsUpdate: known.needsUpdate,
    reachable: status.reachable,
    // A machine that did not answer said nothing about its harnesses.
    ...(status.reachable
      ? { harnesses: status.harnesses.filter((row) => row.installed).map((row) => row.harness as string) }
      : {}),
  });
};

/** How long an answer stands before a seat card may ask again. */
const ASK_AGAIN_AFTER_MS = 30_000;
let listRead: { readonly at: number; readonly done: Promise<unknown> } | undefined;
const asked = new Map<string, number>();

/** For tests: forget when anything was last asked. */
export const forgetMachineChecks = (): void => {
  listRead = undefined;
  asked.clear();
};

/**
 * Ask one machine about itself for the seats placed on it. Every seat card on
 * that machine calls this; the list is read once and the machine asked once
 * in a while, whatever the number of cards. A machine that is not set up, or
 * runs another build, has no link to answer over and is not asked.
 */
export const checkSeatMachine = async (name: string, now: number = Date.now()): Promise<void> => {
  if (listRead === undefined || now - listRead.at >= ASK_AGAIN_AFTER_MS) {
    listRead = { at: now, done: readMachineList() };
  }
  await listRead.done;
  const known = state$.machineFacts[name].peek();
  const machine = state$.machines.peek().find((row) => row.id === name);
  if (known === undefined || machine === undefined || machine.isThisMachine) return;
  if (!known.setUp || known.needsUpdate) return;
  const last = asked.get(name);
  if (last !== undefined && now - last < ASK_AGAIN_AFTER_MS) return;
  asked.set(name, now);
  const status = await machineCommand("machine.status", { name });
  // A refused question says nothing about the machine: the facts stay as they were.
  if (status.ok && "reachable" in status.data) noteMachineStatus(name, status.data);
};
