import { Result, Schema } from "effect";
import {
  STATION_PROTOCOL_BASELINE,
  StationProtocolAccept,
  StationProtocolOffer,
  StationProtocolPreface,
  StationProtocolReject,
  type StationProtocolVersion,
} from "./station-protocol";
import {
  STATION_SESSION_PROTOCOL,
  StationSessionFrame,
  StationSessionRequestFrame,
  StationSessionResponseFrame,
} from "./station-session";
import {
  STATION_CONTROL_PROTOCOL,
  StationControlEnvelope,
  StationControlErr,
  StationControlOk,
} from "./station-api-envelope";
import {
  STATION_API_PROTOCOL,
  ConfigureRequest,
  ConfigureResponse,
  PairRequest,
  PairResponse,
  StationOverseerRequest,
  StationOverseerResponse,
  ProjectRequest,
  ProjectResponse,
  ReportBatch,
  ReportRequest,
  ReportResponse,
  StationApiRequest,
  StationApiResponse,
  StatusRequest,
  StatusResponse,
} from "./station-api";
import {
  WORK_PROTOCOL,
  StoredWorkRecord,
  WorkAction,
  WorkCommand,
  WorkDisposition,
  WorkFact,
  WorkRecord,
  WorkResult,
} from "./work-protocol";
import {
  ContentAvailability,
  ContentCorrupt,
  ContentIdentity,
  ContentMissing,
  ContentPart,
  ContentReceipt,
  ContentRef,
  ContentUnavailable,
} from "./content";

/**
 * Frozen Station Protocol 1 Codec Bundle.
 *
 * Station protocol 1 is the exact currently deployed protocol version.
 * This module exports the closed registry mapping protocol 1 to its
 * strict Effect Schema encode/decode codecs.
 */
export const STATION_PROTOCOL_1 = STATION_PROTOCOL_BASELINE;
export type StationProtocol1 = typeof STATION_PROTOCOL_1;

export interface StationProtocolCodecDefinition<To, From = unknown> {
  readonly schema: unknown;
  readonly decode: (u: unknown) => Result.Result<To, Schema.SchemaError>;
  readonly encode: (a: To) => Result.Result<From, Schema.SchemaError>;
}

const makeCodec = <To, From = unknown>(
  schema: Schema.Schema<To>,
): StationProtocolCodecDefinition<To, From> => ({
  schema,
  decode: Schema.decodeUnknownResult(schema as any, { onExcessProperty: "error" }),
  encode: Schema.encodeResult(schema as any),
});

/**
 * Closed collection of frozen codecs for Station Protocol 1.
 */
export const STATION_PROTOCOL_1_CODECS = Object.freeze({
  version: STATION_PROTOCOL_1,
  preface: Object.freeze({
    protocol: "vellum-command/station-protocol-preface/v1" as const,
    preface: makeCodec(StationProtocolPreface),
    offer: makeCodec(StationProtocolOffer),
    accept: makeCodec(StationProtocolAccept),
    reject: makeCodec(StationProtocolReject),
  }),
  session: Object.freeze({
    protocol: STATION_SESSION_PROTOCOL,
    frame: makeCodec(StationSessionFrame),
    request: makeCodec(StationSessionRequestFrame),
    response: makeCodec(StationSessionResponseFrame),
  }),
  control: Object.freeze({
    protocol: STATION_CONTROL_PROTOCOL,
    envelope: makeCodec(StationControlEnvelope),
    ok: makeCodec(StationControlOk),
    err: makeCodec(StationControlErr),
  }),
  api: Object.freeze({
    protocol: STATION_API_PROTOCOL,
    request: makeCodec(StationApiRequest),
    response: makeCodec(StationApiResponse),
    pairRequest: makeCodec(PairRequest),
    pairResponse: makeCodec(PairResponse),
    configureRequest: makeCodec(ConfigureRequest),
    configureResponse: makeCodec(ConfigureResponse),
    projectRequest: makeCodec(ProjectRequest),
    projectResponse: makeCodec(ProjectResponse),
    reportRequest: makeCodec(ReportRequest),
    reportResponse: makeCodec(ReportResponse),
    overseerRequest: makeCodec(StationOverseerRequest),
    overseerResponse: makeCodec(StationOverseerResponse),
    reportBatch: makeCodec(ReportBatch),
    statusRequest: makeCodec(StatusRequest),
    statusResponse: makeCodec(StatusResponse),
  }),
  work: Object.freeze({
    protocol: WORK_PROTOCOL,
    record: makeCodec(WorkRecord),
    command: makeCodec(WorkCommand),
    fact: makeCodec(WorkFact),
    disposition: makeCodec(WorkDisposition),
    storedRecord: makeCodec(StoredWorkRecord),
    action: makeCodec(WorkAction),
    result: makeCodec(WorkResult),
  }),
  content: Object.freeze({
    identity: makeCodec(ContentIdentity),
    ref: makeCodec(ContentRef),
    part: makeCodec(ContentPart),
    receipt: makeCodec(ContentReceipt),
    missing: makeCodec(ContentMissing),
    corrupt: makeCodec(ContentCorrupt),
    unavailable: makeCodec(ContentUnavailable),
    availability: makeCodec(ContentAvailability),
  }),
});

export type StationProtocol1Codecs = typeof STATION_PROTOCOL_1_CODECS;

/**
 * Closed registry of Station Protocol codecs indexed strictly by protocol version integer.
 * Only version 1 is registered.
 */
const STATION_PROTOCOL_CODEC_REGISTRY = Object.freeze(
  new Map<StationProtocolVersion, StationProtocol1Codecs>([
    [STATION_PROTOCOL_1, STATION_PROTOCOL_1_CODECS],
  ]),
);

/**
 * Lookup a frozen Station protocol codec by version.
 * Fails closed for any unregistered version.
 */
export const lookupStationProtocolCodec = (
  version: StationProtocolVersion,
): Result.Result<StationProtocol1Codecs, "unsupported-station-protocol"> => {
  const codec = STATION_PROTOCOL_CODEC_REGISTRY.get(version);
  return codec !== undefined
    ? Result.succeed(codec)
    : Result.fail("unsupported-station-protocol");
};

/**
 * Inspect whether a protocol version has an active registered codec.
 */
export const isStationProtocolSupported = (
  version: number,
): version is StationProtocol1 =>
  version === STATION_PROTOCOL_1;
