import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { ModelService } from "../model/service";
import { ModelActorRefs } from "../model/actor-refs";
import { readModelDigest } from "../model/digest";
import { SnapshotsService } from "../snapshots";
import { withSqlRead } from "../state/sql-read";
import { WorkRepository } from "../work/repository";
import type { CanvasControlListData, CanvasControlReadData } from "./protocol";

export class CanvasControlQueryError extends Schema.TaggedError<CanvasControlQueryError>()("CanvasControlQueryError", { message: Schema.String, cause: Schema.Unknown }) {}

const queryError = Effect.mapError((cause: unknown) => new CanvasControlQueryError({ message: cause instanceof Error ? cause.message : String(cause), cause }));

/** Owner-local read projections. No document or mailbox is sent over this socket. */
export class CanvasControlQueries extends Context.Service<CanvasControlQueries>()("@junto/CanvasControlQueries", {
  make: Effect.gen(function* () {
    const model = yield* ModelService;
    const actors = yield* ModelActorRefs;
    const snapshots = yield* SnapshotsService;
    const sql = yield* SqlClient.SqlClient;
    const context = yield* Effect.context<ModelService | ModelActorRefs | WorkRepository | SqlClient.SqlClient>();
    const list = Effect.fn("CanvasControlQueries.list")(function* () {
      return yield* withSqlRead(sql, Effect.gen(function* () {
        const out: Array<CanvasControlListData[number]> = [];
        for (const name of yield* model.listCanvases()) {
          const canvas = yield* model.canvas(name);
          out.push({ name, seq: canvas.seq, nodes: canvas.nodes.size, edges: canvas.wires.size });
        }
        return out;
      })).pipe(queryError);
    });
    const read = Effect.fn("CanvasControlQueries.read")(function* (name: string) {
      return yield* withSqlRead(sql, Effect.gen(function* () {
        const opened = yield* model.open(name);
        const actorRefs = yield* actors.read(name);
        const current = yield* snapshots.current;
        const digest = yield* readModelDigest(name, current).pipe(Effect.provide(context));
        const data: CanvasControlReadData = { opened, actorRefs, snapshots: current, digest };
        return data;
      })).pipe(queryError);
    });
    return { list, read };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
