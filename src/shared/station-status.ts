import { Either, Schema } from "effect";
import type { ServiceCheck } from "./contracts";
import type { KernelSnapshot } from "./ipc";
import {
  DisplayTimestamp,
  InstallationId,
  StationHostId,
  type StationConfiguration as StationConfigurationValue,
  type StationEventAck as StationEventAckValue,
  type StationProjectionReference as StationProjectionReferenceValue,
  type StationReadiness as StationReadinessValue,
  type StatusResponse as StatusResponseValue,
} from "./station-api";
import {
  assessSupervisedRuntime,
  type SupervisedInstallState,
} from "./station";

/**
 * Durable operational observations. Authoritative station configuration,
 * projections, and logical cursors live in StationRepository instead.
 */
export const STATION_STATUS_VERSION = 2 as const;

/** A kernel observation older than this is display history, not live truth. */
export const STATION_KERNEL_STALE_AFTER_MS = 2 * 60 * 1_000;

/** Deployment sightings are operator history and use a deliberately broad SLA. */
export const STATION_DEPLOYMENT_STALE_AFTER_MS = 24 * 60 * 60 * 1_000;

const NonNegativeInteger = Schema.Number.pipe(
  Schema.int(),
  Schema.nonNegative(),
);
const Diagnostic = Schema.String.pipe(Schema.maxLength(4_096));
const Stage = Schema.String.pipe(Schema.maxLength(512));
const Endpoint = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(255),
);
const AppVersion = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(128),
);

export const StationDeployOutcome = Schema.Literal(
  "ready",
  "failed",
  "rolled-back",
  "indeterminate",
);
export type StationDeployOutcome = typeof StationDeployOutcome.Type;

export const StationDeployRecord = Schema.Struct({
  at: DisplayTimestamp,
  hostId: StationHostId,
  endpoint: Endpoint,
  ok: Schema.Boolean,
  outcome: StationDeployOutcome,
  packageState: Schema.Literal("present", "previous", "unknown"),
  role: Schema.Literal("remote", "previous", "unknown"),
  version: AppVersion,
  lastSeen: Schema.optionalWith(DisplayTimestamp, { exact: true }),
  rollback: Schema.Literal("not-required", "restored", "failed"),
  configurationOk: Schema.Boolean,
  detail: Diagnostic,
  stages: Schema.Array(Stage).pipe(Schema.maxItems(32)),
});
export type StationDeployRecord = typeof StationDeployRecord.Type;

export const StationKernelRecord = Schema.Struct({
  observedAt: DisplayTimestamp,
  armedRegionCount: NonNegativeInteger,
  lastFireAt: Schema.optionalWith(DisplayTimestamp, { exact: true }),
  lastFireKind: Schema.optionalWith(
    Schema.Literal("watcher", "timer", "manual"),
    { exact: true },
  ),
  lastFireDry: Schema.optionalWith(Schema.Boolean, { exact: true }),
  fault: Schema.optionalWith(
    Schema.String.pipe(Schema.maxLength(1_024)),
    { exact: true },
  ),
  orphanedArmingCount: NonNegativeInteger,
});
export type StationKernelRecord = typeof StationKernelRecord.Type;

const Deployments = Schema.Record({
  key: StationHostId,
  value: StationDeployRecord,
});

export const StationStatusDocument = Schema.Struct({
  version: Schema.Literal(STATION_STATUS_VERSION),
  kernel: Schema.optionalWith(StationKernelRecord, { exact: true }),
  deployments: Schema.optionalWith(Deployments, { exact: true }),
});
export type StationStatusDocument = typeof StationStatusDocument.Type;

export type StationRemoteObservation = {
  readonly hostId: string;
  readonly endpoint: string;
  readonly reachability: "reachable" | "unreachable" | "unknown";
  readonly reachabilityError?: string;
  /** Exact typed response from the Remote's Station API. */
  readonly station?: StatusResponseValue;
  readonly observationError?: string;
};

export const defaultStationStatus = (): StationStatusDocument => ({
  version: STATION_STATUS_VERSION,
});

const decodeStatus = Schema.decodeUnknownEither(StationStatusDocument, {
  onExcessProperty: "error",
});

/** Strict boundary decode: retired pull/configure/projection fields are errors. */
export const decodeStationStatusDocument = (
  value: unknown,
): StationStatusDocument | undefined => {
  const decoded = decodeStatus(value);
  return Either.isRight(decoded) ? decoded.right : undefined;
};

const decodeDeploy = Schema.decodeUnknownSync(StationDeployRecord, {
  onExcessProperty: "error",
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
}): StationDeployRecord =>
  decodeDeploy({
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
    stages: (input.stages ?? [])
      .slice(-32)
      .map((stage) => stage.slice(0, 512)),
  });

/**
 * Project the live kernel into the bounded operational facts Doctor needs.
 * Canvas names, node ids, agent identities, instructions, and tokens never
 * enter the observation table.
 */
export const kernelRecordFromSnapshot = (
  snapshot: KernelSnapshot,
  observedAt = new Date().toISOString(),
): StationKernelRecord => {
  let armedRegionCount = 0;
  for (const canvas of Object.values(snapshot.canvases)) {
    armedRegionCount += Object.values(canvas.armed).filter(Boolean).length;
  }

  const latest = [...snapshot.pulseLog]
    .filter((pulse) => Number.isFinite(pulse.at))
    .sort((left, right) => right.at - left.at)[0];

  return {
    observedAt,
    armedRegionCount,
    ...(latest
      ? {
          lastFireAt: new Date(latest.at).toISOString(),
          lastFireKind: latest.kind,
          lastFireDry: latest.dry,
        }
      : {}),
    ...(snapshot.fault ? { fault: snapshot.fault.slice(0, 1_024) } : {}),
    orphanedArmingCount: snapshot.orphanedArming?.length ?? 0,
  };
};

export type StationDoctorInput = {
  readonly installationId: InstallationId;
  readonly configuration?: StationConfigurationValue;
  readonly configuredAt?: string;
  readonly projection?: StationProjectionReferenceValue;
  readonly receivedThrough: ReadonlyArray<StationEventAckValue>;
  readonly version?: string;
  readonly supervisedInstalled: SupervisedInstallState;
  /** Durable deployment and kernel observations only. */
  readonly status: StationStatusDocument;
  /** Current in-process kernel truth, preferred over the durable heartbeat. */
  readonly kernel?: StationKernelRecord;
  readonly registeredRemoteEndpoints?: Readonly<Record<string, string>>;
  readonly remoteObservations?: ReadonlyArray<StationRemoteObservation>;
  readonly readiness: StationReadinessValue;
  readonly now?: number;
};

const timestampIsStale = (
  value: string,
  now: number,
  thresholdMs: number,
): boolean => {
  const observed = Date.parse(value);
  return (
    !Number.isFinite(now) ||
    !Number.isFinite(observed) ||
    observed > now ||
    now - observed > thresholdMs
  );
};

const boundedDiagnostic = (
  value: string | undefined,
  fallback: string,
): string => {
  const normalized = value?.replaceAll(/\s+/gu, " ").trim();
  return (normalized || fallback).slice(0, 512);
};

type RemoteProjection = {
  readonly line: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly fleetBlind: boolean;
  readonly stale: boolean;
  readonly error: boolean;
};

const localConfigurationDetail = (
  configuration: StationConfigurationValue | undefined,
): string =>
  configuration === undefined
    ? "configuration absent"
    : configuration.role === "command-center"
      ? `Command Center · host ${configuration.hostId}`
      : `Remote · host ${configuration.hostId} · CC ${configuration.commandCenterRef}`;

/** Pure Doctor projection over canonical repository and Station API facts. */
export const assessStationDoctor = (input: StationDoctorInput): ServiceCheck => {
  const now = input.now ?? Date.now();
  const configuration = input.configuration;
  const role = configuration?.role ?? "";
  const hostId = configuration?.hostId ?? "unconfigured";
  const supervised = assessSupervisedRuntime({
    role,
    hostId,
    supervisedPreferred: configuration?.supervisedPreferred ?? false,
    supervisedInstalled: input.supervisedInstalled,
  });

  const lines = [
    `installation ${input.installationId}`,
    localConfigurationDetail(configuration),
    supervised.detail,
  ];
  let worst: "ok" | "warning" | "error" = "ok";
  const raise = (status: "warning" | "error") => {
    if (status === "error") worst = "error";
    else if (worst === "ok") worst = "warning";
  };

  if (configuration === undefined) raise("warning");
  if (supervised.status === "warning") raise("warning");

  if (input.readiness.database) lines.push("database ready");
  else {
    lines.push("database unavailable");
    raise("error");
  }
  if (input.readiness.workControl) lines.push("work control ready");
  else {
    lines.push("work control not ready");
    raise("warning");
  }
  if (input.readiness.simulation) lines.push("simulation ready");
  else {
    lines.push("simulation degraded");
    raise("warning");
  }

  if (configuration?.role === "remote") {
    if (input.projection === undefined) {
      lines.push("projection absent");
      raise("warning");
    } else {
      lines.push(
        `projection ${input.projection.generation} · received ${input.projection.receivedAt}`,
      );
    }
  }
  const localCursors = input.receivedThrough
    .map((cursor) => `${cursor.home}:${cursor.through}`)
    .join(",");
  lines.push(`logical cursors ${localCursors || "none"}`);

  const localKernel = input.kernel ?? input.status.kernel;
  if (localKernel !== undefined) {
    const stale = timestampIsStale(
      localKernel.observedAt,
      now,
      STATION_KERNEL_STALE_AFTER_MS,
    );
    lines.push(
      `kernel armed ${localKernel.armedRegionCount} · last fire ${localKernel.lastFireAt ?? "never"}${stale ? " · stale" : ""}`,
    );
    if (stale) raise("warning");
    if (localKernel.fault) {
      lines.push(`kernel fault ${boundedDiagnostic(localKernel.fault, "unknown")}`);
      raise("error");
    }
    if (localKernel.orphanedArmingCount > 0) {
      lines.push(
        `${localKernel.orphanedArmingCount} orphaned armed region(s)`,
      );
      raise("warning");
    }
  }

  const deployments = Object.values(input.status.deployments ?? {}).sort(
    (left, right) => left.hostId.localeCompare(right.hostId),
  );
  const deploymentByHost = new Map<string, StationDeployRecord>(
    deployments.map((deployment) => [deployment.hostId, deployment] as const),
  );
  const observationByHost = new Map(
    (input.remoteObservations ?? []).map(
      (observation) => [observation.hostId, observation] as const,
    ),
  );
  const registryKnown =
    input.registeredRemoteEndpoints !== undefined ||
    input.remoteObservations !== undefined;
  const registeredEndpoints = new Map(
    Object.entries(input.registeredRemoteEndpoints ?? {}),
  );
  for (const observation of input.remoteObservations ?? []) {
    if (!registeredEndpoints.has(observation.hostId)) {
      registeredEndpoints.set(observation.hostId, observation.endpoint);
    }
  }
  if (!registryKnown) {
    for (const deployment of deployments) {
      registeredEndpoints.set(deployment.hostId, deployment.endpoint);
    }
  }

  for (const deployment of deployments) {
    const endpoint = registeredEndpoints.get(deployment.hostId);
    if (!registryKnown) continue;
    if (endpoint === undefined) {
      lines.push(
        `Remote ${deployment.hostId}: stale deployment receipt (host no longer registered)`,
      );
      raise("warning");
    } else if (endpoint !== deployment.endpoint) {
      lines.push(
        `Remote ${deployment.hostId}: stale deployment receipt (registered endpoint changed)`,
      );
      raise("warning");
    }
  }

  const activeDeployments = deployments.filter(
    (deployment) =>
      !registryKnown ||
      registeredEndpoints.get(deployment.hostId) === deployment.endpoint,
  );
  const latestDeployment = [...activeDeployments].sort((left, right) =>
    right.at.localeCompare(left.at)
  )[0];

  const remotes: RemoteProjection[] = [];
  for (
    const [remoteHostId, endpoint] of [...registeredEndpoints].sort(
      ([left], [right]) => left.localeCompare(right),
    )
  ) {
    const deployment = deploymentByHost.get(remoteHostId)?.endpoint === endpoint
      ? deploymentByHost.get(remoteHostId)
      : undefined;
    const observation = observationByHost.get(remoteHostId)?.endpoint === endpoint
      ? observationByHost.get(remoteHostId)
      : undefined;
    const station = observation?.station;
    const problems: string[] = [];
    let hardError = false;
    let fleetBlind = false;
    let stale = false;

    if (deployment === undefined) {
      problems.push("registered but no managed deployment receipt");
    } else {
      if (deployment.outcome === "indeterminate") {
        problems.push(
          `deploy indeterminate (last seen ${deployment.lastSeen ?? "never"})`,
        );
        hardError = true;
      } else if (deployment.outcome !== "ready") {
        problems.push(`deploy ${deployment.outcome}`);
      }
      if (deployment.packageState !== "present") {
        problems.push(`package state ${deployment.packageState}`);
      }
      if (
        deployment.lastSeen !== undefined &&
        timestampIsStale(
          deployment.lastSeen,
          now,
          STATION_DEPLOYMENT_STALE_AFTER_MS,
        )
      ) {
        problems.push("deployment observation stale");
        stale = true;
      }
    }

    if (observation?.reachability === "unreachable") {
      problems.push(
        `fleet-blind: ${boundedDiagnostic(
          observation.reachabilityError,
          "Remote unreachable",
        )}`,
      );
      hardError = true;
      fleetBlind = true;
    } else if (station === undefined) {
      problems.push(
        `fleet-blind: ${boundedDiagnostic(
          observation?.observationError,
          "Station API status unavailable",
        )}`,
      );
      fleetBlind = true;
    } else {
      if (
        station.configuration?.role !== "remote" ||
        station.configuration.hostId !== remoteHostId
      ) {
        problems.push("Station API configuration does not match registry");
        hardError = true;
      }
      if (
        configuration?.role === "command-center" &&
        station.configuration?.role === "remote" &&
        station.configuration.commandCenterInstallationId !==
          input.installationId
      ) {
        problems.push(
          "Station API configuration names another Command Center",
        );
        hardError = true;
      }
      const notReady = Object.entries(station.readiness)
        .filter(([, ready]) => !ready)
        .map(([name]) => name);
      if (notReady.length > 0) {
        problems.push(`not ready: ${notReady.join(", ")}`);
      }
      if (station.state === "degraded") problems.push("Station API degraded");
      if (station.projection === undefined) {
        problems.push("projection absent");
      }
    }

    const state = hardError
      ? "error"
      : fleetBlind
        ? "fleet-blind"
        : stale
          ? "stale"
          : problems.length > 0
            ? "warning"
            : "ok";
    if (hardError) raise("error");
    else if (fleetBlind || stale || problems.length > 0) raise("warning");

    const prefix = `remote.${remoteHostId}.`;
    remotes.push({
      line:
        `Remote ${remoteHostId} (${endpoint}): Station API ${station?.state ?? "unavailable"} · ` +
        `installation ${station?.installationId ?? "unknown"} · ` +
        `projection ${station?.projection?.generation ?? "absent"} · ` +
        `cursors ${station?.receivedThrough.length ?? 0} · ` +
        `errors ${problems.join("; ") || "none"}`,
      metadata: {
        [`${prefix}state`]: state,
        [`${prefix}reachability`]: observation?.reachability ?? "unknown",
        [`${prefix}apiState`]: station?.state ?? "unavailable",
        [`${prefix}installationId`]: station?.installationId ?? "",
        [`${prefix}role`]: station?.configuration?.role ?? "unknown",
        [`${prefix}projectionGeneration`]:
          station?.projection?.generation ?? "",
        [`${prefix}receivedCursorCount`]: String(
          station?.receivedThrough.length ?? 0,
        ),
        [`${prefix}receivedThrough`]:
          station?.receivedThrough
            .map((cursor) => `${cursor.home}:${cursor.through}`)
            .join(",") ?? "",
        [`${prefix}databaseReady`]:
          station?.readiness.database === true ? "true" : "false",
        [`${prefix}workControlReady`]:
          station?.readiness.workControl === true ? "true" : "false",
        [`${prefix}simulationReady`]:
          station?.readiness.simulation === true ? "true" : "false",
        [`${prefix}errorCount`]: String(problems.length),
      },
      fleetBlind,
      stale,
      error: hardError,
    });
  }
  lines.push(...remotes.map((remote) => remote.line));

  const remoteMetadata = Object.assign(
    {},
    ...remotes.map((remote) => remote.metadata),
  ) as Record<string, string>;

  return {
    id: "station",
    label: "Station",
    status: worst,
    detail: lines.join(" · "),
    metadata: {
      installationId: input.installationId,
      configurationState:
        configuration === undefined ? "unconfigured" : "configured",
      role: role || "unset",
      hostId,
      configuredAt: input.configuredAt ?? "",
      projectionGeneration: input.projection?.generation ?? "",
      projectionContentSha256: input.projection?.contentSha256 ?? "",
      receivedCursorCount: String(input.receivedThrough.length),
      receivedThrough: localCursors,
      databaseReady: input.readiness.database ? "true" : "false",
      workControlReady: input.readiness.workControl ? "true" : "false",
      simulationReady: input.readiness.simulation ? "true" : "false",
      supervisedPreferred: supervised.metadata.supervisedPreferred,
      supervisedInstalled: supervised.metadata.supervisedInstalled,
      supervisedAligned: supervised.metadata.supervisedAligned,
      ...(localKernel
        ? {
            kernelObservedAt: localKernel.observedAt,
            kernelArmedCount: String(localKernel.armedRegionCount),
            kernelLastFireAt: localKernel.lastFireAt ?? "",
          }
        : {}),
      deploymentCount: String(activeDeployments.length),
      staleDeploymentCount: String(
        deployments.length - activeDeployments.length,
      ),
      remoteCount: String(remotes.length),
      remoteFleetBlindCount: String(
        remotes.filter((remote) => remote.fleetBlind).length,
      ),
      remoteStaleCount: String(
        remotes.filter((remote) => remote.stale).length,
      ),
      remoteErrorCount: String(
        remotes.filter((remote) => remote.error).length,
      ),
      ...remoteMetadata,
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
