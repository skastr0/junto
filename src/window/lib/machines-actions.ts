import { observable } from "@legendapp/state";
import type { BoatAddInput, BoatStatusData } from "@shared/boat";
import type { MachineAddInput, MachineArgsByOp } from "@shared/machine-control";
import type { MachineCommandProgress } from "@shared/machine-progress";
import { askConfirm } from "./confirm";
import { getJuntoApi } from "./junto-api";
import {
  machineCommand,
  newMachineCommandId,
  onMachineCommandProgress,
  type MachineCommandRefusal,
} from "./machine-commands";
import { noteBoatPower, noteMachineStatus, readMachineList } from "./machine-list";
import { openSettings } from "./settings-state";
import {
  withInstallStep,
  type MachineBoat,
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
  /** By machine name: a send, an update or a Boat add in flight, or the one that failed. */
  copies: {} as Record<string, MachineCopy>,
  /** What Boat last said about the account and its machines. Absent when it could not be asked. */
  boat: undefined as BoatStatusData | undefined,
  /** By machine name: the label of a Boat add this window started, until the list has it. */
  adding: {} as Record<string, string>,
  /** By machine name: a wake or a sleep this window asked for and is waiting on. */
  power: {} as Record<string, "wake" | "sleep">,
});

/**
 * What Boat said about one machine, with whether the machine list has it. A
 * wake or a sleep in flight reads as the power it is going to.
 */
export const boatMachine = (
  boat: BoatStatusData | undefined,
  power: Readonly<Record<string, "wake" | "sleep">>,
  name: string,
  listed: boolean,
): MachineBoat | undefined => {
  const view = boat?.machines.find((machine) => machine.machineName === name);
  if (view === undefined) return undefined;
  const asked = power[name];
  return { ...view, listed, ...(asked === undefined ? {} : { power: asked === "wake" ? "waking" : "falling-asleep" }) };
};

/** Only an awake Boat machine is asked about itself; any other machine always is. */
const canAsk = (name: string): boolean => {
  const view = boatMachine(machines$.boat.peek(), machines$.power.peek(), name, true);
  return view === undefined || view.unreadable === true || view.power === "awake";
};

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
 * that is not set up, or runs another build, has no link to answer over,
 * except on an explicit refresh (`recheckNeedsUpdate`) so a machine updated
 * outside this window can clear its stale flag. Never probes a machine while
 * a send or update is running on it.
 */
export const refreshMachines = async (options?: {
  readonly recheckNeedsUpdate?: boolean;
}): Promise<void> => {
  machines$.loading.set(true);
  try {
    // The pickers on the canvas read the same list, from the same read. A
    // Boat status read never wakes a machine.
    const [listed, boat] = await Promise.all([readMachineList(), machineCommand("machine.boat-status", {})]);
    const boatData = boat.ok ? boat.data : undefined;
    machines$.boat.set(boatData);
    noteBoatPower(boatData);
    if (!listed.ok) {
      machines$.error.set(listed.message);
      return;
    }
    const items = listed.data.machines;
    machines$.error.set("");
    machines$.items.set(items);
    const names = new Set(items.map((item) => item.machine.id));
    for (const name of Object.keys(machines$.adding.peek())) {
      if (names.has(name)) machines$.adding[name].delete();
    }
    // What is not answered for here: a machine no longer listed, or a
    // sleeping one, whose last answer is not what it is now.
    for (const name of Object.keys(machines$.reads.peek())) {
      if (!names.has(name) || !canAsk(name)) machines$.reads[name].delete();
    }
    const kept = new Set([...names, ...Object.keys(machines$.adding.peek())]);
    for (const name of Object.keys(machines$.copies.peek())) {
      if (!kept.has(name)) machines$.copies[name].delete();
    }
    const copies = machines$.copies.peek();
    const recheck = options?.recheckNeedsUpdate === true;
    await Promise.all(
      items
        .filter((item) => {
          const name = item.machine.id;
          if (copies[name]?.kind === "running") return false;
          if (item.machine.isThisMachine) return true;
          if (!item.setUp || !canAsk(name)) return false;
          return recheck || !item.needsUpdate;
        })
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
 *
 * When `machine.update` refuses because live seats are running there and
 * `stopRunningSeats` was not set, the in-flight copy state is cleared cleanly
 * (not turned into an error) and the refusal is returned so the caller can
 * ask the operator to confirm before re-calling with `stopRunningSeats: true`.
 */
export const copyJunto = async (
  name: string,
  op: Exclude<MachineCopyOp, "add">,
  options?: { readonly stopRunningSeats?: boolean },
): Promise<MachineCommandRefusal | undefined> => {
  if (machines$.copies[name].peek()?.kind === "running") return undefined;
  const id = newMachineCommandId();
  machines$.copies[name].set({ kind: "running", op, id, steps: [] });
  const args =
    op === "update" && options?.stopRunningSeats === true
      ? ({ name, stopRunningSeats: true } as MachineArgsByOp["machine.update"])
      : { name };
  const answer = await machineCommand(op === "send" ? "machine.send" : "machine.update", args, id);
  if (!answer.ok) {
    const needsConfirm =
      op === "update" &&
      options?.stopRunningSeats !== true &&
      ((answer.runningSeats !== undefined && answer.runningSeats > 0) || answer.runningSeatsUnknown === true);
    if (needsConfirm) {
      machines$.copies[name].delete();
      return answer;
    }
    keepFailedCopy(name, op, id, answer);
    return answer;
  }
  machines$.copies[name].delete();
  await refreshMachines();
  return undefined;
};

/**
 * Update Junto on a machine, confirming first if live seats are running on it
 * or if an older remote build could not confirm whether seats are running.
 * The count always comes from the live SSH preflight refusal, never from the
 * cached `machine.list` snapshot.
 */
export const requestMachineUpdate = async (item: MachineListItem): Promise<boolean> => {
  const name = item.machine.id;
  const label = item.machine.label.trim() || name;
  const refused = await copyJunto(name, "update");
  if (!refused) return true;
  const hasCount = refused.runningSeats !== undefined && refused.runningSeats > 0;
  if (!hasCount && refused.runningSeatsUnknown !== true) return false;
  const body = hasCount
    ? [
        `${refused.runningSeats === 1 ? "1 seat is" : `${refused.runningSeats} seats are`} running on ${label} and will stop while Junto updates.`,
      ]
    : [`Could not check whether seats are running on ${label}. Updating will stop any running seats.`];
  const confirmed = await askConfirm({
    source: "machine-update-running-seats",
    title: `Update ${label} now?`,
    body,
    confirmLabel: "Update now",
    tone: "danger",
  });
  if (!confirmed) return false;
  const retried = await copyJunto(name, "update", { stopRunningSeats: true });
  return !retried;
};

/**
 * Update every idle machine that needs an update, one by one so any running-seat
 * confirmation modal never collides with another.
 */
export const updateAllIdleMachines = async (items: ReadonlyArray<MachineListItem>): Promise<void> => {
  for (const item of items) {
    await requestMachineUpdate(item);
  }
};

const day = (when: string): string => {
  const date = new Date(when);
  return Number.isNaN(date.getTime())
    ? when
    : date.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
};

/** Ask, then remove a machine from this Mac's list. Shared by MachinesWindow and the TopBar popover. */
export const removeMachineAfterConfirm = async (
  item: MachineListItem,
  boat: MachineBoat | undefined,
): Promise<string> => {
  const label = item.machine.label.trim() || item.machine.id;
  const confirmed = await askConfirm({
    source: "machine-remove",
    title: `Remove ${label}?`,
    body: [
      `This machine stops reaching ${label}. Its seats stay on the canvas and cannot run until you add it again.`,
      boat === undefined
        ? `Junto stays installed on ${label}.`
        : `${label} stays on Boat, asleep${boat.diskKeptUntil ? `, and Boat keeps its disk until ${day(boat.diskKeptUntil)}` : ""}. Delete it on Boat to remove it there too.`,
    ],
    confirmLabel: "Remove machine",
    tone: "danger",
  });
  if (!confirmed) return "";
  const refused = await removeMachine(item.machine.id);
  return refused ? refused.message : "";
};

/** Ask, then remove the machine and delete it on Boat. */
export const deleteBoatAfterConfirm = async (item: MachineListItem, listed: boolean): Promise<string> => {
  const label = item.machine.label.trim() || item.machine.id;
  const confirmed = await askConfirm({
    source: "machine-boat-delete",
    title: `Delete ${label} on Boat?`,
    body: [
      listed
        ? `This machine stops reaching ${label}, and Boat deletes it with its disk. Its seats stay on the canvas and cannot run.`
        : `Boat deletes ${label} with its disk. It was never added to your machines.`,
      "This cannot be undone.",
    ],
    confirmLabel: "Delete on Boat",
    tone: "danger",
  });
  if (!confirmed) return "";
  const refused = await deleteBoatMachine(item.machine.id);
  return refused ? refused.message : "";
};

/** Open Settings when another machine runs a newer build than this Mac. */
export const openAppUpdates = (): void => {
  openSettings();
};

/** Keep a failed command on its row, with what the owner confirmed of it. */
const keepFailedCopy = (name: string, op: MachineCopyOp, id: string, answer: MachineCommandRefusal): void => {
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
    ...(running?.download === undefined ? {} : { download: running.download }),
    ...(running?.transfer === undefined ? {} : { transfer: running.transfer }),
    ...(answer.disposition === undefined ? {} : { disposition: answer.disposition }),
    ...(answer.ownWords === true ? { ownWords: true } : {}),
    installed: answer.installed !== undefined,
  });
};

/** Connect this machine to the operator's Boat account. The refusal, when there is one, is for the form. */
export const connectBoat = async (): Promise<MachineCommandRefusal | undefined> => {
  const connected = await machineCommand("machine.boat-connect", {});
  if (!connected.ok) return connected;
  await refreshMachines();
  return undefined;
};

/**
 * Make a machine on Boat, add it and send Junto to it: one owner command that
 * takes minutes. The machine is on the shelf from the start; the send's steps
 * arrive on it as they would for any send.
 */
export const addBoatMachine = async (input: BoatAddInput): Promise<void> => {
  const name = input.name;
  if (machines$.copies[name].peek()?.kind === "running") return;
  const id = newMachineCommandId();
  machines$.adding[name].set(input.label ?? name);
  machines$.copies[name].set({ kind: "running", op: "add", id, steps: [] });
  const answer = await machineCommand("machine.boat-add", input, id);
  if (!answer.ok) {
    keepFailedCopy(name, "add", id, answer);
    // How far it got is the list's to say.
    await refreshMachines();
    return;
  }
  machines$.copies[name].delete();
  machines$.adding[name].delete();
  await refreshMachines();
};

/** Wake a Boat machine, or put one to sleep. Resolves to the owner's refusal, or nothing. */
export const setBoatPower = async (name: string, to: "wake" | "sleep"): Promise<MachineCommandRefusal | undefined> => {
  if (machines$.power[name].peek() !== undefined) return undefined;
  machines$.power[name].set(to);
  const answer = await machineCommand(to === "wake" ? "machine.wake" : "machine.sleep", { name });
  machines$.power[name].delete();
  await refreshMachines();
  return answer.ok ? undefined : answer;
};

/** Remove a Boat machine and delete it on Boat. The refusal, when there is one, is for the dialog. */
export const deleteBoatMachine = async (name: string): Promise<MachineCommandRefusal | undefined> => {
  const deleted = await machineCommand("machine.boat-delete", { name });
  if (!deleted.ok) return deleted;
  machines$.adding[name].delete();
  dismissCopy(name);
  await refreshMachines();
  return undefined;
};

/** Forget a failed send, so the row shows the machine as it is. */
export const dismissCopy = (name: string): void => {
  if (machines$.copies[name].peek()?.kind === "failed") machines$.copies[name].delete();
};

/**
 * Check a machine again. After a send that failed or could not be confirmed,
 * that means reading the list again too: whether Junto is on the machine is
 * the list's to say, not the failed command's. When Boat is connected, refresh
 * Boat status first so a sleeping Boat machine is not dialed as unreachable.
 */
export const checkMachineAgain = async (item: MachineListItem): Promise<void> => {
  const name = item.machine.id;
  if (machines$.copies[name].peek()?.kind === "failed") {
    dismissCopy(name);
    machines$.adding[name].delete();
    await refreshMachines({ recheckNeedsUpdate: true });
    return;
  }
  if (machines$.boat.peek() !== undefined) {
    const boat = await machineCommand("machine.boat-status", {});
    const boatData = boat.ok ? boat.data : undefined;
    machines$.boat.set(boatData);
    noteBoatPower(boatData);
  }
  if (!canAsk(name)) {
    await refreshMachines();
    return;
  }
  await checkMachine(item);
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
    if (progress.event.event === "machine-download") {
      // The download comes first: once a byte is copied or a step is seen it is over.
      if (copy.kind !== "running" || copy.steps.length > 0 || copy.transfer !== undefined) return;
      const prior = copy.download;
      if (prior && (prior.totalBytes !== progress.event.totalBytes || prior.downloadedBytes > progress.event.downloadedBytes || prior.state === "downloaded")) return;
      machines$.copies[name].set({ ...copy, download: progress.event });
      return;
    }
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

let machineWatchers = 0;
let stopMachineWatch: (() => void) | undefined;

/**
 * Keep `machines$` alive in the background: one initial read, progress steps
 * for in-flight copies even after the Machines window closes, and live push
 * refreshes whenever main reports a machine state change or core restart.
 */
export const followMachines = (): (() => void) => {
  machineWatchers += 1;
  if (machineWatchers === 1) {
    const cleanups: Array<() => void> = [];
    cleanups.push(followMachineProgress());
    const api = getJuntoApi();
    const onChanged = api?.onMachinesChanged;
    if (typeof onChanged === "function") {
      cleanups.push(onChanged(() => { void refreshMachines(); }));
    }
    if (typeof api?.onCoreRestarted === "function") {
      cleanups.push(api.onCoreRestarted(() => { void refreshMachines(); }));
    }
    if (machines$.items.peek().length === 0 && !machines$.loading.peek()) {
      void refreshMachines();
    }
    stopMachineWatch = () => {
      for (const cleanup of cleanups) cleanup();
      stopMachineWatch = undefined;
    };
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    machineWatchers = Math.max(0, machineWatchers - 1);
    if (machineWatchers === 0) stopMachineWatch?.();
  };
};
