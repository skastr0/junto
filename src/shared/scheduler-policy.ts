import { Schema } from "effect";

/** `${canvasName}::${nodeId}` of one cron node, as the scheduler stores it. */
export const TimerKey = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(512)),
  Schema.brand("TimerKey"),
);
export type TimerKey = typeof TimerKey.Type;
