/**
 * Durable operational observations in the app-owned SQLite StateEngine.
 *
 * This is intentionally not a second Station model. Configuration,
 * projections, pairing, and logical cursors belong exclusively to
 * StationRepository. This service retains only kernel heartbeat and managed
 * deployment receipts.
 */

import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import {
  decodeStationStatusDocument,
  defaultStationStatus,
  STATION_STATUS_VERSION,
  type StationDeployRecord,
  type StationKernelRecord,
  type StationStatusDocument,
} from "@shared/station-status";
import { StateTransactionOperation } from "./state/service";

type StationStatusFactKind = "kernel" | "deployment";

const StationStatusFactRow = Schema.Struct({
  kind: Schema.Literals(["kernel", "deployment"]),
  host_id: Schema.String,
  record_json: Schema.String,
});

export class StationStatusStoreError extends Schema.TaggedError<StationStatusStoreError>()(
  "StationStatusStoreError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Unknown,
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

const persistenceError = (
  operation: string,
  error: unknown,
): StationStatusStoreError => StationStatusStoreError.make({
  operation,
  message: error instanceof Error ? error.message : String(error),
  cause: error,
});

export class StationStatusService extends Context.Service<StationStatusService,
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
  }>()("@junto/StationStatusService") {}

const parseRecord = (row: typeof StationStatusFactRow.Type): unknown => {
  try {
    return JSON.parse(row.record_json) as unknown;
  } catch (error) {
    throw statusError("read.decode-json", error);
  }
};

const documentFromRows = (rows: ReadonlyArray<typeof StationStatusFactRow.Type>): StationStatusDocument => {
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

export const makeStationStatusLive = (): Layer.Layer<
  StationStatusService,
  StationStatusStoreError,
  SqlClient.SqlClient
> =>
  Layer.effect(
    StationStatusService,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const factRows = SqlSchema.findAll({
        Request: Schema.Void,
        Result: StationStatusFactRow,
        execute: () => sql`
          SELECT kind, host_id, record_json FROM station_status_facts
          WHERE kind IN ('kernel', 'deployment') ORDER BY kind, host_id
        `,
      });
      const readDocument = Effect.fn("station-status.read-document")(function* () {
        const rows = yield* factRows(undefined);
        return yield* Effect.try({
          try: () => documentFromRows(rows),
          catch: (error) => statusError("read", error),
        });
      });
      const upsertFact = Effect.fn("station-status.upsert-fact")(function* (
        kind: StationStatusFactKind,
        hostId: string,
        record: unknown,
      ) {
        const encoded = yield* Effect.try({
          try: () => JSON.stringify(record),
          catch: (error) => statusError("write.encode-fact", error),
        });
        if (encoded === undefined) {
          return yield* statusError("write.encode-fact", new Error(`station observation ${kind}/${hostId} is not JSON data`));
        }
        yield* sql`
          INSERT INTO station_status_facts(kind, host_id, record_json, updated_at)
          VALUES (${kind}, ${hostId}, ${encoded}, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          ON CONFLICT(kind, host_id) DO UPDATE SET
            record_json = excluded.record_json, updated_at = excluded.updated_at
        `;
      });
      const read = readDocument().pipe(
        Effect.mapError((error) => persistenceError("read", error)),
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
          yield* upsertFact("kernel", "", admitted).pipe(
            sql.withTransaction,
            Effect.provideService(StateTransactionOperation, "station-status.record-kernel"),
            Effect.mapError((error) => persistenceError("record-kernel", error)),
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

        yield* sql.withTransaction(Effect.gen(function* () {
            const current = yield* readDocument();
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
            const normalized = yield* Effect.try({
              try: () => normalizedDocument("record-deployment", {
                version: STATION_STATUS_VERSION,
                deployments: { [merged.hostId]: merged },
              }).deployments![merged.hostId]!,
              catch: (error) => statusError("record-deployment", error),
            });
            yield* upsertFact("deployment", merged.hostId, normalized);
          }))
          .pipe(
            Effect.provideService(StateTransactionOperation, "station-status.record-deployment"),
            Effect.mapError((error) => persistenceError("record-deployment", error)),
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
