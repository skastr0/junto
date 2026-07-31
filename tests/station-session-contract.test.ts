import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  InstallationId,
  PairResponse,
  STATION_API_PROTOCOL,
  StatusRequest,
  StatusResponse,
} from "../src/shared/station-api";
import {
  STATION_CONTROL_PROTOCOL,
  stationControlErr,
  stationControlOk,
} from "../src/shared/station-api-envelope";
import {
  STATION_SESSION_PROTOCOL,
  StationSessionRequestFrame,
  StationSessionRequestId,
  StationSessionResponseFrame,
  decideStationSessionCorrelation,
  decodeStationSessionFrame,
  stationSessionResponse,
} from "../src/shared/station-session";
import {
  STATION_PROTOCOL_PREFACE,
  StationProtocolOffer,
} from "../src/shared/station-protocol";

const requestId = Schema.decodeUnknownSync(StationSessionRequestId)(
  "status-01",
);
const otherRequestId = Schema.decodeUnknownSync(StationSessionRequestId)(
  "status-02",
);
const installationId = Schema.decodeUnknownSync(InstallationId)(
  "remote-01",
);
const commandCenterInstallationId = Schema.decodeUnknownSync(InstallationId)(
  "cc-01",
);

const request = StationSessionRequestFrame.make({
  protocol: STATION_SESSION_PROTOCOL,
  frame: "request",
  requestId,
  request: StatusRequest.make({
    protocol: STATION_API_PROTOCOL,
    op: "status",
  }),
});

const statusEnvelope = stationControlOk(
  StatusResponse.make({
    protocol: STATION_API_PROTOCOL,
    op: "status",
    installationId,
    state: "unenrolled",
    receivedThrough: [],
    peerAcknowledgedThrough: [],
    readiness: {
      database: true,
      workControl: true,
      simulation: false,
      session: true,
    },
    observedAt: "2026-07-27T15:00:00.000Z",
  }),
);

describe("Station session v2 frame contract", () => {
  it("correlates one exact Station request and response", () => {
    const response = stationSessionResponse(request, statusEnvelope);

    expect(response.requestId).toBe(request.requestId);
    expect(response.frame).toBe("response");
    expect(decideStationSessionCorrelation(request, response)).toEqual({
      _tag: "correlated",
    });
    expect(Either.isRight(decodeStationSessionFrame(request))).toBe(true);
    expect(Either.isRight(decodeStationSessionFrame(response))).toBe(true);
  });

  it("rejects request-id and successful-operation mismatches", () => {
    const wrongRequestId = StationSessionResponseFrame.make({
      protocol: STATION_SESSION_PROTOCOL,
      frame: "response",
      requestId: otherRequestId,
      envelope: statusEnvelope,
    });
    expect(
      decideStationSessionCorrelation(request, wrongRequestId),
    ).toEqual({ _tag: "request-id-mismatch" });

    const pairEnvelope = stationControlOk(
      PairResponse.make({
        protocol: STATION_API_PROTOCOL,
        op: "pair",
        commandCenterInstallationId,
        stationInstallationId: installationId,
        pairedAt: "2026-07-27T15:00:00.000Z",
      }),
    );
    const wrongOperation = StationSessionResponseFrame.make({
      protocol: STATION_SESSION_PROTOCOL,
      frame: "response",
      requestId,
      envelope: pairEnvelope,
    });
    expect(
      decideStationSessionCorrelation(request, wrongOperation),
    ).toEqual({
      _tag: "operation-mismatch",
      requestOperation: "status",
      responseOperation: "pair",
    });
    expect(() => stationSessionResponse(request, pairEnvelope)).toThrow(
      "does not match request operation",
    );
  });

  it("rejects a same-operation response for a different request identity", () => {
    const pairRequest = StationSessionRequestFrame.make({
      protocol: STATION_SESSION_PROTOCOL,
      frame: "request",
      requestId,
      request: {
        protocol: STATION_API_PROTOCOL,
        op: "pair",
        commandCenterInstallationId,
        stationInstallationId: installationId,
        stationLabel: "Remote 01",
        appVersion: "0.1.0",
      },
    });
    const wrongStation = stationControlOk(
      PairResponse.make({
        protocol: STATION_API_PROTOCOL,
        op: "pair",
        commandCenterInstallationId,
        stationInstallationId: Schema.decodeUnknownSync(InstallationId)(
          "remote-02",
        ),
        pairedAt: "2026-07-27T15:00:00.000Z",
      }),
    );
    const response = StationSessionResponseFrame.make({
      protocol: STATION_SESSION_PROTOCOL,
      frame: "response",
      requestId,
      envelope: wrongStation,
    });

    expect(
      decideStationSessionCorrelation(pairRequest, response),
    ).toEqual({
      _tag: "response-identity-mismatch",
      operation: "pair",
    });
    expect(() => stationSessionResponse(pairRequest, wrongStation)).toThrow(
      "response-identity-mismatch",
    );
  });

  it("correlates a typed error by request ID without inventing an operation", () => {
    const response = stationSessionResponse(
      request,
      stationControlErr("runtime_down", "simulation unavailable", true),
    );
    expect(decideStationSessionCorrelation(request, response)).toEqual({
      _tag: "correlated",
    });
    expect(Either.isRight(decodeStationSessionFrame(response))).toBe(true);
  });

  it("rejects v1 layers, unknown frames, and excess fields", () => {
    expect(
      Either.isLeft(
        decodeStationSessionFrame({
          protocol: "vellum/station-session/v1",
          frame: "request",
          requestId,
          request: {
            protocol: STATION_API_PROTOCOL,
            op: "status",
          },
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
            protocol: "vellum/station-api/v1",
            op: "status",
          },
        }),
      ),
    ).toBe(true);
    expect(
      Either.isLeft(
        decodeStationSessionFrame({
          protocol: STATION_SESSION_PROTOCOL,
          frame: "response",
          requestId,
          envelope: {
            protocol: "vellum/station-control/v1",
            ok: true,
            response: {
              protocol: STATION_API_PROTOCOL,
              op: "status",
              installationId,
              state: "unenrolled",
              receivedThrough: [],
              peerAcknowledgedThrough: [],
              readiness: {
                database: true,
                workControl: true,
                simulation: false,
                session: true,
              },
              observedAt: "2026-07-27T15:00:00.000Z",
            },
          },
        }),
      ),
    ).toBe(true);
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

    expect(STATION_SESSION_PROTOCOL).toBe("vellum/station-session/v4");
    expect(STATION_CONTROL_PROTOCOL).toBe("vellum/station-control/v4");
  });

  it("keeps the protocol preface outside the frozen v4 session frame", () => {
    const preface = StationProtocolOffer.make({
      protocol: STATION_PROTOCOL_PREFACE,
      frame: "offer",
      appVersion: "0.1.0",
      stateSchemaVersion: 1,
      support: { preferred: 2, compatibleFrom: 2, warnBelow: 2 },
    });
    expect(Either.isLeft(decodeStationSessionFrame(preface))).toBe(true);
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
