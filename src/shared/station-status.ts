import type { ServiceCheck } from "./contracts";
import type { CanvasPullResult, CanvasPullStatus } from "./canvas-pull";
import type { KernelSnapshot } from "./ipc";
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

/**
 * Pulls are manual today, so freshness cannot pretend a tighter scheduler
 * exists. One day is the explicit operator policy: older last-known canvases
 * remain usable, but Doctor calls them stale.
 */
export const STATION_PULL_STALE_AFTER_MS = 24 * 60 * 60 * 1_000;

/**
 * The running kernel mirrors a heartbeat at least every 30 seconds. Four
 * missed heartbeats (two minutes) is the point where armed/fire state stops
 * being presented as live truth.
 */
export const STATION_KERNEL_STALE_AFTER_MS = 2 * 60 * 1_000;

export const STATION_PULL_ADMISSION_VERSION = 1 as const;

export type StationPullAdmissionWitness = {
  readonly version: typeof STATION_PULL_ADMISSION_VERSION;
  /** Physical Remote identity at the successful pull boundary. */
  readonly stationHostId: string;
  /** SHA-256 of the complete station configuration tuple. */
  readonly stationConfigSha256: string;
  /** SHA-256 of canonical names + exact bytes in the local canvas mirror. */
  readonly canvasMirrorSha256: string;
  readonly canvasCount: number;
};

export type StationPullRecord = {
  readonly at: string;
  readonly status: CanvasPullStatus;
  readonly ok: boolean;
  readonly detail: string;
  readonly commandCenterRef: string;
  readonly keptLocal: boolean;
  readonly pulledCount: number;
  readonly failedCount: number;
  /**
   * Present only after a complete Remote pull committed and the local mirror
   * was observed under the same station configuration. Descriptive legacy
   * pull rows intentionally decode without it and are never admission proof.
   */
  readonly admission?: StationPullAdmissionWitness;
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

export type StationKernelRecord = {
  readonly observedAt: string;
  readonly armedRegionCount: number;
  readonly lastFireAt?: string;
  readonly lastFireKind?: "watcher" | "timer" | "manual";
  readonly lastFireDry?: boolean;
  readonly fault?: string;
  readonly orphanedArmingCount: number;
};

/**
 * Command Center → Station projection delivery receipt (Cut 5 / 7.1).
 * Distinct from lastPull (Remote canvas-pull path). Tracks push intent
 * reachability truth: pending → applied | rejected | unreachable.
 */
export type StationProjectionDeliveryStatus =
  | "applied"
  | "pending"
  | "unreachable"
  | "rejected";

export type StationProjectionRecord = {
  readonly at: string;
  readonly hostId: string;
  /** Registered SSH endpoint when the target is remote; omitted for local/test. */
  readonly endpoint?: string;
  readonly generation: string;
  readonly manifestSha256: string;
  readonly frameSha256?: string;
  readonly status: StationProjectionDeliveryStatus;
  readonly ok: boolean;
  readonly detail: string;
};

export type StationStatusDocument = {
  readonly version: typeof STATION_STATUS_VERSION;
  readonly lastPull?: StationPullRecord;
  readonly lastConfigure?: StationConfigureRecord;
  /** Bounded, non-authorial heartbeat for SSH-readable fleet diagnostics. */
  readonly kernel?: StationKernelRecord;
  /** Latest durable deployment receipt for each registered Remote host. */
  readonly deployments?: Readonly<Record<string, StationDeployRecord>>;
  /**
   * Most recent projection delivery attempt (any host). Doctor / Settings
   * surface this as reachability truth; not live canvas authority.
   */
  readonly lastProjection?: StationProjectionRecord;
  /** Latest projection delivery receipt per enrolled host id. */
  readonly projections?: Readonly<Record<string, StationProjectionRecord>>;
};

export type StationRemoteObservation = {
  readonly hostId: string;
  readonly endpoint: string;
  readonly reachability: "reachable" | "unreachable" | "unknown";
  readonly reachabilityError?: string;
  readonly settingsState: "observed" | "unavailable" | "invalid";
  readonly stationRole?: string;
  readonly stationHostId?: string;
  readonly statusState: "observed" | "unavailable" | "invalid";
  readonly status?: StationStatusDocument;
  readonly observationError?: string;
};

export const defaultStationStatus = (): StationStatusDocument => ({
  version: STATION_STATUS_VERSION,
});

export const stationStatusPath = (home: string): string =>
  `${home}/.vellum/station-status.json`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isFiniteNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  Number.isInteger(value) &&
  value >= 0;

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

const decodePullAdmissionWitness = (
  value: unknown,
): StationPullAdmissionWitness | undefined => {
  if (
    !isRecord(value) ||
    value.version !== STATION_PULL_ADMISSION_VERSION ||
    typeof value.stationHostId !== "string" ||
    value.stationHostId.length === 0 ||
    value.stationHostId.length > 64 ||
    typeof value.stationConfigSha256 !== "string" ||
    !SHA256_HEX_PATTERN.test(value.stationConfigSha256) ||
    typeof value.canvasMirrorSha256 !== "string" ||
    !SHA256_HEX_PATTERN.test(value.canvasMirrorSha256) ||
    !isFiniteNonNegativeInteger(value.canvasCount)
  ) {
    return undefined;
  }
  return {
    version: STATION_PULL_ADMISSION_VERSION,
    stationHostId: value.stationHostId,
    stationConfigSha256: value.stationConfigSha256,
    canvasMirrorSha256: value.canvasMirrorSha256,
    canvasCount: value.canvasCount,
  };
};

const decodePullRecord = (value: unknown): StationPullRecord | undefined => {
  if (!isRecord(value)) return undefined;
  const status = value.status;
  const admission =
    value.admission === undefined
      ? undefined
      : decodePullAdmissionWitness(value.admission);
  if (
    typeof value.at !== "string" ||
    !["ok", "partial", "empty", "unreachable", "misconfigured", "skipped_not_remote"].includes(
      String(status),
    ) ||
    typeof value.ok !== "boolean" ||
    typeof value.detail !== "string" ||
    typeof value.commandCenterRef !== "string" ||
    typeof value.keptLocal !== "boolean" ||
    !isFiniteNonNegativeInteger(value.pulledCount) ||
    !isFiniteNonNegativeInteger(value.failedCount) ||
    (value.admission !== undefined && admission === undefined)
  ) {
    return undefined;
  }
  return {
    at: value.at,
    status: status as CanvasPullStatus,
    ok: value.ok,
    detail: value.detail.slice(0, 4_096),
    commandCenterRef: value.commandCenterRef.slice(0, 255),
    keptLocal: value.keptLocal,
    pulledCount: value.pulledCount,
    failedCount: value.failedCount,
    ...(admission === undefined ? {} : { admission }),
  };
};

const decodeConfigureRecord = (
  value: unknown,
): StationConfigureRecord | undefined => {
  if (
    !isRecord(value) ||
    typeof value.at !== "string" ||
    typeof value.ok !== "boolean" ||
    typeof value.hostId !== "string" ||
    typeof value.detail !== "string"
  ) {
    return undefined;
  }
  return {
    at: value.at,
    ok: value.ok,
    hostId: value.hostId.slice(0, 64),
    detail: value.detail.slice(0, 4_096),
  };
};

const decodeKernelRecord = (
  value: unknown,
): StationKernelRecord | undefined => {
  if (
    !isRecord(value) ||
    typeof value.observedAt !== "string" ||
    !isFiniteNonNegativeInteger(value.armedRegionCount) ||
    !isFiniteNonNegativeInteger(value.orphanedArmingCount)
  ) {
    return undefined;
  }
  if (
    value.lastFireAt !== undefined &&
    typeof value.lastFireAt !== "string"
  ) {
    return undefined;
  }
  if (
    value.lastFireKind !== undefined &&
    value.lastFireKind !== "watcher" &&
    value.lastFireKind !== "timer" &&
    value.lastFireKind !== "manual"
  ) {
    return undefined;
  }
  if (
    value.lastFireDry !== undefined &&
    typeof value.lastFireDry !== "boolean"
  ) {
    return undefined;
  }
  if (value.fault !== undefined && typeof value.fault !== "string") {
    return undefined;
  }
  return {
    observedAt: value.observedAt,
    armedRegionCount: value.armedRegionCount,
    ...(typeof value.lastFireAt === "string"
      ? { lastFireAt: value.lastFireAt }
      : {}),
    ...(value.lastFireKind === "watcher" ||
    value.lastFireKind === "timer" ||
    value.lastFireKind === "manual"
      ? { lastFireKind: value.lastFireKind }
      : {}),
    ...(typeof value.lastFireDry === "boolean"
      ? { lastFireDry: value.lastFireDry }
      : {}),
    ...(typeof value.fault === "string"
      ? { fault: value.fault.slice(0, 1_024) }
      : {}),
    orphanedArmingCount: value.orphanedArmingCount,
  };
};

const decodeDeployRecord = (
  value: unknown,
): StationDeployRecord | undefined => {
  if (
    !isRecord(value) ||
    typeof value.at !== "string" ||
    typeof value.hostId !== "string" ||
    typeof value.endpoint !== "string" ||
    typeof value.ok !== "boolean" ||
    !["ready", "failed", "rolled-back", "indeterminate"].includes(
      String(value.outcome),
    ) ||
    !["present", "previous", "unknown"].includes(
      String(value.packageState),
    ) ||
    !["remote", "previous", "unknown"].includes(String(value.role)) ||
    typeof value.version !== "string" ||
    !["not-required", "restored", "failed"].includes(
      String(value.rollback),
    ) ||
    typeof value.configurationOk !== "boolean" ||
    typeof value.detail !== "string" ||
    !Array.isArray(value.stages) ||
    value.stages.length > 32 ||
    !value.stages.every((stage) => typeof stage === "string") ||
    (value.lastSeen !== undefined && typeof value.lastSeen !== "string")
  ) {
    return undefined;
  }
  return {
    at: value.at,
    hostId: value.hostId.slice(0, 64),
    endpoint: value.endpoint.slice(0, 255),
    ok: value.ok,
    outcome: value.outcome as StationDeployOutcome,
    packageState: value.packageState as StationDeployRecord["packageState"],
    role: value.role as StationDeployRecord["role"],
    version: value.version.slice(0, 128),
    ...(typeof value.lastSeen === "string"
      ? { lastSeen: value.lastSeen }
      : {}),
    rollback: value.rollback as StationDeployRecord["rollback"],
    configurationOk: value.configurationOk,
    detail: value.detail.slice(0, 4_096),
    stages: value.stages.map((stage) => stage.slice(0, 512)),
  };
};

const PROJECTION_STATUSES = new Set<string>([
  "applied",
  "pending",
  "unreachable",
  "rejected",
]);

const GENERATION_PATTERN = /^(0|[1-9][0-9]*)$/;

const decodeProjectionRecord = (
  value: unknown,
): StationProjectionRecord | undefined => {
  if (
    !isRecord(value) ||
    typeof value.at !== "string" ||
    typeof value.hostId !== "string" ||
    value.hostId.length === 0 ||
    value.hostId.length > 64 ||
    typeof value.generation !== "string" ||
    !GENERATION_PATTERN.test(value.generation) ||
    value.generation.length > 32 ||
    typeof value.manifestSha256 !== "string" ||
    !SHA256_HEX_PATTERN.test(value.manifestSha256) ||
    !PROJECTION_STATUSES.has(String(value.status)) ||
    typeof value.ok !== "boolean" ||
    typeof value.detail !== "string" ||
    (value.endpoint !== undefined && typeof value.endpoint !== "string") ||
    (value.frameSha256 !== undefined &&
      (typeof value.frameSha256 !== "string" ||
        !SHA256_HEX_PATTERN.test(value.frameSha256)))
  ) {
    return undefined;
  }
  return {
    at: value.at,
    hostId: value.hostId.slice(0, 64),
    ...(typeof value.endpoint === "string"
      ? { endpoint: value.endpoint.slice(0, 255) }
      : {}),
    generation: value.generation,
    manifestSha256: value.manifestSha256,
    ...(typeof value.frameSha256 === "string"
      ? { frameSha256: value.frameSha256 }
      : {}),
    status: value.status as StationProjectionDeliveryStatus,
    ok: value.ok,
    detail: value.detail.slice(0, 4_096),
  };
};

/**
 * Decode the owner-local or SSH-read status mirror without trusting its shape.
 * Unknown fields are dropped; an invalid known field rejects the document so
 * Doctor reports corruption instead of inventing health.
 */
export const decodeStationStatusDocument = (
  value: unknown,
): StationStatusDocument | undefined => {
  if (!isRecord(value) || value.version !== STATION_STATUS_VERSION) {
    return undefined;
  }
  const lastPull =
    value.lastPull === undefined
      ? undefined
      : decodePullRecord(value.lastPull);
  const lastConfigure =
    value.lastConfigure === undefined
      ? undefined
      : decodeConfigureRecord(value.lastConfigure);
  const kernel =
    value.kernel === undefined
      ? undefined
      : decodeKernelRecord(value.kernel);
  const lastProjection =
    value.lastProjection === undefined
      ? undefined
      : decodeProjectionRecord(value.lastProjection);
  if (
    (value.lastPull !== undefined && !lastPull) ||
    (value.lastConfigure !== undefined && !lastConfigure) ||
    (value.kernel !== undefined && !kernel) ||
    (value.lastProjection !== undefined && !lastProjection)
  ) {
    return undefined;
  }

  let deployments: Record<string, StationDeployRecord> | undefined;
  if (value.deployments !== undefined) {
    if (!isRecord(value.deployments)) return undefined;
    const entries = Object.entries(value.deployments);
    if (entries.length > 32) return undefined;
    deployments = {};
    for (const [hostId, raw] of entries) {
      const deployment = decodeDeployRecord(raw);
      if (!deployment || deployment.hostId !== hostId) return undefined;
      deployments[hostId] = deployment;
    }
  }

  let projections: Record<string, StationProjectionRecord> | undefined;
  if (value.projections !== undefined) {
    if (!isRecord(value.projections)) return undefined;
    const entries = Object.entries(value.projections);
    if (entries.length > 32) return undefined;
    projections = {};
    for (const [hostId, raw] of entries) {
      const projection = decodeProjectionRecord(raw);
      if (!projection || projection.hostId !== hostId) return undefined;
      projections[hostId] = projection;
    }
  }

  return {
    version: STATION_STATUS_VERSION,
    ...(lastPull ? { lastPull } : {}),
    ...(lastConfigure ? { lastConfigure } : {}),
    ...(kernel ? { kernel } : {}),
    ...(deployments ? { deployments } : {}),
    ...(lastProjection ? { lastProjection } : {}),
    ...(projections ? { projections } : {}),
  };
};

export const pullRecordFromResult = (
  result: CanvasPullResult,
  admission?: StationPullAdmissionWitness,
): StationPullRecord => ({
  at: result.pulledAt,
  status: result.status,
  ok: result.ok,
  detail: result.detail,
  commandCenterRef: result.commandCenterRef,
  keptLocal: result.keptLocal,
  pulledCount: result.pulled.length,
  failedCount: result.failed.length,
  ...(admission === undefined ? {} : { admission }),
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

export const projectionRecordFromResult = (input: {
  readonly hostId: string;
  readonly endpoint?: string;
  readonly generation: string;
  readonly manifestSha256: string;
  readonly frameSha256?: string;
  readonly status: StationProjectionDeliveryStatus;
  readonly detail: string;
  readonly at?: string;
}): StationProjectionRecord => ({
  at: input.at ?? new Date().toISOString(),
  hostId: input.hostId.slice(0, 64),
  ...(input.endpoint ? { endpoint: input.endpoint.slice(0, 255) } : {}),
  generation: input.generation,
  manifestSha256: input.manifestSha256,
  ...(input.frameSha256 ? { frameSha256: input.frameSha256 } : {}),
  status: input.status,
  ok: input.status === "applied",
  detail: input.detail.slice(0, 4_096),
});

/**
 * Project the live kernel into the only facts fleet Doctor needs. Canvas
 * names, node ids, summaries, agent keys, and instructions never cross into
 * this durable status mirror.
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
  readonly role: string;
  readonly hostId: string;
  readonly commandCenterRef: string;
  readonly version?: string;
  readonly supervisedPreferred: boolean;
  readonly supervisedInstalled: SupervisedInstallState;
  readonly status: StationStatusDocument;
  /** Current in-process kernel truth for this station. */
  readonly kernel?: StationKernelRecord;
  /** Current registry endpoints; omitted only when the registry cannot be read. */
  readonly registeredRemoteEndpoints?: Readonly<Record<string, string>>;
  /** SSH observations for registered Remotes; omitted when host probing failed globally. */
  readonly remoteObservations?: ReadonlyArray<StationRemoteObservation>;
  /** Work control socket present and token file readable (agent CLI plane). */
  readonly workControlReady: boolean;
  /** Deterministic freshness seam for Doctor tests. */
  readonly now?: number;
};

const timestampIsStale = (
  value: string,
  now: number,
  thresholdMs: number,
): boolean => {
  const observed = Date.parse(value);
  return !Number.isFinite(observed) || now - observed > thresholdMs;
};

const boundedDiagnostic = (value: string | undefined, fallback: string): string => {
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

/**
 * Pure doctor check for station fleet + agent tooling readiness.
 */
export const assessStationDoctor = (input: StationDoctorInput): ServiceCheck => {
  const role = input.role;
  const now = input.now ?? Date.now();
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
  const pullStale =
    pull !== undefined &&
    timestampIsStale(pull.at, now, STATION_PULL_STALE_AFTER_MS);
  if (pull) {
    lines.push(
      `last pull ${pull.status}${pull.ok ? "" : " (failed)"}${pullStale ? " (stale)" : ""} · ${pull.pulledCount} file(s) · ${pull.at}`,
    );
    if (pullStale) raise("warning");
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

  const lastProjection = input.status.lastProjection;
  if (lastProjection) {
    lines.push(
      `last projection ${lastProjection.status} · gen ${lastProjection.generation} · host ${lastProjection.hostId} · ${lastProjection.at}`,
    );
    if (lastProjection.status === "rejected") raise("warning");
    if (lastProjection.status === "unreachable") raise("warning");
    if (lastProjection.status === "pending") raise("warning");
  }

  const deployments = Object.values(input.status.deployments ?? {}).sort((a, b) =>
    a.hostId.localeCompare(b.hostId),
  );
  const deploymentByHost = new Map(
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
  const registeredEndpoints = new Map<string, string>(
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
    const registeredEndpoint = registeredEndpoints.get(deployment.hostId);
    if (registryKnown) {
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
  }

  const activeDeployments = deployments.filter(
    (deployment) =>
      !registryKnown ||
      registeredEndpoints.get(deployment.hostId) === deployment.endpoint,
  );
  const latestDeployment = [...activeDeployments].sort((a, b) =>
    b.at.localeCompare(a.at),
  )[0];

  if (input.version !== undefined || input.kernel !== undefined) {
    const localErrors: string[] = [];
    const localKernel = input.kernel;
    const localKernelStale =
      localKernel !== undefined &&
      timestampIsStale(
        localKernel.observedAt,
        now,
        STATION_KERNEL_STALE_AFTER_MS,
      );
    if (localKernelStale) localErrors.push("kernel status stale");
    if (localKernel?.fault) {
      localErrors.push(boundedDiagnostic(localKernel.fault, "kernel fault"));
      raise("error");
    }
    if ((localKernel?.orphanedArmingCount ?? 0) > 0) {
      localErrors.push(
        `${localKernel!.orphanedArmingCount} orphaned armed region(s)`,
      );
      raise("warning");
    }
    if (role === "remote" && localKernel?.armedRegionCount === 0) {
      localErrors.push("Remote not armed");
      raise("warning");
    }
    if (localKernelStale) raise("warning");
    if (role === "remote" && pullStale) localErrors.push("pull stale");
    if (role === "remote" && pull === undefined) {
      localErrors.push("no canvas pull recorded");
    }

    const localLastPull =
      role !== "remote"
        ? "n/a"
        : pull
          ? `${pull.status} ${pull.at}${pullStale ? " (stale)" : ""}`
          : "never";
    const localArmed =
      localKernel === undefined
        ? "unknown"
        : `${localKernel.armedRegionCount > 0 ? "yes" : "no"} (${localKernel.armedRegionCount}${localKernelStale ? ", stale" : ""})`;
    const localLastFire =
      localKernel?.lastFireAt
        ? `${localKernel.lastFireAt} ${localKernel.lastFireKind ?? "unknown"} ${localKernel.lastFireDry ? "dry" : "live"}`
        : localKernel
          ? "never"
          : "unknown";
    lines.push(
      `Local station: installed yes · role ${role || "unset"} · version ${input.version ?? "unknown"} · hostId ${input.hostId} · last pull ${localLastPull} · armed ${localArmed} · last fire ${localLastFire} · errors ${localErrors.join("; ") || "none"}`,
    );
  }

  const remoteProjections: RemoteProjection[] = [];
  for (const [hostId, endpoint] of [...registeredEndpoints].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const candidateDeployment = deploymentByHost.get(hostId);
    const deployment =
      candidateDeployment?.endpoint === endpoint
        ? candidateDeployment
        : undefined;
    const candidateObservation = observationByHost.get(hostId);
    const observation =
      candidateObservation?.endpoint === endpoint
        ? candidateObservation
        : undefined;

    const errors: string[] = [];
    let hardError = false;
    let fleetBlind = false;
    let stale = false;

    const installed =
      deployment?.packageState === "present"
        ? "yes"
        : deployment?.packageState === "unknown"
          ? "unknown"
          : "no";
    if (!deployment) {
      errors.push("registered but not installed by Command Center");
    } else {
      if (deployment.outcome === "indeterminate") {
        errors.push(
          `deploy indeterminate (last seen ${deployment.lastSeen ?? "never"})`,
        );
        hardError = true;
      } else if (deployment.outcome !== "ready") {
        errors.push(`deploy ${deployment.outcome}`);
      }
      if (
        deployment.lastSeen &&
        timestampIsStale(
          deployment.lastSeen,
          now,
          STATION_PULL_STALE_AFTER_MS,
        )
      ) {
        errors.push("install observation stale");
        stale = true;
      }
      if (deployment.packageState !== "present") {
        errors.push(`package state ${deployment.packageState}`);
      }
      if (deployment.version === "unknown") errors.push("version unknown");
    }

    const reachability = observation?.reachability ?? "unknown";
    if (reachability === "unreachable") {
      hardError = true;
      fleetBlind = true;
      errors.push(
        `fleet-blind: ${boundedDiagnostic(
          observation?.reachabilityError,
          "Remote unreachable",
        )}`,
      );
    } else if (observation === undefined) {
      fleetBlind = true;
      errors.push("fleet-blind: Remote status not observed");
    } else {
      if (observation.settingsState === "invalid") {
        hardError = true;
        errors.push("Remote settings invalid");
      } else if (observation.settingsState !== "observed") {
        fleetBlind = true;
      }
      if (observation.statusState === "invalid") {
        hardError = true;
        errors.push("Remote station status invalid");
      } else if (observation.statusState !== "observed") {
        fleetBlind = true;
      }
      if (
        observation.settingsState !== "observed" ||
        observation.statusState !== "observed"
      ) {
        errors.push(
          `fleet-blind: ${boundedDiagnostic(
            observation.observationError,
            "station status files unavailable",
          )}`,
        );
      }
    }

    const observedRole =
      observation?.settingsState === "observed"
        ? observation.stationRole
        : undefined;
    const remoteRole =
      observedRole ??
      (deployment?.role === "remote" ? "remote" : "unknown");
    if (observedRole !== undefined && observedRole !== "remote") {
      errors.push(`role ${observedRole || "unset"} (expected remote)`);
      hardError = true;
    }
    if (
      observation?.settingsState === "observed" &&
      observation.stationHostId !== undefined &&
      observation.stationHostId !== hostId
    ) {
      errors.push(
        `hostId ${observation.stationHostId} (expected ${hostId})`,
      );
      hardError = true;
    }

    const remoteStatus =
      observation?.statusState === "observed"
        ? observation.status
        : undefined;
    const remotePull = remoteStatus?.lastPull;
    const remotePullStale =
      remotePull !== undefined &&
      timestampIsStale(
        remotePull.at,
        now,
        STATION_PULL_STALE_AFTER_MS,
      );
    if (remotePullStale) {
      errors.push("pull stale");
      stale = true;
    } else if (remoteStatus && !remotePull) {
      errors.push("no canvas pull recorded");
    }
    const lastPullText = remotePull
      ? `${remotePull.status} ${remotePull.at}${remotePullStale ? " (stale)" : ""}`
      : remoteStatus
        ? "never"
        : "unknown";

    const remoteKernel = remoteStatus?.kernel;
    const remoteKernelStale =
      remoteKernel !== undefined &&
      timestampIsStale(
        remoteKernel.observedAt,
        now,
        STATION_KERNEL_STALE_AFTER_MS,
      );
    if (remoteKernelStale) {
      errors.push("kernel status stale");
      stale = true;
    }
    if (remoteStatus && !remoteKernel) {
      errors.push("fleet-blind: kernel status unavailable");
      fleetBlind = true;
    }
    if (remoteKernel?.armedRegionCount === 0) {
      errors.push("Remote not armed");
    }
    if (remoteKernel?.fault) {
      errors.push(boundedDiagnostic(remoteKernel.fault, "kernel fault"));
      hardError = true;
    }
    if ((remoteKernel?.orphanedArmingCount ?? 0) > 0) {
      errors.push(
        `${remoteKernel!.orphanedArmingCount} orphaned armed region(s)`,
      );
    }
    const armedText =
      remoteKernel === undefined
        ? "unknown"
        : `${remoteKernel.armedRegionCount > 0 ? "yes" : "no"} (${remoteKernel.armedRegionCount}${remoteKernelStale ? ", stale" : ""})`;
    const lastFireText =
      remoteKernel?.lastFireAt
        ? `${remoteKernel.lastFireAt} ${remoteKernel.lastFireKind ?? "unknown"} ${remoteKernel.lastFireDry ? "dry" : "live"}`
        : remoteKernel
          ? "never"
          : "unknown";

    const state = hardError
      ? "error"
      : fleetBlind
        ? "fleet-blind"
        : stale
          ? "stale"
          : errors.length > 0
            ? "warning"
            : "ok";
    if (hardError) raise("error");
    else if (fleetBlind || stale || errors.length > 0) raise("warning");

    const metadataPrefix = `remote.${hostId}.`;
    remoteProjections.push({
      line:
        `Remote ${hostId} (${endpoint}): installed ${
          installed === "no" && !deployment
            ? "no (no managed install receipt)"
            : installed
        } · role ${remoteRole} · version ${deployment?.version ?? "unknown"} · hostId ${hostId} · ` +
        `last pull ${lastPullText} · armed ${armedText} · last fire ${lastFireText} · reachability ${reachability} · errors ${errors.join("; ") || "none"}`,
      metadata: {
        [`${metadataPrefix}installed`]: installed,
        [`${metadataPrefix}role`]: remoteRole,
        [`${metadataPrefix}version`]: deployment?.version ?? "unknown",
        [`${metadataPrefix}lastPullStatus`]: remotePull?.status ?? "unknown",
        [`${metadataPrefix}lastPullAt`]: remotePull?.at ?? "",
        [`${metadataPrefix}lastPullStale`]: remotePullStale ? "true" : "false",
        [`${metadataPrefix}armed`]:
          remoteKernel === undefined
            ? "unknown"
            : remoteKernel.armedRegionCount > 0
              ? "true"
              : "false",
        [`${metadataPrefix}armedCount`]:
          remoteKernel === undefined
            ? ""
            : String(remoteKernel.armedRegionCount),
        [`${metadataPrefix}kernelObservedAt`]:
          remoteKernel?.observedAt ?? "",
        [`${metadataPrefix}kernelStale`]:
          remoteKernelStale ? "true" : "false",
        [`${metadataPrefix}lastFireAt`]:
          remoteKernel?.lastFireAt ?? "",
        [`${metadataPrefix}reachability`]: reachability,
        [`${metadataPrefix}state`]: state,
        [`${metadataPrefix}errorCount`]: String(errors.length),
      },
      fleetBlind,
      stale,
      error: hardError,
    });
  }
  lines.push(...remoteProjections.map((projection) => projection.line));

  const roleKey = role.length > 0 ? role : "unset";
  const remoteMetadata = Object.assign(
    {},
    ...remoteProjections.map((projection) => projection.metadata),
  ) as Record<string, string>;
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
            lastPullStale: pullStale ? "true" : "false",
          }
        : {}),
      ...(input.kernel
        ? {
            kernelObservedAt: input.kernel.observedAt,
            kernelArmedCount: String(input.kernel.armedRegionCount),
            kernelLastFireAt: input.kernel.lastFireAt ?? "",
          }
        : {}),
      ...(configure
        ? {
            lastConfigureOk: configure.ok ? "true" : "false",
            lastConfigureHostId: configure.hostId,
            lastConfigureAt: configure.at,
          }
        : {}),
      ...(lastProjection
        ? {
            lastProjectionStatus: lastProjection.status,
            lastProjectionOk: lastProjection.ok ? "true" : "false",
            lastProjectionGeneration: lastProjection.generation,
            lastProjectionManifestSha256: lastProjection.manifestSha256,
            lastProjectionHostId: lastProjection.hostId,
            lastProjectionAt: lastProjection.at,
            lastProjectionDetail: lastProjection.detail.slice(0, 512),
          }
        : {}),
      deploymentCount: String(activeDeployments.length),
      staleDeploymentCount: String(deployments.length - activeDeployments.length),
      remoteCount: String(remoteProjections.length),
      remoteFleetBlindCount: String(
        remoteProjections.filter((projection) => projection.fleetBlind).length,
      ),
      remoteStaleCount: String(
        remoteProjections.filter((projection) => projection.stale).length,
      ),
      remoteErrorCount: String(
        remoteProjections.filter((projection) => projection.error).length,
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

/** Type guard for StationRole from settings string. */
export const asStationRoleLabel = (role: string): StationRole | "" =>
  role === "command-center" || role === "remote" ? role : "";
