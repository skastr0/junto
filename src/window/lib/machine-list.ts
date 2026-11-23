import type { BoatStatusData } from "@shared/boat";
import type { MachinePeerStatus } from "@shared/machine-control";
import { machineCommand, type MachineCommandAnswer } from "./machine-commands";
import type { MachineFacts } from "./machines";
import { state$ } from "./state";

type MachineListItemOptionalFields = {
  readonly setupState?: MachineFacts["setupState"];
  readonly updateDirection?: MachineFacts["updateDirection"];
};

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
    const extra = item as typeof item & MachineListItemOptionalFields;
    // What a machine said about itself stands only while it can still say it.
    const answered = item.setUp && !item.needsUpdate ? before[name] : undefined;
    facts[name] = {
      setUp: item.setUp,
      needsUpdate: item.needsUpdate,
      ...(extra.setupState === undefined ? {} : { setupState: extra.setupState }),
      ...(extra.updateDirection === undefined ? {} : { updateDirection: extra.updateDirection }),
      ...(before[name]?.asleep === undefined ? {} : { asleep: before[name].asleep }),
      ...(answered?.reachable === undefined ? {} : { reachable: answered.reachable }),
      ...(answered?.harnesses === undefined ? {} : { harnesses: answered.harnesses }),
    };
  }
  state$.machines.set(listed.data.machines.map((item) => item.machine));
  state$.machineFacts.set(facts);
  return listed;
};

/** Keep Boat's asleep state in the canvas machine facts so sleeping seats never read unreachable. */
export const noteBoatPower = (boat: BoatStatusData | undefined): void => {
  const asleepByName = new Map<string, boolean>();
  for (const view of boat?.machines ?? []) {
    if (!view.unreadable) asleepByName.set(view.machineName, view.power === "asleep");
  }
  const current = state$.machineFacts.peek();
  let changed = false;
  const next: Record<string, MachineFacts> = {};
  for (const [name, facts] of Object.entries(current)) {
    const asleep = asleepByName.get(name);
    if ((facts.asleep ?? false) !== (asleep ?? false) || (asleep === undefined && facts.asleep !== undefined)) {
      changed = true;
    }
    const { asleep: _prev, ...rest } = facts;
    next[name] = asleep ? { ...rest, asleep: true } : rest;
  }
  if (changed) state$.machineFacts.set(next);
};

/** Keep what another machine said when it was asked about itself. */
export const noteMachineStatus = (name: string, status: MachinePeerStatus): void => {
  const known = state$.machineFacts[name].peek();
  if (known === undefined) return;
  state$.machineFacts[name].set({
    setUp: known.setUp,
    needsUpdate: known.needsUpdate,
    ...(known.setupState === undefined ? {} : { setupState: known.setupState }),
    ...(known.updateDirection === undefined ? {} : { updateDirection: known.updateDirection }),
    ...(known.asleep === undefined ? {} : { asleep: known.asleep }),
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
  if (status.ok && "reachable" in status.data) {
    noteMachineStatus(name, status.data);
    // A refused build was still a checked hello. Read its current update flag.
    await readMachineList();
  }
};
