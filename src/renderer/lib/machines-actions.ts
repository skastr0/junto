import { observable } from "@legendapp/state";
import type { MachineAddInput } from "@shared/machine-control";
import type { MachineCommandProgress } from "@shared/machine-progress";
import {
  machineCommand,
  newMachineCommandId,
  onMachineCommandProgress,
  type MachineCommandRefusal,
} from "./machine-commands";
import { noteMachineStatus, readMachineList } from "./machine-list";
import {
  withInstallStep,
  type MachineCopy,
  type MachineCopyOp,
  type MachineListItem,
  type MachineRead,
} from "./machines-view";

// What the Machines window knows and what it can do. Every read and every
// action is one owner machine command; the window keeps no fact of its own
// about a machine and cannot do anything a command cannot.

export const machines$ = observable({
  /** The list is being read. */
  loading: false,
  /** Why the list could not be read, in the owner's words. */
  error: "",
  items: [] as ReadonlyArray<MachineListItem>,
  /** By machine name: what it last said about itself. */
  reads: {} as Record<string, MachineRead>,
  /** By machine name: a send or an update in flight, or the one that failed. */
  copies: {} as Record<string, MachineCopy>,
});

const setRead = (name: string, read: MachineRead): void => {
  machines$.reads[name].set(read);
};

/** Ask one machine about itself. This machine also says which harnesses it has. */
export const checkMachine = async (item: MachineListItem): Promise<void> => {
  const name = item.machine.id;
  setRead(name, { kind: "reading" });
  if (item.machine.isThisMachine) {
    const [status, harnesses] = await Promise.all([
      machineCommand("machine.status", {}),
      machineCommand("machine.harnesses", {}),
    ]);
    if (!status.ok) return setRead(name, { kind: "failed", message: status.message });
    if (!harnesses.ok) return setRead(name, { kind: "failed", message: harnesses.message });
    if ("reachable" in status.data) {
      return setRead(name, { kind: "failed", message: "This machine answered as another one." });
    }
    return setRead(name, { kind: "own", status: status.data, harnesses: harnesses.data.harnesses });
  }
  const status = await machineCommand("machine.status", { name });
  if (!status.ok) return setRead(name, { kind: "failed", message: status.message });
  if (!("reachable" in status.data)) {
    return setRead(name, { kind: "failed", message: "Another machine answered in its place." });
  }
  setRead(name, { kind: "peer", status: status.data });
  // The seat cards on the canvas read the same answer.
  noteMachineStatus(name, status.data);
  // The hello may have reported another build since the list was read.
  const listed = await readMachineList();
  if (listed.ok) {
    machines$.items.set(listed.data.machines);
    // A refused build did not answer questions about its harnesses or secrets.
    if (listed.data.machines.find(row => row.machine.id === name)?.needsUpdate) machines$.reads[name].delete();
  }
};

/**
 * Read the machine list, then ask each machine that can answer. A machine
 * that is not set up, or runs another build, has no link to answer over.
 */
export const refreshMachines = async (): Promise<void> => {
  machines$.loading.set(true);
  try {
    // The pickers on the canvas read the same list, from the same read.
    const listed = await readMachineList();
    if (!listed.ok) {
      machines$.error.set(listed.message);
      return;
    }
    const items = listed.data.machines;
    machines$.error.set("");
    machines$.items.set(items);
    const names = new Set(items.map((item) => item.machine.id));
    for (const name of Object.keys(machines$.reads.peek())) {
      if (!names.has(name)) machines$.reads[name].delete();
    }
    for (const name of Object.keys(machines$.copies.peek())) {
      if (!names.has(name)) machines$.copies[name].delete();
    }
    await Promise.all(
      items
        .filter((item) => item.machine.isThisMachine || (item.setUp && !item.needsUpdate))
        .map((item) => checkMachine(item)),
    );
  } finally {
    machines$.loading.set(false);
  }
};

/** Add a machine by its name and SSH target. The refusal, when there is one, is for the form. */
export const addMachine = async (input: MachineAddInput): Promise<MachineCommandRefusal | undefined> => {
  const added = await machineCommand("machine.add", input);
  if (!added.ok) return added;
  await refreshMachines();
  return undefined;
};

/**
 * Send Junto to a machine, or update the Junto on it. One owner command:
 * main copies the build this machine runs and, on a first send, sets the
 * machine up. The window then reads the list again and shows what it says.
 */
export const copyJunto = async (name: string, op: MachineCopyOp): Promise<void> => {
  if (machines$.copies[name].peek()?.kind === "running") return;
  const id = newMachineCommandId();
  machines$.copies[name].set({ kind: "running", op, id, steps: [] });
  const answer = await machineCommand(op === "send" ? "machine.send" : "machine.update", { name }, id);
  if (!answer.ok) {
    const running = machines$.copies[name].peek();
    const seen = running?.kind === "running" ? running.steps : [];
    // What is kept is what was confirmed: the steps seen, the steps the owner
    // listed, and where it said the install left the machine. Nothing is sent
    // again from here; the operator decides.
    const confirmed = [...answer.transitions, ...(answer.installed?.transitions ?? [])];
    machines$.copies[name].set({
      kind: "failed",
      op,
      id,
      message: answer.message,
      steps: confirmed.reduce((steps, transition) => withInstallStep(steps, transition.step), seen),
      ...(running?.transfer === undefined ? {} : { transfer: running.transfer }),
      ...(answer.disposition === undefined ? {} : { disposition: answer.disposition }),
      installed: answer.installed !== undefined,
    });
    return;
  }
  machines$.copies[name].delete();
  await refreshMachines();
};

/** Forget a failed send, so the row shows the machine as it is. */
export const dismissCopy = (name: string): void => {
  if (machines$.copies[name].peek()?.kind === "failed") machines$.copies[name].delete();
};

/**
 * Check a machine again. After a send that failed or could not be confirmed,
 * that means reading the list again too: whether Junto is on the machine is
 * the list's to say, not the failed command's.
 */
export const checkMachineAgain = async (item: MachineListItem): Promise<void> => {
  if (machines$.copies[item.machine.id].peek()?.kind !== "failed") return checkMachine(item);
  dismissCopy(item.machine.id);
  await refreshMachines();
};

/** Remove a machine from this one's list. The refusal, when there is one, is for the dialog. */
export const removeMachine = async (name: string): Promise<MachineCommandRefusal | undefined> => {
  const removed = await machineCommand("machine.remove", { name });
  if (!removed.ok) return removed;
  await refreshMachines();
  return undefined;
};

/**
 * Put a step on the row of the command it belongs to. A step that arrives
 * after its command ended still confirms that step. A step for no command
 * this window started is dropped.
 */
export const applyMachineProgress = (progress: MachineCommandProgress): void => {
  for (const [name, copy] of Object.entries(machines$.copies.peek())) {
    if (copy.id !== progress.id) continue;
    if (progress.event.event === "machine-copy") {
      if (copy.kind !== "running" || copy.steps.length > 0) return;
      const prior = copy.transfer;
      if (prior && (prior.totalBytes !== progress.event.totalBytes || prior.copiedBytes > progress.event.copiedBytes || prior.state === "copied")) return;
      machines$.copies[name].set({ ...copy, transfer: progress.event });
      return;
    }
    machines$.copies[name].set({ ...copy, steps: withInstallStep(copy.steps, progress.event.step) });
    return;
  }
};

/** Follow the steps of sends in flight for as long as the window is open. */
export const followMachineProgress = (): (() => void) => onMachineCommandProgress(applyMachineProgress);
