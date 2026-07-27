/**
 * Durable operational observations in the app-owned SQLite StateEngine.
 *
 * This is intentionally not a second Station model. Configuration,
 * projections, pairing, and logical cursors belong exclusively to
 * StationRepository. This service retains only kernel heartbeat and managed
 * deployment receipts.
 */

import { Context, Effect, Layer, Schema } from "effect";
import {
  decodeStationStatusDocument,
  defaultStationStatus,
  STATION_STATUS_VERSION,
  type StationDeployRecord,
  type StationKernelRecord,
  type StationStatusDocument,
} from "@shared/station-status";
import {
  StateEngine,
  type StateEngineError,
  type StateReader,
  type StateWriter,
} from "./state/service";

type StationStatusFactKind = "kernel" | "deployment";

type StationStatusFactRow = {
  readonly kind: StationStatusFactKind;
  readonly host_id: string;
  readonly record_json: string;
};

export class StationStatusStoreError extends Schema.TaggedError<StationStatusStoreError>()(
  "StationStatusStoreError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Defect,
  },
) {}

const statusError = (
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
): StationStatusStoreError => statusError(operation, error);

export class StationStatusService extends Context.Tag(
  "@vellum/StationStatusService",
)<
  StationStatusService,
  {
    readonly read: Effect.Effect<
      StationStatusDocument,
      StationStatusStoreError
    >;
    readonly recordKernel: (
      kernel: StationKernelRecord,
    ) => Effect.Effect<void, StationStatusStoreError>;
    readonly recordDeployment: (
      deployment: StationDeployRecord,
    ) => Effect.Effect<void, StationStatusStoreError>;
  }
>() {}

const parseRecord = (row: StationStatusFactRow): unknown => {
  try {
    return JSON.parse(row.record_json) as unknown;
  } catch (error) {
    throw statusError("read.decode-json", error);
  }
};

const readDocument = (reader: StateReader): StationStatusDocument => {
  const rows = reader.all<StationStatusFactRow>(
    `SELECT kind, host_id, record_json
       FROM station_status_facts
      WHERE kind IN ('kernel', 'deployment')
      ORDER BY kind, host_id`,
  );
  if (rows.length === 0) return defaultStationStatus();

  const raw: {
    version: typeof STATION_STATUS_VERSION;
    kernel?: unknown;
    deployments?: Record<string, unknown>;
  } = { version: STATION_STATUS_VERSION };

  for (const row of rows) {
    const record = parseRecord(row);
    if (row.kind === "kernel") {
      raw.kernel = record;
    } else {
      (raw.deployments ??= {})[row.host_id] = record;
    }
  }

  const decoded = decodeStationStatusDocument(raw);
  if (decoded === undefined) {
    throw statusError(
      "read.decode-document",
      new Error("SQLite station observation facts violate the shared contract"),
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
    throw statusError(
      operation,
      new Error("station observation transition violates the shared contract"),
    );
  }
  return decoded;
};

const upsertFact = (
  writer: StateWriter,
  kind: StationStatusFactKind,
  hostId: string,
  record: unknown,
): void => {
  const encoded = JSON.stringify(record);
  if (encoded === undefined) {
    throw statusError(
      "write.encode-fact",
      new Error(`station observation ${kind}/${hostId} is not JSON data`),
    );
  }
  writer.run(
    `INSERT INTO station_status_facts(
       kind,
       host_id,
       record_json,
       updated_at
     ) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT(kind, host_id) DO UPDATE SET
       record_json = excluded.record_json,
       updated_at = excluded.updated_at`,
    [kind, hostId, encoded],
  );
};

export const makeStationStatusLive = (): Layer.Layer<
  StationStatusService,
  StationStatusStoreError,
  StateEngine
> =>
  Layer.effect(
    StationStatusService,
    Effect.gen(function* () {
      const engine = yield* StateEngine;

      const read = engine
        .read("station-status.read", readDocument)
        .pipe(
          Effect.mapError((error) => fromStateError("read", error)),
          Effect.withSpan("station-status.read"),
        );

      const recordKernel = Effect.fn("StationStatusService.recordKernel")(
        function* (kernel: StationKernelRecord) {
          const admitted = yield* Effect.try({
            try: () =>
              normalizedDocument("record-kernel.input", {
                version: STATION_STATUS_VERSION,
                kernel,
              }).kernel!,
            catch: (error) => statusError("record-kernel.input", error),
          });
          yield* engine
            .transaction("station-status.record-kernel", (writer) => {
              upsertFact(writer, "kernel", "", admitted);
            })
            .pipe(
              Effect.mapError((error) =>
                fromStateError("record-kernel", error)
              ),
            );
        },
      );

      const recordDeployment = Effect.fn(
        "StationStatusService.recordDeployment",
      )(function* (deployment: StationDeployRecord) {
        const admitted = yield* Effect.try({
          try: () =>
            normalizedDocument("record-deployment.input", {
              version: STATION_STATUS_VERSION,
              deployments: { [deployment.hostId]: deployment },
            }).deployments![deployment.hostId]!,
          catch: (error) => statusError("record-deployment.input", error),
        });

        yield* engine
          .transaction("station-status.record-deployment", (writer) => {
            const current = readDocument(writer);
            const previous = current.deployments?.[admitted.hostId];
            const sameTarget = previous?.endpoint === admitted.endpoint;
            const packageUnchanged =
              sameTarget && admitted.packageState === "previous";
            const roleUnchanged =
              sameTarget && admitted.role === "previous";
            const merged: StationDeployRecord = {
              ...admitted,
              packageState: packageUnchanged
                ? previous.packageState
                : admitted.packageState,
              role: roleUnchanged ? previous.role : admitted.role,
              version: packageUnchanged ? previous.version : admitted.version,
              ...(packageUnchanged && previous.lastSeen
                ? { lastSeen: previous.lastSeen }
                : {}),
            };
            const normalized = normalizedDocument("record-deployment", {
              version: STATION_STATUS_VERSION,
              deployments: { [merged.hostId]: merged },
            }).deployments![merged.hostId]!;
            upsertFact(writer, "deployment", merged.hostId, normalized);
          })
          .pipe(
            Effect.mapError((error) =>
              fromStateError("record-deployment", error)
            ),
          );
      });

      return StationStatusService.of({
        read,
        recordKernel,
        recordDeployment,
      });
    }),
  );

export const StationStatusLive = makeStationStatusLive();
