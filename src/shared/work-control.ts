import { Either, Schema } from "effect";
import { parseNodeRef } from "./node-ref";
import { TaskState } from "./canvas";

// Work control-plane wire contract: NDJSON frames over a local Unix domain
// socket at ~/.vellum/work/control.sock. Pure module — no Node imports — so
// the Electron-hosted daemon, the standalone CLI, and tests share one source
// of truth. Transport is owner-local only; every request carries a bearer
// token. Domain mutations route through WorkService — this file only knows
// shapes, paths-as-strings, and admission bounds.

// ---------------------------------------------------------------------------
// Paths (functions of home so the module stays platform-pure)

/** Default dir: `~/.vellum/work`. Tests override with `VELLUM_WORK_HOME`. */
export const workControlDir = (home: string): string => `${home}/.vellum/work`;

export const workControlSocketPath = (workHome: string): string =>
  `${workHome}/control.sock`;

export const workControlTokenPath = (workHome: string): string =>
  `${workHome}/token`;

export const WORK_HOME_ENV = "VELLUM_WORK_HOME";
export const WORK_NODE_REF_ENV = "VELLUM_NODE_REF";
export const WORK_PROTOCOL_VERSION = "vellum-work/v1";

export const WORK_DEFAULT_BATCH_CONCURRENCY = 5;
export const WORK_DEFAULT_TIMEOUT_MS = 30_000;
export const WORK_MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const WORK_MAX_ERROR_BYTES = 4_096;

// ---------------------------------------------------------------------------
// Ops

export const WorkOpName = Schema.Literal(
  "ping",
  "doctor",
  "capabilities",
  "onboard",
  "tasks.list",
  "tasks.claim",
  "tasks.update",
  "msg.list",
  "msg.send",
  "request.create",
  "artifact.publish",
);
export type WorkOpName = typeof WorkOpName.Type;

// ---------------------------------------------------------------------------
// Error family (wire + CLI). Exhaustive at the boundary.

export const WorkErrorType = Schema.Literal(
  "ScopeError",
  "ClaimConflict",
  "UnknownTarget",
  "StaleNodeRef",
  "InvalidTransition",
  "RuntimeDown",
  "AuthError",
  "InputError",
  "ProtocolError",
  "InternalError",
);
export type WorkErrorType = typeof WorkErrorType.Type;

export const WorkErrorDetails = Schema.Struct({
  path: Schema.optionalWith(Schema.String, { exact: true }),
  expected: Schema.optionalWith(Schema.Unknown, { exact: true }),
  received: Schema.optionalWith(Schema.Unknown, { exact: true }),
  hint: Schema.optionalWith(Schema.String, { exact: true }),
  next_step: Schema.optionalWith(Schema.String, { exact: true }),
  retryable: Schema.optionalWith(Schema.Boolean, { exact: true }),
  from: Schema.optionalWith(Schema.String, { exact: true }),
  to: Schema.optionalWith(Schema.String, { exact: true }),
  holder: Schema.optionalWith(Schema.String, { exact: true }),
  target: Schema.optionalWith(Schema.String, { exact: true }),
  caller: Schema.optionalWith(Schema.String, { exact: true }),
  missing: Schema.optionalWith(Schema.String, { exact: true }),
});
export type WorkErrorDetails = typeof WorkErrorDetails.Type;

export const WorkErrorBody = Schema.Struct({
  type: WorkErrorType,
  message: Schema.String,
  details: Schema.optionalWith(WorkErrorDetails, { exact: true }),
});
export type WorkErrorBody = typeof WorkErrorBody.Type;

// ---------------------------------------------------------------------------
// Request / response envelopes (wire)

export const WorkRequestEnvelope = Schema.Struct({
  token: Schema.String,
  nodeRef: Schema.String,
  op: WorkOpName,
  args: Schema.optionalWith(Schema.Unknown, { exact: true }),
  id: Schema.optionalWith(Schema.String, { exact: true }),
});
export type WorkRequestEnvelope = typeof WorkRequestEnvelope.Type;

export const WorkResponseOk = Schema.Struct({
  ok: Schema.Literal(true),
  op: WorkOpName,
  data: Schema.Unknown,
  id: Schema.optionalWith(Schema.String, { exact: true }),
  protocol_version: Schema.optionalWith(Schema.String, { exact: true }),
});
export type WorkResponseOk = typeof WorkResponseOk.Type;

export const WorkResponseErr = Schema.Struct({
  ok: Schema.Literal(false),
  op: Schema.optionalWith(WorkOpName, { exact: true }),
  error: WorkErrorBody,
  id: Schema.optionalWith(Schema.String, { exact: true }),
  protocol_version: Schema.optionalWith(Schema.String, { exact: true }),
});
export type WorkResponseErr = typeof WorkResponseErr.Type;

export const WorkResponseEnvelope = Schema.Union(WorkResponseOk, WorkResponseErr);
export type WorkResponseEnvelope = typeof WorkResponseEnvelope.Type;

export const decodeWorkRequest = Schema.decodeUnknownEither(WorkRequestEnvelope);
export const decodeWorkResponse = Schema.decodeUnknownEither(WorkResponseEnvelope);

export const workOk = (
  op: WorkOpName,
  data: unknown,
  id?: string,
): WorkResponseOk => ({
  ok: true,
  op,
  data,
  protocol_version: WORK_PROTOCOL_VERSION,
  ...(id !== undefined ? { id } : {}),
});

export const workErr = (
  type: WorkErrorType,
  message: string,
  details?: WorkErrorDetails,
  op?: WorkOpName,
  id?: string,
): WorkResponseErr => ({
  ok: false,
  error: {
    type,
    message,
    ...(details !== undefined ? { details } : {}),
  },
  protocol_version: WORK_PROTOCOL_VERSION,
  ...(op !== undefined ? { op } : {}),
  ...(id !== undefined ? { id } : {}),
});

// ---------------------------------------------------------------------------
// Domain arg schemas (shared by CLI input + daemon decode)

export const NodeField = Schema.optionalWith(Schema.String, { exact: true });

export const TasksListArgs = Schema.Struct({
  target: Schema.String,
  node: NodeField,
});
export type TasksListArgs = typeof TasksListArgs.Type;

export const TasksClaimArgs = Schema.Struct({
  target: Schema.String,
  task: Schema.String,
  actor: Schema.optionalWith(Schema.String, { exact: true }),
  node: NodeField,
});
export type TasksClaimArgs = typeof TasksClaimArgs.Type;

export const TasksUpdateArgs = Schema.Struct({
  target: Schema.String,
  task: Schema.String,
  state: TaskState,
  note: Schema.optionalWith(Schema.String, { exact: true }),
  node: NodeField,
});
export type TasksUpdateArgs = typeof TasksUpdateArgs.Type;

export const MsgListArgs = Schema.Struct({
  target: Schema.String,
  taskId: Schema.optionalWith(Schema.String, { exact: true }),
  node: NodeField,
});
export type MsgListArgs = typeof MsgListArgs.Type;

export const MsgSendArgs = Schema.Struct({
  target: Schema.String,
  text: Schema.String,
  taskId: Schema.optionalWith(Schema.String, { exact: true }),
  role: Schema.optionalWith(Schema.Literal("user", "agent"), { exact: true }),
  node: NodeField,
});
export type MsgSendArgs = typeof MsgSendArgs.Type;

export const RequestCreateArgs = Schema.Struct({
  target: Schema.String,
  brief: Schema.String,
  metadata: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
    { exact: true },
  ),
  node: NodeField,
});
export type RequestCreateArgs = typeof RequestCreateArgs.Type;

/** Wire form after CLI has inlined file bytes as base64 raw parts. */
export const ArtifactPartWire = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("url"),
    url: Schema.String,
    mediaType: Schema.optionalWith(Schema.String, { exact: true }),
  }),
  Schema.Struct({ kind: Schema.Literal("data"), data: Schema.Unknown }),
  Schema.Struct({
    kind: Schema.Literal("raw"),
    bytesBase64: Schema.String,
    mediaType: Schema.optionalWith(Schema.String, { exact: true }),
  }),
);

export const ArtifactPublishArgs = Schema.Struct({
  target: Schema.String,
  name: Schema.optionalWith(Schema.String, { exact: true }),
  artifactId: Schema.optionalWith(Schema.String, { exact: true }),
  parts: Schema.Array(ArtifactPartWire),
  taskId: Schema.optionalWith(Schema.String, { exact: true }),
  metadata: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
    { exact: true },
  ),
  node: NodeField,
});
export type ArtifactPublishArgs = typeof ArtifactPublishArgs.Type;

/** CLI-only: raw parts may carry a filesystem path; CLI reads + b64s. */
export const ArtifactPartCli = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("url"),
    url: Schema.String,
    mediaType: Schema.optionalWith(Schema.String, { exact: true }),
  }),
  Schema.Struct({ kind: Schema.Literal("data"), data: Schema.Unknown }),
  Schema.Struct({
    kind: Schema.Literal("raw"),
    bytesBase64: Schema.optionalWith(Schema.String, { exact: true }),
    path: Schema.optionalWith(Schema.String, { exact: true }),
    mediaType: Schema.optionalWith(Schema.String, { exact: true }),
  }),
);

export const ArtifactPublishCliArgs = Schema.Struct({
  target: Schema.String,
  name: Schema.optionalWith(Schema.String, { exact: true }),
  artifactId: Schema.optionalWith(Schema.String, { exact: true }),
  parts: Schema.Array(ArtifactPartCli),
  taskId: Schema.optionalWith(Schema.String, { exact: true }),
  metadata: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
    { exact: true },
  ),
  node: NodeField,
});
export type ArtifactPublishCliArgs = typeof ArtifactPublishCliArgs.Type;

export const EmptyArgs = Schema.Struct({
  node: NodeField,
});
export type EmptyArgs = typeof EmptyArgs.Type;

// ---------------------------------------------------------------------------
// Helpers

export const validateNodeRefString = (
  input: string,
):
  | { readonly ok: true; readonly value: { readonly canvasName: string; readonly nodeId: string } }
  | { readonly ok: false; readonly error: WorkErrorBody } => {
  const parsed = parseNodeRef(input);
  if (!parsed.ok) {
    return {
      ok: false,
      error: {
        type: "StaleNodeRef",
        message: parsed.error.message,
        details: {
          path: "nodeRef",
          received: input,
          hint: "use a canonical vellum://canvas/<name>?node=<id> reference",
          next_step: "set VELLUM_NODE_REF or pass node in the payload",
          retryable: false,
        },
      },
    };
  }
  return { ok: true, value: parsed.value };
};

export const stripTokenFromLog = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  if ("token" in copy) copy.token = "[redacted]";
  return copy;
};

export const encodeWorkFrame = (value: unknown): string => `${JSON.stringify(value)}\n`;

export const decodeWorkJsonLine = (line: string): Either.Either<unknown, string> => {
  try {
    return Either.right(JSON.parse(line) as unknown);
  } catch {
    return Either.left("malformed JSON frame");
  }
};
