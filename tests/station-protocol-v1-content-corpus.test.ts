import { readFileSync } from "node:fs";
import { Result } from "effect";
import { describe, expect, it } from "vitest";
import {
  CURRENT_STATION_PROTOCOL_SUPPORT,
  STATION_PROTOCOL_BASELINE,
  selectStationProtocolCodec,
} from "../src/shared/station-protocol";

interface ContentWireCorpus {
  readonly protocol: {
    readonly baseline: number;
    readonly support: {
      readonly preferred: number;
      readonly compatibleFrom: number;
      readonly warnBelow: number;
    };
  };
}

const corpus = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/station-protocol-v1/content-wire-corpus.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as ContentWireCorpus;

describe("Station protocol v1 content wire corpus", () => {
  it("keeps the unreleased Station contract at v1", () => {
    expect(corpus.protocol.baseline).toBe(1);
    expect(STATION_PROTOCOL_BASELINE).toBe(1);
    expect(CURRENT_STATION_PROTOCOL_SUPPORT).toEqual(corpus.protocol.support);
    expect(selectStationProtocolCodec(1)).toEqual(Result.succeed(1));
    expect(selectStationProtocolCodec(2)).toEqual(
      Result.fail("unsupported-station-protocol"),
    );
  });
});
