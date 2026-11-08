import { use$ } from "@legendapp/state/react";
import { useEffect, useMemo } from "react";
import { isThisMachine } from "@shared/machine-identity";
import { isHarnessId, templateFor } from "@shared/managed-terminal-templates";
import type { RemoteHost } from "@shared/remote-hosts";
import { state$ } from "./state";

/**
 * Machines as the window knows them.
 *
 * This machine's name has one source: main puts it in settings. A seat,
 * terminal or page is on this machine when its `host` is that name; nothing
 * compares a host against a written name. The machine list adds what the
 * operator reads, a label for each machine, and which machines are set up.
 * It is absent when the machines surface is off.
 */

/** What the owner's machine list says about one machine. */
export type MachineFacts = {
  /** Junto is on it and this machine holds its identity: a seat can be placed there. */
  readonly setUp: boolean;
  /** It runs another build, and refuses this machine until it is updated. */
  readonly needsUpdate: boolean;
  /** Whether it answered when last asked. Absent until it has been asked. */
  readonly reachable?: boolean;
  /** The harnesses it said it has. Absent until it has answered. */
  readonly harnesses?: ReadonlyArray<string>;
};

/** This machine's name. Empty until settings have loaded. */
export const thisMachineName = (): string => state$.settings.machine.name.get();

export const useThisMachineName = (): string => use$(state$.settings.machine.name);

/** Whether `host` names the machine called `name`. Nothing is, before the name is known. */
export const isOnMachine = (host: string | undefined, name: string): boolean =>
  name !== "" && isThisMachine(host, name);

/** Whether `host` names the machine this window runs on. */
export const onThisMachine = (host: string | undefined): boolean =>
  isOnMachine(host, thisMachineName());

/** What the operator calls a machine: its label, else its name. */
export const machineLabelIn = (
  machines: ReadonlyArray<Pick<RemoteHost, "id" | "label">>,
  name: string,
): string => machines.find((machine) => machine.id === name)?.label.trim() || name;

export const machineLabel = (name: string): string =>
  machineLabelIn(state$.machines.get(), name);

/**
 * How a line the operator reads names a machine. "This machine" is always
 * the one the window runs on; any other is named by its label.
 */
export const machineInWords = (
  machines: ReadonlyArray<Pick<RemoteHost, "id" | "label">>,
  name: string,
  thisName: string,
): string => (isOnMachine(name, thisName) ? "this machine" : machineLabelIn(machines, name));

/**
 * The machines something new can be placed on: this machine, and every other
 * machine that is set up. A machine that was only added has no Junto on it,
 * so nothing placed there could start.
 */
export const setUpMachinesIn = (
  machines: ReadonlyArray<RemoteHost>,
  facts: Readonly<Record<string, MachineFacts>>,
): ReadonlyArray<RemoteHost> =>
  machines.filter((machine) => machine.isThisMachine || facts[machine.id]?.setUp === true);

/**
 * A machine and its label, for a picker. This machine comes first, the rest
 * by label.
 */
export type MachineChoice = { readonly id: string; readonly label: string };

export const machineChoices = (
  machines: ReadonlyArray<RemoteHost>,
  thisName: string,
): ReadonlyArray<MachineChoice> => {
  const seen = new Set<string>();
  const listed = machines.filter((machine) => {
    if (seen.has(machine.id)) return false;
    seen.add(machine.id);
    return true;
  });
  // The list may be absent; this machine can always be chosen.
  const all =
    thisName === "" || seen.has(thisName)
      ? listed.map((machine) => ({ id: machine.id, label: machine.label.trim() || machine.id }))
      : [
          { id: thisName, label: thisName },
          ...listed.map((machine) => ({ id: machine.id, label: machine.label.trim() || machine.id })),
        ];
  return [...all].sort((left, right) => {
    if (left.id === thisName) return -1;
    if (right.id === thisName) return 1;
    return left.label.localeCompare(right.label);
  });
};

/**
 * Read the machine list from the owner. A failed read keeps the last list.
 * The define identifier must wrap the import() here so a build without the
 * machines surface drops the owner command client with it.
 */
export const loadMachines = async (): Promise<ReadonlyArray<RemoteHost>> => {
  if (__JUNTO_FLEET_UI_ENABLED__) {
    try {
      const { readMachineList } = await import("./machine-list");
      await readMachineList();
    } catch {
      // The list is what the operator reads, never what the window decides on.
    }
  }
  return state$.machines.peek();
};

/** Read the list, then the machines something new can be placed on. */
export const loadSetUpMachines = async (): Promise<ReadonlyArray<RemoteHost>> => {
  await loadMachines();
  return setUpMachinesIn(state$.machines.peek(), state$.machineFacts.peek());
};

/** The machine list as last read. */
export const useMachines = (): ReadonlyArray<RemoteHost> => use$(state$.machines);

/**
 * Ask a machine whether it answers and which harnesses it has, for the seats
 * placed on it. Asked at most once in a while however many seats ask; the
 * answer lands in the machine facts.
 */
export const requestMachineCheck = (name: string): void => {
  if (!__JUNTO_FLEET_UI_ENABLED__) return;
  void import("./machine-list")
    .then(({ checkSeatMachine }) => checkSeatMachine(name))
    .catch(() => undefined);
};

/** Why a seat cannot run where it is placed, when its machine is the reason. */
export type SeatMachineState = "not-listed" | "not-set-up" | "needs-update" | "unreachable" | "harness-missing";

export type SeatMachineLine = {
  readonly state: SeatMachineState;
  /** What happened and what to do, naming the machine by its label. */
  readonly line: string;
};

/**
 * The line a seat shows when the machine it is placed on is why it cannot
 * run. Nothing for a seat on this machine, nothing before the list has been
 * read, and nothing about a harness until the machine has answered.
 */
export const seatMachineLine = (input: {
  readonly host: string;
  readonly harness: string | undefined;
  readonly thisName: string;
  readonly machines: ReadonlyArray<Pick<RemoteHost, "id" | "label">>;
  readonly facts: Readonly<Record<string, MachineFacts>>;
}): SeatMachineLine | undefined => {
  const { host, harness, thisName, machines, facts } = input;
  if (thisName === "" || isOnMachine(host, thisName) || machines.length === 0) return undefined;
  const label = machineLabelIn(machines, host);
  if (!machines.some((machine) => machine.id === host)) {
    return { state: "not-listed", line: `${label} is not one of your machines. Add it in Machines, or move this seat.` };
  }
  const known = facts[host];
  if (known === undefined) return undefined;
  if (!known.setUp) {
    return { state: "not-set-up", line: `Junto is not on ${label} yet. Send it from Machines.` };
  }
  if (known.needsUpdate) {
    return { state: "needs-update", line: `${label} runs a different build of Junto. Update it from Machines.` };
  }
  if (known.reachable === false) {
    return { state: "unreachable", line: `Cannot reach ${label}. Check that it is on.` };
  }
  if (harness !== undefined && known.harnesses !== undefined && !known.harnesses.includes(harness)) {
    const name = isHarnessId(harness) ? templateFor(harness).displayName : harness;
    return { state: "harness-missing", line: `${name} is not on ${label}. Install it there, or move this seat.` };
  }
  return undefined;
};

/** The same line for a seat card, asking the machine once the card is on screen. */
export const useSeatMachineLine = (
  host: string | undefined,
  harness: string | undefined,
): SeatMachineLine | undefined => {
  const thisName = useThisMachineName();
  const machines = useMachines();
  const facts = use$(state$.machineFacts);
  const elsewhere = host !== undefined && thisName !== "" && !isOnMachine(host, thisName);
  useEffect(() => {
    if (elsewhere && host !== undefined) requestMachineCheck(host);
  }, [elsewhere, host]);
  return useMemo(
    () => (host === undefined ? undefined : seatMachineLine({ host, harness, thisName, machines, facts })),
    [host, harness, thisName, machines, facts],
  );
};

/** The machines something new can be placed on, as last read. */
export const useSetUpMachines = (): ReadonlyArray<RemoteHost> => {
  const machines = use$(state$.machines);
  const facts = use$(state$.machineFacts);
  return useMemo(() => setUpMachinesIn(machines, facts), [machines, facts]);
};
