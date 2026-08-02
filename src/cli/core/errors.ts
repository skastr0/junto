import { Schema } from "effect";

export class InputError extends Schema.TaggedErrorClass<InputError>()("InputError", {
  message: Schema.String,
  path: Schema.optionalKey(Schema.String),
  expected: Schema.optionalKey(Schema.Unknown),
  received: Schema.optionalKey(Schema.Unknown),
  hint: Schema.optionalKey(Schema.String),
  next_step: Schema.optionalKey(Schema.String),
}) {}

export class RuntimeDown extends Schema.TaggedErrorClass<RuntimeDown>()("RuntimeDown", {
  message: Schema.String,
  next_step: Schema.optionalKey(Schema.String),
}) {}

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  next_step: Schema.optionalKey(Schema.String),
}) {}

export class WireError extends Schema.TaggedErrorClass<WireError>()("WireError", {
  type: Schema.String,
  message: Schema.String,
  details: Schema.optionalKey(Schema.Unknown),
}) {}
