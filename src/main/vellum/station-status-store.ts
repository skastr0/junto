/**
 * Durable station/fleet receipts in the app-owned SQLite StateEngine.
 *
 * The exported Promise functions are the compatibility seam used by existing
 * main-process integrations. They delegate to the one service instance
 * acquired by the app runtime; this module never opens a database.
 */

import { Context, Effect, Layer, Schema } from "effect";
import {
  decodeStationStatusDocument,
  defaultStationStatus,
  STATION_STATUS_VERSION,
  type StationConfigureRecord,
  type StationDeployRecord,
  type StationKernelRecord,
  type StationProjectionRecord,
  type StationPullRecord,
  type StationStatusDocument,
} from "@shared/station-status";
import {
  StateEngine,
  type StateEngineError,
  type StateReader,
  type StateWriter,
} from "./state/service";

type StationStatusFactKind =
  | "pull"
  | "last-configure"
  | "configure"
  | "kernel"
  | "deployment"
  | "last-projection"
  | "projection";

type StationStatusFactRow = {
  readonly kind: StationStatusFactKind;
  readonly host_id: string;
  readonly record_json: string;
  readonly projection_generation: string | null;
};

export class StationStatusStoreError extends Schema.TaggedError<StationStatusStoreError>()(
  "StationStatusStoreError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Defect,
  },
) {}

const stationStatusStoreError = (
  operation: string,
  cause: unknown,
): StationStatusStoreError =>
  cause instanceof StationStatusStoreError
    ? cause
    : StationStatusStoreError.make({
        operation,
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });

const fromStateError = (
  operation: string,
  error: StateEngineError,
): StationStatusStoreError => stationStatusStoreError(operation, error);

export type StationStatusChangeKind =
  | "pull"
  | "configure"
  | "kernel"
  | "deployment"
  | "projection";

export type StationStatusChange = {
  readonly kind: StationStatusChangeKind;
  readonly previous: StationStatusDocument;
  readonly current: StationStatusDocument;
};

export class StationStatusService extends Context.Tag(
  "@vellum/StationStatusService",
)<
  StationStatusService,
  {
    readonly read: Effect.Effect<
      StationStatusDocument,
      StationStatusStoreError
    >;
    readonly recordPull: (
      pull: StationPullRecord,
    ) => Effect.Effect<void, StationStatusStoreError>;
    readonly recordConfigure: (
      configure: StationConfigureRecord,
    ) => Effect.Effect<void, StationStatusStoreError>;
    readonly recordKernel: (
      kernel: StationKernelRecord,
    ) => Effect.Effect<void, StationStatusStoreError>;
    readonly recordDeployment: (
      deployment: StationDeployRecord,
      configure: StationConfigureRecord,
    ) => Effect.Effect<void, StationStatusStoreError>;
    readonly recordProjection: (
      projection: StationProjectionRecord,
    ) => Effect.Effect<void, StationStatusStoreError>;
  }
>() {}

const statusListeners = new Set<(change: StationStatusChange) => void>();

export const subscribeStationStatus = (
  listener: (change: StationStatusChange) => void,
): (() => void) => {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
};

const notifyStationStatus = (change: StationStatusChange): void => {
  for (const listener of statusListeners) {
    try {
      listener(change);
    } catch {
      // The database transition already committed. One observer must not
      // prevent independent health/readiness consumers from seeing the fact.
      console.warn("[vellum:station-status] listener failed");
    }
  }
};

const parseFact = (row: StationStatusFactRow): unknown => {
  try {
    return JSON.parse(row.record_json) as unknown;
  } catch (error) {
    throw stationStatusStoreError("read.decode-json", error);
  }
};

const readDocument = (reader: StateReader): StationStatusDocument => {
  const rows = reader.all<StationStatusFactRow>(
    `
      SELECT kind, host_id, record_json, projection_generation
      FROM station_status_facts
      ORDER BY kind, host_id
    `,
  );
  if (rows.length === 0) return defaultStationStatus();

  const raw: {
    version: typeof STATION_STATUS_VERSION;
    lastPull?: unknown;
    lastConfigure?: unknown;
    configures?: Record<string, unknown>;
    kernel?: unknown;
    deployments?: Record<string, unknown>;
    lastProjection?: unknown;
    projections?: Record<string, unknown>;
  } = { version: STATION_STATUS_VERSION };

  for (const row of rows) {
    const record = parseFact(row);
    switch (row.kind) {
      case "pull":
        raw.lastPull = record;
        break;
      case "last-configure":
        raw.lastConfigure = record;
        break;
      case "configure":
        (raw.configures ??= {})[row.host_id] = record;
        break;
      case "kernel":
        raw.kernel = record;
        break;
      case "deployment":
        (raw.deployments ??= {})[row.host_id] = record;
        break;
      case "last-projection":
        raw.lastProjection = record;
        break;
      case "projection":
        (raw.projections ??= {})[row.host_id] = record;
        break;
    }

    if (
      (row.kind === "last-projection" || row.kind === "projection") &&
      (
        record === null ||
        typeof record !== "object" ||
        Array.isArray(record) ||
        (record as { generation?: unknown }).generation !==
          row.projection_generation
      )
    ) {
      throw stationStatusStoreError(
        "read.projection-generation",
        new Error(
          `projection fact ${row.kind}/${row.host_id || "singleton"} disagrees with its logical generation`,
        ),
      );
    }
  }

  const decoded = decodeStationStatusDocument(raw);
  if (decoded === undefined) {
    throw stationStatusStoreError(
      "read.decode-document",
      new Error("SQLite station-status facts violate the shared contract"),
    );
  }
  return decoded;
};

const normalizedDocument = (
  operation: string,
  value: StationStatusDocument,
): StationStatusDocument => {
  const decoded = decodeStationStatusDocument(value);
  if (decoded === undefined) {
    throw stationStatusStoreError(
      operation,
      new Error("station-status transition violates the shared contract"),
    );
  }
  return decoded;
};

const upsertFact = (
  writer: StateWriter,
  kind: StationStatusFactKind,
  hostId: string,
  record: unknown,
  projectionGeneration: string | null = null,
): void => {
  const recordJson = JSON.stringify(record);
  if (recordJson === undefined) {
    throw stationStatusStoreError(
      "write.encode-fact",
      new Error(`station-status fact ${kind}/${hostId} is not JSON data`),
    );
  }
  writer.run(
    `
      INSERT INTO station_status_facts(
        kind,
        host_id,
        record_json,
        projection_generation,
        updated_at
      )
      VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(kind, host_id) DO UPDATE SET
        record_json = excluded.record_json,
        projection_generation = excluded.projection_generation,
        updated_at = excluded.updated_at
    `,
    [kind, hostId, recordJson, projectionGeneration],
  );
};

const compareGeneration = (left: string, right: string): number =>
  left.length === right.length
    ? left === right
      ? 0
      : left < right
        ? -1
        : 1
    : left.length < right.length
      ? -1
      : 1;

const sameDocument = (
  left: StationStatusDocument,
  right: StationStatusDocument,
): boolean => JSON.stringify(left) === JSON.stringify(right);

type CommittedChange = {
  readonly changed: boolean;
  readonly change: StationStatusChange;
};

const commitChange = (
  engine: Context.Tag.Service<typeof StateEngine>,
  operation: string,
  kind: StationStatusChangeKind,
  mutate: (current: StationStatusDocument) => StationStatusDocument,
  persist: (
    writer: StateWriter,
    current: StationStatusDocument,
    next: StationStatusDocument,
  ) => void,
): Effect.Effect<void, StationStatusStoreError> =>
  engine
    .transaction(`station-status.${operation}`, (writer) => {
      const current = readDocument(writer);
      const next = normalizedDocument(operation, mutate(current));
      const changed = !sameDocument(current, next);
      if (changed) persist(writer, current, next);
      return {
        changed,
        change: { kind, previous: current, current: next },
      } satisfies CommittedChange;
    })
    .pipe(
      Effect.mapError((error) => fromStateError(operation, error)),
      Effect.tap(({ changed, change }) =>
        changed
          ? Effect.sync(() => notifyStationStatus(change))
          : Effect.void
      ),
      Effect.asVoid,
      Effect.withSpan(`station-status.${operation}`),
    );

let installedService:
  | Context.Tag.Service<typeof StationStatusService>
  | undefined;

const installServiceBridge = (
  service: Context.Tag.Service<typeof StationStatusService>,
): Effect.Effect<
  Context.Tag.Service<typeof StationStatusService>,
  StationStatusStoreError
> =>
  Effect.try({
    try: () => {
      if (installedService !== undefined && installedService !== service) {
        throw new Error("station-status service bridge is already installed");
      }
      installedService = service;
      return service;
    },
    catch: (error) => stationStatusStoreError("bridge.install", error),
  });

const uninstallServiceBridge = (
  service: Context.Tag.Service<typeof StationStatusService>,
): Effect.Effect<void> =>
  Effect.sync(() => {
    if (installedService === service) installedService = undefined;
  });

export const makeStationStatusLive = (): Layer.Layer<
  StationStatusService,
  StationStatusStoreError,
  StateEngine
> =>
  Layer.scoped(
    StationStatusService,
    Effect.gen(function* () {
      const engine = yield* StateEngine;
      yield* engine
        .read("station-status.bootstrap", (reader) =>
          reader.get<{ count: number }>(
            "SELECT count(*) AS count FROM station_status_facts",
          )
        )
        .pipe(
          Effect.mapError((error) =>
            fromStateError("bootstrap", error),
          ),
        );

      const read = engine
        .read("station-status.read", readDocument)
        .pipe(
          Effect.mapError((error) => fromStateError("read", error)),
          Effect.withSpan("station-status.read"),
        );

      const recordPull = (pull: StationPullRecord) =>
        commitChange(
          engine,
          "record-pull",
          "pull",
          (current) => ({
            ...current,
            version: STATION_STATUS_VERSION,
            lastPull: pull,
          }),
          (writer, _current, next) => {
            upsertFact(writer, "pull", "", next.lastPull);
          },
        );

      const recordConfigure = (configure: StationConfigureRecord) =>
        commitChange(
          engine,
          "record-configure",
          "configure",
          (current) => ({
            ...current,
            version: STATION_STATUS_VERSION,
            lastConfigure: configure,
            configures: {
              ...(current.configures ?? {}),
              [configure.hostId]: configure,
            },
          }),
          (writer, _current, next) => {
            upsertFact(
              writer,
              "last-configure",
              "",
              next.lastConfigure,
            );
            upsertFact(
              writer,
              "configure",
              configure.hostId,
              next.configures?.[configure.hostId],
            );
          },
        );

      const recordKernel = (kernel: StationKernelRecord) =>
        commitChange(
          engine,
          "record-kernel",
          "kernel",
          (current) => ({
            ...current,
            version: STATION_STATUS_VERSION,
            kernel,
          }),
          (writer, _current, next) => {
            upsertFact(writer, "kernel", "", next.kernel);
          },
        );

      const recordDeployment = (
        deployment: StationDeployRecord,
        configure: StationConfigureRecord,
      ) =>
        deployment.hostId !== configure.hostId
          ? Effect.fail(
              stationStatusStoreError(
                "record-deployment.input",
                new Error(
                  `deployment host ${deployment.hostId} does not match configure host ${configure.hostId}`,
                ),
              ),
            )
          : commitChange(
              engine,
              "record-deployment",
              "deployment",
              (current) => {
                const previous =
                  current.deployments?.[deployment.hostId];
                const sameTarget =
                  previous?.endpoint === deployment.endpoint;
                const packageUnchanged =
                  sameTarget && deployment.packageState === "previous";
                const roleUnchanged =
                  sameTarget && deployment.role === "previous";
                const merged: StationDeployRecord = {
                  ...deployment,
                  packageState: packageUnchanged
                    ? previous.packageState
                    : deployment.packageState,
                  role: roleUnchanged ? previous.role : deployment.role,
                  version: packageUnchanged
                    ? previous.version
                    : deployment.version,
                  ...(packageUnchanged && previous.lastSeen
                    ? { lastSeen: previous.lastSeen }
                    : {}),
                };
                return {
                  ...current,
                  version: STATION_STATUS_VERSION,
                  lastConfigure: configure,
                  configures: {
                    ...(current.configures ?? {}),
                    [configure.hostId]: configure,
                  },
                  deployments: {
                    ...(current.deployments ?? {}),
                    [deployment.hostId]: merged,
                  },
                };
              },
              (writer, _current, next) => {
                upsertFact(
                  writer,
                  "last-configure",
                  "",
                  next.lastConfigure,
                );
                upsertFact(
                  writer,
                  "configure",
                  configure.hostId,
                  next.configures?.[configure.hostId],
                );
                upsertFact(
                  writer,
                  "deployment",
                  deployment.hostId,
                  next.deployments?.[deployment.hostId],
                );
              },
            );

      const recordProjection = (projection: StationProjectionRecord) =>
        engine
          .transaction("station-status.record-projection", (writer) => {
            const normalizedProjection = normalizedDocument(
              "record-projection.input",
              {
                version: STATION_STATUS_VERSION,
                lastProjection: projection,
              },
            ).lastProjection!;
            const current = readDocument(writer);
            const previousForHost =
              current.projections?.[normalizedProjection.hostId];
            if (previousForHost !== undefined) {
              const hostOrder = compareGeneration(
                normalizedProjection.generation,
                previousForHost.generation,
              );
              if (hostOrder < 0) {
                return {
                  changed: false,
                  change: {
                    kind: "projection",
                    previous: current,
                    current,
                  },
                } satisfies CommittedChange;
              }
              if (
                hostOrder === 0 &&
                normalizedProjection.manifestSha256 !==
                  previousForHost.manifestSha256
              ) {
                throw stationStatusStoreError(
                  "record-projection.conflict",
                  new Error(
                    `projection generation ${normalizedProjection.generation} for host ${normalizedProjection.hostId} has conflicting content`,
                  ),
                );
              }
            }

            const advanceGlobal =
              current.lastProjection === undefined ||
              compareGeneration(
                normalizedProjection.generation,
                current.lastProjection.generation,
              ) >= 0;
            const next = normalizedDocument("record-projection", {
              ...current,
              version: STATION_STATUS_VERSION,
              ...(advanceGlobal
                ? { lastProjection: normalizedProjection }
                : {}),
              projections: {
                ...(current.projections ?? {}),
                [normalizedProjection.hostId]: normalizedProjection,
              },
            });
            const changed = !sameDocument(current, next);
            if (changed) {
              upsertFact(
                writer,
                "projection",
                normalizedProjection.hostId,
                next.projections?.[normalizedProjection.hostId],
                normalizedProjection.generation,
              );
              if (advanceGlobal) {
                upsertFact(
                  writer,
                  "last-projection",
                  "",
                  next.lastProjection,
                  normalizedProjection.generation,
                );
              }
            }
            return {
              changed,
              change: {
                kind: "projection",
                previous: current,
                current: next,
              },
            } satisfies CommittedChange;
          })
          .pipe(
            Effect.mapError((error) =>
              fromStateError("record-projection", error),
            ),
            Effect.tap(({ changed, change }) =>
              changed
                ? Effect.sync(() => notifyStationStatus(change))
                : Effect.void
            ),
            Effect.asVoid,
            Effect.withSpan("station-status.record-projection"),
          );

      const service = StationStatusService.of({
        read,
        recordPull,
        recordConfigure,
        recordKernel,
        recordDeployment,
        recordProjection,
      });
      return yield* Effect.acquireRelease(
        installServiceBridge(service),
        uninstallServiceBridge,
      );
    }),
  );

export const StationStatusLive = makeStationStatusLive();

const requireInstalledService = (
  operation: string,
): Context.Tag.Service<typeof StationStatusService> => {
  if (installedService !== undefined) return installedService;
  throw stationStatusStoreError(
    operation,
    new Error(
      "station-status service is not initialized by the app runtime",
    ),
  );
};

export const readStationStatus = (): Promise<StationStatusDocument> => {
  try {
    return Effect.runPromise(requireInstalledService("read").read);
  } catch (error) {
    return Promise.reject(error);
  }
};

export const recordStationPull = (
  pull: StationPullRecord,
): Promise<void> => {
  try {
    return Effect.runPromise(
      requireInstalledService("record-pull").recordPull(pull),
    );
  } catch (error) {
    return Promise.reject(error);
  }
};

export const recordStationConfigure = (
  configure: StationConfigureRecord,
): Promise<void> => {
  try {
    return Effect.runPromise(
      requireInstalledService("record-configure").recordConfigure(configure),
    );
  } catch (error) {
    return Promise.reject(error);
  }
};

export const recordStationKernel = (
  kernel: StationKernelRecord,
): Promise<void> => {
  try {
    return Effect.runPromise(
      requireInstalledService("record-kernel").recordKernel(kernel),
    );
  } catch (error) {
    return Promise.reject(error);
  }
};

export const recordStationDeployment = (
  deployment: StationDeployRecord,
  configure: StationConfigureRecord,
): Promise<void> => {
  try {
    return Effect.runPromise(
      requireInstalledService("record-deployment").recordDeployment(
        deployment,
        configure,
      ),
    );
  } catch (error) {
    return Promise.reject(error);
  }
};

/**
 * Persist a projection delivery receipt. Per-host and global pointers advance
 * by canonical generation, never wall-clock timestamp; equal-generation
 * status transitions retain call order.
 */
export const recordStationProjection = (
  projection: StationProjectionRecord,
): Promise<void> => {
  try {
    return Effect.runPromise(
      requireInstalledService("record-projection").recordProjection(
        projection,
      ),
    );
  } catch (error) {
    return Promise.reject(error);
  }
};
