import { Context, Effect, Layer, Option, PubSub, Schema, Stream } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { ActorRef } from "@shared/work-reference";
import { InstallationId } from "@shared/installation-id";
import { deriveActorSeatId } from "../actor-seat-id";
import { withSqlRead } from "../state/sql-read";
import { ModelService } from "./service";
import { ModelRefused, modelError } from "./records";

export type ActorRefsChanged = {
  readonly canvas: string;
  readonly refs: ReadonlyArray<ActorRef>;
};

/** Execution references have their own read and stream; spatial rows stay small. */
export class ModelActorRefs extends Context.Service<ModelActorRefs>()(
  "@junto/ModelActorRefs",
  {
    make: Effect.gen(function* () {
      const model = yield* ModelService;
      const sql = yield* SqlClient.SqlClient;
      const changed = yield* PubSub.sliding<ActorRefsChanged>(256);
      // Each seat with no machine row is reported once, not on every evaluation.
      const unplaced = new Set<string>();
      const topologyRows = SqlSchema.findAll({
        Request: Schema.Void,
        Result: Schema.Struct({
          host_id: Schema.String,
          installation_id: InstallationId,
        }),
        // A removed machine keeps its row (one per name, never re-pinned to
        // another installation), so its seats keep their ids for naming and
        // reads. This read grants nothing: peer() and peers still exclude it,
        // so link admission and exchange routing refuse that machine. Only the
        // owner re-pinning the same installation brings it back.
        execute:
          () => sql`SELECT configuration.machine_name AS host_id, installation.installation_id
        FROM machine_configuration AS configuration JOIN installation ON installation.singleton=configuration.singleton
        WHERE configuration.singleton=1
        UNION ALL SELECT machine_name AS host_id, installation_id FROM machine_peers`,
      });
      const read = Effect.fn("ModelActorRefs.read")(function* (
        canvas?: string,
      ) {
        return yield* withSqlRead(
          sql,
          Effect.gen(function* () {
            const rows = yield* topologyRows(undefined);
            const topology = new Map(
              rows.map((row) => [row.host_id, row.installation_id]),
            );
            const names =
              canvas === undefined ? yield* model.listCanvases() : [canvas];
            const refs: ActorRef[] = [];
            for (const name of names) {
              const current = yield* model.canvas(name);
              for (const node of current.nodes.values()) {
                if (node.kind !== "agent") continue;
                const home = topology.get(node.host);
                // A seat on a machine never pinned here has no id; one such
                // seat must not stop every canvas from reading.
                if (home === undefined) {
                  const key = `${name}\u0000${node.id}\u0000${node.host}`;
                  if (!unplaced.has(key)) {
                    unplaced.add(key);
                    yield* Effect.logWarning("seat skipped: its machine is not known here").pipe(
                      Effect.annotateLogs({ area: "model", canvas: name, seat: node.id, host: node.host }));
                  }
                  continue;
                }
                refs.push({
                  canvasName: name,
                  nodeId: node.id,
                  seatId: deriveActorSeatId(home, node.bindingId),
                });
              }
            }
            return refs.sort(
              (a, b) =>
                a.canvasName.localeCompare(b.canvasName) ||
                a.nodeId.localeCompare(b.nodeId),
            );
          }),
        ).pipe(Effect.mapError((cause) => modelError("actorRefs", cause)));
      });
      /**
       * One seat's reference, read by its own key: its row names the binding,
       * and that machine's topology row names the installation. A receipt or
       * a card needs one actor, never every seat on the canvas.
       */
      const seat = Effect.fn("ModelActorRefs.seat")(function* (
        canvas: string,
        nodeId: string,
      ) {
        return yield* withSqlRead(
          sql,
          Effect.gen(function* () {
            const row = yield* SqlSchema.findOneOption({
              Request: Schema.Tuple([Schema.String, Schema.String]),
              Result: Schema.Struct({
                binding_id: Schema.String,
                installation_id: InstallationId,
              }),
              // A removed machine keeps its row (one per name, never re-pinned
              // to another installation), so a seat on it still has an id.
              execute: ([name, id]) =>
                sql`SELECT seats.binding_id, home.installation_id
                FROM seats JOIN (
                  SELECT configuration.machine_name AS machine_name, installation.installation_id AS installation_id
                  FROM machine_configuration AS configuration JOIN installation ON installation.singleton = configuration.singleton
                  UNION ALL SELECT machine_name, installation_id FROM machine_peers
                ) AS home ON home.machine_name = seats.host
                WHERE seats.canvas_name = ${name} AND seats.id = ${id}`,
            })([canvas, nodeId]).pipe(Effect.map(Option.getOrUndefined));
            if (row === undefined) return undefined;
            return {
              canvasName: canvas,
              nodeId,
              seatId: deriveActorSeatId(row.installation_id, row.binding_id),
            } satisfies ActorRef;
          }),
        ).pipe(Effect.mapError((cause) => modelError("actorRefsSeat", cause)));
      });
      // References change only when seats or canvas membership change, never on mail.
      const announce = (canvas: string) =>
        read(canvas).pipe(
          Effect.tap((refs) =>
            Effect.sync(() => {
              PubSub.publishUnsafe(changed, { canvas, refs });
            }),
          ),
          Effect.catch(() => Effect.void),
        );
      yield* model.changes.pipe(
        Stream.runForEach((event) =>
          event.nodes.some((node) => node.kind === "agent") ||
          event.removedNodes.length
            ? announce(event.canvas)
            : Effect.void,
        ),
        Effect.forkScoped,
      );
      yield* model.canvasesChanges.pipe(
        Stream.runForEach((event) => {
          if (event._tag === "Removed")
            return Effect.sync(() => {
              PubSub.publishUnsafe(changed, { canvas: event.canvas, refs: [] });
            });
          return announce(event.canvas);
        }),
        Effect.forkScoped,
      );
      return { read, seat, changes: Stream.fromPubSub(changed) };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
