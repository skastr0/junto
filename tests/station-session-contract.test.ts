import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  InstallationId,
  STATION_API_PROTOCOL,
  StatusRequest,
  StatusResponse,
} from "../src/shared/station-api";
import {
  stationControlOk,
} from "../src/shared/station-api-envelope";
import {
  STATION_SESSION_PROTOCOL,
  StationSessionRequestFrame,
  StationSessionRequestId,
  decodeStationSessionFrame,
  stationSessionResponse,
} from "../src/shared/station-session";

const requestId = Schema.decodeUnknownSync(StationSessionRequestId)(
  "status-01",
);
const installationId = Schema.decodeUnknownSync(InstallationId)(
  "remote-01",
);

describe("Station session frame contract", () => {
  it("correlates one exact Station request and response", () => {
    const request = StationSessionRequestFrame.make({
      protocol: STATION_SESSION_PROTOCOL,
      frame: "request",
      requestId,
      request: StatusRequest.make({
        protocol: STATION_API_PROTOCOL,
        op: "status",
      }),
    });
    const response = stationSessionResponse(
      request,
      stationControlOk(
        StatusResponse.make({
          protocol: STATION_API_PROTOCOL,
          op: "status",
          installationId,
          state: "unenrolled",
          receivedThrough: [],
          readiness: {
            database: true,
            workControl: true,
            simulation: false,
          },
          observedAt: "2026-07-27T15:00:00.000Z",
        }),
      ),
    );

    expect(response.requestId).toBe(request.requestId);
    expect(response.frame).toBe("response");
    expect(Either.isRight(decodeStationSessionFrame(request))).toBe(true);
    expect(Either.isRight(decodeStationSessionFrame(response))).toBe(true);
  });

  it("rejects uncorrelated shapes, unknown frames, and excess fields", () => {
    expect(
      Either.isLeft(
        decodeStationSessionFrame({
          protocol: STATION_SESSION_PROTOCOL,
          frame: "heartbeat",
          requestId,
        }),
      ),
    ).toBe(true);
    expect(
      Either.isLeft(
        decodeStationSessionFrame({
          protocol: STATION_SESSION_PROTOCOL,
          frame: "request",
          requestId,
          request: {
            protocol: STATION_API_PROTOCOL,
            op: "status",
          },
          endpoint: "must-not-enter-the-domain",
        }),
      ),
    ).toBe(true);
  });

  it("bounds and brands request IDs", () => {
    expect(() =>
      Schema.decodeUnknownSync(StationSessionRequestId)(""),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(StationSessionRequestId)("x".repeat(65)),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(StationSessionRequestId)("bad id"),
    ).toThrow();
  });
});
