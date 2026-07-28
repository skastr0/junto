import { Schema } from "effect";
import {
  StationApiRequest,
} from "./station-api";
import {
  StationControlEnvelope,
} from "./station-api-envelope";

/**
 * Correlated, transport-neutral framing for one persistent Station session.
 *
 * OpenSSH and future HTTPS adapters may choose their own byte framing, but
 * both carry this exact request/response envelope. Domain ordering remains in
 * projection generations and WorkRecord routes; request IDs only correlate
 * concurrent calls on one ephemeral connection.
 */
export const STATION_SESSION_PROTOCOL = "vellum/station-session/v2" as const;

export const StationSessionRequestId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(64),
  Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  Schema.brand("StationSessionRequestId"),
);
export type StationSessionRequestId =
  typeof StationSessionRequestId.Type;

export const StationSessionRequestFrame = Schema.Struct({
  protocol: Schema.Literal(STATION_SESSION_PROTOCOL),
  frame: Schema.Literal("request"),
  requestId: StationSessionRequestId,
  request: StationApiRequest,
});
export type StationSessionRequestFrame =
  typeof StationSessionRequestFrame.Type;

export const StationSessionResponseFrame = Schema.Struct({
  protocol: Schema.Literal(STATION_SESSION_PROTOCOL),
  frame: Schema.Literal("response"),
  requestId: StationSessionRequestId,
  envelope: StationControlEnvelope,
});
export type StationSessionResponseFrame =
  typeof StationSessionResponseFrame.Type;

export const StationSessionFrame = Schema.Union(
  StationSessionRequestFrame,
  StationSessionResponseFrame,
);
export type StationSessionFrame = typeof StationSessionFrame.Type;

export const decodeStationSessionFrame =
  Schema.decodeUnknownEither(StationSessionFrame, {
    onExcessProperty: "error",
  });

export const stationSessionResponse = (
  request: Pick<StationSessionRequestFrame, "requestId">,
  envelope: StationControlEnvelope,
): StationSessionResponseFrame =>
  StationSessionResponseFrame.make({
    protocol: STATION_SESSION_PROTOCOL,
    frame: "response",
    requestId: request.requestId,
    envelope,
  });
