import { use$ } from "@legendapp/state/react";
import type { BoatStatusData } from "@shared/boat";
import type { RemoteHost } from "@shared/remote-hosts";
import { isOnMachine, machineLabelIn, type MachineFacts } from "./machines";
import { boatMachine, machines$ } from "./machines-actions";
import {
  harnessName,
  harnessesKeychainBlocked,
  harnessesSeatsLack,
  machineCondition,
  machineCopyStepLines,
  machineDownloadStepLines,
  machineMissingSecrets,
  machineStepLines,
  type MachineCondition,
  type MachineCopy,
  type MachineListItem,
  type MachineRead,
  type MachineStepLine,
} from "./machines-view";
import { state$ } from "./state";

export type SeatMachineRecoverySeverity = "broken" | "needs-you" | "asleep";

export type SeatMachineRecoveryAction = {
  readonly kind: "send" | "update" | "wake" | "check" | "finish" | "check-updates" | "open-machines";
  readonly label: string;
  readonly pendingLabel?: string;
};

export type SeatMachineRecovery = {
  readonly hostId: string;
  readonly label: string;
  readonly severity: SeatMachineRecoverySeverity;
  readonly eyebrow: "stopped" | "asleep";
  readonly eyebrowTone: "amber" | "steel";
  /** Names the machine once. */
  readonly headline: string;
  /** One sentence, using "there" or "its screen" instead of repeating the machine label. */
  readonly detail: string;
  readonly running: boolean;
  readonly steps: ReadonlyArray<MachineStepLine>;
  readonly action: SeatMachineRecoveryAction;
  readonly item?: MachineListItem;
  readonly listed: boolean;
  readonly condition: MachineCondition | "not-listed";
};

const syntheticItem = (
  hostId: string,
  label: string,
  facts: MachineFacts | undefined,
): MachineListItem | undefined => {
  if (facts === undefined) return undefined;
  return {
    machine: { id: hostId, label, isThisMachine: false, capabilities: ["terminal"] },
    setUp: facts.setUp,
    needsUpdate: facts.needsUpdate,
    ...(facts.setupState === undefined ? {} : { setupState: facts.setupState }),
    ...(facts.updateDirection === undefined ? {} : { updateDirection: facts.updateDirection }),
  };
};

const stepsOf = (copy: MachineCopy | undefined): ReadonlyArray<MachineStepLine> =>
  copy?.kind === "running"
    ? [...machineDownloadStepLines(copy), ...machineCopyStepLines(copy), ...machineStepLines(copy)]
    : [];

/**
 * Resolve the inline recovery card for a stopped seat when its remote machine
 * is why the seat cannot run. Returns undefined for seats on this machine,
 * healthy machines, or before the machine list has loaded.
 */
export const seatMachineRecovery = (input: {
  readonly host: string | undefined;
  readonly harness: string | undefined;
  readonly thisName: string;
  readonly machines: ReadonlyArray<Pick<RemoteHost, "id" | "label">>;
  readonly facts: Readonly<Record<string, MachineFacts>>;
  readonly items: ReadonlyArray<MachineListItem>;
  readonly reads: Readonly<Record<string, MachineRead>>;
  readonly copies: Readonly<Record<string, MachineCopy>>;
  readonly boat: BoatStatusData | undefined;
  readonly power: Readonly<Record<string, "wake" | "sleep">>;
}): SeatMachineRecovery | undefined => {
  const { host, harness, thisName, machines, facts, items, reads, copies, boat, power } = input;
  if (!host || thisName === "" || isOnMachine(host, thisName)) return undefined;

  const listedItem = items.find((entry) => entry.machine.id === host);
  const listedInCanvas = machines.some((row) => row.id === host);
  const label = listedItem?.machine.label.trim() || machineLabelIn(machines, host);
  const boatView = boatMachine(boat, power, host, listedItem !== undefined);
  const copy = copies[host];
  const read = reads[host];

  // Nothing is known before the machine list has been read once.
  if (items.length === 0 && machines.length === 0) return undefined;

  if (listedItem === undefined && !listedInCanvas) {
    if (boatView !== undefined && !boatView.unreadable && boatView.power === "failed") {
      return {
        hostId: host,
        label,
        severity: "broken",
        eyebrow: "stopped",
        eyebrowTone: "amber",
        headline: `Boat says ${label} failed`,
        detail: "Open Machines to delete it on Boat or remove it.",
        running: false,
        steps: [],
        action: { kind: "open-machines", label: "Open Machines" },
        listed: false,
        condition: "boat-failed",
      };
    }
    return {
      hostId: host,
      label,
      severity: "needs-you",
      eyebrow: "stopped",
      eyebrowTone: "amber",
      headline: `${label} is not one of your machines`,
      detail: "Add it in Machines to run this seat.",
      running: false,
      steps: [],
      action: { kind: "open-machines", label: "Add machine" },
      listed: false,
      condition: "not-listed",
    };
  }

  const item = listedItem ?? syntheticItem(host, label, facts[host]);
  if (item === undefined) return undefined;

  const effectiveRead: MachineRead | undefined =
    read ??
    (facts[host]?.reachable === false
      ? {
          kind: "peer",
          status: { machineName: host, reachable: false, harnesses: [], missingSecrets: [] },
        }
      : undefined);

  const condition = machineCondition(item, effectiveRead, copy, boatView);
  const steps = stepsOf(copy);

  switch (condition) {
    case "this-machine":
    case "checking":
    case "falling-asleep":
      return undefined;
    case "asleep":
      return {
        hostId: host,
        label,
        severity: "asleep",
        eyebrow: "asleep",
        eyebrowTone: "steel",
        headline: `${label} is asleep`,
        detail: "Wake it to start this seat.",
        running: false,
        steps: [],
        action: { kind: "wake", label: "Wake", pendingLabel: "Waking…" },
        item,
        listed: true,
        condition,
      };
    case "waking":
      return {
        hostId: host,
        label,
        severity: "asleep",
        eyebrow: "asleep",
        eyebrowTone: "steel",
        headline: `Waking ${label}`,
        detail: "This seat will reopen once it answers.",
        running: true,
        steps: [],
        action: { kind: "wake", label: "Wake", pendingLabel: "Waking…" },
        item,
        listed: true,
        condition,
      };
    case "sending":
    case "adding":
      return {
        hostId: host,
        label,
        severity: "needs-you",
        eyebrow: "stopped",
        eyebrowTone: "amber",
        headline: `Sending Junto to ${label}`,
        detail: "This seat will reopen once setup finishes.",
        running: true,
        steps,
        action: { kind: "send", label: "Send Junto", pendingLabel: "Sending…" },
        item,
        listed: listedItem !== undefined,
        condition,
      };
    case "updating":
      return {
        hostId: host,
        label,
        severity: "needs-you",
        eyebrow: "stopped",
        eyebrowTone: "amber",
        headline: `Updating Junto on ${label}`,
        detail: "This seat will reopen once the update finishes.",
        running: true,
        steps,
        action: { kind: "update", label: "Update Junto", pendingLabel: "Updating…" },
        item,
        listed: true,
        condition,
      };
    case "not-set-up":
      return {
        hostId: host,
        label,
        severity: "needs-you",
        eyebrow: "stopped",
        eyebrowTone: "amber",
        headline: `Junto is not on ${label} yet`,
        detail: "Send Junto there to set it up and run this seat.",
        running: false,
        steps: [],
        action: { kind: "send", label: "Send Junto", pendingLabel: "Sending…" },
        item,
        listed: true,
        condition,
      };
    case "installed-not-linked":
      return {
        hostId: host,
        label,
        severity: "needs-you",
        eyebrow: "stopped",
        eyebrowTone: "amber",
        headline: `${label} is not connected to this Mac`,
        detail: "Junto is already installed there. Reconnect and update it to run this seat.",
        running: false,
        steps: [],
        action: { kind: "send", label: "Reconnect", pendingLabel: "Reconnecting…" },
        item,
        listed: true,
        condition,
      };
    case "boat-unfinished":
      return {
        hostId: host,
        label,
        severity: "needs-you",
        eyebrow: "stopped",
        eyebrowTone: "amber",
        headline: `${label} is not finished on Boat`,
        detail: "Finish adding it to send Junto and start this seat.",
        running: false,
        steps: [],
        action: { kind: "finish", label: "Finish adding", pendingLabel: "Adding…" },
        item,
        listed: false,
        condition,
      };
    case "needs-update":
      return {
        hostId: host,
        label,
        severity: "needs-you",
        eyebrow: "stopped",
        eyebrowTone: "amber",
        headline: `${label} needs an update`,
        detail: "Update Junto there so this seat can start.",
        running: false,
        steps: [],
        action: { kind: "update", label: "Update Junto", pendingLabel: "Updating…" },
        item,
        listed: true,
        condition,
      };
    case "peer-newer":
      return {
        hostId: host,
        label,
        severity: "needs-you",
        eyebrow: "stopped",
        eyebrowTone: "amber",
        headline: `${label} is on a newer Junto`,
        detail: "Update Junto on this Mac to connect and start this seat.",
        running: false,
        steps: [],
        action: { kind: "check-updates", label: "Check for updates" },
        item,
        listed: true,
        condition,
      };
    case "update-stopped":
      return {
        hostId: host,
        label,
        severity: "broken",
        eyebrow: "stopped",
        eyebrowTone: "amber",
        headline: `Junto stopped on ${label}`,
        detail: "The update could not start, so nothing is running there right now. Reinstall Junto.",
        running: false,
        steps: [],
        action: { kind: "update", label: "Reinstall Junto", pendingLabel: "Reinstalling…" },
        item,
        listed: true,
        condition,
      };
    case "update-failed":
      return {
        hostId: host,
        label,
        severity: "broken",
        eyebrow: "stopped",
        eyebrowTone: "amber",
        headline: `Update failed on ${label}`,
        detail: "The previous Junto is still there. Try updating it again.",
        running: false,
        steps: [],
        action: { kind: "update", label: "Try update again", pendingLabel: "Updating…" },
        item,
        listed: true,
        condition,
      };
    case "send-failed":
      return {
        hostId: host,
        label,
        severity: "broken",
        eyebrow: "stopped",
        eyebrowTone: "amber",
        headline: `Could not send Junto to ${label}`,
        detail: "Nothing changed there. Send Junto again to finish setup.",
        running: false,
        steps: [],
        action: { kind: "send", label: "Send Junto", pendingLabel: "Sending…" },
        item,
        listed: true,
        condition,
      };
    case "send-unconfirmed":
    case "update-unconfirmed":
    case "sent-not-ready":
    case "updated-not-ready":
    case "add-failed":
      return {
        hostId: host,
        label,
        severity: "broken",
        eyebrow: "stopped",
        eyebrowTone: "amber",
        headline:
          condition === "add-failed"
            ? `Could not finish adding ${label}`
            : condition === "sent-not-ready" || condition === "updated-not-ready"
              ? `Junto is not ready on ${label}`
              : `Could not confirm Junto on ${label}`,
        detail: "Check its status before trying again.",
        running: false,
        steps: [],
        action: { kind: "check", label: "Check again", pendingLabel: "Checking…" },
        item,
        listed: listedItem !== undefined,
        condition,
      };
    case "boat-failed":
      return {
        hostId: host,
        label,
        severity: "broken",
        eyebrow: "stopped",
        eyebrowTone: "amber",
        headline: `Boat says ${label} failed`,
        detail: "Open Machines to delete it on Boat or remove it.",
        running: false,
        steps: [],
        action: { kind: "open-machines", label: "Open Machines" },
        item,
        listed: listedItem !== undefined,
        condition,
      };
    case "gone":
      return {
        hostId: host,
        label,
        severity: "broken",
        eyebrow: "stopped",
        eyebrowTone: "amber",
        headline: `${label} is no longer on Boat`,
        detail: "Open Machines to remove it from your machines.",
        running: false,
        steps: [],
        action: { kind: "open-machines", label: "Open Machines" },
        item,
        listed: true,
        condition,
      };
    case "unreachable":
    case "check-failed":
      return {
        hostId: host,
        label,
        severity: "broken",
        eyebrow: "stopped",
        eyebrowTone: "amber",
        headline: `Cannot reach ${label}`,
        detail: "Check that it is on and that SSH reaches it, then check again.",
        running: false,
        steps: [],
        action: { kind: "check", label: "Check again", pendingLabel: "Checking…" },
        item,
        listed: true,
        condition,
      };
    case "ready": {
      const seatHarnesses = harness ? [harness] : [];
      const lacking = harnessesSeatsLack(read, seatHarnesses);
      if (lacking.length > 0) {
        return {
          hostId: host,
          label,
          severity: "needs-you",
          eyebrow: "stopped",
          eyebrowTone: "amber",
          headline: `${harnessName(lacking[0]!)} is not on ${label}`,
          detail: "Install it there, then check again.",
          running: false,
          steps: [],
          action: { kind: "check", label: "Check again", pendingLabel: "Checking…" },
          item,
          listed: true,
          condition,
        };
      }
      const blocked = harnessesKeychainBlocked(read, seatHarnesses);
      if (blocked.length > 0) {
        const name = harnessName(blocked[0]!);
        return {
          hostId: host,
          label,
          severity: "needs-you",
          eyebrow: "stopped",
          eyebrowTone: "amber",
          headline: `Sign-in blocked on ${label}`,
          detail: `${name} uses its Mac keychain, which stays locked until someone signs in at its screen. Sign in there, then restart Junto.`,
          running: false,
          steps: [],
          action: { kind: "check", label: "Check again", pendingLabel: "Checking…" },
          item,
          listed: true,
          condition,
        };
      }
      const missingSecrets = machineMissingSecrets(read);
      if (missingSecrets.length > 0) {
        return {
          hostId: host,
          label,
          severity: "needs-you",
          eyebrow: "stopped",
          eyebrowTone: "amber",
          headline: `${label} is missing secrets`,
          detail: `Set ${missingSecrets.join(", ")} there. Junto never sends a secret between machines.`,
          running: false,
          steps: [],
          action: { kind: "check", label: "Check again", pendingLabel: "Checking…" },
          item,
          listed: true,
          condition,
        };
      }
      // Also catch missing harness from canvas facts when Machines reads have not populated yet.
      if (
        read === undefined &&
        harness !== undefined &&
        facts[host]?.reachable === true &&
        facts[host]?.harnesses !== undefined &&
        !facts[host].harnesses.includes(harness)
      ) {
        return {
          hostId: host,
          label,
          severity: "needs-you",
          eyebrow: "stopped",
          eyebrowTone: "amber",
          headline: `${harnessName(harness)} is not on ${label}`,
          detail: "Install it there, then check again.",
          running: false,
          steps: [],
          action: { kind: "check", label: "Check again", pendingLabel: "Checking…" },
          item,
          listed: true,
          condition,
        };
      }
      return undefined;
    }
  }
};

/**
 * Live recovery card descriptor for a stopped remote seat in TerminalSurface.
 * Uses only `use$` (no `useState`/`useMemo`) so TerminalSurface's hook table
 * stays stable across plain-function mocked-hook test rigs.
 */
export const useSeatMachineRecovery = (
  host: string | undefined,
  harness: string | undefined,
): SeatMachineRecovery | undefined =>
  use$(() =>
    seatMachineRecovery({
      host,
      harness,
      thisName: state$.settings.machine.name.get(),
      machines: state$.machines.get(),
      facts: state$.machineFacts.get(),
      items: machines$.items.get(),
      reads: machines$.reads.get(),
      copies: machines$.copies.get(),
      boat: machines$.boat.get(),
      power: machines$.power.get(),
    }),
  );
