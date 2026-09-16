import { Result, Schema } from "effect";
import type { ServiceCheck } from "./contracts";
import type { KernelSnapshot } from "./ipc";
import { remoteStationContractVersion } from "./remote-station-release";
import {
  DisplayTimestamp,
  InstallationId,
  StationHostId,
  type RouteCursor as RouteCursorValue,
  type StationConfiguration as StationConfigurationValue,
  type StationProjectionReference as StationProjectionReferenceValue,
  type StationReadiness as StationReadinessValue,
  type StatusResponse as StatusResponseValue,
} from "./station-api";
import {
  assessSupervisedRuntime,
  type SupervisedInstallState,
} from "./station";
import type {
  StationAppVersion,
  StationProtocolSupport,
  StationProtocolVersion,
  StationStateSchemaVersion,
} from "./station-protocol";

/**
 * Durable operational observations. Authoritative station configuration,
 * projections, and logical cursors live in StationRepository instead.
 */
export const STATION_STATUS_VERSION = remoteStationContractVersion(
  "Station status observation",
  1,
);

/** A kernel observation older than this is display history, not live truth. */
export const STATION_KERNEL_STALE_AFTER_MS = 2 * 60 * 1_000;

/** Deployment sightings are operator history and use a deliberately broad SLA. */
export const STATION_DEPLOYMENT_STALE_AFTER_MS = 24 * 60 * 60 * 1_000;

const NonNegativeInteger = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
);
const Diagnostic = Schema.String.pipe(Schema.check(Schema.isMaxLength(4_096)));
const Stage = Schema.String.pipe(Schema.check(Schema.isMaxLength(512)));
const Endpoint = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(255)),
);
const AppVersion = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(128)),
);

export const StationRecoveryKind = Schema.Literals([
  "retryable",
  "update-required",
  "identity-conflict",
  "runtime-down",
]);
export type StationRecoveryKind = typeof StationRecoveryKind.Type;

export type StationRecoveryGuidance = {
  readonly kind: StationRecoveryKind;
  readonly nextStep: string;
};

export type StationRouteObservation = {
  readonly phase:
    | "connecting"
    | "synchronizing"
    | "ready"
    | "update-required"
    | "backoff"
    | "stopped";
  readonly sessionOpen: boolean;
  readonly attempt: number;
  readonly updatedAt: string;
  readonly nextRetryAt?: string;
};

export type StationReadinessObservation = {
  readonly database?: boolean;
  readonly workControl?: boolean;
  readonly simulation?: boolean;
  readonly terminal?: boolean;
  readonly browser?: boolean;
};

/**
 * Count-only intent topology from the exact complete portfolio projected to a
 * Remote. This is Command Center evidence, not a second topology authority.
 */
export type StationTopologyObservation = {
  readonly canvasCount: number;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly actorCount: number;
  readonly sinkCount: number;
  readonly schedulerCount: number;
  readonly targetNodeCount: number;
  readonly targetActorCount: number;
  readonly targetSinkCount: number;
  readonly targetSchedulerCount: number;
  readonly commandCenterNodeCount: number;
  readonly otherStationNodeCount: number;
  readonly targetInternalAccessEdgeCount: number;
  readonly remoteActorToCommandCenterSinkEdgeCount: number;
  readonly commandCenterActorToRemoteSinkEdgeCount: number;
  readonly stationPeerEdgeCount: number;
  readonly danglingEdgeCount: number;
};

/** Last bounded projection plus work-report reconciliation for one Remote. */
export type StationSynchronizationObservation = {
  readonly projectionDecision: "unchanged" | "install" | "idempotent";
  readonly projectionGeneration: string;
  readonly projectionContentSha256: string;
  readonly reportRounds: number;
  readonly outboundSent: number;
  readonly inboundReceived: number;
  readonly inboundAccepted: number;
  readonly inboundIdempotent: number;
  readonly inboundRejected: number;
  readonly hasMoreOutbound: boolean;
  readonly hasMoreInbound: boolean;
  readonly converged: boolean;
};

export const StationDeployOutcome = Schema.Literals(["ready", "failed",
"indeterminate",]);
export type StationDeployOutcome = typeof StationDeployOutcome.Type;

export const StationDeployRecord = Schema.Struct({
  at: DisplayTimestamp,
  hostId: StationHostId,
  endpoint: Endpoint,
  ok: Schema.Boolean,
  outcome: StationDeployOutcome,
  packageState: Schema.Literals(["present", "previous", "unknown"]),
  role: Schema.Literals(["remote", "previous", "unknown"]),
  version: AppVersion,
  lastSeen: Schema.optionalKey(DisplayTimestamp),
  configurationOk: Schema.Boolean,
  detail: Diagnostic,
  stages: Schema.Array(Stage).pipe(Schema.check(Schema.isMaxLength(32))),
  recoveryKind: Schema.optionalKey(StationRecoveryKind),
  recoveryDetail: Schema.optionalKey(Diagnostic),
});
export type StationDeployRecord = typeof StationDeployRecord.Type;

// Armed-region / pulse-log doctor fields retained as always-zero wire shape
// so older status readers stay compile-clean; Region Pulse product is retired.
export const StationKernelRecord = Schema.Struct({
  observedAt: DisplayTimestamp,
  armedRegionCount: NonNegativeInteger,
  lastFireAt: Schema.optionalKey(DisplayTimestamp),
  lastFireKind: Schema.optionalKey(Schema.Literals(["watcher", "timer", "manual"])),
  lastFireDry: Schema.optionalKey(Schema.Boolean),
  fault: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMaxLength(1_024)))),
  orphanedArmingCount: NonNegativeInteger,
});
export type StationKernelRecord = typeof StationKernelRecord.Type;

const Deployments = Schema.Record(StationHostId, StationDeployRecord);

export const StationStatusDocument = Schema.Struct({
  version: Schema.Literal(STATION_STATUS_VERSION),
  kernel: Schema.optionalKey(StationKernelRecord),
  deployments: Schema.optionalKey(Deployments),
});
export type StationStatusDocument = typeof StationStatusDocument.Type;

export type StationProtocolPeerObservation = {
  readonly appVersion: StationAppVersion;
  readonly stateSchemaVersion: StationStateSchemaVersion;
  readonly support: StationProtocolSupport;
};

/**
 * Ephemeral compatibility truth for one CC-opened Station connection.
 *
 * The compatibility preface owns these diagnostics; Doctor and Fleet merely
 * project them for the operator.
 */
export type StationProtocolObservation =
  | {
      readonly compatibility: "compatible" | "deprecated";
      readonly negotiatedProtocol: StationProtocolVersion;
      readonly local: StationProtocolPeerObservation;
      readonly peer: StationProtocolPeerObservation;
    }
  | {
      readonly compatibility: "update-required";
      readonly local: StationProtocolPeerObservation;
      readonly peer: StationProtocolPeerObservation;
    };

export type StationRemoteObservation = {
  readonly hostId: string;
  readonly endpoint: string;
  readonly reachability: "reachable" | "unreachable" | "unknown";
  /** Whether these facts came from the current probe or a retained receipt. */
  readonly source?: "live" | "last-acknowledged";
  readonly observedAt?: string;
  /** Installation bound by the Command Center fleet target. */
  readonly expectedInstallationId?: string;
  readonly reachabilityError?: string;
  readonly protocol?: StationProtocolObservation;
  readonly route?: StationRouteObservation;
  readonly readiness?: StationReadinessObservation;
  /** Exact projected intent counts for this target, computed on Command Center. */
  readonly topology?: StationTopologyObservation;
  /** Last successful bounded projection and report reconciliation receipt. */
  readonly synchronization?: StationSynchronizationObservation;
  /** Package/deploy receipt facts are optional when the fleet has no receipt. */
  readonly packageGeneration?: string;
  readonly deployReceiptAt?: string;
  readonly deployRecoveryKind?: StationRecoveryKind;
  readonly recovery?: StationRecoveryGuidance;
  /** Exact typed response from the Remote's Station API. */
  readonly station?: StatusResponseValue;
  readonly observationError?: string;
};

export const defaultStationStatus = (): StationStatusDocument => ({
  version: STATION_STATUS_VERSION,
});

const decodeStatus = Schema.decodeUnknownResult(StationStatusDocument, {
  onExcessProperty: "error",
});

/** Strict boundary decode: retired pull/configure/projection fields are errors. */
export const decodeStationStatusDocument = (
  value: unknown,
): StationStatusDocument | undefined => {
  const decoded = decodeStatus(value);
  return Result.isSuccess(decoded) ? decoded.success : undefined;
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
  readonly configurationOk: boolean;
  readonly detail: string;
  readonly stages?: ReadonlyArray<string>;
  readonly recoveryKind?: StationRecoveryKind;
  readonly recoveryDetail?: string;
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
    configurationOk: input.configurationOk,
    detail: redactStationDiagnostic(input.detail).slice(0, 4_096),
    stages: (input.stages ?? [])
      .slice(-32)
      .map((stage) => redactStationDiagnostic(stage).slice(0, 512)),
    ...(input.recoveryKind === undefined
      ? {}
      : { recoveryKind: input.recoveryKind }),
    ...(input.recoveryDetail === undefined
      ? {}
      : { recoveryDetail: redactStationDiagnostic(input.recoveryDetail).slice(0, 4_096) }),
  });

/**
 * Durable receipt for a deployment refusal that provably never reached apply
 * (unreachable host, busy deploy slot, admission refusal). packageState and
 * role "previous" keep the station-status store's preservation guard in
 * force, so the record never clobbers the host's last observed package state,
 * role, version, or lastSeen with a version that was never installed.
 */
export const refusedBeforeApplyDeployRecord = (input: {
  readonly hostId: string;
  readonly endpoint: string;
  readonly detail: string;
  readonly stages?: ReadonlyArray<string>;
  readonly at?: string;
}): StationDeployRecord =>
  deployRecordFromResult({
    hostId: input.hostId,
    endpoint: input.endpoint,
    ok: false,
    outcome: "failed",
    packageState: "previous",
    role: "previous",
    configurationOk: false,
    detail: input.detail,
    ...(input.stages === undefined ? {} : { stages: input.stages }),
    recoveryKind: "retryable",
    ...(input.at === undefined ? {} : { at: input.at }),
  });

/**
 * Project the live kernel into the bounded operational facts Doctor needs.
 * Canvas names, node ids, agent identities, instructions, and tokens never
 * enter the observation table.
 */
export const kernelRecordFromSnapshot = (
  _snapshot: KernelSnapshot,
  observedAt = new Date().toISOString(),
): StationKernelRecord => {
  // Region Pulse delivery / arming product is retired — doctor fields stay
  // present at zero so status documents remain shape-stable.
  return {
    observedAt,
    armedRegionCount: 0,
    orphanedArmingCount: 0,
  };
};

export type StationDoctorInput = {
  readonly installationId: InstallationId;
  readonly configuration?: StationConfigurationValue;
  readonly configuredAt?: string;
  readonly projection?: StationProjectionReferenceValue;
  readonly receivedThrough: ReadonlyArray<RouteCursorValue>;
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

/** Remove credential, socket, path, and board-reference material at the
 * diagnostic boundary. Operator diagnostics are evidence, never a log dump. */
export const redactStationDiagnostic = (value: string): string =>
  value
    .replaceAll(
      /((?:bearer|authorization|access[_ -]?token|socket[_ -]?token|token|password|license(?:[_ -]?key)?|dodo(?:[_ -]?(?:key|activation)(?:[_ -]?id)?|[_ -]?id)?))\s*[:=]\s*[^\s,;]+/giu,
      "$1=[redacted]",
    )
    .replaceAll(/junto:\/\/[^\s)]+/giu, "junto://[redacted]")
    .replaceAll(
      /\b(?:agent|terminal|task|board|requests|artifacts|node)-[0-9A-Z]{8,}\b/giu,
      "[node redacted]",
    )
    .replaceAll(
      /(?:\/Users\/[^\s,;]+|\/home\/[^\s,;]+|[A-Za-z]:\\[^\s,;]+)/gu,
      "[path redacted]",
    );

const boundedDiagnostic = (
  value: string | undefined,
  fallback: string,
): string => {
  const normalized = value?.replaceAll(/\s+/gu, " ").trim();
  return redactStationDiagnostic(normalized || fallback).slice(0, 512);
};

const knownBoolean = (value: boolean | undefined): string =>
  value === undefined ? "unknown" : value ? "true" : "false";

const cursorText = (cursors: ReadonlyArray<RouteCursorValue> | undefined): string =>
  cursors
    ?.map((cursor) => `${cursor.eventHome}->${cursor.entityHome}:${cursor.through}`)
    .join(",") ?? "unknown";

const recoveryForRemote = (input: {
  readonly identityConflict: boolean;
  readonly protocol?: StationProtocolObservation;
  readonly unreachable: boolean;
  readonly stationAvailable: boolean;
  readonly readinessFailed: boolean;
  readonly stale: boolean;
}): StationRecoveryGuidance | undefined => {
  if (input.identityConflict) {
    return {
      kind: "identity-conflict",
      nextStep: "Verify the enrolled installation identity, then re-enroll the intended Remote.",
    };
  }
  if (input.protocol?.compatibility === "update-required") {
    return {
      kind: "update-required",
      nextStep: "Upgrade Command Center and Remote to a compatible Station protocol, then test the link.",
    };
  }
  if (input.unreachable) {
    return {
      kind: "retryable",
      nextStep: "Verify the SSH route and host availability, then retry the bounded link test.",
    };
  }
  if (!input.stationAvailable) {
    return {
      kind: "runtime-down",
      nextStep: "Start the supervised Junto Remote, then retry the link test.",
    };
  }
  if (input.readinessFailed || input.stale) {
    return {
      kind: "retryable",
      nextStep: "Restore the named readiness component or wait for a fresh Station observation, then retry.",
    };
  }
  return undefined;
};

export const stationRecoveryForRemote = recoveryForRemote;

type RemoteProjection = {
  readonly line: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly fleetBlind: boolean;
  readonly stale: boolean;
  readonly error: boolean;
  readonly recovery?: StationRecoveryGuidance;
};

const localConfigurationDetail = (
  configuration: StationConfigurationValue | undefined,
): string =>
  configuration === undefined
    ? "configuration absent"
    : configuration.role === "command-center"
      ? `Command Center - host ${configuration.hostId}`
      : `Remote - host ${configuration.hostId} - CC ${configuration.commandCenterInstallationId}`;

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
  if (input.readiness.session) lines.push("Station session ready");
  else {
    lines.push("Station session disconnected");
    raise("warning");
  }

  if (configuration?.role === "remote") {
    if (input.projection === undefined) {
      lines.push("projection absent");
      raise("warning");
    } else {
      lines.push(
        `projection ${input.projection.generation} - received ${input.projection.receivedAt}`,
      );
    }
  }
  const localCursors = input.receivedThrough
    .map(
      (cursor) =>
        `${cursor.eventHome}->${cursor.entityHome}:${cursor.through}`,
    )
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
      `kernel observed${stale ? " - stale" : ""} - watchers/timers (no pulse product)`,
    );
    if (stale) raise("warning");
    if (localKernel.fault) {
      lines.push(`kernel fault ${boundedDiagnostic(localKernel.fault, "unknown")}`);
      raise("error");
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
    const protocol = observation?.protocol;
    const route = observation?.route;
    const synchronization = observation?.synchronization;
    const topology = observation?.topology;
    const observedAt = observation?.observedAt ?? station?.observedAt;
    const expectedInstallationId = observation?.expectedInstallationId;
    const observedInstallationId = station?.installationId;
    const problems: string[] = [];
    let hardError = false;
    let fleetBlind = false;
    let stale = false;
    let identityConflict = false;
    let readinessFailed = false;

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
      if (deployment.recoveryKind !== undefined) {
        problems.push(
          `recovery ${deployment.recoveryKind}: ${boundedDiagnostic(
            deployment.recoveryDetail,
            "deployment recovery required",
          )}`,
        );
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
    } else if (protocol?.compatibility === "update-required") {
      problems.push("running locally — update required");
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
      if (protocol?.compatibility === "deprecated") {
        problems.push(
          `Station protocol ${protocol.negotiatedProtocol} deprecated`,
        );
      }
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
      if (
        expectedInstallationId !== undefined &&
        observedInstallationId !== undefined &&
        expectedInstallationId !== observedInstallationId
      ) {
        identityConflict = true;
        problems.push(
          `installation identity mismatch (expected ${expectedInstallationId}, observed ${observedInstallationId})`,
        );
        hardError = true;
      }
      const readiness = {
        ...station.readiness,
        ...(observation?.readiness ?? {}),
      };
      const notReady = Object.entries(readiness)
        .filter(([, ready]) => !ready)
        .map(([name]) => name);
      if (notReady.length > 0) {
        readinessFailed = true;
        problems.push(`not ready: ${notReady.join(", ")}`);
      }
      if (station.state === "degraded") problems.push("Station API degraded");
      if (station.projection === undefined) {
        problems.push("projection absent");
      }
    }

    if (route !== undefined && route.phase !== "ready") {
      problems.push(`route ${route.phase}`);
      if (route.phase === "update-required") fleetBlind = true;
    }
    if (synchronization !== undefined && !synchronization.converged) {
      problems.push("last work report did not converge");
    }
    if (
      observedAt !== undefined &&
      timestampIsStale(observedAt, now, STATION_KERNEL_STALE_AFTER_MS)
    ) {
      problems.push("Station observation stale");
      stale = true;
    }

    const recovery = observation?.recovery ?? recoveryForRemote({
      identityConflict,
      protocol,
      unreachable: observation?.reachability === "unreachable",
      stationAvailable: station !== undefined,
      readinessFailed,
      stale,
    });

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
        `Remote ${remoteHostId} (${endpoint}): Station API ${station?.state ?? "unavailable"} - ` +
        `installation ${station?.installationId ?? "unknown"} - ` +
        (protocol === undefined
          ? ""
          : `protocol ${protocol.compatibility}${
            protocol.compatibility === "update-required"
              ? ""
              : `/${protocol.negotiatedProtocol}`
          } - `) +
        `projection ${station?.projection?.generation ?? "absent"} - ` +
        `received ${station === undefined ? "unknown" : station.receivedThrough.length} - ` +
        `peer-acked ${station === undefined ? "unknown" : station.peerAcknowledgedThrough.length} - ` +
        `errors ${problems.join("; ") || "none"} - ` +
        `binding expected ${expectedInstallationId ?? "unknown"} observed ${observedInstallationId ?? "unknown"} - ` +
        `facts ${observation?.source ?? "unknown"} - ` +
        `route ${route?.phase ?? "unknown"} session ${route === undefined ? "unknown" : route.sessionOpen ? "open" : "closed"} - ` +
        `projection hash ${station?.projection?.contentSha256 ?? "unknown"} receivedAt ${station?.projection?.receivedAt ?? "unknown"} - ` +
        `package ${observation?.packageGeneration ?? deployment?.version ?? "unknown"} deploy-receipt ${observation?.deployReceiptAt ?? deployment?.at ?? "unknown"} - ` +
        `logical cursors ${cursorText(station?.receivedThrough)} peer cursors ${cursorText(station?.peerAcknowledgedThrough)} - ` +
        `synchronization ${synchronization === undefined ? "unknown" : synchronization.converged ? "converged" : "incomplete"} rounds ${synchronization?.reportRounds ?? "unknown"} rejected ${synchronization?.inboundRejected ?? "unknown"} - ` +
        `topology canvases=${topology?.canvasCount ?? "unknown"} nodes=${topology?.nodeCount ?? "unknown"} target-actors=${topology?.targetActorCount ?? "unknown"} target-sinks=${topology?.targetSinkCount ?? "unknown"} target-schedulers=${topology?.targetSchedulerCount ?? "unknown"} cross-to-cc=${topology?.remoteActorToCommandCenterSinkEdgeCount ?? "unknown"} cross-from-cc=${topology?.commandCenterActorToRemoteSinkEdgeCount ?? "unknown"} station-peer=${topology?.stationPeerEdgeCount ?? "unknown"} dangling=${topology?.danglingEdgeCount ?? "unknown"} - ` +
        `readiness database=${knownBoolean(station?.readiness.database)} work=${knownBoolean(station?.readiness.workControl)} simulation=${knownBoolean(station?.readiness.simulation)} terminal=${knownBoolean(observation?.readiness?.terminal)} browser=${knownBoolean(observation?.readiness?.browser)} - ` +
        `recovery ${recovery?.kind ?? "none"}${recovery === undefined ? "" : `: ${recovery.nextStep}`} - ` +
        `observation ${observedAt ?? "unknown"}`,
      metadata: {
        [`${prefix}state`]: state,
        [`${prefix}reachability`]: observation?.reachability ?? "unknown",
        [`${prefix}factSource`]: observation?.source ?? "unknown",
        [`${prefix}apiState`]: station?.state ?? "unavailable",
        [`${prefix}protocolCompatibility`]:
          protocol?.compatibility ?? "unknown",
        [`${prefix}protocolNegotiated`]:
          protocol !== undefined &&
            protocol.compatibility !== "update-required"
            ? String(protocol.negotiatedProtocol)
            : "unknown",
        [`${prefix}localAppVersion`]:
          protocol?.local.appVersion ?? "unknown",
        [`${prefix}localStateSchemaVersion`]:
          protocol === undefined
            ? "unknown"
            : String(protocol.local.stateSchemaVersion),
        [`${prefix}localProtocolPreferred`]:
          protocol === undefined
            ? "unknown"
            : String(protocol.local.support.preferred),
        [`${prefix}localProtocolCompatibleFrom`]:
          protocol === undefined
            ? "unknown"
            : String(protocol.local.support.compatibleFrom),
        [`${prefix}localProtocolWarnBelow`]:
          protocol === undefined
            ? "unknown"
            : String(protocol.local.support.warnBelow),
        [`${prefix}peerAppVersion`]:
          protocol?.peer?.appVersion ?? "unknown",
        [`${prefix}peerStateSchemaVersion`]:
          protocol?.peer === undefined
            ? "unknown"
            : String(protocol.peer.stateSchemaVersion),
        [`${prefix}peerProtocolPreferred`]:
          protocol?.peer === undefined
            ? "unknown"
            : String(protocol.peer.support.preferred),
        [`${prefix}peerProtocolCompatibleFrom`]:
          protocol?.peer === undefined
            ? "unknown"
            : String(protocol.peer.support.compatibleFrom),
        [`${prefix}peerProtocolWarnBelow`]:
          protocol?.peer === undefined
            ? "unknown"
            : String(protocol.peer.support.warnBelow),
        [`${prefix}installationId`]: station?.installationId ?? "unknown",
        [`${prefix}expectedInstallationId`]: expectedInstallationId ?? "unknown",
        [`${prefix}observedInstallationId`]: observedInstallationId ?? "unknown",
        [`${prefix}observedAt`]: observedAt ?? "unknown",
        [`${prefix}role`]: station?.configuration?.role ?? "unknown",
        [`${prefix}commandCenterInstallationId`]:
          station?.configuration?.role === "remote"
            ? station.configuration.commandCenterInstallationId
            : "unknown",
        [`${prefix}routePhase`]: route?.phase ?? "unknown",
        [`${prefix}routeSession`]: route === undefined ? "unknown" : route.sessionOpen ? "open" : "closed",
        [`${prefix}routeAttempt`]: route === undefined ? "unknown" : String(route.attempt),
        [`${prefix}routeUpdatedAt`]: route?.updatedAt ?? "unknown",
        [`${prefix}routeNextRetryAt`]: route?.nextRetryAt ?? "unknown",
        [`${prefix}projectionGeneration`]:
          station?.projection?.generation ?? "unknown",
        [`${prefix}projectionContentSha256`]:
          station?.projection?.contentSha256 ?? "unknown",
        [`${prefix}projectionReceivedAt`]:
          station?.projection?.receivedAt ?? "unknown",
        [`${prefix}packageGeneration`]:
          observation?.packageGeneration ?? deployment?.version ?? "unknown",
        [`${prefix}deployReceiptAt`]:
          observation?.deployReceiptAt ?? deployment?.at ?? "unknown",
        [`${prefix}deployRecoveryKind`]:
          observation?.deployRecoveryKind ?? deployment?.recoveryKind ?? "none",
        [`${prefix}receivedCursorCount`]:
          station === undefined ? "unknown" : String(station.receivedThrough.length),
        [`${prefix}receivedThrough`]:
          cursorText(station?.receivedThrough),
        [`${prefix}peerAcknowledgedCursorCount`]:
          station === undefined
            ? "unknown"
            : String(station.peerAcknowledgedThrough.length),
        [`${prefix}peerAcknowledgedThrough`]:
          cursorText(station?.peerAcknowledgedThrough),
        [`${prefix}synchronizationConverged`]:
          synchronization === undefined
            ? "unknown"
            : String(synchronization.converged),
        [`${prefix}synchronizationRounds`]:
          synchronization === undefined
            ? "unknown"
            : String(synchronization.reportRounds),
        [`${prefix}synchronizationInboundRejected`]:
          synchronization === undefined
            ? "unknown"
            : String(synchronization.inboundRejected),
        [`${prefix}topologyCanvasCount`]:
          topology === undefined ? "unknown" : String(topology.canvasCount),
        [`${prefix}topologyNodeCount`]:
          topology === undefined ? "unknown" : String(topology.nodeCount),
        [`${prefix}topologyTargetActorCount`]:
          topology === undefined
            ? "unknown"
            : String(topology.targetActorCount),
        [`${prefix}topologyTargetSinkCount`]:
          topology === undefined
            ? "unknown"
            : String(topology.targetSinkCount),
        [`${prefix}topologyTargetSchedulerCount`]:
          topology === undefined
            ? "unknown"
            : String(topology.targetSchedulerCount),
        [`${prefix}topologyRemoteActorToCommandCenterSinkEdgeCount`]:
          topology === undefined
            ? "unknown"
            : String(topology.remoteActorToCommandCenterSinkEdgeCount),
        [`${prefix}topologyCommandCenterActorToRemoteSinkEdgeCount`]:
          topology === undefined
            ? "unknown"
            : String(topology.commandCenterActorToRemoteSinkEdgeCount),
        [`${prefix}topologyStationPeerEdgeCount`]:
          topology === undefined
            ? "unknown"
            : String(topology.stationPeerEdgeCount),
        [`${prefix}topologyDanglingEdgeCount`]:
          topology === undefined
            ? "unknown"
            : String(topology.danglingEdgeCount),
        [`${prefix}databaseReady`]:
          knownBoolean(station?.readiness.database),
        [`${prefix}workControlReady`]:
          knownBoolean(station?.readiness.workControl),
        [`${prefix}simulationReady`]:
          knownBoolean(station?.readiness.simulation),
        [`${prefix}sessionReady`]:
          knownBoolean(station?.readiness.session),
        [`${prefix}terminalReady`]: knownBoolean(observation?.readiness?.terminal),
        [`${prefix}browserReady`]: knownBoolean(observation?.readiness?.browser),
        [`${prefix}recoveryKind`]: recovery?.kind ?? "none",
        [`${prefix}recoveryNextStep`]: recovery?.nextStep ?? "none",
        [`${prefix}errorCount`]: String(problems.length),
      },
      fleetBlind,
      stale,
      error: hardError,
      ...(recovery === undefined ? {} : { recovery }),
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
    detail: lines.join(" - "),
    metadata: {
      installationId: input.installationId,
      configurationState:
        configuration === undefined ? "unconfigured" : "configured",
      role: role || "unset",
      hostId,
      configuredAt: input.configuredAt ?? "unknown",
      projectionGeneration: input.projection?.generation ?? "unknown",
      projectionContentSha256: input.projection?.contentSha256 ?? "unknown",
      projectionReceivedAt: input.projection?.receivedAt ?? "unknown",
      receivedCursorCount: String(input.receivedThrough.length),
      receivedThrough: localCursors,
      databaseReady: input.readiness.database ? "true" : "false",
      workControlReady: input.readiness.workControl ? "true" : "false",
      simulationReady: input.readiness.simulation ? "true" : "false",
      sessionReady: input.readiness.session ? "true" : "false",
      terminalReady: "unknown",
      browserReady: "unknown",
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
          }
        : {}),
    },
  };
};
