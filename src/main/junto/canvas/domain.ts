import { Schema } from "effect";

/** Frozen station error contract; current authoring uses ModelError. */
export class CanvasError extends Schema.TaggedError<CanvasError>()("CanvasError", {
  message: Schema.String,
}) {}
