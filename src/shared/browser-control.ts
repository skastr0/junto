import { Either, Schema } from "effect";
import {
  BROWSER_CLI_REQUEST_TIMEOUT_MS,
  BROWSER_CONTROL_HEADERS_TIMEOUT_MS,
  BROWSER_CONTROL_MAX_HEADER_BYTES,
  BROWSER_CONTROL_MAX_REQUEST_BODY_BYTES,
  BROWSER_CONTROL_MAX_RESPONSE_BYTES,
  BROWSER_CONTROL_REQUEST_BODY_TIMEOUT_MS,
  BROWSER_MAX_ERROR_BYTES,
  BROWSER_MAX_EVAL_CODE_BYTES,
  BROWSER_MAX_EVAL_RESULT_DEPTH,
  BROWSER_MAX_EVAL_RESULT_NODES,
  BROWSER_MAX_EVAL_RESULT_BYTES,
  BROWSER_MAX_REF_BYTES,
  BROWSER_MAX_SESSION_ID_BYTES,
  BROWSER_MAX_URL_BYTES,
  clampUtf8Bytes,
  isUtf8WithinLimit,
  isValidBrowserSessionId,
  utf8ByteLength,
} from "./browser-limits";

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
/** Host-qualified origin route; still served only on the owner-local UDS. */
export const STATION_BROWSER_ORIGIN_ROUTE_PATH = "/station-route";

export const CONTROL_MAX_HEADER_BYTES = BROWSER_CONTROL_MAX_HEADER_BYTES;
export const CONTROL_HEADERS_TIMEOUT_MS = BROWSER_CONTROL_HEADERS_TIMEOUT_MS;
export const CONTROL_REQUEST_TIMEOUT_MS = BROWSER_CONTROL_REQUEST_BODY_TIMEOUT_MS;
export const CONTROL_MAX_BODY_BYTES = BROWSER_CONTROL_MAX_REQUEST_BODY_BYTES;
export const CONTROL_MAX_RESPONSE_BYTES = BROWSER_CONTROL_MAX_RESPONSE_BYTES;
export const CONTROL_CLI_REQUEST_TIMEOUT_MS = BROWSER_CLI_REQUEST_TIMEOUT_MS;

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
  "unsupported_capability", // resolved page host cannot run browser work here
  "unsupported_result", // result is not losslessly representable as JSON
  "result_too_large", // result or response exceeds its byte budget
  "failed", // operation attempted and failed (load error, eval throw, io)
  "runtime_down", // app not running — socket absent or refusing (CLI-side)
);
export type ControlErrorTag = typeof ControlErrorTag.Type;

const ControlErrorMessage = Schema.String.pipe(
  Schema.filter(
    (value) => isUtf8WithinLimit(value, BROWSER_MAX_ERROR_BYTES),
    { message: () => `control error exceeds ${BROWSER_MAX_ERROR_BYTES} UTF-8 bytes` },
  ),
);

export const ControlError = Schema.Struct({
  _tag: ControlErrorTag,
  message: ControlErrorMessage,
});
export type ControlError = typeof ControlError.Type;

export const controlError = (_tag: ControlErrorTag, message: string): ControlError => ({
  _tag,
  message: clampUtf8Bytes(message, BROWSER_MAX_ERROR_BYTES),
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

type JsonInspection =
  | { readonly ok: true; readonly encoded: string; readonly bytes: number }
  | { readonly ok: false; readonly error: ControlError };

const unsupportedJson = (): ControlError =>
  controlError("unsupported_result", "result is not a finite plain JSON tree");

const inspectPlainJsonTree = (root: unknown): ControlError | undefined => {
  const active = new WeakSet<object>();
  const stack: Array<{ readonly value: unknown; readonly depth: number; readonly exit: boolean }> = [
    { value: root, depth: 0, exit: false },
  ];
  let nodes = 0;
  try {
    while (stack.length > 0) {
      const frame = stack.pop();
      if (frame === undefined) break;
      const value = frame.value;
      if (!frame.exit) {
        nodes += 1;
        if (nodes > BROWSER_MAX_EVAL_RESULT_NODES || frame.depth > BROWSER_MAX_EVAL_RESULT_DEPTH) {
          return controlError(
            "result_too_large",
            `result exceeds the ${BROWSER_MAX_EVAL_RESULT_NODES}-node or ${BROWSER_MAX_EVAL_RESULT_DEPTH}-depth limit`,
          );
        }
      }
      if (typeof value !== "object" || value === null) {
        if (
          value === undefined ||
          typeof value === "bigint" ||
          typeof value === "function" ||
          typeof value === "symbol" ||
          (typeof value === "number" && !Number.isFinite(value))
        ) {
          return unsupportedJson();
        }
        continue;
      }
      if (frame.exit) {
        active.delete(value);
        continue;
      }
      if (active.has(value)) return unsupportedJson();
      active.add(value);
      stack.push({ value, depth: frame.depth, exit: true });

      const prototype = Object.getPrototypeOf(value);
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some((key) => typeof key === "symbol")) return unsupportedJson();

      if (Array.isArray(value)) {
        if (prototype !== Array.prototype || value.length > BROWSER_MAX_EVAL_RESULT_NODES) {
          return unsupportedJson();
        }
        const allowed = new Set<string>(["length"]);
        for (let index = 0; index < value.length; index += 1) allowed.add(String(index));
        if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) {
          return unsupportedJson();
        }
        for (let index = value.length - 1; index >= 0; index -= 1) {
          const descriptor = descriptors[String(index)];
          if (descriptor === undefined || !("value" in descriptor)) return unsupportedJson();
          stack.push({ value: descriptor.value, depth: frame.depth + 1, exit: false });
        }
        continue;
      }

      if (prototype !== Object.prototype && prototype !== null) return unsupportedJson();
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index];
        if (typeof key !== "string") return unsupportedJson();
        const descriptor = descriptors[key];
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
          return unsupportedJson();
        }
        stack.push({ value: descriptor.value, depth: frame.depth + 1, exit: false });
      }
    }
    return undefined;
  } catch {
    return unsupportedJson();
  }
};

/** Strictly inspect a value before placing it on the control wire. */
export const inspectControlJson = (
  value: unknown,
  maxBytes: number,
): JsonInspection => {
  const treeError = inspectPlainJsonTree(value);
  if (treeError !== undefined) return { ok: false, error: treeError };
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      return {
        ok: false,
        error: controlError("unsupported_result", "result is not supported by the JSON control wire"),
      };
    }
    const bytes = utf8ByteLength(encoded);
    return bytes <= maxBytes
      ? { ok: true, encoded, bytes }
      : {
          ok: false,
          error: controlError("result_too_large", `result exceeds ${maxBytes} UTF-8 bytes`),
        };
  } catch {
    return {
      ok: false,
      error: controlError("unsupported_result", "result is not supported by the JSON control wire"),
    };
  }
};

export const inspectEvalResult = (value: unknown): JsonInspection =>
  inspectControlJson(value, BROWSER_MAX_EVAL_RESULT_BYTES);

/** Serialize every response through one bounded, failure-safe wire encoder. */
export const encodeControlEnvelope = (envelope: ControlEnvelope<unknown>): string => {
  const inspected = inspectControlJson(envelope, BROWSER_CONTROL_MAX_RESPONSE_BYTES);
  if (inspected.ok) return inspected.encoded;
  const fallback = JSON.stringify({ ok: false, error: inspected.error } satisfies ControlErr);
  return utf8ByteLength(fallback) <= BROWSER_CONTROL_MAX_RESPONSE_BYTES
    ? fallback
    : '{"ok":false,"error":{"_tag":"failed","message":"control response encoding failed"}}';
};

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

const boundedString = (label: string, maxBytes: number) =>
  Schema.String.pipe(
    Schema.filter(
      (value) => isUtf8WithinLimit(value, maxBytes),
      { message: () => `${label} exceeds ${maxBytes} UTF-8 bytes` },
    ),
  );

const SessionId = Schema.String.pipe(
  Schema.filter(
    isValidBrowserSessionId,
    { message: () => "sessionId must be nonempty bounded ASCII" },
  ),
);

export const OpenRequest = Schema.Struct({
  ref: boundedString("ref", BROWSER_MAX_REF_BYTES),
});
export type OpenRequest = typeof OpenRequest.Type;

export const GotoRequest = Schema.Struct({
  sessionId: SessionId,
  url: boundedString("url", BROWSER_MAX_URL_BYTES),
});
export type GotoRequest = typeof GotoRequest.Type;

export const EvalRequest = Schema.Struct({
  sessionId: SessionId,
  code: boundedString("code", BROWSER_MAX_EVAL_CODE_BYTES),
});
export type EvalRequest = typeof EvalRequest.Type;

export const ScreenshotRequest = Schema.Struct({
  sessionId: SessionId,
});
export type ScreenshotRequest = typeof ScreenshotRequest.Type;

export const CloseRequest = Schema.Struct({
  sessionId: SessionId,
});
export type CloseRequest = typeof CloseRequest.Type;

export const StopRequest = Schema.Struct({
  sessionId: SessionId,
});
export type StopRequest = typeof StopRequest.Type;

// ---------------------------------------------------------------------------
// Responses (data half of the envelope)

export const DoctorData = Schema.Struct({
  status: Schema.Literal("ok"),
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
  hostId: Schema.String,
  url: Schema.String,
  profile: Schema.String,
  state: Schema.String,
  attached: Schema.Boolean,
  title: Schema.optionalWith(Schema.String, { exact: true }),
  lastError: Schema.optionalWith(Schema.String, { exact: true }),
});
export type SessionData = typeof SessionData.Type;

export const EvalData = Schema.Struct({
  // Strict finite JSON decoded from the isolated-world eval envelope.
  result: Schema.Unknown,
});
export type EvalData = typeof EvalData.Type;

export const ScreenshotData = Schema.Struct({
  path: Schema.String,
  bytes: Schema.Number,
});
export type ScreenshotData = typeof ScreenshotData.Type;

/** A page node found in an authorial canvas document (link node with entity.kind "page"). */
export const PageNodeRow = Schema.Struct({
  ref: Schema.String,
  sessionId: Schema.NullOr(Schema.String),
  canvas: Schema.String,
  nodeId: Schema.String,
  hostId: Schema.String,
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
  stop: { method: "POST", path: "/stop" },
} as const;
export type ControlRouteName = keyof typeof CONTROL_ROUTES;

export const CONTROL_TOKEN_HEADER = "x-vellum-token";
export const CONTROL_REQUEST_ID_HEADER = "x-vellum-request-id";

/** Child-only environment inputs. Values never enter argv or query strings. */
export const CONTROL_HOME_ENV = "VELLUM_BROWSER_HOME";

/** UUID or 32-byte hex ids are accepted; both remain header-bounded. */
export const isValidControlRequestId = (value: string): boolean =>
  /^(?:[0-9a-f]{32}|[0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.test(
    value,
  );
