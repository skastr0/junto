import { use$ } from "@legendapp/state/react";
import { isThisMachine } from "@shared/machine-identity";
import type { RemoteHost } from "@shared/remote-hosts";
import { getJuntoApi } from "./junto-api";
import { state$ } from "./state";

/**
 * Machines as the window knows them.
 *
 * This machine's name has one source: main puts it in settings. A seat,
 * terminal or page is on this machine when its `host` is that name; nothing
 * compares a host against a written name. The machine list adds what the
 * operator reads, a label for each machine, and is absent when the machines
 * surface is off.
 */

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

/** Read the machine list from main. A failed read keeps the last list. */
export const loadMachines = async (): Promise<ReadonlyArray<RemoteHost>> => {
  try {
    const result = await getJuntoApi()?.hostsList?.();
    if (result?.ok && Array.isArray(result.hosts)) state$.machines.set([...result.hosts]);
  } catch {
    // The list is what the operator reads, never what the window decides on.
  }
  return state$.machines.peek();
};

/** The machine list, read again whenever the caller mounts. */
export const useMachines = (): ReadonlyArray<RemoteHost> => use$(state$.machines);
