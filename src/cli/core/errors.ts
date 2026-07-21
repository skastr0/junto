import { Schema } from "effect";

export class InputError extends Schema.TaggedError<InputError>()("InputError", {
  message: Schema.String,
  path: Schema.optionalWith(Schema.String, { exact: true }),
  expected: Schema.optionalWith(Schema.Unknown, { exact: true }),
  received: Schema.optionalWith(Schema.Unknown, { exact: true }),
  hint: Schema.optionalWith(Schema.String, { exact: true }),
  next_step: Schema.optionalWith(Schema.String, { exact: true }),
}) {}

export class RuntimeDown extends Schema.TaggedError<RuntimeDown>()("RuntimeDown", {
  message: Schema.String,
  next_step: Schema.optionalWith(Schema.String, { exact: true }),
}) {}

export class AuthError extends Schema.TaggedError<AuthError>()("AuthError", {
  message: Schema.String,
  next_step: Schema.optionalWith(Schema.String, { exact: true }),
}) {}

export class WireError extends Schema.TaggedError<WireError>()("WireError", {
  type: Schema.String,
  message: Schema.String,
  details: Schema.optionalWith(Schema.Unknown, { exact: true }),
}) {}
