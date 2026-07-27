import { Schema } from "effect";
import {
  StationApiRequest,
  StationApiResponse,
} from "./station-api";

/**
 * Transport-neutral Station API envelope.
 *
 * Ok/err wrappers, error codes, and decode helpers live here. Framing bytes,
 * socket paths, and OpenSSH timeouts live in `station-ssh-control.ts`.
 */
export const STATION_CONTROL_PROTOCOL = "vellum/station-control/v1" as const;

export const StationControlErrorCode = Schema.Literal(
  "protocol_error",
  "authorization_denied",
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
  Schema.decodeUnknownEither(StationApiRequest, {
    onExcessProperty: "error",
  });
export const decodeStationControlEnvelope =
  Schema.decodeUnknownEither(StationControlEnvelope, {
    onExcessProperty: "error",
  });

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
