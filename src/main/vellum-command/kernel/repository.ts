import { Context, Effect, Layer, SchemaIssue, Schema } from "effect";
import type { PulseRecord } from "@shared/ipc";
import {
  StateEngine,
  type StateEngineError,
  type StateRow,
} from "../state/service";

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
  }>()("@vellum-command/KernelStateRepository") {}

type ArmedRegionRow = StateRow & {
  readonly canvas_name: string;
  readonly region_id: string;
};

type DebugPulseRow = StateRow & {
  readonly position: number;
  readonly id: string;
  readonly at_epoch_ms: number;
  readonly canvas_name: string;
  readonly source_node_id: string;
  readonly region_id: string | null;
  readonly kind: string;
  readonly summary: string;
  readonly delivered_json: string;
  readonly dry: number;
};

const PulseKind = Schema.Literals(["watcher", "timer", "manual"]);
const Delivered = Schema.Array(Schema.String);
const decodePulseKind = Schema.decodeUnknownResult(PulseKind);
const decodeDelivered = Schema.decodeUnknownResult(Delivered);

const parseError = (error: Schema.SchemaError): string =>
  error instanceof Error ? error.message : String(error);

const persistenceError = (
  operation: string,
  error: StateEngineError,
): KernelStateRepositoryError =>
  error.cause instanceof KernelStateCorruptError
    ? error.cause
    : KernelStatePersistenceError.make({
        operation,
        message: error.message,
        cause: error,
      });

const pulseFromRow = (row: DebugPulseRow): PulseRecord => {
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
  StateEngine
> = Layer.effect(
  KernelStateRepository,
  Effect.gen(function* () {
    const state = yield* StateEngine;

    const listArmedRegions = state
      .read("kernel-state.list-armed-regions", (reader) =>
        reader
          .all<ArmedRegionRow>(
            `
              SELECT canvas_name, region_id
              FROM kernel_armed_regions
              ORDER BY canvas_name, region_id
            `,
          )
          .map((row) => ({
            canvasName: row.canvas_name,
            regionId: row.region_id,
          })),
      )
      .pipe(Effect.mapError((error) => persistenceError("list armed regions", error)));

    const setRegionArmed = (
      canvasName: string,
      regionId: string,
      armed: boolean,
    ) =>
      state
        .transaction("kernel-state.set-region-armed", (writer) => {
          if (armed) {
            writer.run(
              `
                INSERT INTO kernel_armed_regions(
                  canvas_name,
                  region_id,
                  armed_at
                ) VALUES (?, ?, ?)
                ON CONFLICT(canvas_name, region_id) DO UPDATE SET
                  armed_at = excluded.armed_at
              `,
              [canvasName, regionId, new Date().toISOString()],
            );
            return;
          }
          writer.run(
            `
              DELETE FROM kernel_armed_regions
              WHERE canvas_name = ? AND region_id = ?
            `,
            [canvasName, regionId],
          );
        })
        .pipe(
          Effect.mapError((error) =>
            persistenceError(
              `${armed ? "arm" : "disarm"} ${canvasName}/${regionId}`,
              error,
            )
          ),
        );

    const replaceDebugPulseRing = (records: ReadonlyArray<PulseRecord>) => {
      const retained = records.slice(-KERNEL_DEBUG_RING_LIMIT);
      const recordedAt = new Date().toISOString();
      return state
        .transaction("kernel-state.replace-debug-pulse-ring", (writer) => {
          writer.run("DELETE FROM kernel_debug_pulses");
          retained.forEach((record, position) => {
            writer.run(
              `
                INSERT INTO kernel_debug_pulses(
                  position,
                  id,
                  at_epoch_ms,
                  canvas_name,
                  source_node_id,
                  region_id,
                  kind,
                  summary,
                  delivered_json,
                  dry,
                  recorded_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `,
              [
                position,
                record.id,
                record.at,
                record.canvasName,
                record.sourceNodeId,
                record.regionId ?? null,
                record.kind,
                record.summary,
                JSON.stringify(record.delivered),
                record.dry ? 1 : 0,
                recordedAt,
              ],
            );
          });
        })
        .pipe(
          Effect.mapError((error) =>
            persistenceError("replace debug pulse ring", error)
          ),
        );
    };

    const readDebugPulseRing = state
      .read("kernel-state.read-debug-pulse-ring", (reader) =>
        reader
          .all<DebugPulseRow>(
            `
              SELECT
                position,
                id,
                at_epoch_ms,
                canvas_name,
                source_node_id,
                region_id,
                kind,
                summary,
                delivered_json,
                dry
              FROM kernel_debug_pulses
              ORDER BY position
            `,
          )
          .map(pulseFromRow),
      )
      .pipe(Effect.mapError((error) => persistenceError("read debug pulse ring", error)));

    return KernelStateRepository.of({
      listArmedRegions,
      setRegionArmed,
      replaceDebugPulseRing,
      readDebugPulseRing,
    });
  }),
);
