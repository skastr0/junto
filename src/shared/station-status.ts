import type { ServiceCheck } from "./contracts";
import type { CanvasPullResult, CanvasPullStatus } from "./canvas-pull";
import {
  assessSupervisedRuntime,
  type StationRole,
  type SupervisedInstallState,
} from "./station";

/**
 * Durable, local-only station fleet status (not authorial canvas).
 * Written after Remote pull / Configure-as-Remote; read by doctor.
 */

export const STATION_STATUS_VERSION = 1 as const;

export type StationPullRecord = {
  readonly at: string;
  readonly status: CanvasPullStatus;
  readonly ok: boolean;
  readonly detail: string;
  readonly commandCenterRef: string;
  readonly keptLocal: boolean;
  readonly pulledCount: number;
  readonly failedCount: number;
};

export type StationConfigureRecord = {
  readonly at: string;
  readonly ok: boolean;
  readonly hostId: string;
  readonly detail: string;
};

export type StationStatusDocument = {
  readonly version: typeof STATION_STATUS_VERSION;
  readonly lastPull?: StationPullRecord;
  readonly lastConfigure?: StationConfigureRecord;
};

export const defaultStationStatus = (): StationStatusDocument => ({
  version: STATION_STATUS_VERSION,
});

export const stationStatusPath = (home: string): string =>
  `${home}/.vellum/station-status.json`;

export const pullRecordFromResult = (result: CanvasPullResult): StationPullRecord => ({
  at: result.pulledAt,
  status: result.status,
  ok: result.ok,
  detail: result.detail,
  commandCenterRef: result.commandCenterRef,
  keptLocal: result.keptLocal,
  pulledCount: result.pulled.length,
  failedCount: result.failed.length,
});

export const configureRecordFromResult = (input: {
  readonly ok: boolean;
  readonly hostId: string;
  readonly detail: string;
  readonly at?: string;
}): StationConfigureRecord => ({
  at: input.at ?? new Date().toISOString(),
  ok: input.ok,
  hostId: input.hostId,
  detail: input.detail,
});

export type StationDoctorInput = {
  readonly role: string;
  readonly hostId: string;
  readonly commandCenterRef: string;
  readonly supervisedPreferred: boolean;
  readonly supervisedInstalled: SupervisedInstallState;
  readonly status: StationStatusDocument;
  /** Work control socket present and token file readable (agent CLI plane). */
  readonly workControlReady: boolean;
};

/**
 * Pure doctor check for station fleet + agent tooling readiness.
 */
export const assessStationDoctor = (input: StationDoctorInput): ServiceCheck => {
  const role = input.role;
  const supervised = assessSupervisedRuntime({
    role: input.role,
    hostId: input.hostId,
    supervisedPreferred: input.supervisedPreferred,
    supervisedInstalled: input.supervisedInstalled,
  });

  const lines: string[] = [];
  let worst: "ok" | "warning" | "error" = "ok";
  const raise = (status: "ok" | "warning" | "error") => {
    if (status === "error") worst = "error";
    else if (status === "warning" && worst === "ok") worst = "warning";
  };

  if (role === "") {
    lines.push("role unset — complete station onboarding");
    raise("warning");
  } else if (role === "command-center") {
    lines.push(`Command Center · host ${input.hostId}`);
  } else if (role === "remote") {
    lines.push(`Remote · host ${input.hostId}`);
    if (input.commandCenterRef.trim().length === 0) {
      lines.push("commandCenterRef empty");
      raise("warning");
    } else {
      lines.push(`CC ref ${input.commandCenterRef.trim()}`);
    }
  } else {
    lines.push(`role ${role}`);
  }

  lines.push(supervised.detail);
  if (supervised.status === "warning") raise("warning");

  if (input.workControlReady) {
    lines.push("work control ready");
  } else {
    lines.push("work control not ready — is Vellum running?");
    raise("warning");
  }

  const pull = input.status.lastPull;
  if (pull) {
    lines.push(
      `last pull ${pull.status}${pull.ok ? "" : " (failed)"} · ${pull.pulledCount} file(s) · ${pull.at}`,
    );
    if (!pull.ok && pull.status === "unreachable") raise("warning");
    if (!pull.ok && pull.status === "misconfigured") raise("warning");
    if (!pull.ok && pull.status === "partial") raise("warning");
  } else if (role === "remote") {
    lines.push("no canvas pull recorded yet");
    raise("warning");
  }

  const configure = input.status.lastConfigure;
  if (configure) {
    lines.push(
      `last configure ${configure.ok ? "ok" : "failed"} · ${configure.hostId} · ${configure.at}`,
    );
    if (!configure.ok) raise("warning");
  }

  const roleKey = role.length > 0 ? role : "unset";
  return {
    id: "station",
    label: "Station",
    status: worst,
    detail: lines.join(" · "),
    metadata: {
      role: roleKey,
      hostId: input.hostId,
      commandCenterRef: input.commandCenterRef,
      workControlReady: input.workControlReady ? "true" : "false",
      supervisedPreferred: supervised.metadata.supervisedPreferred,
      supervisedInstalled: supervised.metadata.supervisedInstalled,
      supervisedAligned: supervised.metadata.supervisedAligned,
      ...(pull
        ? {
            lastPullStatus: pull.status,
            lastPullOk: pull.ok ? "true" : "false",
            lastPullAt: pull.at,
            lastPullKeptLocal: pull.keptLocal ? "true" : "false",
          }
        : {}),
      ...(configure
        ? {
            lastConfigureOk: configure.ok ? "true" : "false",
            lastConfigureHostId: configure.hostId,
            lastConfigureAt: configure.at,
          }
        : {}),
    },
  };
};

/** Type guard for StationRole from settings string. */
export const asStationRoleLabel = (role: string): StationRole | "" =>
  role === "command-center" || role === "remote" ? role : "";
