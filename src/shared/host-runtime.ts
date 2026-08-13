/**
 * One host-runtime contract for Command Center and Remote.
 *
 * Placement (local | remote) and platform (darwin | linux) select a Layer.
 * They do not change the observation or the gap. Unknown is not down.
 * Ready is work attach, not an SSH badge or a script banner.
 */
import { Schema } from "effect";
import { HostId } from "./remote-hosts";
import { SeatPlacement } from "./terminal-seat-occupancy";
import { StationProcessMode } from "./station-mode";

export const HostRuntimePlatform = Schema.Literals([
  "darwin",
  "linux",
  "unknown",
]);
export type HostRuntimePlatform = typeof HostRuntimePlatform.Type;

export const HostNetwork = Schema.Literals(["up", "down", "unknown"]);
export type HostNetwork = typeof HostNetwork.Type;

export const HostPackage = Schema.Literals(["absent", "present", "unknown"]);
export type HostPackage = typeof HostPackage.Type;

export const HostProcess = Schema.Literals(["down", "up", "unknown"]);
export type HostProcess = typeof HostProcess.Type;

/** Folders/terminals (Darwin) or work control (Linux). Sock-on-disk is not Ready. */
export const HostWorkAttach = Schema.Literals(["down", "up", "unknown"]);
export type HostWorkAttach = typeof HostWorkAttach.Type;

export const HostRuntimeBlockerKind = Schema.Literals([
  "quit-app",
  "auth",
  "unsupported",
]);
export type HostRuntimeBlockerKind = typeof HostRuntimeBlockerKind.Type;

export const HostRuntimeBlocker = Schema.Struct({
  kind: HostRuntimeBlockerKind,
  detail: Schema.String,
});
export type HostRuntimeBlocker = typeof HostRuntimeBlocker.Type;

export const HostRuntimeObservation = Schema.Struct({
  hostId: HostId,
  placement: SeatPlacement,
  platform: HostRuntimePlatform,
  network: HostNetwork,
  package: HostPackage,
  process: HostProcess,
  workAttach: HostWorkAttach,
  mode: StationProcessMode,
  priorInstallationId: Schema.optionalKey(Schema.String),
  blocker: Schema.optionalKey(HostRuntimeBlocker),
});
export type HostRuntimeObservation = typeof HostRuntimeObservation.Type;

export const HostRuntimeIntent = Schema.Literals(["check", "deploy"]);
export type HostRuntimeIntent = typeof HostRuntimeIntent.Type;

export const HostRuntimeGap = Schema.Literals([
  "ready",
  "needInstall",
  "needConfigure",
  "needRestart",
  "needOperator",
  "stillTrying",
]);
export type HostRuntimeGap = typeof HostRuntimeGap.Type;

export const decideHostRuntimeGap = (
  observation: HostRuntimeObservation,
  intent: HostRuntimeIntent,
): HostRuntimeGap => {
  if (observation.blocker !== undefined) return "needOperator";
  if (observation.network === "down") return "stillTrying";

  if (intent === "check") {
    if (
      observation.workAttach === "up" &&
      (observation.mode === "remote" || observation.mode === "command-center")
    ) {
      return "ready";
    }
    return "stillTrying";
  }

  if (observation.package === "absent") return "needInstall";
  const alreadyRemote =
    observation.priorInstallationId !== undefined ||
    observation.mode === "remote";
  if (alreadyRemote) return "needRestart";
  return "needConfigure";
};

export const hostRuntimeGapCopy = (
  gap: HostRuntimeGap,
  blocker?: HostRuntimeBlocker,
): string => {
  if (gap === "needOperator") {
    return blocker?.detail ?? "This machine needs you to do something, then Deploy again.";
  }
  if (gap === "stillTrying") {
    return "Still reaching this machine. Deploy keeps trying while SSH answers.";
  }
  if (gap === "needInstall") {
    return "Vellum Command is not installed on this machine yet.";
  }
  if (gap === "needConfigure") {
    return "Vellum Command is on this machine and still needs to join the fleet.";
  }
  if (gap === "needRestart") {
    return "Updating Vellum Command on this machine. Pairing stays as it is.";
  }
  return "Vellum Command can take work on this machine.";
};
