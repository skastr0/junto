import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  CURRENT_STATION_PROTOCOL_SUPPORT,
  STATION_PROTOCOL_BASELINE,
  STATION_PROTOCOL_PREFACE,
  StationProtocolAccept,
  StationProtocolOffer,
  StationProtocolReject,
  StationProtocolSupport,
  decideStationProtocolPreface,
  decodeStationProtocolPreface,
  negotiateStationProtocol,
  selectStationProtocolCodec,
  stationProtocolAccept,
  stationProtocolReject,
} from "../src/shared/station-protocol";

const support = (preferred: number, compatibleFrom: number, warnBelow: number) =>
  Schema.decodeUnknownSync(StationProtocolSupport)({
    preferred,
    compatibleFrom,
    warnBelow,
  });

const offer = (peerSupport = CURRENT_STATION_PROTOCOL_SUPPORT) =>
  StationProtocolOffer.make({
    protocol: STATION_PROTOCOL_PREFACE,
    frame: "offer",
    appVersion: "0.1.0",
    stateSchemaVersion: 1,
    support: peerSupport,
  });

describe("Station protocol compatibility contract", () => {
  it("starts with one exact v5 Vellum Command protocol and selects the highest intersection", () => {
    expect(STATION_PROTOCOL_BASELINE).toBe(5);
    expect(CURRENT_STATION_PROTOCOL_SUPPORT).toEqual({
      preferred: 5,
      compatibleFrom: 5,
      warnBelow: 5,
    });
    expect(negotiateStationProtocol(support(6, 4, 5), support(5, 3, 4))).toEqual({
      _tag: "selected",
      selected: 5,
      deprecatedForLocal: false,
      deprecatedForPeer: false,
      warning: false,
    });
  });

  it("marks deprecated but still compatible peers and returns typed no-common", () => {
    expect(negotiateStationProtocol(support(5, 1, 4), support(3, 1, 2))).toEqual({
      _tag: "selected",
      selected: 3,
      deprecatedForLocal: true,
      deprecatedForPeer: false,
      warning: true,
    });
    expect(negotiateStationProtocol(support(5, 4, 4), support(3, 1, 1))).toMatchObject({
      _tag: "no-common",
    });
  });

  it("rejects invalid support ranges and non-integer versions", () => {
    expect(() => support(2, 3, 3)).toThrow();
    expect(() => support(2, 1, 3)).toThrow();
    expect(() => support(2.5, 1, 2)).toThrow();
  });

  it("strictly decodes a preface outside session frames", () => {
    const initial = offer();
    expect(Result.isSuccess(decodeStationProtocolPreface(initial))).toBe(true);
    expect(Result.isFailure(decodeStationProtocolPreface({ ...initial, unknown: true }))).toBe(true);
    expect(Result.isFailure(decodeStationProtocolPreface({ ...initial, frame: "request" }))).toBe(true);
  });

  it("accepts only the exact recomputed selection", () => {
    const initial = offer(support(6, 4, 5));
    const accepted = stationProtocolAccept(initial, {
      appVersion: "0.2.0",
      stateSchemaVersion: 2,
      support: support(5, 3, 4),
    });
    expect(decideStationProtocolPreface(initial, accepted)).toEqual({
      _tag: "accepted",
      selected: 5,
      warning: false,
      deprecatedForOfferer: false,
      deprecatedForAcceptor: false,
    });
    const invalid = StationProtocolAccept.make({ ...accepted, selected: 4 });
    expect(decideStationProtocolPreface(initial, invalid)).toEqual({
      _tag: "invalid-accept",
      expected: 5,
      received: 4,
    });
  });

  it("makes a no-common rejection explicitly nonretryable", () => {
    const initial = offer(support(6, 5, 5));
    const rejected = stationProtocolReject({
      appVersion: "0.1.0",
      stateSchemaVersion: 1,
      support: support(4, 3, 3),
    });
    expect(rejected.retryable).toBe(false);
    expect(decideStationProtocolPreface(initial, rejected)).toEqual({ _tag: "no-common" });
    expect(
      Result.isFailure(decodeStationProtocolPreface({ ...rejected, retryable: true })),
    ).toBe(true);
    expect(decideStationProtocolPreface(offer(), rejected)).toEqual({
      _tag: "no-common",
    });
  });

  it("selects only an installed exact codec", () => {
    expect(selectStationProtocolCodec(2)).toEqual(Result.fail("unsupported-station-protocol"));
    expect(selectStationProtocolCodec(3)).toEqual(Result.fail("unsupported-station-protocol"));
    expect(selectStationProtocolCodec(4)).toEqual(Result.fail("unsupported-station-protocol"));
    expect(selectStationProtocolCodec(5)).toEqual(Result.succeed(5));
  });
});
