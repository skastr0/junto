import { Result, Schema } from "effect";
import { StatusResponse } from "./station-api";
import {
  CompanionDeviceId,
  CompanionError,
  CompanionHello,
  CompanionRequestFrame,
  CompanionResponseFrame,
} from "./companion-protocol";
import { AgentSignal } from "./agent-signals";

/**
 * Direct-operator control contract.
 *
 * This owner-local socket is separate from every agent control plane. It has
 * no bearer token, identity claim, arbitrary command, path, or database
 * access. Main admits the OS peer only while explicitly launched in operator
 * control mode, or while a phone companion is paired, and rejects registered
 * agent process trees. Enabled only for a paired phone, the socket answers the
 * `companion.*` ops alone.
 */

export const OPERATOR_PROTOCOL_VERSION = "junto-operator/v1" as const;
export const OPERATOR_DEFAULT_TIMEOUT_MS = 30_000;
/** The longest wait a caller may ask for. */
export const OPERATOR_MAX_TIMEOUT_MS = 15 * 60_000;
/**
 * Room for one whole companion frame (16 KiB in, 512 KiB out) plus the
 * operator envelope that carries it.
 */
export const OPERATOR_MAX_REQUEST_BYTES = 24 * 1024;
export const OPERATOR_MAX_RESPONSE_BYTES = 544 * 1024;
/** A companion change wait is a long poll; the call outlives it. */
export const OPERATOR_COMPANION_WAIT_MAX_MS = 25_000;
export const OPERATOR_MAX_ERROR_BYTES = 4 * 1024;

export const operatorControlDir = (home: string): string =>
  `${home}/.junto/operator`;

export const operatorControlSocketPath = (home: string): string =>
  `${operatorControlDir(home)}/control.sock`;

const RequestId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(64)),
  Schema.check(Schema.isPattern(/^[A-Za-z0-9._-]+$/u)),
);

const Diagnostic = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(4_096)),
);

export const OperatorOpName = Schema.Literals(["station.status", "station.configure-command-center",
"companion.hello",
"companion.call",
"companion.events",]);
export type OperatorOpName = typeof OperatorOpName.Type;

export const OperatorEmptyArgs = Schema.Struct({});
export type OperatorEmptyArgs = typeof OperatorEmptyArgs.Type;

// --- companion relay (junto companion-stdio <-> app) ---------------------------

/** The ops a socket enabled only for a paired phone will answer. */
export const OPERATOR_COMPANION_OPS: ReadonlySet<string> = new Set([
  "companion.hello",
  "companion.call",
  "companion.events",
]);

export const OperatorCompanionHelloArgs = Schema.Struct({ deviceId: CompanionDeviceId });
export type OperatorCompanionHelloArgs = typeof OperatorCompanionHelloArgs.Type;

/** A companion-level refusal (revoked) travels as data, not an operator error. */
export const OperatorCompanionHelloData = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), hello: CompanionHello }),
  Schema.Struct({ ok: Schema.Literal(false), error: CompanionError }),
]);
export type OperatorCompanionHelloData = typeof OperatorCompanionHelloData.Type;

export const OperatorCompanionCallArgs = Schema.Struct({
  deviceId: CompanionDeviceId,
  request: CompanionRequestFrame,
});
export type OperatorCompanionCallArgs = typeof OperatorCompanionCallArgs.Type;

export const OperatorCompanionCallData = Schema.Struct({ response: CompanionResponseFrame });
export type OperatorCompanionCallData = typeof OperatorCompanionCallData.Type;

export const OperatorCompanionEventsArgs = Schema.Struct({
  deviceId: CompanionDeviceId,
  cursor: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMaxLength(128)))),
  waitMs: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isBetween({ minimum: 0, maximum: OPERATOR_COMPANION_WAIT_MAX_MS })),
  ),
});
export type OperatorCompanionEventsArgs = typeof OperatorCompanionEventsArgs.Type;

export const OperatorCompanionEventsData = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    cursor: Schema.String,
    changed: Schema.Boolean,
    signals: Schema.Array(AgentSignal),
    reset: Schema.Boolean,
  }),
  Schema.Struct({ ok: Schema.Literal(false), error: CompanionError }),
]);
export type OperatorCompanionEventsData = typeof OperatorCompanionEventsData.Type;

const request = <
  Op extends OperatorOpName,
  S extends Schema.Top,
>(
  op: Op,
  args: S,
) =>
  Schema.Struct({
    protocol: Schema.Literal(OPERATOR_PROTOCOL_VERSION),
    id: RequestId,
    op: Schema.Literal(op),
    args,
  });

export const OperatorStationStatusRequest = request(
  "station.status",
  OperatorEmptyArgs,
);
export const OperatorConfigureCommandCenterRequest = request(
  "station.configure-command-center",
  OperatorEmptyArgs,
);
export const OperatorCompanionHelloRequest = request("companion.hello", OperatorCompanionHelloArgs);
export const OperatorCompanionCallRequest = request("companion.call", OperatorCompanionCallArgs);
export const OperatorCompanionEventsRequest = request("companion.events", OperatorCompanionEventsArgs);

export const OperatorRequestEnvelope = Schema.Union([OperatorStationStatusRequest,
OperatorConfigureCommandCenterRequest,
OperatorCompanionHelloRequest,
OperatorCompanionCallRequest,
OperatorCompanionEventsRequest,]);
export type OperatorRequestEnvelope = typeof OperatorRequestEnvelope.Type;

const response = <
  Op extends OperatorOpName,
  S extends Schema.Top,
>(
  op: Op,
  data: S,
) =>
  Schema.Struct({
    protocol: Schema.Literal(OPERATOR_PROTOCOL_VERSION),
    id: RequestId,
    ok: Schema.Literal(true),
    op: Schema.Literal(op),
    data,
  });

export const OperatorStationStatusResponse = response(
  "station.status",
  StatusResponse,
);
export const OperatorConfigureCommandCenterResponse = response(
  "station.configure-command-center",
  StatusResponse,
);
export const OperatorCompanionHelloResponse = response("companion.hello", OperatorCompanionHelloData);
export const OperatorCompanionCallResponse = response("companion.call", OperatorCompanionCallData);
export const OperatorCompanionEventsResponse = response("companion.events", OperatorCompanionEventsData);

export const OperatorErrorType = Schema.Literals(["validation", "not_found",
"conflict",
"io",
"runtime_down",
"auth_error",
"protocol_error",
"forbidden",
"shutdown",
"internal_error",]);
export type OperatorErrorType = typeof OperatorErrorType.Type;

export const OperatorErrorBody = Schema.Struct({
  type: OperatorErrorType,
  message: Diagnostic,
  details: Schema.optionalKey(Schema.Struct({
    path: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMaxLength(128)))),
    next_step: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMaxLength(1_024)))),
    retryable: Schema.optionalKey(Schema.Boolean),
  })),
});
export type OperatorErrorBody = typeof OperatorErrorBody.Type;

export const OperatorErrorResponse = Schema.Struct({
  protocol: Schema.Literal(OPERATOR_PROTOCOL_VERSION),
  id: Schema.optionalKey(RequestId),
  ok: Schema.Literal(false),
  op: Schema.optionalKey(OperatorOpName),
  error: OperatorErrorBody,
});
export type OperatorErrorResponse = typeof OperatorErrorResponse.Type;

export const OperatorResponseEnvelope = Schema.Union([OperatorStationStatusResponse,
OperatorConfigureCommandCenterResponse,
OperatorCompanionHelloResponse,
OperatorCompanionCallResponse,
OperatorCompanionEventsResponse,
OperatorErrorResponse,]);
export type OperatorResponseEnvelope = typeof OperatorResponseEnvelope.Type;

export interface OperatorArgsByOp {
  readonly "station.status": OperatorEmptyArgs;
  readonly "station.configure-command-center": OperatorEmptyArgs;
  readonly "companion.hello": OperatorCompanionHelloArgs;
  readonly "companion.call": OperatorCompanionCallArgs;
  readonly "companion.events": OperatorCompanionEventsArgs;
}

export interface OperatorDataByOp {
  readonly "station.status": typeof StatusResponse.Type;
  readonly "station.configure-command-center": typeof StatusResponse.Type;
  readonly "companion.hello": OperatorCompanionHelloData;
  readonly "companion.call": OperatorCompanionCallData;
  readonly "companion.events": OperatorCompanionEventsData;
}

export const decodeOperatorRequest = Schema.decodeUnknownResult(
  OperatorRequestEnvelope,
  { onExcessProperty: "error" },
);

export const decodeOperatorResponse = Schema.decodeUnknownResult(
  OperatorResponseEnvelope,
  { onExcessProperty: "error" },
);

export const encodeOperatorFrame = (
  value: unknown,
  maxBytes = OPERATOR_MAX_RESPONSE_BYTES,
): string => {
  const frame = `${JSON.stringify(value)}\n`;
  if (new TextEncoder().encode(frame).byteLength > maxBytes) {
    throw new Error(`operator control frame exceeds ${maxBytes} bytes`);
  }
  return frame;
};

export const decodeOperatorJsonLine = (
  line: string,
): Result.Result<unknown, string> => {
  try {
    return Result.succeed(JSON.parse(line) as unknown);
  } catch {
    return Result.fail("malformed JSON frame");
  }
};

/**
 * Operator requests contain only public deployment selection facts, except a
 * relayed companion request, whose answer or mail text never reaches a log.
 */
export const redactOperatorRequestForLog = (
  value: OperatorRequestEnvelope,
): unknown =>
  value.op === "companion.call"
    ? { ...value, args: { deviceId: value.args.deviceId, request: { id: value.args.request.id, op: value.args.request.op } } }
    : value;
