import { Context, Effect, Layer, SchemaIssue, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import type { PulseRecord } from "@shared/ipc";
import { StateTransactionOperation } from "../state/service";

export const KERNEL_DEBUG_RING_LIMIT = 20;

export type ArmedRegion = {
  readonly canvasName: string;
  readonly regionId: string;
};

export class KernelStatePersistenceError extends Schema.TaggedError<KernelStatePersistenceError>()(
  "KernelStatePersistenceError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

export class KernelStateCorruptError extends Schema.TaggedError<KernelStateCorruptError>()(
  "KernelStateCorruptError",
  {
    message: Schema.String,
  },
) {}

export type KernelStateRepositoryError =
  | KernelStatePersistenceError
  | KernelStateCorruptError;

export class KernelStateRepository extends Context.Service<KernelStateRepository,
  {
    readonly listArmedRegions: Effect.Effect<
      ReadonlyArray<ArmedRegion>,
      KernelStateRepositoryError
    >;
    readonly setRegionArmed: (
      canvasName: string,
      regionId: string,
      armed: boolean,
    ) => Effect.Effect<void, KernelStateRepositoryError>;
    readonly replaceDebugPulseRing: (
      records: ReadonlyArray<PulseRecord>,
    ) => Effect.Effect<void, KernelStateRepositoryError>;
    readonly readDebugPulseRing: Effect.Effect<
      ReadonlyArray<PulseRecord>,
      KernelStateRepositoryError
    >;
  }>()("@junto/KernelStateRepository") {}

const ArmedRegionRow = Schema.Struct({
  canvas_name: Schema.String,
  region_id: Schema.String,
});

const DebugPulseRow = Schema.Struct({
  position: Schema.Number,
  id: Schema.String,
  at_epoch_ms: Schema.Number,
  canvas_name: Schema.String,
  source_node_id: Schema.String,
  region_id: Schema.NullOr(Schema.String),
  kind: Schema.String,
  summary: Schema.String,
  delivered_json: Schema.String,
  dry: Schema.Number,
});

const PulseKind = Schema.Literals(["watcher", "timer", "manual"]);
const Delivered = Schema.Array(Schema.String);
const decodePulseKind = Schema.decodeUnknownResult(PulseKind);
const decodeDelivered = Schema.decodeUnknownResult(Delivered);

const parseError = (error: Schema.SchemaError): string =>
  error instanceof Error ? error.message : String(error);

const persistenceError = (
  operation: string,
  error: unknown,
): KernelStateRepositoryError =>
  error instanceof KernelStateCorruptError
    ? error
    : KernelStatePersistenceError.make({
        operation,
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      });

const pulseFromRow = (row: typeof DebugPulseRow.Type): PulseRecord => {
  const kind = decodePulseKind(row.kind);
  if (kind._tag === "Failure") {
    throw KernelStateCorruptError.make({
      message: `kernel debug pulse ${row.position} has invalid kind: ${
        parseError(kind.failure)
      }`,
    });
  }

  let deliveredInput: unknown;
  try {
    deliveredInput = JSON.parse(row.delivered_json) as unknown;
  } catch (error) {
    throw KernelStateCorruptError.make({
      message:
        `kernel debug pulse ${row.position} has invalid delivered JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
    });
  }
  const delivered = decodeDelivered(deliveredInput);
  if (delivered._tag === "Failure") {
    throw KernelStateCorruptError.make({
      message:
        `kernel debug pulse ${row.position} has invalid recipients: ${
          parseError(delivered.failure)
        }`,
    });
  }

  return {
    id: row.id,
    at: Number(row.at_epoch_ms),
    canvasName: row.canvas_name,
    sourceNodeId: row.source_node_id,
    ...(row.region_id === null ? {} : { regionId: row.region_id }),
    kind: kind.success,
    summary: row.summary,
    delivered: delivered.success,
    dry: row.dry === 1,
  };
};

export const KernelStateRepositoryLive: Layer.Layer<
  KernelStateRepository,
  never,
  SqlClient.SqlClient
> = Layer.effect(
  KernelStateRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const armedRows = SqlSchema.findAll({
      Request: Schema.Void,
      Result: ArmedRegionRow,
      execute: () => sql`SELECT canvas_name, region_id FROM kernel_armed_regions ORDER BY canvas_name, region_id`,
    });
    const pulseRows = SqlSchema.findAll({
      Request: Schema.Void,
      Result: DebugPulseRow,
      execute: () => sql`
        SELECT position, id, at_epoch_ms, canvas_name, source_node_id, region_id, kind, summary, delivered_json, dry
        FROM kernel_debug_pulses ORDER BY position
      `,
    });

    const listArmedRegions = Effect.fn("kernel-state.list-armed-regions")(function* () {
      return (yield* armedRows(undefined)).map((row) => ({ canvasName: row.canvas_name, regionId: row.region_id }));
    }, Effect.mapError((error) => persistenceError("list armed regions", error)))();

    const setRegionArmed = Effect.fn("kernel-state.set-region-armed")(function* (
      canvasName: string,
      regionId: string,
      armed: boolean,
    ) {
      if (armed) {
        yield* sql`
          INSERT INTO kernel_armed_regions(canvas_name, region_id, armed_at)
          VALUES (${canvasName}, ${regionId}, ${new Date().toISOString()})
          ON CONFLICT(canvas_name, region_id) DO UPDATE SET armed_at = excluded.armed_at
        `;
        return;
      }
      yield* sql`DELETE FROM kernel_armed_regions WHERE canvas_name = ${canvasName} AND region_id = ${regionId}`;
    }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "kernel-state.set-region-armed"),
    (effect, canvasName, regionId, armed) => effect.pipe(Effect.mapError((error) =>
      persistenceError(`${armed ? "arm" : "disarm"} ${canvasName}/${regionId}`, error))));

    const writeDebugPulseRing = Effect.fn("kernel-state.replace-debug-pulse-ring")(function* (
      retained: ReadonlyArray<PulseRecord>,
      recordedAt: string,
    ) {
      yield* sql`DELETE FROM kernel_debug_pulses`;
      for (const [position, record] of retained.entries()) {
        yield* sql`
          INSERT INTO kernel_debug_pulses(position, id, at_epoch_ms, canvas_name, source_node_id, region_id, kind, summary, delivered_json, dry, recorded_at)
          VALUES (${position}, ${record.id}, ${record.at}, ${record.canvasName}, ${record.sourceNodeId}, ${record.regionId ?? null},
            ${record.kind}, ${record.summary}, ${JSON.stringify(record.delivered)}, ${record.dry ? 1 : 0}, ${recordedAt})
        `;
      }
    }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "kernel-state.replace-debug-pulse-ring"),
    Effect.mapError((error) => persistenceError("replace debug pulse ring", error)));

    const replaceDebugPulseRing = (records: ReadonlyArray<PulseRecord>) =>
      writeDebugPulseRing(records.slice(-KERNEL_DEBUG_RING_LIMIT), new Date().toISOString());

    const readDebugPulseRing = Effect.fn("kernel-state.read-debug-pulse-ring")(function* () {
      const rows = yield* pulseRows(undefined).pipe(Effect.mapError((error) => persistenceError("read debug pulse ring", error)));
      return yield* Effect.try({
        try: () => rows.map(pulseFromRow),
        catch: (error) => persistenceError("read debug pulse ring", error),
      });
    })();

    return KernelStateRepository.of({
      listArmedRegions,
      setRegionArmed,
      replaceDebugPulseRing,
      readDebugPulseRing,
    });
  }),
);
