/**
 * The one place a ruling is recorded (docs/plans/0.10/02-universal-resources.md,
 * condition 3). A domain's ruler calls `record` inside its own transaction,
 * after it has written the facts it applied: the ruling's row in
 * `resource_rulings` and its `ruling.applied` or `ruling.refused` fact for
 * every machine then commit with those facts, or none of them does. A replay
 * answered from a stored ruling records nothing.
 *
 * An applied ruling's notices to this machine's own seats are written in the
 * same transaction (`ruling-notices.ts`); every other machine writes its own
 * seats' as it folds the ruling.
 *
 * Only the machine that edits the canvas records; on any other it is refused.
 */
import { Context, Effect, Layer, Option, Schema } from "effect";
import { MachineRepository } from "../machines/repository";
import { ModelRecords } from "../model/records";
import { canvasPlacement } from "./canvas-placement";
import { messageDelivery } from "./message-delivery";
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
    // Both run in the product; a bare work store writes no notices.
    const machines = yield* Effect.serviceOption(MachineRepository);
    const records = yield* Effect.serviceOption(ModelRecords);
    const placementOf = (canvasName: string) =>
      Option.isNone(machines) || Option.isNone(records)
        ? Effect.succeed(undefined)
        : canvasPlacement(canvasName).pipe(
            Effect.provideService(MachineRepository, machines.value),
            Effect.provideService(ModelRecords, records.value),
          );
    return RulingRecorder.of({
      record: (input) =>
        Effect.gen(function* () {
          const placement = input.ruling.kind === "applied" ? yield* placementOf(input.canvasName) : undefined;
          const recorded = yield* repository.recordRuling(placement === undefined ? input : { ...input, placement });
          // Delivery reads the row once the caller commits; one it misses waits in the mailbox for the seat.
          for (const notice of recorded.notices) messageDelivery.notifyAppended(notice.sink.canvasName, notice.sink.nodeId, notice.message);
        }).pipe(
          Effect.mapError((cause) => new RulingRecordFailed({ message: cause instanceof Error ? cause.message : String(cause), cause })),
        ),
    });
  }),
);
