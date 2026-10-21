/**
 * The one place a ruling is recorded (docs/plans/0.10/02-universal-resources.md,
 * condition 3). A domain's ruler calls `record` inside its own transaction,
 * after it has written the facts it applied: the ruling's row in
 * `resource_rulings` and its `ruling.applied` or `ruling.refused` fact for
 * every machine then commit with those facts, or none of them does. A replay
 * answered from a stored ruling records nothing.
 *
 * Only the machine that edits the canvas records; on any other it is refused.
 */
import { Context, Effect, Layer, Schema } from "effect";
import { WorkRepository, type RecordRulingInput } from "./repository";

export class RulingRecordFailed extends Schema.TaggedError<RulingRecordFailed>()("RulingRecordFailed", {
  message: Schema.String,
  cause: Schema.Unknown,
}) {}

export class RulingRecorder extends Context.Service<
  RulingRecorder,
  { readonly record: (input: RecordRulingInput) => Effect.Effect<void, RulingRecordFailed> }
>()("@junto/RulingRecorder") {}

export const RulingRecorderLive: Layer.Layer<RulingRecorder, never, WorkRepository> = Layer.effect(
  RulingRecorder,
  // Read when the layer builds, not when this module loads: repository.ts reaches here through the task fold.
  Effect.gen(function* () {
    const repository = yield* WorkRepository;
    return RulingRecorder.of({
      record: (input) =>
        repository.recordRuling(input).pipe(
          Effect.asVoid,
          Effect.mapError((cause) => new RulingRecordFailed({ message: cause.message, cause })),
        ),
    });
  }),
);
