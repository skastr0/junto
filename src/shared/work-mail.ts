import { Schema } from "effect";
import { Message } from "./work-model";

export const WORK_MAIL_PAGE_SIZE = 50;
export const WORK_MAIL_PAGE_MAX_SIZE = 200;
const Position = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const WorkMailQuery = Schema.Struct({
  canvasName: Schema.NonEmptyString,
  nodeId: Schema.NonEmptyString,
  beforePosition: Schema.optionalKey(Position),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: WORK_MAIL_PAGE_MAX_SIZE }))),
});
export type WorkMailQuery = typeof WorkMailQuery.Type;
export const WorkMailPage = Schema.Struct({
  items: Schema.Array(Schema.Struct({ position: Position, message: Message })),
  nextBeforePosition: Schema.optionalKey(Position),
});
export type WorkMailPage = typeof WorkMailPage.Type;
export const WorkMailChanged = Schema.Struct({
  canvasName: Schema.String,
  nodeId: Schema.String,
});
export type WorkMailChanged = typeof WorkMailChanged.Type;
