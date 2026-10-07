import { Context, Effect, Layer, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql";

/** Other current materializations move with the model, in its owning transaction. */
export class ModelDependents extends Context.Service<ModelDependents, {
  readonly removeCanvas: (canvas: string) => Effect.Effect<void, SqlError.SqlError | Schema.SchemaError>;
  readonly removeNodes: (canvas: string, ids: ReadonlyArray<string>) => Effect.Effect<void, SqlError.SqlError | Schema.SchemaError>;
}>()("@junto/ModelDependents") {
  /** Isolated model tests have no dependent materializations. Never runtime wiring. */
  static readonly empty = Layer.succeed(this, {
    removeCanvas: () => Effect.void,
    removeNodes: () => Effect.void,
  });
}
