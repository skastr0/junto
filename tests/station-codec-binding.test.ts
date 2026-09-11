import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  STATION_PROTOCOL_1_CODECS,
  lookupStationProtocolCodec,
  isStationProtocolSupported,
} from "../src/shared/station-protocol-1-codec";
import {
  CURRENT_STATION_PROTOCOL_SUPPORT,
  StationProtocolVersion,
  selectStationProtocolCodec,
} from "../src/shared/station-protocol";
import {
  bindNegotiatedStationProtocol,
  type StationPeerProtocolDiagnostics,
} from "../src/main/vellum-command/station/peer-session";

describe("Station codec binding across transports", () => {
  const localDiagnostics: StationPeerProtocolDiagnostics = {
    appVersion: "0.1.14",
    stateSchemaVersion: 21,
    support: CURRENT_STATION_PROTOCOL_SUPPORT,
  };

  const peerDiagnostics: StationPeerProtocolDiagnostics = {
    appVersion: "0.1.14",
    stateSchemaVersion: 21,
    support: CURRENT_STATION_PROTOCOL_SUPPORT,
  };

  it("binds negotiated protocol 1 to the exact frozen codec bundle", () => {
    const binding = bindNegotiatedStationProtocol({
      negotiatedProtocol: 1,
      local: localDiagnostics,
      peer: peerDiagnostics,
    });

    expect(binding._tag).toBe("negotiated");
    expect(binding.negotiatedProtocol).toBe(1);
    expect(binding.codec).toBe(STATION_PROTOCOL_1_CODECS);
    expect(binding.compatibility).toBe("compatible");
  });

  it("fails closed on unsupported protocol versions", () => {
    expect(() =>
      bindNegotiatedStationProtocol({
        negotiatedProtocol: 2 as any,
        local: localDiagnostics,
        peer: peerDiagnostics,
      }),
    ).toThrow(/no compiled codec/);

    expect(isStationProtocolSupported(2)).toBe(false);
    expect(
      lookupStationProtocolCodec(
        Schema.decodeUnknownSync(StationProtocolVersion)(2),
      )._tag,
    ).toBe("Failure");
  });

  it("ensures diagnostics do not alter codec selection", () => {
    const customLocal: StationPeerProtocolDiagnostics = {
      appVersion: "99.99.99",
      stateSchemaVersion: 999,
      support: CURRENT_STATION_PROTOCOL_SUPPORT,
    };
    const customPeer: StationPeerProtocolDiagnostics = {
      appVersion: "1.0.0-custom",
      stateSchemaVersion: 1,
      support: CURRENT_STATION_PROTOCOL_SUPPORT,
    };

    const binding = bindNegotiatedStationProtocol({
      negotiatedProtocol: 1,
      local: customLocal,
      peer: customPeer,
    });

    expect(binding.negotiatedProtocol).toBe(1);
    expect(binding.codec).toBe(STATION_PROTOCOL_1_CODECS);
    expect(binding.local.appVersion).toBe("99.99.99");
    expect(binding.peer.appVersion).toBe("1.0.0-custom");
  });
});
