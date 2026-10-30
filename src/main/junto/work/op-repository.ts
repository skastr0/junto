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
import { CommandQueuedResult, RulingAppliedResult, RulingRefusedResult, type QueuedCommand } from "@shared/command-row";
import type { InstallationId } from "@shared/installation-id";
import { opViewOf, opViewOfRuling, type OpListResult, type OpListState, type OpView } from "@shared/op-control";
import type { NodeId } from "@shared/physics/schema";
import type { OpId } from "@shared/work-ids";
import { withSqlRead } from "../state/sql-read";
import { openCommandsOf } from "./open-projections-schema";

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
    /** The seat's writes, newest first; `state` keeps the queued or the refused ones, `before` pages back. */
    readonly list: (
      scope: OpScope,
      filter: { readonly state?: OpListState; readonly before?: OpId; readonly limit: number },
    ) => Effect.Effect<OpListResult, OpReadError>;
    /**
     * Every command this machine wrote on the canvas that no ruling answers
     * yet, every seat's, in queue order: the queue the overlay replays.
     */
    readonly unruled: (canvasName: string) => Effect.Effect<{ readonly writer: InstallationId; readonly commands: ReadonlyArray<QueuedCommand> } | undefined, OpReadError>;
  }>()("@junto/main/OpRepository") {}

const decodeRuling = Schema.decodeUnknownResult(Schema.Union([RulingAppliedResult, RulingRefusedResult]));
const decodeQueued = Schema.decodeUnknownResult(CommandQueuedResult);

type Narrow = { readonly opId?: OpId; readonly before?: OpId; readonly refusedOnly?: boolean; readonly limit: number };

/** The `op_id = ?` and `op_id < ?` conditions a narrow adds, over `column`, with their parameters. */
const narrowed = (column: string, narrow: Narrow): { readonly sql: string; readonly params: ReadonlyArray<string> } => ({
  sql: [
    ...(narrow.opId === undefined ? [] : [`AND ${column} = ?`]),
    ...(narrow.before === undefined ? [] : [`AND ${column} < ?`]),
  ].join(" "),
  params: [...(narrow.opId === undefined ? [] : [narrow.opId]), ...(narrow.before === undefined ? [] : [narrow.before])],
});

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
    const ruledHere = (writer: InstallationId, scope: OpScope, narrow: Narrow) => {
      const where = narrowed("op_id", narrow);
      return Effect.flatMap(
        sql.unsafe<{ op_id: string; kind: string; ruling_json: string }>(
          `SELECT op_id, kind, ruling_json FROM resource_rulings
           WHERE canvas_name = ? AND writer = ? AND actor_kind = 'seat' AND actor_node_id = ?
             ${where.sql}
             ${narrow.refusedOnly === true ? "AND kind = 'refused'" : ""}
           ORDER BY op_id DESC LIMIT ?`,
          [scope.canvasName, writer, scope.seat, ...where.params, narrow.limit],
        ),
        (rows) =>
          Effect.forEach(rows, (row) => {
            const view = opViewOf(row.op_id as OpId, { kind: row.kind, rulingJson: row.ruling_json }, false);
            return Result.isSuccess(view) && view.success !== undefined
              ? Effect.succeed(view.success)
              : Effect.fail(new OpReadError({ operation: "op.ruled-here", message: Result.isFailure(view) ? view.failure : `the ruling of ${row.op_id} is empty` }));
          }),
      );
    };

    /** Rulings received from the editing machine, for this seat's writes from here. */
    const ruledThere = (writer: InstallationId, scope: OpScope, narrow: Narrow) => {
      const where = narrowed("event.item_id", narrow);
      return Effect.flatMap(
        sql.unsafe<{ result_json: string }>(
          `SELECT fact.result_json FROM work_events AS event
           JOIN work_facts AS fact USING (event_home, entity_home, seq)
           WHERE event.item_canvas_name = ? AND event.item_kind = 'ruling'
             AND json_extract(fact.result_json, '$.writer') = ?
             AND json_extract(fact.result_json, '$.actor.kind') = 'seat'
             AND json_extract(fact.result_json, '$.actor.nodeId') = ?
             ${where.sql}
             ${narrow.refusedOnly === true ? "AND event.operation = 'ruling.refused'" : ""}
           ORDER BY event.item_id DESC LIMIT ?`,
          [scope.canvasName, writer, scope.seat, ...where.params, narrow.limit],
        ),
        (rows) =>
          Effect.forEach(rows, (row) => {
            const ruling = decodeRuling(parsed(row.result_json));
            return Result.isSuccess(ruling)
              ? Effect.succeed(opViewOfRuling(ruling.success))
              : Effect.fail(new OpReadError({ operation: "op.ruled-there", message: "a ruling row does not decode" }));
          }),
      );
    };

    /** This seat's commands written here that neither place has ruled. */
    const queued = (writer: InstallationId, scope: OpScope, narrow: Narrow) => {
      const where = narrowed("held.op_id", narrow);
      return Effect.map(
        sql.unsafe<{ op_id: string }>(
          `SELECT held.op_id ${openCommandsOf(`
             AND json_extract(fact.result_json, '$.command.actor.kind') = 'seat'
             AND json_extract(fact.result_json, '$.command.actor.nodeId') = ?
             ${where.sql}`)}
           ORDER BY held.op_id DESC LIMIT ?`,
          [scope.canvasName, writer, scope.seat, ...where.params, narrow.limit],
        ),
        (rows) => rows.map((row): OpView => ({ state: "queued", opId: row.op_id as OpId })),
      );
    };

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

    const list = (scope: OpScope, filter: { readonly state?: OpListState; readonly before?: OpId; readonly limit: number }) =>
      withSqlRead(
        sql,
        Effect.gen(function* () {
          const writer = yield* self;
          if (writer === undefined) return { ops: [], more: false };
          const narrow = {
            limit: filter.limit + 1,
            refusedOnly: filter.state === "refused",
            ...(filter.before === undefined ? {} : { before: filter.before }),
          };
          const views = merged([
            filter.state === "queued" ? [] : yield* ruledHere(writer, scope, narrow),
            filter.state === "queued" ? [] : yield* ruledThere(writer, scope, narrow),
            filter.state === "refused" ? [] : yield* queued(writer, scope, narrow),
          ]);
          return { ops: views.slice(0, filter.limit), more: views.length > filter.limit };
        }),
      ).pipe(Effect.mapError((error) => (error instanceof OpReadError ? error : fail("op.list")(error))));

    const unruled = (canvasName: string) =>
      withSqlRead(
        sql,
        Effect.gen(function* () {
          const writer = yield* self;
          if (writer === undefined) return undefined;
          const rows = yield* sql.unsafe<{ result_json: string }>(
            `SELECT fact.result_json ${openCommandsOf("")}
             ORDER BY length(held.seq), held.seq`,
            [canvasName, writer],
          );
          const commands = yield* Effect.forEach(rows, (row) => {
            const held = decodeQueued(parsed(row.result_json));
            return Result.isSuccess(held)
              ? Effect.succeed(held.success.command)
              : Effect.fail(new OpReadError({ operation: "op.unruled", message: "a command row does not decode" }));
          });
          return { writer, commands };
        }),
      ).pipe(Effect.mapError((error) => (error instanceof OpReadError ? error : fail("op.unruled")(error))));

    return OpRepository.of({ show, list, unruled });
  }),
);
