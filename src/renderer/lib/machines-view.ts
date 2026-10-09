import type {
  MachineHarness,
  MachineListData,
  MachineOwnStatus,
  MachinePeerStatus,
} from "@shared/machine-control";
import { resolveMachineForm, type MachineFigureState, type MachineForm } from "@shared/machine-figure";
import type { MachineInstallTransition } from "@shared/machine-install";
import { isHarnessId, templateFor } from "@shared/managed-terminal-templates";

// What the Machines window says about one machine, worked out from what the
// owner commands answered. Pure: no window, no store, so every state the
// operator can meet is a row in a test. Each line says what happened and what
// to do, never how it works inside.

/** One machine as `machine.list` answers it. */
export type MachineListItem = MachineListData["machines"][number];
export type MachineInstallStep = MachineInstallTransition["step"];
export type MachineCopyOp = "send" | "update";

/** What the window last learned by asking a machine about itself. */
export type MachineRead =
  | { readonly kind: "reading" }
  | { readonly kind: "own"; readonly status: MachineOwnStatus; readonly harnesses: ReadonlyArray<MachineHarness> }
  | { readonly kind: "peer"; readonly status: MachinePeerStatus }
  | { readonly kind: "failed"; readonly message: string };

/** A send or an update this window started, while it runs or after it failed. */
export type MachineCopy =
  | {
      readonly kind: "running";
      readonly op: MachineCopyOp;
      /** The command's id; its progress steps carry the same one. */
      readonly id: string;
      readonly steps: ReadonlyArray<MachineInstallStep>;
    }
  | {
      readonly kind: "failed";
      readonly op: MachineCopyOp;
      /** The plain reason, as the owner command said it. */
      readonly message: string;
      readonly steps: ReadonlyArray<MachineInstallStep>;
    };

/** The one state a machine is in, as the operator would name it. */
export type MachineCondition =
  | "this-machine"
  | "not-set-up"
  | "sending"
  | "updating"
  | "send-failed"
  | "update-failed"
  | "needs-update"
  | "checking"
  | "check-failed"
  | "unreachable"
  | "ready";

export const machineCondition = (
  item: MachineListItem,
  read: MachineRead | undefined,
  copy: MachineCopy | undefined,
): MachineCondition => {
  if (copy?.kind === "running") return copy.op === "send" ? "sending" : "updating";
  if (copy?.kind === "failed") return copy.op === "send" ? "send-failed" : "update-failed";
  if (item.machine.isThisMachine) return "this-machine";
  if (!item.setUp) return "not-set-up";
  // A machine on another build refuses the link, so nothing else can be read from it.
  if (item.needsUpdate) return "needs-update";
  if (read === undefined || read.kind === "reading") return "checking";
  if (read.kind === "failed") return "check-failed";
  if (read.kind === "peer" && !read.status.reachable) return "unreachable";
  return "ready";
};

export type MachineAction = "send" | "update" | "check" | "remove";

/** What the operator can do to a machine in each state, most likely first. */
export const machineActions = (condition: MachineCondition): ReadonlyArray<MachineAction> => {
  switch (condition) {
    case "this-machine":
      return ["check"];
    case "not-set-up":
    case "send-failed":
      return ["send", "remove"];
    case "needs-update":
    case "update-failed":
      return ["update", "remove"];
    case "sending":
    case "updating":
      return [];
    case "checking":
      return ["remove"];
    case "check-failed":
      return ["check", "remove"];
    case "unreachable":
      return ["check", "update", "remove"];
    case "ready":
      return ["check", "remove"];
  }
};

export const MACHINE_ACTION_LABEL: Readonly<Record<MachineAction, string>> = {
  send: "Send Junto",
  update: "Update Junto",
  check: "Check again",
  remove: "Remove",
};

/** The steps of a send, in the order they happen. */
export const MACHINE_INSTALL_STEPS: ReadonlyArray<MachineInstallStep> = [
  "verified",
  "quiescent",
  "selected",
  "started",
  "ready",
];

export const MACHINE_INSTALL_STEP_LABEL: Readonly<Record<MachineInstallStep, string>> = {
  verified: "Build checked",
  quiescent: "Old Junto stopped",
  selected: "New build in place",
  started: "Junto started",
  ready: "Junto answered",
};

/** A step joins the ones already seen, once, in the order steps happen. */
export const withInstallStep = (
  steps: ReadonlyArray<MachineInstallStep>,
  step: MachineInstallStep,
): ReadonlyArray<MachineInstallStep> =>
  steps.includes(step) ? steps : MACHINE_INSTALL_STEPS.filter((known) => known === step || steps.includes(known));

export type MachineSummary = {
  /** What happened, in one line. */
  readonly headline: string;
  /** What to do about it, when there is something to do. */
  readonly advice?: string;
};

const reason = (message: string | undefined, fallback: string): string => message?.trim() || fallback;

export const machineSummary = (
  item: MachineListItem,
  read: MachineRead | undefined,
  copy: MachineCopy | undefined,
): MachineSummary => {
  switch (machineCondition(item, read, copy)) {
    case "this-machine":
      return { headline: "This machine" };
    case "not-set-up":
      return { headline: "Added. Junto is not on it yet.", advice: "Send Junto to set it up." };
    case "sending":
      return { headline: "Sending Junto" };
    case "updating":
      return { headline: "Updating Junto" };
    case "send-failed":
      return {
        headline: "Junto could not be sent",
        advice: reason(copy?.kind === "failed" ? copy.message : undefined, "Send it again."),
      };
    case "update-failed":
      return {
        headline: "Junto could not be updated",
        advice: reason(copy?.kind === "failed" ? copy.message : undefined, "Update it again."),
      };
    case "needs-update":
      return {
        headline: "Runs a different build of Junto",
        advice: "Update it before its seats can run from this machine.",
      };
    case "checking":
      return { headline: "Checking" };
    case "check-failed":
      return {
        headline: "Could not check this machine",
        advice: reason(read?.kind === "failed" ? read.message : undefined, "Check again."),
      };
    case "unreachable":
      return {
        headline: "Cannot reach this machine",
        advice: reason(
          read?.kind === "peer" ? read.status.detail : undefined,
          "Check that it is on and that SSH reaches it.",
        ),
      };
    case "ready":
      return { headline: "Ready" };
  }
};

/** What a harness is called, falling back to its id for one this build does not know. */
export const harnessName = (harness: string): string =>
  isHarnessId(harness) ? templateFor(harness).displayName : harness;

/** The harness CLIs a machine reported, when it has been read. */
export const machineHarnesses = (read: MachineRead | undefined): ReadonlyArray<MachineHarness> | undefined => {
  if (read?.kind === "own") return read.harnesses;
  if (read?.kind === "peer" && read.status.reachable) return read.status.harnesses;
  return undefined;
};

/** Names of the secrets a machine lacks. Names only: a value never reaches the window. */
export const machineMissingSecrets = (read: MachineRead | undefined): ReadonlyArray<string> =>
  read?.kind === "peer" && read.status.reachable ? read.status.missingSecrets : [];

/** The harnesses seats placed on a machine need and it does not have. */
export const harnessesSeatsLack = (
  read: MachineRead | undefined,
  seatHarnesses: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const reported = machineHarnesses(read);
  if (reported === undefined) return [];
  const installed = new Set(reported.filter((row) => row.installed).map((row) => row.harness as string));
  return [...new Set(seatHarnesses)].filter((harness) => !installed.has(harness)).sort();
};

/** How many machines want the operator, for the window's one status line. */
export const machinesNeedingAttention = (conditions: ReadonlyArray<MachineCondition>): number =>
  conditions.filter(
    (condition) =>
      condition === "not-set-up" ||
      condition === "send-failed" ||
      condition === "update-failed" ||
      condition === "needs-update" ||
      condition === "check-failed" ||
      condition === "unreachable",
  ).length;

/** The form a machine is drawn in: the operator's choice, else what it said about itself, else its name. */
export const machineForm = (item: MachineListItem, read: MachineRead | undefined): MachineForm =>
  resolveMachineForm({
    name: item.machine.id,
    label: item.machine.label,
    isThisMachine: item.machine.isThisMachine,
    ...(item.machine.appearance?.glyph === undefined ? {} : { glyph: item.machine.appearance.glyph }),
    ...(read?.kind === "own" || read?.kind === "peer"
      ? read.status.form === undefined
        ? {}
        : { reported: read.status.form }
      : {}),
  });

/** The state the machine figure paints. It takes counts and flags, never a name or a value. */
export const machineFigureState = (
  item: MachineListItem,
  read: MachineRead | undefined,
  copy: MachineCopy | undefined,
  placed: { readonly seats: number; readonly harnesses: ReadonlyArray<string> },
): MachineFigureState => {
  const condition = machineCondition(item, read, copy);
  const answered = read?.kind === "own" || (read?.kind === "peer" && read.status.reachable);
  return {
    setUp: item.setUp,
    reach: condition === "unreachable" ? "unreachable" : answered ? "reachable" : "unknown",
    install:
      condition === "sending"
        ? "sending"
        : condition === "updating"
          ? "updating"
          : condition === "needs-update"
            ? "needs-update"
            : "idle",
    ...(copy === undefined ? {} : { step: copy.steps.length }),
    missingHarness: harnessesSeatsLack(read, placed.harnesses).length > 0,
    missingSecrets: machineMissingSecrets(read).length,
    seats: placed.seats,
  };
};
