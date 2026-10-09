import { Result, Schema } from "effect";
import {
  CompanionDeviceId,
  CompanionError,
  CompanionHello,
  CompanionRequestFrame,
  CompanionResponseFrame,
} from "./companion-protocol";
import { AgentSignal } from "./agent-signals";
import {
  MachineOpName, MachineAddInput, MachineEmptyInput, MachineCopyInput, MachineStatusInput,
  MachineTargetInput, MachinePeerIdentity, MachineConfigured, MachinePeerPin,
  MachineListData, MachineStatusData, MachineRemoved, MachineHarnesses,
  type MachineArgsByOp, type MachineDataByOp,
} from "./machine-control";
import { MachineInstallResult, MachineInstallError } from "./machine-install";
import { RemoteHost } from "./remote-hosts";

/** Owner-local control, admitted by OS peer ancestry rather than seat tokens. */

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

export const RequestId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(64)),
  Schema.check(Schema.isPattern(/^[A-Za-z0-9._-]+$/u)),
);

const Diagnostic = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(4_096)),
);

export const OperatorOpName = Schema.Literals(["companion.hello",
"companion.call",
"companion.events", ...MachineOpName.literals]);
export type OperatorOpName = typeof OperatorOpName.Type;

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

export const OperatorCompanionHelloRequest = request("companion.hello", OperatorCompanionHelloArgs);
export const OperatorCompanionCallRequest = request("companion.call", OperatorCompanionCallArgs);
export const OperatorCompanionEventsRequest = request("companion.events", OperatorCompanionEventsArgs);

export const OperatorMachineAddRequest = request("machine.add", MachineAddInput);
export const OperatorMachineListRequest = request("machine.list", MachineEmptyInput);
export const OperatorMachineSendRequest = request("machine.send", MachineCopyInput);
export const OperatorMachineStatusRequest = request("machine.status", MachineStatusInput);
export const OperatorMachineUpdateRequest = request("machine.update", MachineCopyInput);
export const OperatorMachineRemoveRequest = request("machine.remove", MachineTargetInput);
export const OperatorMachineHarnessesRequest = request("machine.harnesses", MachineStatusInput);
export const OperatorMachineConfigureRequest = request("machine.configure", MachineTargetInput);
export const OperatorMachineSetupRequest = request("machine.setup", MachinePeerIdentity);

export const OperatorRequestEnvelope = Schema.Union([OperatorCompanionHelloRequest,
OperatorCompanionCallRequest,
OperatorCompanionEventsRequest,
OperatorMachineAddRequest,
OperatorMachineListRequest,
OperatorMachineSendRequest,
OperatorMachineStatusRequest,
OperatorMachineUpdateRequest,
OperatorMachineRemoveRequest,
OperatorMachineHarnessesRequest,
OperatorMachineConfigureRequest,
OperatorMachineSetupRequest,
]);
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

export const OperatorCompanionHelloResponse = response("companion.hello", OperatorCompanionHelloData);
export const OperatorCompanionCallResponse = response("companion.call", OperatorCompanionCallData);
export const OperatorCompanionEventsResponse = response("companion.events", OperatorCompanionEventsData);

export const OperatorMachineAddResponse = response("machine.add", RemoteHost);
export const OperatorMachineListResponse = response("machine.list", MachineListData);
export const OperatorMachineSendResponse = response("machine.send", MachineInstallResult);
export const OperatorMachineStatusResponse = response("machine.status", MachineStatusData);
export const OperatorMachineUpdateResponse = response("machine.update", MachineInstallResult);
export const OperatorMachineRemoveResponse = response("machine.remove", MachineRemoved);
export const OperatorMachineHarnessesResponse = response("machine.harnesses", MachineHarnesses);
export const OperatorMachineConfigureResponse = response("machine.configure", MachineConfigured);
export const OperatorMachineSetupResponse = response("machine.setup", MachinePeerPin);

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
    disposition: Schema.optionalKey(MachineInstallError.fields.disposition),
    transitions: MachineInstallError.fields.transitions,
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

export const OperatorResponseEnvelope = Schema.Union([OperatorCompanionHelloResponse,
OperatorCompanionCallResponse,
OperatorCompanionEventsResponse,
OperatorMachineAddResponse,
OperatorMachineListResponse,
OperatorMachineSendResponse,
OperatorMachineStatusResponse,
OperatorMachineUpdateResponse,
OperatorMachineRemoveResponse,
OperatorMachineHarnessesResponse,
OperatorMachineConfigureResponse,
OperatorMachineSetupResponse,
OperatorErrorResponse,]);
export type OperatorResponseEnvelope = typeof OperatorResponseEnvelope.Type;

export interface OperatorArgsByOp extends MachineArgsByOp {
  readonly "companion.hello": OperatorCompanionHelloArgs;
  readonly "companion.call": OperatorCompanionCallArgs;
  readonly "companion.events": OperatorCompanionEventsArgs;
}

export interface OperatorDataByOp extends MachineDataByOp {
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
