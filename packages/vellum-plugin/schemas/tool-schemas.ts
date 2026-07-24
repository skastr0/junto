import { Schema } from "effect";

/** Empty input (onboard). */
export const EmptyInput = Schema.Struct({});
export type EmptyInput = typeof EmptyInput.Type;

export const TaskState = Schema.Literal(
  "submitted",
  "working",
  "input-required",
  "completed",
  "canceled",
  "failed",
  "rejected",
  "auth-required",
);
export type TaskState = typeof TaskState.Type;

export const TasksListInput = Schema.Struct({
  target: Schema.String,
});
export type TasksListInput = typeof TasksListInput.Type;

export const TasksUpdateInput = Schema.Struct({
  target: Schema.String,
  task: Schema.String,
  state: TaskState,
  note: Schema.optionalWith(Schema.String, { exact: true }),
});
export type TasksUpdateInput = typeof TasksUpdateInput.Type;

export const MsgListInput = Schema.Struct({
  target: Schema.String,
  taskId: Schema.optionalWith(Schema.String, { exact: true }),
});
export type MsgListInput = typeof MsgListInput.Type;

export const MsgSendInput = Schema.Struct({
  target: Schema.String,
  text: Schema.String,
  taskId: Schema.optionalWith(Schema.String, { exact: true }),
});
export type MsgSendInput = typeof MsgSendInput.Type;

export const RequestCreateInput = Schema.Struct({
  target: Schema.String,
  brief: Schema.String,
  metadata: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
    { exact: true },
  ),
});
export type RequestCreateInput = typeof RequestCreateInput.Type;

/** Artifact part — text or base64 raw bytes (plugin keeps this simple). */
export const ArtifactPartInput = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("text"),
    text: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("raw"),
    bytesBase64: Schema.String,
    mediaType: Schema.optionalWith(Schema.String, { exact: true }),
  }),
  Schema.Struct({
    kind: Schema.Literal("url"),
    url: Schema.String,
    mediaType: Schema.optionalWith(Schema.String, { exact: true }),
  }),
);
export type ArtifactPartInput = typeof ArtifactPartInput.Type;

export const ArtifactPublishInput = Schema.Struct({
  target: Schema.String,
  parts: Schema.Array(ArtifactPartInput),
  name: Schema.optionalWith(Schema.String, { exact: true }),
  artifactId: Schema.optionalWith(Schema.String, { exact: true }),
  taskId: Schema.optionalWith(Schema.String, { exact: true }),
  metadata: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
    { exact: true },
  ),
});
export type ArtifactPublishInput = typeof ArtifactPublishInput.Type;

export const WorkErrorBody = Schema.Struct({
  type: Schema.String,
  message: Schema.String,
  details: Schema.optionalWith(Schema.Unknown, { exact: true }),
});
export type WorkErrorBody = typeof WorkErrorBody.Type;

/** Stable Prism envelope over work-control JSON op results. */
export const WorkCommandResult = Schema.Struct({
  ok: Schema.Boolean,
  op: Schema.String,
  data: Schema.optional(Schema.Unknown),
  error: Schema.optional(WorkErrorBody),
}).pipe(
  Schema.filter(
    (value) => {
      if (value.ok) return value.error === undefined && "data" in value;
      return value.error !== undefined;
    },
    {
      message: () =>
        "WorkCommandResult success requires data and no error; failure requires error.",
    },
  ),
  Schema.annotations({
    title: "WorkCommandResult",
    description: "Envelope over Vellum work-control NDJSON op responses.",
  }),
);
export type WorkCommandResult = typeof WorkCommandResult.Type;
