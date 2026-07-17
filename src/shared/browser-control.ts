import { Either, Schema } from "effect";

// Browser control-plane protocol: the wire contract between the Electron-hosted
// HTTP server (main/vellum/browser/control.ts) and the agent CLI
// (scripts/browser-cli.ts). Pure module — no Node imports — so both ends and
// tests share one source of truth. Transport is a local Unix domain socket only
// and every request carries a bearer token; this file only knows shapes,
// admission bounds, and paths-as-strings.

// ---------------------------------------------------------------------------
// Paths (functions of the home dir so the module stays platform-pure)

export const controlDir = (home: string): string => `${home}/.vellum/browser`;
export const controlSocketPath = (home: string): string => `${controlDir(home)}/control.sock`;
export const controlTokenPath = (home: string): string => `${controlDir(home)}/control.token`;
export const controlShotsDir = (home: string): string => `${controlDir(home)}/shots`;

export const CONTROL_MAX_HEADER_BYTES = 16 * 1024;
export const CONTROL_HEADERS_TIMEOUT_MS = 5_000;
export const CONTROL_REQUEST_TIMEOUT_MS = 10_000;
export const CONTROL_MAX_BODY_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// Error envelope — Effect Schema TaggedError style: every failure is a struct
// discriminated by `_tag`, JSON-serializable across the socket. `runtime_down`
// is minted client-side only (the socket does not answer); the server never
// emits it.

export const ControlErrorTag = Schema.Literal(
  "unauthorized", // missing/wrong token
  "bad_request", // malformed body / unknown route
  "invalid", // domain-invalid input (bad profile id, profile switch on warm session)
  "not_found", // no such session / node
  "forbidden", // url scheme not allowed
  "timeout", // operation exceeded its deadline
  "cancelled", // operation was aborted by its caller
  "resource_exhausted", // bounded browser capacity is currently full
  "failed", // operation attempted and failed (load error, eval throw, io)
  "runtime_down", // app not running — socket absent or refusing (CLI-side)
);
export type ControlErrorTag = typeof ControlErrorTag.Type;

export const ControlError = Schema.Struct({
  _tag: ControlErrorTag,
  message: Schema.String,
});
export type ControlError = typeof ControlError.Type;

export const controlError = (_tag: ControlErrorTag, message: string): ControlError => ({
  _tag,
  message,
});

// ok/error envelope. `data` stays schema-less here (per-endpoint schemas below
// type it); the envelope itself is the invariant every response satisfies.
export interface ControlOk<T> {
  readonly ok: true;
  readonly data: T;
}
export interface ControlErr {
  readonly ok: false;
  readonly error: ControlError;
}
export type ControlEnvelope<T> = ControlOk<T> | ControlErr;

export const controlOk = <T>(data: T): ControlOk<T> => ({ ok: true, data });
export const controlErr = (_tag: ControlErrorTag, message: string): ControlErr => ({
  ok: false,
  error: controlError(_tag, message),
});

const EnvelopeWire = Schema.Union(
  Schema.Struct({ ok: Schema.Literal(true), data: Schema.Unknown }),
  Schema.Struct({ ok: Schema.Literal(false), error: ControlError }),
);

/** Decode an untrusted wire payload into an envelope (data left unknown). */
export const decodeControlEnvelope = (
  input: unknown,
): Either.Either<ControlEnvelope<unknown>, ControlError> => {
  const decoded = Schema.decodeUnknownEither(EnvelopeWire)(input);
  return Either.isLeft(decoded)
    ? Either.left(controlError("bad_request", "malformed control envelope"))
    : Either.right(decoded.right as ControlEnvelope<unknown>);
};

// ---------------------------------------------------------------------------
// Requests

export const OpenRequest = Schema.Struct({
  ref: Schema.String,
});
export type OpenRequest = typeof OpenRequest.Type;

export const GotoRequest = Schema.Struct({
  sessionId: Schema.String,
  url: Schema.String,
});
export type GotoRequest = typeof GotoRequest.Type;

export const EvalRequest = Schema.Struct({
  sessionId: Schema.String,
  code: Schema.String,
});
export type EvalRequest = typeof EvalRequest.Type;

export const ScreenshotRequest = Schema.Struct({
  sessionId: Schema.String,
  // Absolute PNG destination; omitted → server picks under ~/.vellum/browser/shots/.
  path: Schema.optionalWith(Schema.String, { exact: true }),
});
export type ScreenshotRequest = typeof ScreenshotRequest.Type;

export const CloseRequest = Schema.Struct({
  sessionId: Schema.String,
});
export type CloseRequest = typeof CloseRequest.Type;

// ---------------------------------------------------------------------------
// Responses (data half of the envelope)

export const DoctorData = Schema.Struct({
  status: Schema.Literal("ok"),
  pid: Schema.Number,
  version: Schema.String,
  sessions: Schema.Number,
});
export type DoctorData = typeof DoctorData.Type;

export const ProfileRow = Schema.Struct({
  id: Schema.String,
  label: Schema.optionalWith(Schema.String, { exact: true }),
  default: Schema.optionalWith(Schema.Boolean, { exact: true }),
});
export type ProfileRow = typeof ProfileRow.Type;

export const SessionData = Schema.Struct({
  sessionId: Schema.String,
  ref: Schema.String,
  nodeId: Schema.String,
  url: Schema.String,
  profile: Schema.String,
  state: Schema.String,
  attached: Schema.Boolean,
  title: Schema.optionalWith(Schema.String, { exact: true }),
  lastError: Schema.optionalWith(Schema.String, { exact: true }),
});
export type SessionData = typeof SessionData.Type;

export const EvalData = Schema.Struct({
  // JSON-serialized executeJavaScript result; undefined round-trips as null.
  result: Schema.Unknown,
});
export type EvalData = typeof EvalData.Type;

export const ScreenshotData = Schema.Struct({
  path: Schema.String,
  bytes: Schema.Number,
});
export type ScreenshotData = typeof ScreenshotData.Type;

/** A page node found in a .canvas document (link node with entity.kind "page"). */
export const PageNodeRow = Schema.Struct({
  ref: Schema.String,
  sessionId: Schema.NullOr(Schema.String),
  canvas: Schema.String,
  nodeId: Schema.String,
  url: Schema.String,
  profile: Schema.optionalWith(Schema.String, { exact: true }),
});
export type PageNodeRow = typeof PageNodeRow.Type;

// ---------------------------------------------------------------------------
// Routes — single table both ends dispatch on.

export const CONTROL_ROUTES = {
  doctor: { method: "GET", path: "/doctor" },
  profiles: { method: "GET", path: "/profiles" },
  sessions: { method: "GET", path: "/sessions" },
  pages: { method: "GET", path: "/pages" },
  open: { method: "POST", path: "/open" },
  goto: { method: "POST", path: "/goto" },
  eval: { method: "POST", path: "/eval" },
  screenshot: { method: "POST", path: "/screenshot" },
  close: { method: "POST", path: "/close" },
} as const;
export type ControlRouteName = keyof typeof CONTROL_ROUTES;

export const CONTROL_TOKEN_HEADER = "x-vellum-token";
