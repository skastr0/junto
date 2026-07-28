import { Either, Schema } from "effect";
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
  it("starts with one exact v2 protocol and selects the highest intersection", () => {
    expect(STATION_PROTOCOL_BASELINE).toBe(2);
    expect(CURRENT_STATION_PROTOCOL_SUPPORT).toEqual({
      preferred: 2,
      compatibleFrom: 2,
      warnBelow: 2,
    });
    expect(negotiateStationProtocol(support(4, 2, 3), support(3, 1, 2))).toEqual({
      _tag: "selected",
      selected: 3,
      deprecatedForLocal: false,
      deprecatedForPeer: false,
      warning: false,
    });
  });

  it("marks deprecated but still compatible peers and returns typed no-common", () => {
    expect(negotiateStationProtocol(support(4, 1, 3), support(2, 1, 2))).toEqual({
      _tag: "selected",
      selected: 2,
      deprecatedForLocal: true,
      deprecatedForPeer: false,
      warning: true,
    });
    expect(negotiateStationProtocol(support(4, 3, 3), support(2, 1, 1))).toMatchObject({
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
    expect(Either.isRight(decodeStationProtocolPreface(initial))).toBe(true);
    expect(Either.isLeft(decodeStationProtocolPreface({ ...initial, unknown: true }))).toBe(true);
    expect(Either.isLeft(decodeStationProtocolPreface({ ...initial, frame: "request" }))).toBe(true);
  });

  it("accepts only the exact recomputed selection", () => {
    const initial = offer(support(4, 2, 3));
    const accepted = stationProtocolAccept(initial, {
      appVersion: "0.2.0",
      stateSchemaVersion: 2,
      support: support(3, 1, 2),
    });
    expect(decideStationProtocolPreface(initial, accepted)).toEqual({
      _tag: "accepted",
      selected: 3,
      warning: false,
      deprecatedForOfferer: false,
      deprecatedForAcceptor: false,
    });
    const invalid = StationProtocolAccept.make({ ...accepted, selected: 2 });
    expect(decideStationProtocolPreface(initial, invalid)).toEqual({
      _tag: "invalid-accept",
      expected: 3,
      received: 2,
    });
  });

  it("makes a no-common rejection explicitly nonretryable", () => {
    const initial = offer(support(4, 3, 3));
    const rejected = stationProtocolReject({
      appVersion: "0.1.0",
      stateSchemaVersion: 1,
      support: support(2, 1, 1),
    });
    expect(rejected.retryable).toBe(false);
    expect(decideStationProtocolPreface(initial, rejected)).toEqual({ _tag: "no-common" });
    expect(
      Either.isLeft(decodeStationProtocolPreface({ ...rejected, retryable: true })),
    ).toBe(true);
    expect(decideStationProtocolPreface(offer(), rejected)).toEqual({
      _tag: "invalid-reject",
    });
  });

  it("selects only an installed exact codec", () => {
    expect(selectStationProtocolCodec(2)).toEqual(Either.right(2));
    expect(selectStationProtocolCodec(3)).toEqual(Either.left("unsupported-station-protocol"));
  });
});
