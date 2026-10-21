/**
 * What became of a seat's resource writes (`junto op show`, `junto op list`;
 * plan 02). Three places hold the answer on this machine, and every read is
 * scoped to the writes this machine wrote for one seat:
 *
 * - `resource_rulings`: rulings made here, when this machine edits the canvas.
 * - `ruling.applied` and `ruling.refused` rows: the editing machine's rulings,
 *   received on the exchange.
 * - `command.queued` rows with no ruling in either: still queued.
 *
 * A ruling made here wins over the same ruling received, and any ruling over
 * the queued row it rules.
 */
import { Context, Effect, Layer, Result, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { RulingAppliedResult, RulingRefusedResult } from "@shared/command-row";
import type { InstallationId } from "@shared/installation-id";
import { opViewOf, opViewOfRuling, type OpListResult, type OpListState, type OpView } from "@shared/op-control";
import type { NodeId } from "@shared/physics/schema";
import type { OpId } from "@shared/work-ids";
import { withSqlRead } from "../state/sql-read";

export class OpReadError extends Schema.TaggedError<OpReadError>()("OpReadError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

/** One seat's writes on one canvas. */
export type OpScope = { readonly canvasName: string; readonly seat: NodeId };

export class OpRepository extends Context.Service<OpRepository,
  {
    /** One write of the seat, or undefined when this machine wrote none with that opId for it. */
    readonly show: (scope: OpScope, opId: OpId) => Effect.Effect<OpView | undefined, OpReadError>;
    /** The seat's writes, newest first; `state` keeps the queued or the refused ones. */
    readonly list: (
      scope: OpScope,
      filter: { readonly state?: OpListState; readonly limit: number },
    ) => Effect.Effect<OpListResult, OpReadError>;
  }>()("@junto/main/OpRepository") {}

const decodeRuling = Schema.decodeUnknownResult(Schema.Union([RulingAppliedResult, RulingRefusedResult]));

type Narrow = { readonly opId?: OpId; readonly refusedOnly?: boolean; readonly limit: number };

const parsed = (json: string): unknown => {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
};

export const OpRepositoryLive: Layer.Layer<OpRepository, never, SqlClient.SqlClient> = Layer.effect(
  OpRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fail = (operation: string) => (cause: unknown) =>
      new OpReadError({ operation, message: cause instanceof Error ? cause.message : String(cause) });

    const self = Effect.map(
      sql.unsafe<{ installation_id: string }>("SELECT installation_id FROM installation WHERE singleton = 1"),
      (rows) => rows[0]?.installation_id as InstallationId | undefined,
    );

    /** Rulings made here, for this seat. */
    const ruledHere = (writer: InstallationId, scope: OpScope, narrow: Narrow) =>
      Effect.flatMap(
        sql.unsafe<{ op_id: string; kind: string; ruling_json: string }>(
          `SELECT op_id, kind, ruling_json FROM resource_rulings
           WHERE canvas_name = ? AND writer = ? AND actor_kind = 'seat' AND actor_node_id = ?
             ${narrow.opId === undefined ? "" : "AND op_id = ?"}
             ${narrow.refusedOnly === true ? "AND kind = 'refused'" : ""}
           ORDER BY op_id DESC LIMIT ?`,
          [scope.canvasName, writer, scope.seat, ...(narrow.opId === undefined ? [] : [narrow.opId]), narrow.limit],
        ),
        (rows) =>
          Effect.forEach(rows, (row) => {
            const view = opViewOf(row.op_id as OpId, { kind: row.kind, rulingJson: row.ruling_json }, false);
            return Result.isSuccess(view) && view.success !== undefined
              ? Effect.succeed(view.success)
              : Effect.fail(new OpReadError({ operation: "op.ruled-here", message: Result.isFailure(view) ? view.failure : `the ruling of ${row.op_id} is empty` }));
          }),
      );

    /** Rulings received from the editing machine, for this seat's writes from here. */
    const ruledThere = (writer: InstallationId, scope: OpScope, narrow: Narrow) =>
      Effect.flatMap(
        sql.unsafe<{ result_json: string }>(
          `SELECT fact.result_json FROM work_events AS event
           JOIN work_facts AS fact USING (event_home, entity_home, seq)
           WHERE event.item_canvas_name = ? AND event.item_kind = 'ruling'
             AND json_extract(fact.result_json, '$.writer') = ?
             AND json_extract(fact.result_json, '$.actor.kind') = 'seat'
             AND json_extract(fact.result_json, '$.actor.nodeId') = ?
             ${narrow.opId === undefined ? "" : "AND event.item_id = ?"}
             ${narrow.refusedOnly === true ? "AND event.operation = 'ruling.refused'" : ""}
           ORDER BY event.item_id DESC LIMIT ?`,
          [scope.canvasName, writer, scope.seat, ...(narrow.opId === undefined ? [] : [narrow.opId]), narrow.limit],
        ),
        (rows) =>
          Effect.forEach(rows, (row) => {
            const ruling = decodeRuling(parsed(row.result_json));
            return Result.isSuccess(ruling)
              ? Effect.succeed(opViewOfRuling(ruling.success))
              : Effect.fail(new OpReadError({ operation: "op.ruled-there", message: "a ruling row does not decode" }));
          }),
      );

    /** This seat's commands written here that neither place has ruled. */
    const queued = (writer: InstallationId, scope: OpScope, narrow: Narrow) =>
      Effect.map(
        sql.unsafe<{ op_id: string }>(
          `SELECT event.item_id AS op_id FROM work_events AS event
           JOIN work_facts AS fact USING (event_home, entity_home, seq)
           WHERE event.event_home = ? AND event.entity_home = ? AND event.item_canvas_name = ?
             AND event.item_kind = 'command' AND event.operation = 'command.queued'
             AND json_extract(fact.result_json, '$.command.actor.kind') = 'seat'
             AND json_extract(fact.result_json, '$.command.actor.nodeId') = ?
             ${narrow.opId === undefined ? "" : "AND event.item_id = ?"}
             AND NOT EXISTS (
               SELECT 1 FROM resource_rulings AS ruled
               WHERE ruled.canvas_name = event.item_canvas_name AND ruled.writer = event.event_home
                 AND ruled.op_id = event.item_id
             )
             AND NOT EXISTS (
               SELECT 1 FROM work_events AS ruling
               JOIN work_facts AS ruled USING (event_home, entity_home, seq)
               WHERE ruling.item_canvas_name = event.item_canvas_name AND ruling.item_kind = 'ruling'
                 AND ruling.item_id = event.item_id
                 AND json_extract(ruled.result_json, '$.writer') = event.event_home
             )
           ORDER BY event.item_id DESC LIMIT ?`,
          [writer, writer, scope.canvasName, scope.seat, ...(narrow.opId === undefined ? [] : [narrow.opId]), narrow.limit],
        ),
        (rows) => rows.map((row): OpView => ({ state: "queued", opId: row.op_id as OpId })),
      );

    /** First view per opId in source order, newest first. */
    const merged = (sources: ReadonlyArray<ReadonlyArray<OpView>>): ReadonlyArray<OpView> => {
      const byOp = new Map<OpId, OpView>();
      for (const views of sources) for (const view of views) if (!byOp.has(view.opId)) byOp.set(view.opId, view);
      return [...byOp.values()].sort((a, b) => (a.opId < b.opId ? 1 : a.opId > b.opId ? -1 : 0));
    };

    const show = (scope: OpScope, opId: OpId) =>
      withSqlRead(
        sql,
        Effect.gen(function* () {
          const writer = yield* self;
          if (writer === undefined) return undefined;
          const narrow = { opId, limit: 1 };
          const views = merged([
            yield* ruledHere(writer, scope, narrow),
            yield* ruledThere(writer, scope, narrow),
            yield* queued(writer, scope, narrow),
          ]);
          return views[0];
        }),
      ).pipe(Effect.mapError((error) => (error instanceof OpReadError ? error : fail("op.show")(error))));

    const list = (scope: OpScope, filter: { readonly state?: OpListState; readonly limit: number }) =>
      withSqlRead(
        sql,
        Effect.gen(function* () {
          const writer = yield* self;
          if (writer === undefined) return { ops: [], more: false };
          const narrow = { limit: filter.limit + 1, refusedOnly: filter.state === "refused" };
          const views = merged([
            filter.state === "queued" ? [] : yield* ruledHere(writer, scope, narrow),
            filter.state === "queued" ? [] : yield* ruledThere(writer, scope, narrow),
            filter.state === "refused" ? [] : yield* queued(writer, scope, narrow),
          ]);
          return { ops: views.slice(0, filter.limit), more: views.length > filter.limit };
        }),
      ).pipe(Effect.mapError((error) => (error instanceof OpReadError ? error : fail("op.list")(error))));

    return OpRepository.of({ show, list });
  }),
);
