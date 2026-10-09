import { Context, Effect, Layer, PubSub, Schema, Stream } from "effect";
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
      const topologyRows = SqlSchema.findAll({
        Request: Schema.Void,
        Result: Schema.Struct({
          host_id: Schema.String,
          installation_id: InstallationId,
        }),
        execute:
          () => sql`SELECT configuration.machine_name AS host_id, installation.installation_id
        FROM machine_configuration AS configuration JOIN installation ON installation.singleton=configuration.singleton
        WHERE configuration.singleton=1
        UNION ALL SELECT machine_name AS host_id, installation_id FROM machine_peers WHERE retired_at IS NULL`,
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
                if (home === undefined)
                  return yield* new ModelRefused({
                    rule: `Configure the installation for seat host ${node.host}.`,
                  });
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
      return { read, changes: Stream.fromPubSub(changed) };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
