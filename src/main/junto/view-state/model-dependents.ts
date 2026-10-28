/**
 * The model delete seam's two dependents (0.11, 04): Work's materializations
 * and the operator's view rows. Both go in the model's transaction, so a
 * node or canvas delete never leaves a row pointing at what it removed.
 *
 * The view rows use the same delete pass as `ViewStateRepository`, over
 * `SqlClient`, so there is no cycle: `ModelLive` is provided *to* the stores,
 * and cannot require one of them.
 */
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { ModelDependents } from "../model/dependents";
import { afterSqlCommit } from "../state/sql-commit";
import { makeWorkModelDependents } from "../work/model-dependents";
import { publishViewStateChange } from "./changes";
import { removeViewCanvas, removeViewNodes } from "./remove";

export const ProductModelDependentsLive = Layer.effect(
  ModelDependents,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const work = yield* makeWorkModelDependents;
    return ModelDependents.of({
      removeCanvas: (canvas) =>
        Effect.gen(function* () {
          yield* work.removeCanvas(canvas);
          yield* removeViewCanvas(sql, canvas);
          // A window still showing the canvas must drop its rows.
          yield* afterSqlCommit(sql, publishViewStateChange);
        }),
      removeNodes: (canvas, ids) =>
        Effect.gen(function* () {
          yield* work.removeNodes(canvas, ids);
          yield* removeViewNodes(sql, canvas, ids);
          yield* afterSqlCommit(sql, publishViewStateChange);
        }),
    });
  }),
);
