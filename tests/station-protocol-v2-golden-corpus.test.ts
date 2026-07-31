import { readFileSync } from "node:fs";
import { Either } from "effect";
import { describe, expect, it } from "vitest";
import {
  decodeStationControlRequest,
} from "../src/shared/station-api-envelope";
import {
  decodeStationProtocolPreface,
  selectStationProtocolCodec,
} from "../src/shared/station-protocol";
import {
  decodeStationSessionFrame,
} from "../src/shared/station-session";

interface LegacyCorpus {
  readonly preface: {
    readonly offer: unknown;
    readonly accept: unknown;
  };
  readonly session: {
    readonly requests: ReadonlyArray<unknown>;
    readonly responses: ReadonlyArray<unknown>;
  };
}

const legacy = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/station-protocol-v2/valid-corpus.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as LegacyCorpus;

describe("retired Station protocol v2 golden wire corpus", () => {
  it("has no installed codec after the protocol-3 proposal cut", () => {
    expect(selectStationProtocolCodec(2)).toEqual(
      Either.left("unsupported-station-protocol"),
    );
  });

  it("fails closed before any legacy domain frame can be interpreted", () => {
    expect(Either.isRight(decodeStationProtocolPreface(legacy.preface.offer)))
      .toBe(true);
    expect(Either.isRight(decodeStationProtocolPreface(legacy.preface.accept)))
      .toBe(true);
    for (const wire of legacy.session.requests) {
      expect(Either.isLeft(decodeStationSessionFrame(wire))).toBe(true);
      const request =
        typeof wire === "object" && wire !== null && "request" in wire
          ? (wire as { readonly request: unknown }).request
          : wire;
      expect(Either.isLeft(decodeStationControlRequest(request))).toBe(true);
    }
    for (const wire of legacy.session.responses) {
      expect(Either.isLeft(decodeStationSessionFrame(wire))).toBe(true);
    }
  });
});
