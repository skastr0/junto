import { Schema } from "effect";
import {
  VELLUM_LAUNCHD_LABEL,
  kickstartLaunchAgent,
  launchAgentTargetForCurrentUser,
  printLaunchAgent,
  type LaunchctlFailureKind,
  type LaunchctlRunResult,
  type VellumLaunchAgentTarget,
} from "../settings/launchctl-runner";
import {
  stationSupervisorFailure,
  type StationSupervisor,
  type StationSupervisorFailure,
  type StationSupervisorHandoff,
  type StationSupervisorMetadata,
  type StationSupervisorObservation,
} from "./contract";

const LaunchdObservedPid = Schema.Int.pipe(
  Schema.between(1, 0x7fff_ffff),
  Schema.brand("LaunchdObservedPid"),
);
type LaunchdObservedPid = typeof LaunchdObservedPid.Type;

type ParsedLaunchdPid =
  | { readonly kind: "none" }
  | { readonly kind: "pid"; readonly pid: LaunchdObservedPid }
  | { readonly kind: "invalid"; readonly diagnostic: string };

const metadata: StationSupervisorMetadata = Object.freeze({
  provider: "launchd",
  displayName: "LaunchAgent",
  serviceLabel: VELLUM_LAUNCHD_LABEL,
  recovery: Object.freeze({
    title: "Repair Vellum LaunchAgent supervision",
    detail: "Reinstall Vellum with supervised startup enabled.",
  }),
});

const launchctlFailureKinds: Record<
  LaunchctlFailureKind,
  StationSupervisorFailure["kind"]
> = {
  "invalid-target": "target-unavailable",
  "admission-refused": "admission-refused",
  "spawn-failed": "spawn-failed",
  "process-error": "process-error",
  "stdout-overflow": "output-overflow",
  "stderr-overflow": "output-overflow",
  deadline: "deadline",
  "exit-nonzero": "command-failed",
  "close-timeout": "close-unconfirmed",
};

const mapLaunchctlFailure = (
  result: Extract<LaunchctlRunResult, { readonly ok: false }>,
): StationSupervisorFailure => stationSupervisorFailure(
  launchctlFailureKinds[result.failure.kind],
  result.failure.diagnostic,
);

const knownAbsentLaunchAgent = (
  result: LaunchctlRunResult,
): boolean => !result.ok && result.clean &&
  result.failure.kind === "exit-nonzero" &&
  result.close?.code === 113 && result.close.signal === null;

const parseLaunchdPid = (stdout: string): ParsedLaunchdPid => {
  const pidLines = stdout.split(/\r?\n/).filter((line) =>
    /^\s*pid\s*=/.test(line)
  );
  if (pidLines.length === 0) return Object.freeze({ kind: "none" });
  if (pidLines.length !== 1) {
    return Object.freeze({
      kind: "invalid",
      diagnostic: "launchctl returned multiple pid fields",
    });
  }

  const match = /^\s*pid\s*=\s*([1-9]\d*)\s*$/.exec(pidLines[0]!);
  if (match === null) {
    return Object.freeze({
      kind: "invalid",
      diagnostic: "launchctl returned a malformed pid field",
    });
  }
  const decoded = Schema.decodeUnknownEither(LaunchdObservedPid)(
    Number(match[1]),
  );
  if (decoded._tag === "Left") {
    return Object.freeze({
      kind: "invalid",
      diagnostic: "launchctl returned an out-of-range pid field",
    });
  }
  return Object.freeze({ kind: "pid", pid: decoded.right });
};

const targetUnavailable = (): StationSupervisorFailure =>
  stationSupervisorFailure(
    "target-unavailable",
    "The current user's Vellum LaunchAgent target could not be established.",
  );

const observeLaunchAgent = async (
  target: VellumLaunchAgentTarget | undefined,
): Promise<StationSupervisorObservation> => {
  if (target === undefined) {
    return Object.freeze({
      provider: "launchd",
      state: "unknown",
      ownership: "unknown",
      failure: targetUnavailable(),
    });
  }

  const result = await printLaunchAgent(target);
  if (!result.ok) {
    if (knownAbsentLaunchAgent(result)) {
      return Object.freeze({
        provider: "launchd",
        state: "absent",
        ownership: "none",
      });
    }
    return Object.freeze({
      provider: "launchd",
      state: "unknown",
      ownership: "unknown",
      failure: mapLaunchctlFailure(result),
    });
  }

  const parsed = parseLaunchdPid(result.stdout);
  if (parsed.kind === "invalid") {
    return Object.freeze({
      provider: "launchd",
      state: "degraded",
      ownership: "unknown",
      failure: stationSupervisorFailure("invalid-output", parsed.diagnostic),
    });
  }
  if (parsed.kind === "none") {
    return Object.freeze({
      provider: "launchd",
      state: "inactive",
      ownership: "none",
    });
  }
  return Object.freeze({
    provider: "launchd",
    state: "active",
    ownership: parsed.pid === process.pid ? "current" : "other",
  });
};

const requestLaunchAgentHandoff = async (
  target: VellumLaunchAgentTarget | undefined,
): Promise<StationSupervisorHandoff> => {
  if (target === undefined) {
    return Object.freeze({
      provider: "launchd",
      accepted: false,
      failure: targetUnavailable(),
    });
  }
  const result = await kickstartLaunchAgent(target);
  if (result.ok) {
    return Object.freeze({ provider: "launchd", accepted: true });
  }
  return Object.freeze({
    provider: "launchd",
    accepted: false,
    failure: mapLaunchctlFailure(result),
  });
};

export const createDarwinStationSupervisor = (): StationSupervisor => {
  const target = launchAgentTargetForCurrentUser();
  return Object.freeze({
    metadata,
    observe: () => observeLaunchAgent(target),
    requestHandoff: () => requestLaunchAgentHandoff(target),
  });
};
