import { Schema } from "effect";
import {
  STATION_API_MAX_PROJECTION_CHARS,
  StationApiRequest,
  StationApiResponse,
} from "./station-api";

/**
 * Owner-local transport for the Station API.
 *
 * The app owns the database and this socket. Standalone clients exchange one
 * newline-delimited request/response pair and never open durable state.
 */
export const STATION_CONTROL_PROTOCOL = "vellum/station-control/v1" as const;
export const STATION_CONTROL_HOME_ENV = "VELLUM_STATION_HOME";
export const STATION_CONTROL_REQUEST_TIMEOUT_MS = 30_000;
export const STATION_CONTROL_MAX_CLIENTS = 8;

// The projection bound dominates every request and report. A JSON document is
// itself encoded as a JSON string on this wire, so reserve worst-case UTF-8
// expansion plus one MiB for the typed envelope while retaining a hard bound.
export const STATION_CONTROL_MAX_FRAME_BYTES =
  STATION_API_MAX_PROJECTION_CHARS * 4 + 1024 * 1024;

export const stationControlDir = (home: string): string =>
  `${home}/.vellum/station`;

export const stationControlSocketPath = (stationHome: string): string =>
  `${stationHome}/control.sock`;

export const StationControlErrorCode = Schema.Literal(
  "protocol_error",
  "request_rejected",
  "state_conflict",
  "integrity_error",
  "runtime_down",
  "unavailable",
  "internal_error",
);
export type StationControlErrorCode = typeof StationControlErrorCode.Type;

export const StationControlError = Schema.Struct({
  code: StationControlErrorCode,
  message: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(512)),
  retryable: Schema.Boolean,
});
export type StationControlError = typeof StationControlError.Type;

export const StationControlOk = Schema.Struct({
  protocol: Schema.Literal(STATION_CONTROL_PROTOCOL),
  ok: Schema.Literal(true),
  response: StationApiResponse,
});
export type StationControlOk = typeof StationControlOk.Type;

export const StationControlErr = Schema.Struct({
  protocol: Schema.Literal(STATION_CONTROL_PROTOCOL),
  ok: Schema.Literal(false),
  error: StationControlError,
});
export type StationControlErr = typeof StationControlErr.Type;

export const StationControlEnvelope = Schema.Union(
  StationControlOk,
  StationControlErr,
);
export type StationControlEnvelope = typeof StationControlEnvelope.Type;

export const decodeStationControlRequest =
  Schema.decodeUnknownEither(StationApiRequest);
export const decodeStationControlEnvelope =
  Schema.decodeUnknownEither(StationControlEnvelope);

export const stationControlOk = (
  response: StationApiResponse,
): StationControlOk => ({
  protocol: STATION_CONTROL_PROTOCOL,
  ok: true,
  response,
});

export const stationControlErr = (
  code: StationControlErrorCode,
  message: string,
  retryable: boolean,
): StationControlErr => ({
  protocol: STATION_CONTROL_PROTOCOL,
  ok: false,
  error: { code, message, retryable },
});

export const encodeStationControlFrame = (value: unknown): string => {
  const encoded = `${JSON.stringify(value)}\n`;
  if (
    new TextEncoder().encode(encoded).byteLength >
      STATION_CONTROL_MAX_FRAME_BYTES
  ) {
    throw new Error(
      `station control frame exceeds ${STATION_CONTROL_MAX_FRAME_BYTES} bytes`,
    );
  }
  return encoded;
};
