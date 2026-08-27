import { readFileSync } from "node:fs";
import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  STATION_PROTOCOL_1,
  STATION_PROTOCOL_1_CODECS,
  isStationProtocolSupported,
  lookupStationProtocolCodec,
} from "../src/shared/station-protocol-1-codec";
import {
  CURRENT_STATION_PROTOCOL_SUPPORT,
  STATION_PROTOCOL_BASELINE,
  StationProtocolVersion,
  selectStationProtocolCodec,
} from "../src/shared/station-protocol";

const corpus = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/station-protocol-1-golden-corpus.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

describe("Station protocol 1 frozen codecs & registry", () => {
  it("closed registry maps only Station protocol 1 to its frozen codec", () => {
    expect(STATION_PROTOCOL_1).toBe(1);
    expect(STATION_PROTOCOL_BASELINE).toBe(1);
    expect(isStationProtocolSupported(1)).toBe(true);
    expect(isStationProtocolSupported(2)).toBe(false);
    expect(isStationProtocolSupported(0)).toBe(false);

    const lookup1 = lookupStationProtocolCodec(
      Schema.decodeUnknownSync(StationProtocolVersion)(1),
    );
    expect(Result.isSuccess(lookup1)).toBe(true);
    if (Result.isSuccess(lookup1)) {
      expect(lookup1.success.version).toBe(1);
      expect(lookup1.success).toBe(STATION_PROTOCOL_1_CODECS);
    }

    for (const unsupported of [2, 3, 4, 99]) {
      const lookupUnsupported = lookupStationProtocolCodec(
        Schema.decodeUnknownSync(StationProtocolVersion)(unsupported),
      );
      expect(lookupUnsupported).toEqual(
        Result.fail("unsupported-station-protocol"),
      );
    }
  });

  it("decodes, encodes, and maintains byte stability for preface frames", () => {
    for (const [key, sample] of Object.entries(corpus.preface)) {
      const codec = STATION_PROTOCOL_1_CODECS.preface[
        key as keyof typeof STATION_PROTOCOL_1_CODECS.preface
      ];
      if (typeof codec === "string") continue;

      // Decode valid
      const decoded = codec.decode(sample);
      expect(Result.isSuccess(decoded)).toBe(true);
      if (!Result.isSuccess(decoded)) continue;

      // Encode back
      const encoded = codec.encode(decoded.success);
      expect(Result.isSuccess(encoded)).toBe(true);
      if (!Result.isSuccess(encoded)) continue;

      // Strict byte stability on re-encoding
      const json1 = JSON.stringify(encoded.success);
      const reDecoded = codec.decode(JSON.parse(json1));
      expect(Result.isSuccess(reDecoded)).toBe(true);
      if (Result.isSuccess(reDecoded)) {
        const reEncoded = codec.encode(reDecoded.success);
        expect(Result.isSuccess(reEncoded)).toBe(true);
        if (Result.isSuccess(reEncoded)) {
          expect(JSON.stringify(reEncoded.success)).toBe(json1);
        }
      }

      // Strict excess property rejection
      const withExcess = { ...(sample as object), excess_forbidden_key: 123 };
      expect(Result.isFailure(codec.decode(withExcess))).toBe(true);
    }
  });

  it("decodes, encodes, and maintains byte stability for session frames", () => {
    for (const [key, sample] of Object.entries(corpus.session)) {
      const decoded = STATION_PROTOCOL_1_CODECS.session.frame.decode(sample);
      expect(Result.isSuccess(decoded)).toBe(true);
      if (!Result.isSuccess(decoded)) continue;

      const encoded = STATION_PROTOCOL_1_CODECS.session.frame.encode(
        decoded.success,
      );
      expect(Result.isSuccess(encoded)).toBe(true);
      if (!Result.isSuccess(encoded)) continue;

      const json1 = JSON.stringify(encoded.success);
      const reDecoded = STATION_PROTOCOL_1_CODECS.session.frame.decode(
        JSON.parse(json1),
      );
      expect(Result.isSuccess(reDecoded)).toBe(true);
      if (Result.isSuccess(reDecoded)) {
        const reEncoded = STATION_PROTOCOL_1_CODECS.session.frame.encode(
          reDecoded.success,
        );
        expect(Result.isSuccess(reEncoded)).toBe(true);
        if (Result.isSuccess(reEncoded)) {
          expect(JSON.stringify(reEncoded.success)).toBe(json1);
        }
      }

      const withExcess = { ...(sample as object), excess_forbidden_key: 123 };
      expect(
        Result.isFailure(
          STATION_PROTOCOL_1_CODECS.session.frame.decode(withExcess),
        ),
      ).toBe(true);
    }
  });

  it("decodes, encodes, and maintains byte stability for control envelopes", () => {
    for (const [key, sample] of Object.entries(corpus.control)) {
      const decoded = STATION_PROTOCOL_1_CODECS.control.envelope.decode(sample);
      expect(Result.isSuccess(decoded)).toBe(true);
      if (!Result.isSuccess(decoded)) continue;

      const encoded = STATION_PROTOCOL_1_CODECS.control.envelope.encode(
        decoded.success,
      );
      expect(Result.isSuccess(encoded)).toBe(true);
      if (!Result.isSuccess(encoded)) continue;

      const json1 = JSON.stringify(encoded.success);
      const reDecoded = STATION_PROTOCOL_1_CODECS.control.envelope.decode(
        JSON.parse(json1),
      );
      expect(Result.isSuccess(reDecoded)).toBe(true);
      if (Result.isSuccess(reDecoded)) {
        const reEncoded = STATION_PROTOCOL_1_CODECS.control.envelope.encode(
          reDecoded.success,
        );
        expect(Result.isSuccess(reEncoded)).toBe(true);
        if (Result.isSuccess(reEncoded)) {
          expect(JSON.stringify(reEncoded.success)).toBe(json1);
        }
      }

      const withExcess = { ...(sample as object), excess_forbidden_key: 123 };
      expect(
        Result.isFailure(
          STATION_PROTOCOL_1_CODECS.control.envelope.decode(withExcess),
        ),
      ).toBe(true);
    }
  });

  it("decodes, encodes, and maintains byte stability for all Station API operations", () => {
    for (const [key, sample] of Object.entries(corpus.api)) {
      const codec = STATION_PROTOCOL_1_CODECS.api[
        key as keyof typeof STATION_PROTOCOL_1_CODECS.api
      ];
      if (typeof codec === "string") continue;

      const decoded = codec.decode(sample);
      expect(Result.isSuccess(decoded)).toBe(true);
      if (!Result.isSuccess(decoded)) continue;

      const encoded = codec.encode(decoded.success);
      expect(Result.isSuccess(encoded)).toBe(true);
      if (!Result.isSuccess(encoded)) continue;

      const json1 = JSON.stringify(encoded.success);
      const reDecoded = codec.decode(JSON.parse(json1));
      expect(Result.isSuccess(reDecoded)).toBe(true);
      if (Result.isSuccess(reDecoded)) {
        const reEncoded = codec.encode(reDecoded.success);
        expect(Result.isSuccess(reEncoded)).toBe(true);
        if (Result.isSuccess(reEncoded)) {
          expect(JSON.stringify(reEncoded.success)).toBe(json1);
        }
      }

      const withExcess = { ...(sample as object), excess_forbidden_key: 123 };
      expect(Result.isFailure(codec.decode(withExcess))).toBe(true);
    }
  });

  it("decodes, encodes, and maintains byte stability for content parts and references", () => {
    for (const [key, sample] of Object.entries(corpus.content)) {
      const codec = STATION_PROTOCOL_1_CODECS.content[
        key as keyof typeof STATION_PROTOCOL_1_CODECS.content
      ];
      if (typeof codec === "string") continue;

      const decoded = codec.decode(sample);
      expect(Result.isSuccess(decoded)).toBe(true);
      if (!Result.isSuccess(decoded)) continue;

      const encoded = codec.encode(decoded.success);
      expect(Result.isSuccess(encoded)).toBe(true);
      if (!Result.isSuccess(encoded)) continue;

      const json1 = JSON.stringify(encoded.success);
      const reDecoded = codec.decode(JSON.parse(json1));
      expect(Result.isSuccess(reDecoded)).toBe(true);
      if (Result.isSuccess(reDecoded)) {
        const reEncoded = codec.encode(reDecoded.success);
        expect(Result.isSuccess(reEncoded)).toBe(true);
        if (Result.isSuccess(reEncoded)) {
          expect(JSON.stringify(reEncoded.success)).toBe(json1);
        }
      }

      const withExcess = { ...(sample as object), excess_forbidden_key: 123 };
      expect(Result.isFailure(codec.decode(withExcess))).toBe(true);
    }
  });

  it("decodes, encodes, and maintains byte stability for Work records and dispositions", () => {
    for (const [key, sample] of Object.entries(corpus.work)) {
      const decoded = STATION_PROTOCOL_1_CODECS.work.record.decode(sample);
      expect(Result.isSuccess(decoded)).toBe(true);
      if (!Result.isSuccess(decoded)) continue;

      const encoded = STATION_PROTOCOL_1_CODECS.work.record.encode(
        decoded.success,
      );
      expect(Result.isSuccess(encoded)).toBe(true);
      if (!Result.isSuccess(encoded)) continue;

      const json1 = JSON.stringify(encoded.success);
      const reDecoded = STATION_PROTOCOL_1_CODECS.work.record.decode(
        JSON.parse(json1),
      );
      expect(Result.isSuccess(reDecoded)).toBe(true);
      if (Result.isSuccess(reDecoded)) {
        const reEncoded = STATION_PROTOCOL_1_CODECS.work.record.encode(
          reDecoded.success,
        );
        expect(Result.isSuccess(reEncoded)).toBe(true);
        if (Result.isSuccess(reEncoded)) {
          expect(JSON.stringify(reEncoded.success)).toBe(json1);
        }
      }

      const withExcess = { ...(sample as object), excess_forbidden_key: 123 };
      expect(
        Result.isFailure(
          STATION_PROTOCOL_1_CODECS.work.record.decode(withExcess),
        ),
      ).toBe(true);
    }
  });
});
