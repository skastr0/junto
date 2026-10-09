import type {
  MachineHarness,
  MachineListData,
  MachineOwnStatus,
  MachinePeerStatus,
} from "@shared/machine-control";
import { resolveMachineForm, type MachineFigureState, type MachineForm } from "@shared/machine-figure";
import type { MachineInstallError, MachineInstallTransition } from "@shared/machine-install";
import { isHarnessId, templateFor } from "@shared/managed-terminal-templates";
import { MACHINE_COPY_STALL_MS, type MachineCopyProgress } from "@shared/machine-progress";

// What the Machines window says about one machine, worked out from what the
// owner commands answered. Pure: no window, no store, so every state the
// operator can meet is a row in a test. Each line says what happened and what
// to do, never how it works inside.

/** One machine as `machine.list` answers it. */
export type MachineListItem = MachineListData["machines"][number];
export type MachineInstallStep = MachineInstallTransition["step"];
export type MachineCopyOp = "send" | "update";
/** Where a failed install left a machine, as the owner said it. */
export type MachineInstallDisposition = MachineInstallError["disposition"];

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
      readonly transfer?: MachineCopyProgress;
    }
  | {
      readonly kind: "failed";
      readonly op: MachineCopyOp;
      /** The command's id: a step that arrives late still belongs to it. */
      readonly id: string;
      /** The plain reason, as the owner command said it. */
      readonly message: string;
      /** The steps that were confirmed. One that is not here may still have happened. */
      readonly steps: ReadonlyArray<MachineInstallStep>;
      readonly transfer?: MachineCopyProgress;
      /** Where the owner said the install left the machine. Absent: it did not say. */
      readonly disposition?: MachineInstallDisposition;
      /** The install finished, and what failed came after it. */
      readonly installed: boolean;
    };

/** The one state a machine is in, as the operator would name it. */
export type MachineCondition =
  | "this-machine"
  | "not-set-up"
  | "sending"
  | "updating"
  | "send-failed"
  | "update-failed"
  | "send-unconfirmed"
  | "update-unconfirmed"
  | "sent-not-ready"
  | "updated-not-ready"
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
  if (copy?.kind === "failed") {
    const sent = copy.op === "send";
    if (copy.installed) return sent ? "sent-not-ready" : "updated-not-ready";
    // Only the owner saying the machine was left as it was makes this a plain
    // failure. Any other ending, a timeout among them, may have changed it.
    if (copy.disposition === "staged") return sent ? "send-failed" : "update-failed";
    return sent ? "send-unconfirmed" : "update-unconfirmed";
  }
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
    // Nothing is sent again unasked: the operator checks first, then decides.
    case "send-unconfirmed":
    case "sent-not-ready":
      return ["check", "send", "remove"];
    case "update-unconfirmed":
    case "updated-not-ready":
      return ["check", "update", "remove"];
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

/**
 * How one step of a send stands. `now` is the step being waited for and
 * `ahead` the ones after it. `not-reached` is said only when the owner said
 * the machine was left as it was; otherwise a step nobody confirmed is
 * `unconfirmed`, because no word of a step is not word that it did not happen.
 */
export type MachineStepPhase = "done" | "now" | "ahead" | "not-reached" | "unconfirmed" | "copying" | "stalled";

export const MACHINE_STEP_PHASE_WORD: Readonly<Record<MachineStepPhase, string>> = {
  done: "Done",
  now: "Waiting",
  ahead: "Waiting",
  "not-reached": "Not reached",
  unconfirmed: "Not confirmed",
  copying: "Copying",
  stalled: `No progress for ${MACHINE_COPY_STALL_MS / 1000} seconds`,
};

export type MachineStepLine = {
  readonly step: MachineInstallStep | "copy";
  readonly label: string;
  readonly phase: MachineStepPhase;
};

export const machineCopyStepLines = (copy: MachineCopy | undefined): ReadonlyArray<MachineStepLine> => {
  const transfer = copy?.transfer;
  if (!transfer || (copy.kind === "failed" && copy.installed)) return [];
  const scale = transfer.totalBytes >= 1_000_000 ? 1_000_000 : transfer.totalBytes >= 1_000 ? 1_000 : 1;
  const unit = scale === 1_000_000 ? "MB" : scale === 1_000 ? "KB" : "bytes";
  const amount = `${Math.round(transfer.copiedBytes / scale)} of ${Math.round(transfer.totalBytes / scale)} ${unit}`;
  return [{ step: "copy", label: transfer.state === "copied" ? `Copy, ${amount}` : amount,
    phase: transfer.state === "copied" ? "done" : copy.kind === "failed" ? "unconfirmed" : transfer.state === "stalled" ? "stalled" : "copying" }];
};

/** The steps of a send or an update, each with how it stands. None once the install itself finished. */
export const machineStepLines = (copy: MachineCopy | undefined): ReadonlyArray<MachineStepLine> => {
  if (copy === undefined || (copy.kind === "failed" && copy.installed)) return [];
  const last = MACHINE_INSTALL_STEPS.reduce((seen, step, index) => (copy.steps.includes(step) ? index : seen), -1);
  return MACHINE_INSTALL_STEPS.map((step, index) => {
    const phase: MachineStepPhase = copy.steps.includes(step)
      ? "done"
      : index < last
        ? "unconfirmed"
        : copy.kind === "running"
          ? index === last + 1
            ? "now"
            : "ahead"
          : copy.disposition === "staged"
            ? "not-reached"
            : "unconfirmed";
    return { step, label: MACHINE_INSTALL_STEP_LABEL[step], phase };
  });
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
  /** The operator has something to do here. */
  readonly needsYou: boolean;
};

const reason = (message: string | undefined, fallback: string): string => message?.trim() || fallback;

const CONDITIONS_THAT_NEED_YOU: ReadonlySet<MachineCondition> = new Set([
  "not-set-up",
  "send-failed",
  "update-failed",
  "send-unconfirmed",
  "update-unconfirmed",
  "sent-not-ready",
  "updated-not-ready",
  "needs-update",
  "check-failed",
  "unreachable",
]);

/**
 * How a line names a machine. "This machine" is always the one the window
 * runs on, so a line about any other machine says its label: a line that
 * said "this machine" about another one would send the operator to the wrong
 * computer.
 */
export const machineNamed = (item: MachineListItem): string =>
  item.machine.isThisMachine ? "this machine" : item.machine.label.trim() || item.machine.id;

/**
 * What a machine that answered still lacks for the seats placed on it: a
 * harness, a secret, or both. Such a machine is not ready, whatever its link says.
 */
const lackingLine = (
  item: MachineListItem,
  harnesses: ReadonlyArray<string>,
  secrets: ReadonlyArray<string>,
): Pick<MachineSummary, "headline" | "advice"> | undefined => {
  if (harnesses.length === 0 && secrets.length === 0) return undefined;
  const kinds = [
    harnesses.length === 0 ? undefined : harnesses.length === 1 ? "a harness" : "harnesses",
    secrets.length === 0 ? undefined : secrets.length === 1 ? "a secret" : "secrets",
  ].filter((kind): kind is string => kind !== undefined);
  const subject = kinds.join(" and ");
  const one = harnesses.length + secrets.length === 1;
  const todo = [
    harnesses.length === 0 ? undefined : `install ${harnesses.map(harnessName).join(", ")}`,
    secrets.length === 0 ? undefined : `set ${secrets.join(", ")}`,
  ]
    .filter((step): step is string => step !== undefined)
    .join(" and ");
  return {
    headline: `${subject.charAt(0).toUpperCase()}${subject.slice(1)} ${one ? "is" : "are"} missing`,
    advice: `${todo.charAt(0).toUpperCase()}${todo.slice(1)} on ${machineNamed(item)}. Its seats need ${one ? "it" : "them"}.`,
  };
};

export const machineSummary = (
  item: MachineListItem,
  read: MachineRead | undefined,
  copy: MachineCopy | undefined,
  /** The harnesses the seats placed on this machine use. */
  placed: { readonly harnesses: ReadonlyArray<string> } = { harnesses: [] },
): MachineSummary => {
  const condition = machineCondition(item, read, copy);
  const lacking =
    condition === "ready" || condition === "this-machine"
      ? lackingLine(item, harnessesSeatsLack(read, placed.harnesses), machineMissingSecrets(read))
      : undefined;
  return {
    ...conditionLine(item, read, copy, condition),
    ...lacking,
    needsYou: lacking !== undefined || CONDITIONS_THAT_NEED_YOU.has(condition),
  };
};

const conditionLine = (
  item: MachineListItem,
  read: MachineRead | undefined,
  copy: MachineCopy | undefined,
  condition: MachineCondition,
): Pick<MachineSummary, "headline" | "advice"> => {
  const said = copy?.kind === "failed" ? copy.message : undefined;
  switch (condition) {
    case "this-machine":
      return read?.kind === "failed" ? { headline: "This machine", advice: read.message } : { headline: "This machine" };
    case "not-set-up":
      return { headline: "Added. Junto is not on it yet.", advice: "Send Junto to set it up." };
    case "sending":
      return { headline: "Sending Junto" };
    case "updating":
      return { headline: "Updating Junto" };
    case "send-failed":
      return { headline: "Junto could not be sent", advice: reason(said, "Send it again.") };
    case "update-failed":
      return { headline: "Junto could not be updated", advice: reason(said, "Update it again.") };
    // The command ended without the owner saying how it left the machine.
    // Neither line says the install did not happen: it may have.
    case "send-unconfirmed":
      return {
        headline: "Could not confirm Junto was sent",
        advice: reason(said, "Check it before you send again."),
      };
    case "update-unconfirmed":
      return {
        headline: "Could not confirm Junto was updated",
        advice: reason(said, "Check it before you update again."),
      };
    case "sent-not-ready":
      return { headline: "Junto is on it, but it is not ready", advice: reason(said, "Check it again.") };
    case "updated-not-ready":
      return { headline: "Junto was updated, but it is not ready", advice: reason(said, "Check it again.") };
    case "needs-update":
      return {
        headline: "Runs a different build of Junto",
        advice: "Update it before its seats can run from this machine.",
      };
    case "checking":
      return { headline: "Checking" };
    case "check-failed":
      return {
        headline: "Could not be checked",
        advice: reason(read?.kind === "failed" ? read.message : undefined, "Check again."),
      };
    case "unreachable":
      return {
        headline: "Cannot be reached",
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
export const machinesNeedingAttention = (summaries: ReadonlyArray<MachineSummary>): number =>
  summaries.filter((summary) => summary.needsYou).length;

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
