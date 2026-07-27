import { Either, Schema } from "effect";
import { CanvasDoc } from "@shared/canvas";
import {
  CANVAS_NAME_INPUT_PATTERN,
  CANVAS_NAME_MAX_LENGTH,
} from "@shared/canvas-name";
import { SnapshotState } from "@shared/entities";

/**
 * Main-owned headless canvas protocol.
 *
 * One NDJSON request and one NDJSON response travel over an owner-only Unix
 * socket. There is deliberately no bearer file: read access is owner-local,
 * while the explicit authorial-write witness remains a deletion safety
 * ceremony rather than an identity claim.
 */
export const CANVAS_CONTROL_PROTOCOL_VERSION = "vellum-canvas-control/v1";
export const CANVAS_CONTROL_HOME_ENV = "VELLUM_CANVAS_CONTROL_HOME";
export const CANVAS_CONTROL_DEFAULT_TIMEOUT_MS = 30_000;
export const CANVAS_CONTROL_MAX_REQUEST_BYTES = 64 * 1024;
export const CANVAS_CONTROL_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
export const CANVAS_CONTROL_MAX_ERROR_BYTES = 4_096;

export const canvasControlDir = (home: string): string =>
  `${home}/.vellum/canvas`;

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

export const CanvasControlOp = Schema.Literal("list", "read", "remove");
export type CanvasControlOp = typeof CanvasControlOp.Type;

export const CanvasControlErrorCode = Schema.Literal(
  "InputError",
  "CanvasError",
  "RuntimeDown",
  "AuthorialWriteDenied",
  "AuthoringClosed",
  "ProtocolError",
  "ResponseTooLarge",
  "InternalError",
);
export type CanvasControlErrorCode = typeof CanvasControlErrorCode.Type;

const RequestId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(128),
  Schema.pattern(/^[A-Za-z0-9._:-]+$/),
);

export const CanvasControlRequestEnvelope = Schema.Struct({
  protocol_version: Schema.Literal(CANVAS_CONTROL_PROTOCOL_VERSION),
  op: CanvasControlOp,
  args: Schema.optionalWith(Schema.Unknown, { exact: true }),
  id: Schema.optionalWith(RequestId, { exact: true }),
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
  id: Schema.optionalWith(RequestId, { exact: true }),
});
export type CanvasControlResponseOk = typeof CanvasControlResponseOk.Type;

export const CanvasControlResponseErr = Schema.Struct({
  protocol_version: Schema.Literal(CANVAS_CONTROL_PROTOCOL_VERSION),
  ok: Schema.Literal(false),
  op: Schema.optionalWith(CanvasControlOp, { exact: true }),
  error: CanvasControlErrorBody,
  id: Schema.optionalWith(RequestId, { exact: true }),
});
export type CanvasControlResponseErr = typeof CanvasControlResponseErr.Type;

export const CanvasControlResponseEnvelope = Schema.Union(
  CanvasControlResponseOk,
  CanvasControlResponseErr,
);
export type CanvasControlResponseEnvelope =
  typeof CanvasControlResponseEnvelope.Type;

const BoundedCanvasName = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(CANVAS_NAME_MAX_LENGTH),
  Schema.pattern(CANVAS_NAME_INPUT_PATTERN),
);

export const CanvasControlListArgs = Schema.Struct({});
export type CanvasControlListArgs = typeof CanvasControlListArgs.Type;

export const CanvasControlReadArgs = Schema.Struct({
  name: BoundedCanvasName,
});
export type CanvasControlReadArgs = typeof CanvasControlReadArgs.Type;

export const CanvasControlRemoveArgs = Schema.Struct({
  name: BoundedCanvasName,
  authorialWrite: Schema.optionalWith(Schema.Boolean, { exact: true }),
});
export type CanvasControlRemoveArgs = typeof CanvasControlRemoveArgs.Type;

export const CanvasControlListEntry = Schema.Struct({
  name: Schema.String,
  modifiedAt: Schema.String,
  nodes: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  edges: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
});
export type CanvasControlListEntry = typeof CanvasControlListEntry.Type;

export const CanvasControlListData = Schema.Array(CanvasControlListEntry);
export type CanvasControlListData = typeof CanvasControlListData.Type;

export const CanvasControlReadData = Schema.Struct({
  name: Schema.String,
  revision: Schema.String,
  doc: CanvasDoc,
  snapshots: SnapshotState,
});
export type CanvasControlReadData = typeof CanvasControlReadData.Type;

export const CanvasControlRemoveData = Schema.Struct({
  name: Schema.String,
});
export type CanvasControlRemoveData = typeof CanvasControlRemoveData.Type;

export const decodeCanvasControlRequest = Schema.decodeUnknownEither(
  CanvasControlRequestEnvelope,
  { onExcessProperty: "error" },
);
export const decodeCanvasControlResponse = Schema.decodeUnknownEither(
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
): Either.Either<unknown, string> => {
  try {
    return Either.right(JSON.parse(line) as unknown);
  } catch {
    return Either.left("malformed JSON frame");
  }
};
