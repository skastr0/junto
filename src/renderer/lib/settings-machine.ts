import { observable } from "@legendapp/state";
import { use$ } from "@legendapp/state/react";
import { useMemo } from "react";
import { isValidMachineName } from "@shared/machine-identity";
import { makeThisMachine, type RemoteHost } from "@shared/remote-hosts";
import { isOnMachine, machineLabelIn, setUpMachinesIn, type MachineFacts } from "./machines";
import { state$ } from "./state";

/**
 * The machine a machine-scoped Settings page shows (docs/machines.md,
 * Harness inventory: "Settings name their machine"). One choice for the
 * window: the dropdown in such a page's head sets it, and every
 * machine-scoped page reads it. Unset, or naming a machine that has left the
 * list, it is this machine.
 */
const chosen$ = observable<string | undefined>(undefined);

/** The machine a machine-scoped Settings page shows. */
export type SettingsMachine = {
  /** The machine's short name: a seat's `host`, the key every machine command takes. Empty until settings load. */
  readonly name: string;
  /** What the operator calls it. */
  readonly label: string;
  readonly isThisMachine: boolean;
  /**
   * Whether it answered when last asked. Absent until asked; this machine
   * always answers. False means the page shows the last snapshot and its age.
   */
  readonly reachable?: boolean;
};

/** The machines a Settings page can be about: this machine, and every machine that is set up. */
export const settingsMachinesIn = (
  machines: ReadonlyArray<RemoteHost>,
  facts: Readonly<Record<string, MachineFacts>>,
  thisName: string,
): ReadonlyArray<RemoteHost> => {
  const linked = setUpMachinesIn(machines, facts);
  const own = linked.find((machine) => isOnMachine(machine.id, thisName));
  // The list may not be read yet; this machine can always be shown.
  const first = own ?? (isValidMachineName(thisName) ? makeThisMachine(thisName) : undefined);
  const rest = linked
    .filter((machine) => machine !== own)
    .sort((left, right) => machineLabelIn(linked, left.id).localeCompare(machineLabelIn(linked, right.id)));
  return first === undefined ? rest : [first, ...rest];
};

/** Which machine is shown: the one chosen while it is still listed, else this machine. */
export const settingsMachineIn = (
  chosen: string | undefined,
  machines: ReadonlyArray<RemoteHost>,
  facts: Readonly<Record<string, MachineFacts>>,
  thisName: string,
): SettingsMachine => {
  const listed = settingsMachinesIn(machines, facts, thisName);
  const machine = listed.find((row) => row.id === chosen) ?? listed[0];
  if (machine === undefined) return { name: thisName, label: thisName, isThisMachine: true };
  const own = isOnMachine(machine.id, thisName);
  const reachable = own ? true : facts[machine.id]?.reachable;
  return {
    name: machine.id,
    label: machine.label.trim() || machine.id,
    isThisMachine: own,
    ...(reachable === undefined ? {} : { reachable }),
  };
};

/** Show `name` on every machine-scoped Settings page. */
export const chooseSettingsMachine = (name: string): void => chosen$.set(name);

/** The machine shown, as of now. */
export const settingsMachine = (): SettingsMachine =>
  settingsMachineIn(chosen$.peek(), state$.machines.peek(), state$.machineFacts.peek(), state$.settings.machine.name.peek());

/** The machine shown, kept current. */
export const useSettingsMachine = (): SettingsMachine => {
  const chosen = use$(chosen$);
  const machines = use$(state$.machines);
  const facts = use$(state$.machineFacts);
  const thisName = use$(state$.settings.machine.name);
  return useMemo(() => settingsMachineIn(chosen, machines, facts, thisName), [chosen, machines, facts, thisName]);
};

/** For tests: back to this machine. */
export const forgetSettingsMachine = (): void => chosen$.set(undefined);
