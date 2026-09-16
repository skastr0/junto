import { Result, Schema } from "effect";
import { CanvasDoc } from "@shared/canvas";
import {
  CANVAS_NAME_INPUT_PATTERN,
  CANVAS_NAME_MAX_LENGTH,
} from "@shared/canvas-name";
import { SnapshotState } from "@shared/entities";
import { ActorRef } from "@shared/work-protocol";

/**
 * Main-owned headless canvas protocol.
 *
 * One NDJSON request and one NDJSON response travel over an owner-only Unix
 * socket. The surface is projection-only: it cannot mutate authorial intent.
 */
export const CANVAS_CONTROL_PROTOCOL_VERSION = "vellum-canvas-control/v1";
export const CANVAS_CONTROL_HOME_ENV = "JUNTO_CANVAS_CONTROL_HOME";
export const CANVAS_CONTROL_DEFAULT_TIMEOUT_MS = 30_000;
export const CANVAS_CONTROL_MAX_REQUEST_BYTES = 64 * 1024;
export const CANVAS_CONTROL_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
export const CANVAS_CONTROL_MAX_ERROR_BYTES = 4_096;

export const canvasControlDir = (home: string): string =>
  `${home}/.junto/canvas`;

export const canvasControlSocketPath = (controlHome: string): string =>
  `${controlHome}/control.sock`;

/** Parse locally before dialing so an invalid name never reaches a socket. */
export const canvasControlNameFrom = (raw: string): string => {
  const trimmed = raw.trim();
  if (!CANVAS_NAME_INPUT_PATTERN.test(trimmed)) {
    throw new Error(
      `invalid canvas name "${raw}": use at most ${String(CANVAS_NAME_MAX_LENGTH)} ASCII letters, numbers, hyphens, and underscores`,
    );
  }
  return trimmed.toLowerCase();
};

export const CanvasControlOp = Schema.Literals(["list", "read"]);
export type CanvasControlOp = typeof CanvasControlOp.Type;

export const CanvasControlErrorCode = Schema.Literals(["InputError", "CanvasError",
"RuntimeDown",
"ProtocolError",
"ResponseTooLarge",
"InternalError",]);
export type CanvasControlErrorCode = typeof CanvasControlErrorCode.Type;

const RequestId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(128)),
  Schema.check(Schema.isPattern(/^[A-Za-z0-9._:-]+$/)),
);

export const CanvasControlRequestEnvelope = Schema.Struct({
  protocol_version: Schema.Literal(CANVAS_CONTROL_PROTOCOL_VERSION),
  op: CanvasControlOp,
  args: Schema.optionalKey(Schema.Unknown),
  id: Schema.optionalKey(RequestId),
});
export type CanvasControlRequestEnvelope =
  typeof CanvasControlRequestEnvelope.Type;

export const CanvasControlErrorBody = Schema.Struct({
  code: CanvasControlErrorCode,
  message: Schema.String,
  retryable: Schema.Boolean,
});
export type CanvasControlErrorBody = typeof CanvasControlErrorBody.Type;

export const CanvasControlResponseOk = Schema.Struct({
  protocol_version: Schema.Literal(CANVAS_CONTROL_PROTOCOL_VERSION),
  ok: Schema.Literal(true),
  op: CanvasControlOp,
  data: Schema.Unknown,
  id: Schema.optionalKey(RequestId),
});
export type CanvasControlResponseOk = typeof CanvasControlResponseOk.Type;

export const CanvasControlResponseErr = Schema.Struct({
  protocol_version: Schema.Literal(CANVAS_CONTROL_PROTOCOL_VERSION),
  ok: Schema.Literal(false),
  op: Schema.optionalKey(CanvasControlOp),
  error: CanvasControlErrorBody,
  id: Schema.optionalKey(RequestId),
});
export type CanvasControlResponseErr = typeof CanvasControlResponseErr.Type;

export const CanvasControlResponseEnvelope = Schema.Union([CanvasControlResponseOk,
CanvasControlResponseErr,]);
export type CanvasControlResponseEnvelope =
  typeof CanvasControlResponseEnvelope.Type;

const BoundedCanvasName = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(CANVAS_NAME_MAX_LENGTH)),
  Schema.check(Schema.isPattern(CANVAS_NAME_INPUT_PATTERN)),
);

export const CanvasControlListArgs = Schema.Struct({});
export type CanvasControlListArgs = typeof CanvasControlListArgs.Type;

export const CanvasControlReadArgs = Schema.Struct({
  name: BoundedCanvasName,
});
export type CanvasControlReadArgs = typeof CanvasControlReadArgs.Type;

export const CanvasControlListEntry = Schema.Struct({
  name: Schema.String,
  modifiedAt: Schema.String,
  nodes: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  edges: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type CanvasControlListEntry = typeof CanvasControlListEntry.Type;

export const CanvasControlListData = Schema.Array(CanvasControlListEntry);
export type CanvasControlListData = typeof CanvasControlListData.Type;

export const CanvasControlReadData = Schema.Struct({
  name: Schema.String,
  revision: Schema.String,
  doc: CanvasDoc,
  actorRefs: Schema.Array(ActorRef),
  snapshots: SnapshotState,
});
export type CanvasControlReadData = typeof CanvasControlReadData.Type;

export const decodeCanvasControlRequest = Schema.decodeUnknownResult(
  CanvasControlRequestEnvelope,
  { onExcessProperty: "error" },
);
export const decodeCanvasControlResponse = Schema.decodeUnknownResult(
  CanvasControlResponseEnvelope,
);

export const canvasControlOk = (
  op: CanvasControlOp,
  data: unknown,
  id?: string,
): CanvasControlResponseOk => ({
  protocol_version: CANVAS_CONTROL_PROTOCOL_VERSION,
  ok: true,
  op,
  data,
  ...(id === undefined ? {} : { id }),
});

export const canvasControlErr = (
  code: CanvasControlErrorCode,
  message: string,
  retryable: boolean,
  op?: CanvasControlOp,
  id?: string,
): CanvasControlResponseErr => ({
  protocol_version: CANVAS_CONTROL_PROTOCOL_VERSION,
  ok: false,
  error: {
    code,
    message: message.slice(0, CANVAS_CONTROL_MAX_ERROR_BYTES),
    retryable,
  },
  ...(op === undefined ? {} : { op }),
  ...(id === undefined ? {} : { id }),
});

export const encodeCanvasControlFrame = (value: unknown): string =>
  `${JSON.stringify(value)}\n`;

export const decodeCanvasControlJsonLine = (
  line: string,
): Result.Result<unknown, string> => {
  try {
    return Result.succeed(JSON.parse(line) as unknown);
  } catch {
    return Result.fail("malformed JSON frame");
  }
};
