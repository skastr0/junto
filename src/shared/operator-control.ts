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
  MachineListData, MachineStatusData, MachineRemoved, MachineHarnesses, BoatAddData,
  type MachineArgsByOp, type MachineDataByOp,
} from "./machine-control";
import { MachineInstallResult, MachineInstallError } from "./machine-install";
import { RemoteHost } from "./remote-hosts";
import { MachineExchangeInput, MachineExchangeData } from "./machine-exchange";
import { MachineLogRead, MachineLogsInput } from "./machine-log";
import { EncodedFailure } from "./failure";
import { BoatAddInput, BoatConnectData, BoatDisconnectData, BoatMachineView, BoatStatusData } from "./boat";
import { MachineSeatInput, MachineSeatRead, MachineSeatReadInput, MachineSeatStartInput, MachineSeatStarted, MachineSeatStopped } from "./machine-seat";
import {
  MachineLinkInput, MachineLinkData, MachineLinkKeyInput, MachineLinkKeyData, MachineLinkAcceptInput, MachineLinkAcceptData,
  MachineLinkOpenInput, MachineLinkOpenData, MachineLinkRevokeInput, MachineLinkRevokeData,
} from "./machine-link";
import { MachineVaultRecordInput, MachineVaultTokenData, MachineVaultTokenInput } from "./vault";

/** Owner-local control, admitted by OS peer ancestry rather than seat tokens. */

export const OPERATOR_PROTOCOL_VERSION = "junto-operator/v1" as const;
export const OPERATOR_DEFAULT_TIMEOUT_MS = 30_000;
/** The longest wait a caller may ask for. */
export const OPERATOR_MAX_TIMEOUT_MS = 15 * 60_000;
/**
 * Room for one whole companion frame (288 KiB in, for a `content.stage`
 * piece; 512 KiB out) plus the operator envelope that carries it.
 */
export const OPERATOR_MAX_REQUEST_BYTES = 320 * 1024;
export const OPERATOR_MAX_RESPONSE_BYTES = 544 * 1024;
/** The refusal a connection gets while every operator control peer slot is taken. */
export const OPERATOR_PEER_LIMIT_MESSAGE = "operator control peer limit reached";
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
export const OperatorMachineExchangeRequest = request("machine.exchange", MachineExchangeInput);
export const OperatorMachineLogsRequest = request("machine.logs", MachineLogsInput);
export const OperatorMachineSeatStartRequest = request("machine.seat-start", MachineSeatStartInput);
export const OperatorMachineSeatStopRequest = request("machine.seat-stop", MachineSeatInput);
export const OperatorMachineSeatReadRequest = request("machine.seat-read", MachineSeatReadInput);
export const OperatorMachineBoatConnectRequest = request("machine.boat-connect", MachineEmptyInput);
export const OperatorMachineBoatDisconnectRequest = request("machine.boat-disconnect", MachineEmptyInput);
export const OperatorMachineBoatStatusRequest = request("machine.boat-status", MachineEmptyInput);
export const OperatorMachineBoatAddRequest = request("machine.boat-add", BoatAddInput);
export const OperatorMachineBoatDeleteRequest = request("machine.boat-delete", MachineTargetInput);
export const OperatorMachineWakeRequest = request("machine.wake", MachineTargetInput);
export const OperatorMachineSleepRequest = request("machine.sleep", MachineTargetInput);
export const OperatorMachineLinkRequest = request("machine.link", MachineLinkInput);
export const OperatorMachineLinkKeyRequest = request("machine.link-key", MachineLinkKeyInput);
export const OperatorMachineLinkAcceptRequest = request("machine.link-accept", MachineLinkAcceptInput);
export const OperatorMachineLinkOpenRequest = request("machine.link-open", MachineLinkOpenInput);
export const OperatorMachineLinkRevokeRequest = request("machine.link-revoke", MachineLinkRevokeInput);
export const OperatorMachineVaultTokenRequest = request("machine.vault-token", MachineVaultTokenInput);
export const OperatorMachineVaultRecordRequest = request("machine.vault-record", MachineVaultRecordInput);

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
OperatorMachineExchangeRequest,
OperatorMachineLogsRequest,
OperatorMachineSeatStartRequest,
OperatorMachineSeatStopRequest,
OperatorMachineSeatReadRequest,
OperatorMachineBoatConnectRequest,
OperatorMachineBoatDisconnectRequest,
OperatorMachineBoatStatusRequest,
OperatorMachineBoatAddRequest,
OperatorMachineBoatDeleteRequest,
OperatorMachineWakeRequest,
OperatorMachineSleepRequest,
OperatorMachineLinkRequest,
OperatorMachineLinkKeyRequest,
OperatorMachineLinkAcceptRequest,
OperatorMachineLinkOpenRequest,
OperatorMachineLinkRevokeRequest,
OperatorMachineVaultTokenRequest,
OperatorMachineVaultRecordRequest,
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
export const OperatorMachineExchangeResponse = response("machine.exchange", MachineExchangeData);
export const OperatorMachineLogsResponse = response("machine.logs", MachineLogRead);
export const OperatorMachineSeatStartResponse = response("machine.seat-start", MachineSeatStarted);
export const OperatorMachineSeatStopResponse = response("machine.seat-stop", MachineSeatStopped);
export const OperatorMachineSeatReadResponse = response("machine.seat-read", MachineSeatRead);
export const OperatorMachineBoatConnectResponse = response("machine.boat-connect", BoatConnectData);
export const OperatorMachineBoatDisconnectResponse = response("machine.boat-disconnect", BoatDisconnectData);
export const OperatorMachineBoatStatusResponse = response("machine.boat-status", BoatStatusData);
export const OperatorMachineBoatAddResponse = response("machine.boat-add", BoatAddData);
export const OperatorMachineBoatDeleteResponse = response("machine.boat-delete", MachineRemoved);
export const OperatorMachineWakeResponse = response("machine.wake", BoatMachineView);
export const OperatorMachineSleepResponse = response("machine.sleep", BoatMachineView);
export const OperatorMachineLinkResponse = response("machine.link", MachineLinkData);
export const OperatorMachineLinkKeyResponse = response("machine.link-key", MachineLinkKeyData);
export const OperatorMachineLinkAcceptResponse = response("machine.link-accept", MachineLinkAcceptData);
export const OperatorMachineLinkOpenResponse = response("machine.link-open", MachineLinkOpenData);
export const OperatorMachineLinkRevokeResponse = response("machine.link-revoke", MachineLinkRevokeData);
export const OperatorMachineVaultTokenResponse = response("machine.vault-token", MachineVaultTokenData);
export const OperatorMachineVaultRecordResponse = response("machine.vault-record", MachineVaultTokenData);

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
    installed: Schema.optionalKey(MachineInstallResult),
    /** The typed failure behind the message, encoded and scrubbed by the one encoder. */
    failure: Schema.optionalKey(EncodedFailure),
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
OperatorMachineExchangeResponse,
OperatorMachineLogsResponse,
OperatorMachineSeatStartResponse,
OperatorMachineSeatStopResponse,
OperatorMachineSeatReadResponse,
OperatorMachineBoatConnectResponse,
OperatorMachineBoatDisconnectResponse,
OperatorMachineBoatStatusResponse,
OperatorMachineBoatAddResponse,
OperatorMachineBoatDeleteResponse,
OperatorMachineWakeResponse,
OperatorMachineSleepResponse,
OperatorMachineLinkResponse,
OperatorMachineLinkKeyResponse,
OperatorMachineLinkAcceptResponse,
OperatorMachineLinkOpenResponse,
OperatorMachineLinkRevokeResponse,
OperatorMachineVaultTokenResponse,
OperatorMachineVaultRecordResponse,
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
