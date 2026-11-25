import type {
  MachineHarness,
  MachineListData,
  MachineOwnStatus,
  MachinePeerStatus,
} from "@shared/machine-control";
import type { BoatStatusData } from "@shared/boat";
import { resolveMachineForm, type MachineFigureState, type MachineForm } from "@shared/machine-figure";
import type { MachineInstallError, MachineInstallTransition } from "@shared/machine-install";
import { isHarnessId, templateFor } from "@shared/managed-terminal-templates";
import { MACHINE_COPY_STALL_MS, type MachineCopyProgress, type MachineDownloadProgress } from "@shared/machine-progress";
import { compareView, MachineRowUrgency, type ViewGroup } from "@shared/wire/urgency";

// What the Machines window says about one machine, worked out from what the
// owner commands answered. Pure: no window, no store, so every state the
// operator can meet is a row in a test. Each line says what happened and what
// to do, never how it works inside.

/** Three-state setup fact when reported by the owner's machine list. */
export type MachineSetupState = "not-installed" | "installed-not-linked" | "set-up";
/** Which side runs the older build when two Junto builds differ. */
export type MachineUpdateDirection = "peer-older" | "this-older" | "different";

/** One machine as `machine.list` answers it. */
export type MachineListItem = MachineListData["machines"][number] & {
  readonly setupState?: MachineSetupState;
  readonly updateDirection?: MachineUpdateDirection;
  readonly peerVersion?: string;
  readonly peerBuiltAt?: string;
  readonly runningSeats?: number;
  readonly runningSeatsAt?: string;
};
export type MachineInstallStep = MachineInstallTransition["step"];
/** A send, an update, or a Boat add: making the machine on Boat, then its send. */
export type MachineCopyOp = "send" | "update" | "add";

/**
 * A Boat machine as `machine.boat-status` answered it. `listed` is false for
 * one Boat made that never reached the machine list.
 */
export type MachineBoat = BoatStatusData["machines"][number] & { readonly listed: boolean };
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
      /** This build's bundle being fetched, before anything is copied. */
      readonly download?: MachineDownloadProgress;
      readonly transfer?: MachineCopyProgress;
    }
  | {
      readonly kind: "failed";
      readonly op: MachineCopyOp;
      /** The command's id: a step that arrives late still belongs to it. */
      readonly id: string;
      /** The plain reason, as the owner command said it. */
      readonly message: string;
      /** The message is the core's own fixed words, so a failed row may show it as the reason. */
      readonly ownWords?: true;
      /** The steps that were confirmed. One that is not here may still have happened. */
      readonly steps: ReadonlyArray<MachineInstallStep>;
      /** This build's bundle being fetched, before anything is copied. */
      readonly download?: MachineDownloadProgress;
      readonly transfer?: MachineCopyProgress;
      /** Where the owner said the install left the machine. Absent: it did not say. */
      readonly disposition?: MachineInstallDisposition;
      /** The install finished, and what failed came after it. */
      readonly installed: boolean;
    };

/** The one state a machine is in, as the operator would name it. */
export type MachineCondition =
  | "this-machine"
  | "adding"
  | "add-failed"
  | "boat-unfinished"
  | "asleep"
  | "waking"
  | "falling-asleep"
  | "boat-failed"
  | "gone"
  | "not-set-up"
  | "installed-not-linked"
  | "sending"
  | "updating"
  | "send-failed"
  | "update-failed"
  | "update-stopped"
  | "send-unconfirmed"
  | "update-unconfirmed"
  | "sent-not-ready"
  | "updated-not-ready"
  | "needs-update"
  | "peer-newer"
  | "checking"
  | "check-failed"
  | "unreachable"
  | "ready";

export const machineCondition = (
  item: MachineListItem,
  read: MachineRead | undefined,
  copy: MachineCopy | undefined,
  boat?: MachineBoat,
): MachineCondition => {
  if (copy?.kind === "running") return copy.op === "add" ? "adding" : copy.op === "send" ? "sending" : "updating";
  if (copy?.kind === "failed") {
    if (copy.op === "add") return "add-failed";
    const sent = copy.op === "send";
    if (copy.installed) return sent ? "sent-not-ready" : "updated-not-ready";
    // Only the owner saying the machine was left as it was makes this a plain
    // failure. An update that already stopped the old Junto (`activated`) leaves
    // nothing running there and needs a reinstall. Any other ending may have changed it.
    if (copy.disposition === "staged") return sent ? "send-failed" : "update-failed";
    if (!sent && copy.disposition === "activated") return "update-stopped";
    return sent ? "send-unconfirmed" : "update-unconfirmed";
  }
  if (item.machine.isThisMachine) return "this-machine";
  // Boat could not be asked about it: its power is not known, so it is not said.
  const power = boat === undefined || boat.unreadable ? undefined : boat.power;
  if (power === "gone") return "gone";
  if (power === "failed") return "boat-failed";
  if (boat !== undefined && !boat.listed) return "boat-unfinished";
  if (!item.setUp) return item.setupState === "installed-not-linked" ? "installed-not-linked" : "not-set-up";
  // A machine on another build refuses the link, so nothing else can be read from it.
  if (item.needsUpdate) return item.updateDirection === "this-older" ? "peer-newer" : "needs-update";
  // A sleeping machine is not asked anything: asking would be refused, never a fault.
  if (power === "asleep") return "asleep";
  if (power === "waking") return "waking";
  if (power === "falling-asleep") return "falling-asleep";
  if (read === undefined || read.kind === "reading") return "checking";
  if (read.kind === "failed") return "check-failed";
  if (read.kind === "peer" && !read.status.reachable) return "unreachable";
  return "ready";
};

export type MachineAction =
  | "send"
  | "update"
  | "check"
  | "check-updates"
  | "wake"
  | "sleep"
  | "finish"
  | "remove"
  | "delete";

/** Conditions in which a Boat machine that is awake can be put to sleep. */
const CAN_SLEEP: ReadonlySet<MachineCondition> = new Set([
  "ready",
  "check-failed",
  "unreachable",
  "needs-update",
  "peer-newer",
  "not-set-up",
  "installed-not-linked",
]);

/**
 * What the operator can do to a machine in each state, most likely first. A
 * Boat machine can also be put to sleep while awake, and deleted on Boat.
 */
export const machineActions = (
  condition: MachineCondition,
  boat?: MachineBoat,
  /** False for a machine only this window or Boat knows of: there is nothing to remove yet, only Boat's to delete. */
  listed = true,
): ReadonlyArray<MachineAction> => {
  const actions = conditionActions(condition);
  if (!listed) {
    const kept = actions.filter((action) => action !== "remove");
    if (boat === undefined || condition === "adding") return kept;
    return [...kept, ...(condition === "add-failed" ? (["finish"] as const) : []), "delete"];
  }
  if (boat === undefined || condition === "adding" || condition === "gone") return actions;
  const sleep = boat.power === "awake" && !boat.unreadable && CAN_SLEEP.has(condition) ? (["sleep"] as const) : [];
  return [...actions.filter((action) => action !== "remove"), ...sleep, "remove", "delete"];
};

const conditionActions = (condition: MachineCondition): ReadonlyArray<MachineAction> => {
  switch (condition) {
    case "this-machine":
      return ["check"];
    case "adding":
      return [];
    case "add-failed":
      return ["check", "remove"];
    case "boat-unfinished":
      return ["finish"];
    case "asleep":
      return ["wake", "remove"];
    case "waking":
    case "falling-asleep":
    case "boat-failed":
    case "gone":
      return ["remove"];
    case "not-set-up":
    case "installed-not-linked":
    case "send-failed":
      return ["send", "remove"];
    case "needs-update":
    case "update-failed":
      return ["update", "remove"];
    case "update-stopped":
      return ["update", "check", "remove"];
    case "peer-newer":
      return ["check-updates", "check", "remove"];
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
  "check-updates": "Check for updates",
  wake: "Wake",
  sleep: "Put to sleep",
  finish: "Finish adding",
  remove: "Remove",
  delete: "Delete on Boat",
};

/** Context-specific label for an action when a condition calls for clearer wording. */
export const machineActionLabel = (action: MachineAction, condition: MachineCondition): string => {
  if (action === "send" && condition === "installed-not-linked") return "Reconnect";
  if (action === "update" && condition === "update-stopped") return "Reinstall Junto";
  if (action === "update" && condition === "update-failed") return "Try update again";
  return MACHINE_ACTION_LABEL[action];
};

/** The steps of a send, in the order they happen. */
export const MACHINE_INSTALL_STEPS: ReadonlyArray<MachineInstallStep> = [
  "verified",
  "quiescent",
  "selected",
  "started",
  "ready",
];

export const MACHINE_INSTALL_STEP_LABEL: Readonly<Record<MachineInstallStep, { readonly upcoming: string; readonly done: string }>> = {
  verified: { upcoming: "Check the build", done: "Build checked" },
  quiescent: { upcoming: "Stop the old Junto", done: "Old Junto stopped" },
  selected: { upcoming: "Put the new build in place", done: "New build in place" },
  started: { upcoming: "Start Junto", done: "Junto started" },
  ready: { upcoming: "Junto answers", done: "Junto answered" },
  // The sender's own sixth step on a send, never an update (remote-design, c65fe82c8); remote-window shows it.
  pinned: { upcoming: "Trust this machine", done: "Trusts this machine" },
};

/**
 * How one step of a send stands. `now` is the step being waited for and
 * `ahead` the ones after it. `not-reached` is said only when the owner said
 * the machine was left as it was; otherwise a step nobody confirmed is
 * `unconfirmed`, because no word of a step is not word that it did not happen.
 */
export type MachineStepPhase = "done" | "now" | "ahead" | "not-reached" | "unconfirmed" | "downloading" | "copying" | "stalled";

export const MACHINE_STEP_PHASE_WORD: Readonly<Record<MachineStepPhase, string>> = {
  done: "Done",
  now: "",
  ahead: "",
  "not-reached": "",
  unconfirmed: "Not confirmed",
  downloading: "Downloading",
  copying: "Copying",
  stalled: `No progress for ${MACHINE_COPY_STALL_MS / 1000} seconds`,
};

export type MachineStepLine = {
  readonly step: MachineInstallStep | "download" | "copy";
  readonly label: string;
  readonly phase: MachineStepPhase;
};

const byteAmount = (bytes: number, totalBytes: number): string => {
  const scale = totalBytes >= 1_000_000 ? 1_000_000 : totalBytes >= 1_000 ? 1_000 : 1;
  const unit = scale === 1_000_000 ? "MB" : scale === 1_000 ? "KB" : "bytes";
  return `${Math.round(bytes / scale)} of ${Math.round(totalBytes / scale)} ${unit}`;
};

/**
 * The fetch of this build's bundle, its own step ahead of the copy. A
 * download that did not finish left the machine as it was, so after a failure
 * it reads as not reached, never as unconfirmed.
 */
export const machineDownloadStepLines = (copy: MachineCopy | undefined): ReadonlyArray<MachineStepLine> => {
  const download = copy?.download;
  if (!download || (copy.kind === "failed" && copy.installed)) return [];
  const amount = byteAmount(download.downloadedBytes, download.totalBytes);
  const settled = download.state === "downloaded" || copy.kind === "failed";
  return [{ step: "download", label: settled ? `Download, ${amount}` : amount,
    phase: download.state === "downloaded" ? "done" : copy.kind === "failed" ? "not-reached" : download.state === "stalled" ? "stalled" : "downloading" }];
};

export const machineCopyStepLines = (copy: MachineCopy | undefined): ReadonlyArray<MachineStepLine> => {
  const transfer = copy?.transfer;
  if (!transfer || (copy.kind === "failed" && copy.installed)) return [];
  const amount = byteAmount(transfer.copiedBytes, transfer.totalBytes);
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
    return { step, label: MACHINE_INSTALL_STEP_LABEL[step][phase === "done" ? "done" : "upcoming"], phase };
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

/** Failed-copy states that may show the core's own reason under their fixed sentence. */
const FAILED_COPY_CONDITIONS: ReadonlySet<MachineCondition> = new Set([
  "add-failed",
  "send-failed",
  "update-failed",
  "update-stopped",
  "send-unconfirmed",
  "update-unconfirmed",
  "sent-not-ready",
  "updated-not-ready",
]);

/**
 * Core's own fixed sentence as a failed row shows it: first letter raised and
 * a period added when missing. Only a message the core marked as its own is
 * shown; an unmarked message may carry stderr, a path or a peer's words.
 */
const ownWordsReason = (copy: MachineCopy | undefined, condition: MachineCondition): string | undefined => {
  if (copy?.kind !== "failed" || copy.ownWords !== true || !FAILED_COPY_CONDITIONS.has(condition)) return undefined;
  const words = copy.message.trim();
  if (words === "") return undefined;
  const raised = `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
  return /[.!?]$/u.test(raised) ? raised : `${raised}.`;
};

const CONDITIONS_THAT_NEED_YOU: ReadonlySet<MachineCondition> = new Set([
  "add-failed",
  "boat-unfinished",
  "boat-failed",
  "gone",
  "not-set-up",
  "installed-not-linked",
  "send-failed",
  "update-failed",
  "update-stopped",
  "send-unconfirmed",
  "update-unconfirmed",
  "sent-not-ready",
  "updated-not-ready",
  "needs-update",
  "peer-newer",
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

const keychainBlockedLine = (
  item: MachineListItem,
  blocked: ReadonlyArray<string>,
): Pick<MachineSummary, "headline" | "advice"> | undefined => {
  if (blocked.length === 0) return undefined;
  const names = blocked.map(harnessName).join(", ");
  const owner = item.machine.isThisMachine ? "this Mac's" : `${machineNamed(item)}'s Mac`;
  const verb = blocked.length === 1 ? "uses" : "use";
  return {
    headline: "Sign-in is blocked",
    advice: `${names} ${verb} ${owner} keychain, which stays locked until someone signs in at its screen. Sign in there, then restart Junto.`,
  };
};

export const machineSummary = (
  item: MachineListItem,
  read: MachineRead | undefined,
  copy: MachineCopy | undefined,
  /** The harnesses the seats placed on this machine use. */
  placed: { readonly harnesses: ReadonlyArray<string> } = { harnesses: [] },
  boat?: MachineBoat,
): MachineSummary => {
  const condition = machineCondition(item, read, copy, boat);
  const lacking =
    condition === "ready" || condition === "this-machine"
      ? lackingLine(item, harnessesSeatsLack(read, placed.harnesses), machineMissingSecrets(read))
      : undefined;
  const keychain =
    lacking === undefined && (condition === "ready" || condition === "this-machine")
      ? keychainBlockedLine(item, harnessesKeychainBlocked(read, placed.harnesses))
      : undefined;
  return {
    ...conditionLine(item, read, copy, condition),
    ...lacking,
    ...keychain,
    needsYou: lacking !== undefined || keychain !== undefined || CONDITIONS_THAT_NEED_YOU.has(condition),
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
    // Boat says nothing while it makes and wakes the machine; the send's first step ends that.
    case "adding":
      return copy?.kind === "running" && copy.steps.length === 0 && copy.download === undefined && copy.transfer === undefined
        ? { headline: "Making it on Boat" }
        : { headline: "Sending Junto", advice: "This takes a few minutes." };
    case "add-failed":
      return { headline: "Could not finish adding it on Boat", advice: reason(said, "Check it, then add it again or remove it.") };
    case "boat-unfinished":
      return { headline: "Made on Boat, not added yet", advice: "Finish adding it to send Junto to it." };
    case "asleep":
      return {
        headline: "Asleep",
        advice: "It wakes for work: a seat starting on it, or mail for one of its seats. Wake it to check it now.",
      };
    case "waking":
      return { headline: "Waking" };
    case "falling-asleep":
      return { headline: "Going to sleep" };
    case "boat-failed":
      return { headline: "Boat says it failed", advice: "Delete it on Boat, or remove it." };
    case "gone":
      return { headline: "No longer on Boat", advice: "Remove it from your machines." };
    case "not-set-up":
      return { headline: "Added. Junto is not on it yet.", advice: "Send Junto to set it up." };
    case "installed-not-linked":
      return {
        headline: "Not connected to this machine",
        advice: "Junto is already installed there. Reconnect and update it to run its seats.",
      };
    case "sending":
      return { headline: "Sending Junto" };
    case "updating":
      return { headline: "Updating Junto" };
    case "send-failed":
      return { headline: "Junto could not be sent", advice: reason(said, "Send it again.") };
    case "update-failed":
      return { headline: "Junto could not be updated", advice: reason(said, "Update it again.") };
    case "update-stopped":
      return {
        headline: "Junto stopped",
        advice: reason(said, "The update could not start, so nothing is running there right now. Reinstall Junto."),
      };
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
    case "peer-newer":
      return {
        headline: "Runs a newer build of Junto",
        advice: "Update Junto on this machine to connect to it.",
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

const keychainLine = (remoteLabel?: string): string =>
  remoteLabel?.trim()
    ? `A sign-in kept in ${remoteLabel.trim()}'s Mac keychain cannot be used while its desktop is locked. Sign in at its screen, then restart Junto.`
    : "A sign-in kept in this Mac's keychain cannot be used here. Log in to its desktop, then update Junto.";

/**
 * What the window says about an installed harness's sign-in, or nothing.
 * Junto reads no credential and launches no harness to find out, so no line
 * ever says signed in or signed out.
 */
export const harnessSignInLine = (row: MachineHarness, remoteLabel?: string): string | undefined => {
  if (!row.installed) return undefined;
  if (row.signIn === "sign-in-unverified") return "Sign-in not checked";
  if (row.signIn === "keychain-login-unavailable") return keychainLine(remoteLabel);
  return undefined;
};

/** Where one harness stands on a machine, as far as Junto can tell without launching it. */
export type HarnessState = "found" | "unverified" | "keychain" | "missing";

export const harnessState = (row: MachineHarness): HarnessState =>
  !row.installed
    ? "missing"
    : row.signIn === "keychain-login-unavailable"
      ? "keychain"
      : row.signIn === "sign-in-unverified"
        ? "unverified"
        : "found";

/** Below this many harnesses in one state, each keeps a line of its own. */
const HARNESS_GROUP_MIN = 3;

/**
 * A machine's harnesses as the window lists them: the state most of them
 * share said once, with their names, and a line of its own for each one
 * whose state differs. With no state shared widely enough, every one is apart.
 */
export type MachineHarnessGroups = {
  readonly shared?: { readonly state: HarnessState; readonly line: string; readonly harnesses: ReadonlyArray<MachineHarness> };
  readonly apart: ReadonlyArray<MachineHarness>;
};

const sharedLine = (state: HarnessState, count: number, total: number, remoteLabel?: string): string => {
  const many = count === total ? `All ${count}` : `${count}`;
  switch (state) {
    case "found":
      return `${many} found`;
    case "unverified":
      return `${many} found. Sign-in not checked`;
    case "keychain":
      return `${many} found. ${keychainLine(remoteLabel)}`;
    case "missing":
      return `${many} not found`;
  }
};

export const machineHarnessGroups = (
  rows: ReadonlyArray<MachineHarness>,
  remoteLabel?: string,
): MachineHarnessGroups => {
  const byState = new Map<HarnessState, MachineHarness[]>();
  for (const row of rows) byState.set(harnessState(row), [...(byState.get(harnessState(row)) ?? []), row]);
  // The largest group; on a tie, the one met first.
  const [state, members] = [...byState].reduce<[HarnessState, MachineHarness[]] | undefined>(
    (best, next) => (best === undefined || next[1].length > best[1].length ? next : best),
    undefined,
  ) ?? ["found", []];
  if (members.length < HARNESS_GROUP_MIN) return { apart: rows };
  return {
    shared: { state, line: sharedLine(state, members.length, rows.length, remoteLabel), harnesses: members },
    apart: rows.filter((row) => harnessState(row) !== state),
  };
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

/** The harnesses seats placed on a machine use whose Mac keychain sign-in is locked. */
export const harnessesKeychainBlocked = (
  read: MachineRead | undefined,
  seatHarnesses: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const reported = machineHarnesses(read);
  if (reported === undefined) return [];
  const blocked = new Set(
    reported
      .filter((row) => row.installed && row.signIn === "keychain-login-unavailable")
      .map((row) => row.harness as string),
  );
  return [...new Set(seatHarnesses)].filter((harness) => blocked.has(harness)).sort();
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
  boat?: MachineBoat,
): MachineFigureState => {
  const condition = machineCondition(item, read, copy, boat);
  const answered = read?.kind === "own" || (read?.kind === "peer" && read.status.reachable);
  return {
    setUp: item.setUp,
    reach: condition === "unreachable" ? "unreachable" : answered ? "reachable" : "unknown",
    install:
      condition === "sending" || condition === "adding"
        ? "sending"
        : condition === "updating"
          ? "updating"
          : condition === "needs-update" || condition === "peer-newer"
            ? "needs-update"
            : "idle",
    ...(copy === undefined ? {} : { step: copy.steps.length }),
    missingHarness: harnessesSeatsLack(read, placed.harnesses).length > 0,
    missingSecrets: machineMissingSecrets(read).length,
    seats: placed.seats,
  };
};

const clockTime = (iso: string | undefined): string | undefined => {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

const hhmm = (iso: string | undefined): string => {
  const time = clockTime(iso);
  return time ? ` (${time})` : "";
};

/**
 * Passive display line for running seats on a remote machine, taken from
 * `machine.list` (`runningSeats`, `runningSeatsAt`). Never used for the update
 * confirm count, which comes from the live SSH preflight.
 */
export const runningSeatsLine = (item: MachineListItem): string | undefined => {
  const count = item.runningSeats;
  if (count === undefined || count <= 0) return undefined;
  const label = item.machine.label.trim() || item.machine.id;
  return `${count} of your seats ${count === 1 ? "runs" : "run"} on ${label}${hhmm(item.runningSeatsAt)}`;
};

export type MachinesBarSeverity = "quiet" | "working" | "amber" | "crimson";
export type MachinesBarRowSeverity = ViewGroup<typeof MachineRowUrgency>;

export type MachinesBarRowAction = {
  readonly kind: "send" | "update" | "check" | "finish" | "check-updates" | "remove" | "delete";
  readonly label: string;
  readonly pendingLabel?: string;
  readonly danger: boolean;
  /** Label shown while armed for two-press destructive actions. */
  readonly armedLabel?: string;
};

export type MachinesBarRow = {
  readonly id: string;
  readonly label: string;
  readonly severity: MachinesBarRowSeverity;
  readonly status: string;
  /** Core's own fixed reason, on a failed command's row, when the core marked it. */
  readonly reason?: string;
  readonly action?: MachinesBarRowAction;
  readonly condition: MachineCondition;
  readonly listed: boolean;
};

export type MachinesBarEntry = {
  readonly item: MachineListItem;
  readonly listed: boolean;
  readonly read: MachineRead | undefined;
  readonly copy: MachineCopy | undefined;
  readonly boat: MachineBoat | undefined;
  readonly placed: { readonly seats: number; readonly harnesses: ReadonlyArray<string> };
};

export type MachinesBarSummary = {
  readonly severity: MachinesBarSeverity;
  readonly brokenCount: number;
  readonly needsYouCount: number;
  readonly workingCount: number;
  /** Broken + needs-you count; working and sleeping Boat machines are never counted. */
  readonly count: number;
  readonly ariaLabel: string;
  readonly rows: ReadonlyArray<MachinesBarRow>;
  /** Listed idle machines that can be updated from this Mac via Update all. */
  readonly idleUpdatableNames: ReadonlyArray<string>;
};

const workingStatusLine = (condition: MachineCondition, copy: MachineCopy | undefined): string => {
  if (condition === "waking") return "Waking";
  if (copy?.kind !== "running") return condition === "updating" ? "Updating Junto" : "Sending Junto";
  if (condition === "adding" && copy.steps.length === 0 && copy.download === undefined && copy.transfer === undefined) {
    return "Making it on Boat";
  }
  const verb = copy.op === "update" ? "Updating Junto" : "Sending Junto";
  if (copy.download && copy.download.state !== "downloaded") {
    return `${verb}, downloading ${byteAmount(copy.download.downloadedBytes, copy.download.totalBytes)}`;
  }
  if (copy.transfer && copy.transfer.state !== "copied") {
    return `${verb}, copying ${byteAmount(copy.transfer.copiedBytes, copy.transfer.totalBytes)}`;
  }
  const currentStep = Math.min(copy.steps.length + 1, MACHINE_INSTALL_STEPS.length);
  return `${verb}, step ${currentStep} of ${MACHINE_INSTALL_STEPS.length}`;
};

/**
 * A row's seats clause. The label is on the row's first line, so it is not
 * named again, and the count says when it was read: a machine out of reach
 * cannot say what runs there now.
 */
const withRunningSeats = (sentence: string, item: MachineListItem): string => {
  const count = item.runningSeats;
  if (count === undefined || count <= 0) return sentence;
  const time = clockTime(item.runningSeatsAt);
  return `${sentence} Had ${count} ${count === 1 ? "seat" : "seats"} running${time ? ` at ${time}` : ""}.`;
};

/** What a ready machine lacks for its seats, as a row says it: harnesses by name up to two, secrets by count. */
const lackingRowLine = (harnesses: ReadonlyArray<string>, secrets: ReadonlyArray<string>): string => {
  const parts = [
    harnesses.length === 0
      ? undefined
      : harnesses.length <= 2
        ? harnesses.map(harnessName).join(" and ")
        : `${harnesses.length} harnesses`,
    secrets.length === 0 ? undefined : `${secrets.length} ${secrets.length === 1 ? "secret" : "secrets"}`,
  ].filter((part): part is string => part !== undefined);
  const one = harnesses.length + secrets.length === 1;
  return `${parts.join(" and ")} ${one ? "is" : "are"} missing there.`;
};

const classifyBarEntry = (entry: MachinesBarEntry): MachinesBarRow | undefined => {
  const { item, listed, read, copy, boat, placed } = entry;
  const id = item.machine.id;
  const label = item.machine.label.trim() || id;
  const condition = machineCondition(item, read, copy, boat);

  if (condition === "adding" || condition === "sending" || condition === "updating" || condition === "waking") {
    return { id, label, severity: MachineRowUrgency.group.working, status: workingStatusLine(condition, copy), condition, listed };
  }

  // Sleeping, falling asleep, and checking are quiet.
  if (condition === "asleep" || condition === "falling-asleep" || condition === "checking") {
    return undefined;
  }

  const hasSeats = placed.seats > 0 || (item.runningSeats ?? 0) > 0;

  switch (condition) {
    case "boat-failed":
      return {
        id,
        label,
        severity: MachineRowUrgency.group.broken,
        status: "Boat says it failed.",
        action: { kind: "delete", label: "Delete on Boat", armedLabel: `Delete ${label} on Boat`, danger: true },
        condition,
        listed,
      };
    case "gone":
      return {
        id,
        label,
        severity: MachineRowUrgency.group.broken,
        status: "No longer on Boat.",
        action: { kind: "remove", label: "Remove", armedLabel: `Remove ${label}`, danger: true },
        condition,
        listed,
      };
    case "update-stopped":
      return {
        id,
        label,
        severity: MachineRowUrgency.group.broken,
        status: "The update failed, and nothing runs there now.",
        action: { kind: "update", label: "Reinstall Junto", pendingLabel: "Reinstalling…", danger: false },
        condition,
        listed,
      };
    case "update-failed":
      return {
        id,
        label,
        severity: MachineRowUrgency.group.broken,
        status: "Junto could not be updated. The old build still runs.",
        action: { kind: "update", label: "Try update again", pendingLabel: "Updating…", danger: false },
        condition,
        listed,
      };
    case "update-unconfirmed":
      return {
        id,
        label,
        severity: MachineRowUrgency.group.broken,
        status: "Could not confirm Junto was updated.",
        action: { kind: "check", label: "Check again", pendingLabel: "Checking…", danger: false },
        condition,
        listed,
      };
    case "updated-not-ready":
      return {
        id,
        label,
        severity: MachineRowUrgency.group.broken,
        status: "Junto was updated, but it is not ready.",
        action: { kind: "check", label: "Check again", pendingLabel: "Checking…", danger: false },
        condition,
        listed,
      };
    case "send-failed":
      return {
        id,
        label,
        severity: MachineRowUrgency.group.broken,
        status: "Junto could not be sent.",
        action: { kind: "send", label: "Send Junto", pendingLabel: "Sending…", danger: false },
        condition,
        listed,
      };
    case "send-unconfirmed":
    case "sent-not-ready":
    case "add-failed":
      return {
        id,
        label,
        severity: MachineRowUrgency.group.broken,
        status:
          condition === "add-failed"
            ? "Could not finish adding it on Boat."
            : condition === "sent-not-ready"
              ? "Junto is on it, but it is not ready."
              : "Could not confirm Junto was sent.",
        action: { kind: "check", label: "Check again", pendingLabel: "Checking…", danger: false },
        condition,
        listed,
      };
    case "unreachable":
    case "check-failed": {
      const base =
        condition === "check-failed"
          ? "Could not be checked."
          : hasSeats
            ? "Cannot be reached."
            : "Cannot be reached. Check that it is on.";
      return {
        id,
        label,
        severity: hasSeats ? MachineRowUrgency.group.broken : MachineRowUrgency.group["needs-you"],
        status: withRunningSeats(base, item),
        action: { kind: "check", label: "Check again", pendingLabel: "Checking…", danger: false },
        condition,
        listed,
      };
    }
    case "needs-update":
      return {
        id,
        label,
        severity: MachineRowUrgency.group["needs-you"],
        status: withRunningSeats("Runs a different build of Junto.", item),
        action: { kind: "update", label: "Update Junto", pendingLabel: "Updating…", danger: false },
        condition,
        listed,
      };
    case "peer-newer":
      return {
        id,
        label,
        severity: MachineRowUrgency.group["needs-you"],
        status: "Runs a newer build of Junto. Update this machine to connect.",
        action: { kind: "check-updates", label: "Check for updates", danger: false },
        condition,
        listed,
      };
    case "not-set-up":
      return {
        id,
        label,
        severity: MachineRowUrgency.group["needs-you"],
        status: "Junto is not on it yet.",
        action: { kind: "send", label: "Send Junto", pendingLabel: "Sending…", danger: false },
        condition,
        listed,
      };
    case "installed-not-linked":
      return {
        id,
        label,
        severity: MachineRowUrgency.group["needs-you"],
        status: "Junto is installed there, but not connected.",
        action: { kind: "send", label: "Reconnect", pendingLabel: "Reconnecting…", danger: false },
        condition,
        listed,
      };
    case "boat-unfinished":
      return {
        id,
        label,
        severity: MachineRowUrgency.group["needs-you"],
        status: "Made on Boat, not added yet.",
        action: { kind: "finish", label: "Finish adding", pendingLabel: "Adding…", danger: false },
        condition,
        listed,
      };
    case "ready":
    case "this-machine": {
      const missingHarnesses = harnessesSeatsLack(read, placed.harnesses);
      const missingSecrets = machineMissingSecrets(read);
      if (missingHarnesses.length > 0 || missingSecrets.length > 0) {
        return {
          id,
          label,
          severity: MachineRowUrgency.group["needs-you"],
          status: lackingRowLine(missingHarnesses, missingSecrets),
          action: { kind: "check", label: "Check again", pendingLabel: "Checking…", danger: false },
          condition,
          listed,
        };
      }
      const blocked = harnessesKeychainBlocked(read, placed.harnesses);
      if (blocked.length > 0) {
        return {
          id,
          label,
          severity: MachineRowUrgency.group["needs-you"],
          status: "Sign-in is blocked. Sign in at its screen, then restart Junto.",
          action: { kind: "check", label: "Check again", pendingLabel: "Checking…", danger: false },
          condition,
          listed,
        };
      }
      return undefined;
    }
  }
};

const compareMachineRow = compareView(MachineRowUrgency);

const workingAriaLabel = (workingRows: ReadonlyArray<MachinesBarRow>): string => {
  if (workingRows.length > 1) return `Machines, ${workingRows.length} are busy`;
  const row = workingRows[0]!;
  if (row.condition === "waking") return `Machines, waking ${row.label}`;
  if (row.condition === "updating") return `Machines, updating Junto on ${row.label}`;
  return `Machines, sending Junto to ${row.label}`;
};

/**
 * Compute the TopBar Machines badge and popover rows from live machine state.
 * Pure: every state is testable without mounting the window.
 */
export const machinesBarSummary = (entries: ReadonlyArray<MachinesBarEntry>): MachinesBarSummary => {
  const rows = entries
    .map((entry) => {
      const row = classifyBarEntry(entry);
      if (row === undefined) return undefined;
      const reason = ownWordsReason(entry.copy, row.condition);
      return reason === undefined ? row : { ...row, reason };
    })
    .filter((row): row is MachinesBarRow => row !== undefined)
    .sort((left, right) => {
      const bySeverity = compareMachineRow(left.severity, right.severity);
      return bySeverity !== 0 ? bySeverity : left.label.localeCompare(right.label);
    });

  const brokenRows = rows.filter((row) => row.severity === MachineRowUrgency.group.broken);
  const needsYouRows = rows.filter((row) => row.severity === MachineRowUrgency.group["needs-you"]);
  const workingRows = rows.filter((row) => row.severity === MachineRowUrgency.group.working);
  const brokenCount = brokenRows.length;
  const needsYouCount = needsYouRows.length;
  const workingCount = workingRows.length;
  const count = brokenCount + needsYouCount;

  const severity: MachinesBarSeverity =
    brokenCount > 0 ? "crimson" : needsYouCount > 0 ? "amber" : workingCount > 0 ? "working" : "quiet";

  const ariaLabel =
    brokenCount > 0
      ? needsYouCount > 0
        ? `Machines, ${brokenCount} cannot work, ${needsYouCount} ${needsYouCount === 1 ? "needs" : "need"} you`
        : `Machines, ${brokenCount} cannot work`
      : needsYouCount > 0
        ? `Machines, ${needsYouCount} ${needsYouCount === 1 ? "needs" : "need"} you`
        : workingCount > 0
          ? workingAriaLabel(workingRows)
          : "Machines";

  const idleUpdatableNames = rows
    .filter((row) => row.listed && row.condition === "needs-update")
    .map((row) => row.id);

  return {
    severity,
    brokenCount,
    needsYouCount,
    workingCount,
    count,
    ariaLabel,
    rows,
    idleUpdatableNames,
  };
};
