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

export type StationDeployOutcome =
  | "ready"
  | "failed"
  | "rolled-back"
  | "indeterminate";

export type StationDeployRecord = {
  readonly at: string;
  readonly hostId: string;
  /** Registered SSH mutation target this observation belongs to. */
  readonly endpoint: string;
  readonly ok: boolean;
  readonly outcome: StationDeployOutcome;
  readonly packageState: "present" | "previous" | "unknown";
  readonly role: "remote" | "previous" | "unknown";
  readonly version: string;
  readonly lastSeen?: string;
  readonly rollback: "not-required" | "restored" | "failed";
  readonly configurationOk: boolean;
  readonly detail: string;
  readonly stages: ReadonlyArray<string>;
};

export type StationStatusDocument = {
  readonly version: typeof STATION_STATUS_VERSION;
  readonly lastPull?: StationPullRecord;
  readonly lastConfigure?: StationConfigureRecord;
  /** Latest durable deployment receipt for each registered Remote host. */
  readonly deployments?: Readonly<Record<string, StationDeployRecord>>;
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

export const deployRecordFromResult = (input: {
  readonly hostId: string;
  readonly endpoint: string;
  readonly ok: boolean;
  readonly outcome: StationDeployOutcome;
  readonly packageState: StationDeployRecord["packageState"];
  readonly role: StationDeployRecord["role"];
  readonly version?: string;
  readonly lastSeen?: string;
  readonly rollback: StationDeployRecord["rollback"];
  readonly configurationOk: boolean;
  readonly detail: string;
  readonly stages?: ReadonlyArray<string>;
  readonly at?: string;
}): StationDeployRecord => ({
  at: input.at ?? new Date().toISOString(),
  hostId: input.hostId,
  endpoint: input.endpoint,
  ok: input.ok,
  outcome: input.outcome,
  packageState: input.packageState,
  role: input.role,
  version: input.version?.trim() || "unknown",
  ...(input.lastSeen ? { lastSeen: input.lastSeen } : {}),
  rollback: input.rollback,
  configurationOk: input.configurationOk,
  detail: input.detail.slice(0, 4_096),
  stages: (input.stages ?? []).slice(-32).map((stage) => stage.slice(0, 512)),
});

export type StationDoctorInput = {
  readonly role: string;
  readonly hostId: string;
  readonly commandCenterRef: string;
  readonly supervisedPreferred: boolean;
  readonly supervisedInstalled: SupervisedInstallState;
  readonly status: StationStatusDocument;
  /** Current registry endpoints; omitted only when the registry cannot be read. */
  readonly registeredRemoteEndpoints?: Readonly<Record<string, string>>;
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

  const deployments = Object.values(input.status.deployments ?? {}).sort((a, b) =>
    a.hostId.localeCompare(b.hostId),
  );
  for (const deployment of deployments) {
    const registeredEndpoint = input.registeredRemoteEndpoints?.[deployment.hostId];
    if (input.registeredRemoteEndpoints !== undefined) {
      if (registeredEndpoint === undefined) {
        lines.push(
          `Remote ${deployment.hostId}: stale deployment receipt (host no longer registered)`,
        );
        raise("warning");
        continue;
      }
      if (registeredEndpoint !== deployment.endpoint) {
        lines.push(
          `Remote ${deployment.hostId}: stale deployment receipt (registered endpoint changed)`,
        );
        raise("warning");
        continue;
      }
    }
    const seen = deployment.lastSeen ?? "never";
    lines.push(
      `Remote ${deployment.hostId} (${deployment.endpoint}): last observed package ${deployment.packageState} · role ${deployment.role} · version ${deployment.version} · last seen ${seen} · attempt ${deployment.outcome}`,
    );
    if (deployment.outcome === "indeterminate") raise("error");
    else if (deployment.outcome !== "ready") raise("warning");
    if (
      deployment.outcome === "ready" &&
      (deployment.packageState !== "present" ||
        deployment.role !== "remote" ||
        deployment.version === "unknown" ||
        deployment.lastSeen === undefined)
    ) {
      raise("warning");
    }
  }

  const activeDeployments = deployments.filter(
    (deployment) =>
      input.registeredRemoteEndpoints === undefined ||
      input.registeredRemoteEndpoints[deployment.hostId] === deployment.endpoint,
  );
  const latestDeployment = [...activeDeployments].sort((a, b) =>
    b.at.localeCompare(a.at),
  )[0];

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
      deploymentCount: String(activeDeployments.length),
      staleDeploymentCount: String(deployments.length - activeDeployments.length),
      ...(latestDeployment
        ? {
            lastDeployHostId: latestDeployment.hostId,
            lastDeployOk: latestDeployment.ok ? "true" : "false",
            lastDeployOutcome: latestDeployment.outcome,
            lastDeployPackageState: latestDeployment.packageState,
            lastDeployRole: latestDeployment.role,
            lastDeployVersion: latestDeployment.version,
            lastDeployAt: latestDeployment.at,
            lastDeployLastSeen: latestDeployment.lastSeen ?? "",
            lastDeployRollback: latestDeployment.rollback,
          }
        : {}),
    },
  };
};

/** Type guard for StationRole from settings string. */
export const asStationRoleLabel = (role: string): StationRole | "" =>
  role === "command-center" || role === "remote" ? role : "";
