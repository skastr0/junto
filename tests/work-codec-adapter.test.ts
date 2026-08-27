import { readFileSync } from "node:fs";
import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  lowerOutboundWorkRecord,
  raiseInboundWorkRecord,
  pageOutboundWorkRoute,
  preflightClaimResponseEncodability,
} from "../src/shared/work-codec-adapter";
import {
  STATION_PROTOCOL_1_CODECS,
} from "../src/shared/station-protocol-1-codec";
import {
  WorkRecord,
  type WorkRecord as WorkRecordValue,
  WORK_PROTOCOL,
} from "../src/shared/work-protocol";

const corpus = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/station-protocol-1-golden-corpus.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

const decodeRecord = Schema.decodeUnknownSync(WorkRecord, {
  onExcessProperty: "error",
});

describe("Work codec adapter — lowering, raising, paging, and claim preflight", () => {
  it("lowers domain records through bound codec with unchanged semantic hash and byte bounds", () => {
    for (const [key, raw] of Object.entries(corpus.work)) {
      const record = decodeRecord(raw);
      const lowering = lowerOutboundWorkRecord(record, STATION_PROTOCOL_1_CODECS);
      expect(Result.isSuccess(lowering)).toBe(true);
      if (Result.isSuccess(lowering)) {
        expect(lowering.success.contentSha256).toBe(record.contentSha256);
        expect(lowering.success.encodedByteLength).toBeGreaterThan(0);
        expect(lowering.success.wireRecord).toBeDefined();
      }
    }
  });

  it("raises inbound wire records preserving raw bytes and proving exact semantic compatibility", () => {
    for (const [key, raw] of Object.entries(corpus.work)) {
      const raising = raiseInboundWorkRecord(raw, STATION_PROTOCOL_1_CODECS);
      expect(Result.isSuccess(raising)).toBe(true);
      if (Result.isSuccess(raising)) {
        expect(raising.success.domainRecord.contentSha256).toBe(
          (raw as WorkRecordValue).contentSha256,
        );
        expect(raising.success.rawRecord).toEqual(raw);
        expect(raising.success.evaluation.status).toBe("exact");
      }
    }
  });

  it("rejects unrepresentable or corrupt inbound records without raising", () => {
    const corrupt = { ...corpus.work.taskCreateFact, protocol: "invalid/work/v99" };
    const raising = raiseInboundWorkRecord(corrupt, STATION_PROTOCOL_1_CODECS);
    expect(Result.isFailure(raising)).toBe(true);
  });

  it("pages outbound route calculating limits from wire bytes and stops at the first unrepresentable route head", () => {
    const records = [
      decodeRecord(corpus.work.taskCreateFact),
      decodeRecord(corpus.work.taskDescribeFact),
      decodeRecord(corpus.work.taskTransitionFact),
    ];

    const paged = pageOutboundWorkRoute(records, { maxRecords: 2 }, STATION_PROTOCOL_1_CODECS);
    expect(paged.loweredRecords.length).toBe(2);
    expect(paged.advancedThroughSeq).toBe("2");
    expect(paged.unrepresentableRouteHead).toBeNull();
    expect(paged.totalBytes).toBeGreaterThan(0);
  });

  it("stops and prevents cursor advance if an unrepresentable record is at the route head", () => {
    const valid = decodeRecord(corpus.work.taskCreateFact);
    // Construct a record with mutated hash that fails lowering check
    const invalid: WorkRecordValue = {
      ...decodeRecord(corpus.work.taskDescribeFact),
      contentSha256: "0".repeat(64) as any, // Mismatched hash
    };

    const records = [valid, invalid, decodeRecord(corpus.work.taskTransitionFact)];

    const paged = pageOutboundWorkRoute(records, {}, STATION_PROTOCOL_1_CODECS);
    // First record succeeds
    expect(paged.loweredRecords.length).toBe(1);
    expect(paged.advancedThroughSeq).toBe("1");
    // Second record failed lowering; route stops and records the error
    expect(paged.unrepresentableRouteHead).not.toBeNull();
    expect(paged.unrepresentableRouteHead?.reason).toBe("hash-divergence");
  });

  it("proves claim response encodability during synchronous preflight", () => {
    const claimFact = decodeRecord(corpus.work.taskClaimFact);
    const appliedDisposition = decodeRecord(corpus.work.appliedDisposition);

    const preflight = preflightClaimResponseEncodability(
      claimFact,
      appliedDisposition,
      STATION_PROTOCOL_1_CODECS,
    );
    expect(Result.isSuccess(preflight)).toBe(true);
  });

  it("fails claim preflight if disposition cannot be lowered", () => {
    const claimFact = decodeRecord(corpus.work.taskClaimFact);
    const corruptDisposition: WorkRecordValue = {
      ...decodeRecord(corpus.work.appliedDisposition),
      contentSha256: "9".repeat(64) as any,
    };

    const preflight = preflightClaimResponseEncodability(
      claimFact,
      corruptDisposition,
      STATION_PROTOCOL_1_CODECS,
    );
    expect(Result.isFailure(preflight)).toBe(true);
  });
});
