import { Schema } from "effect";
import { UpdateErrorCode, type UpdateErrorCode as Code } from "@shared/update";

export class UpdateError extends Schema.TaggedErrorClass<UpdateError>()(
  "UpdateError",
  {
    code: UpdateErrorCode,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {
  get updateCode(): Code {
    return this.code;
  }
}

export const updateError = (
  code: Code,
  message: string,
  cause?: unknown,
): UpdateError =>
  new UpdateError({
    code,
    message,
    ...(cause === undefined ? {} : { cause }),
  });
