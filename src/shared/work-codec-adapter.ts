import { Result } from "effect";
import {
  STATION_PROTOCOL_1_CODECS,
  type StationProtocol1Codecs,
} from "./station-protocol-1-codec";
import {
  WorkRecord,
  type WorkRecord as WorkRecordValue,
  workRecordEncodedByteLength,
  WORK_PROTOCOL_MAX_RECORD_BYTES,
} from "./work-protocol";
import {
  evaluateSemanticCompatibility,
  type SemanticCompatibilityEvaluation,
} from "./semantic-compatibility-adapter";
import { computeWorkRecordContentSha256 } from "./work-canonical-json";

/**
 * Pure Work Codec and Replay Adapter.
 *
 * Provides:
 * 1. Wire lowering: Lowers domain Work records through the bound protocol codec,
 *    verifying exact semantic round trips, unchanged hashes, and wire byte bounds.
 * 2. Ingress raising: Validates semantic hash, decodes through bound codec,
 *    and produces verified domain Work records while preserving raw bytes.
 * 3. Route paging with wire budget: Computes page limits from actual encoded wire bytes
 *    and stops at the first unrepresentable route head without skipping or advancing ACKs.
 * 4. Claim encodability preflight: Proves synchronous claim response encodability
 *    before committing work transactions.
 */

export interface WorkLoweringResult {
  readonly wireRecord: unknown;
  readonly encodedByteLength: number;
  readonly contentSha256: string;
}

export interface WorkLoweringError {
  readonly _tag: "WorkLoweringError";
  readonly reason:
    | "codec-encode-failed"
    | "semantic-mismatch"
    | "hash-divergence"
    | "size-limit-exceeded";
  readonly message: string;
  readonly recordId: WorkRecordValue["id"];
}

/**
 * Lower a domain WorkRecord through a bound Station protocol codec.
 * Enforces:
 * - Successful encode through bound codec
 * - Strict byte length within WORK_PROTOCOL_MAX_RECORD_BYTES
 * - Exact lossless round-trip decode
 * - Unchanged semantic contentSha256 matching the canonical computation
 */
export const lowerOutboundWorkRecord = (
  record: WorkRecordValue,
  codec: StationProtocol1Codecs = STATION_PROTOCOL_1_CODECS,
): Result.Result<WorkLoweringResult, WorkLoweringError> => {
  // Validate that the record contentSha256 matches the actual computed semantic digest
  const computedHash = computeWorkRecordContentSha256(record as unknown as Record<string, unknown>);
  if (record.contentSha256 !== computedHash) {
    return Result.fail({
      _tag: "WorkLoweringError",
      reason: "hash-divergence",
      message: `Outbound Work record contentSha256 does not match computed semantic hash (${record.contentSha256} !== ${computedHash})`,
      recordId: record.id,
    });
  }

  const encodeResult = codec.work.record.encode(record);
  if (Result.isFailure(encodeResult)) {
    return Result.fail({
      _tag: "WorkLoweringError",
      reason: "codec-encode-failed",
      message: `Failed to encode outbound Work record ${record.id.route.eventHome}:${record.id.route.entityHome}:${record.id.seq}`,
      recordId: record.id,
    });
  }

  const wireRecord = encodeResult.success;
  const byteLength = workRecordEncodedByteLength(record);
  if (byteLength === undefined || byteLength > WORK_PROTOCOL_MAX_RECORD_BYTES) {
    return Result.fail({
      _tag: "WorkLoweringError",
      reason: "size-limit-exceeded",
      message: `Encoded Work record exceeds max size limit (${byteLength ?? "unknown"} > ${WORK_PROTOCOL_MAX_RECORD_BYTES})`,
      recordId: record.id,
    });
  }

  // Verify round-trip decode equality
  const roundTripDecode = codec.work.record.decode(wireRecord);
  if (Result.isFailure(roundTripDecode)) {
    return Result.fail({
      _tag: "WorkLoweringError",
      reason: "semantic-mismatch",
      message: `Lowered wire record failed round-trip decode verification`,
      recordId: record.id,
    });
  }

  if (roundTripDecode.success.contentSha256 !== record.contentSha256) {
    return Result.fail({
      _tag: "WorkLoweringError",
      reason: "hash-divergence",
      message: `Lowered wire record content hash diverged from domain record (${roundTripDecode.success.contentSha256} !== ${record.contentSha256})`,
      recordId: record.id,
    });
  }

  return Result.succeed({
    wireRecord,
    encodedByteLength: byteLength,
    contentSha256: record.contentSha256,
  });
};

/**
 * Raise an inbound wire Work record through the bound Station protocol codec.
 */
export const raiseInboundWorkRecord = (
  wireRecord: unknown,
  codec: StationProtocol1Codecs = STATION_PROTOCOL_1_CODECS,
): Result.Result<
  {
    readonly domainRecord: WorkRecordValue;
    readonly rawRecord: unknown;
    readonly evaluation: SemanticCompatibilityEvaluation<WorkRecordValue>;
  },
  {
    readonly _tag: "WorkRaisingError";
    readonly reason: "decode-failed" | "hash-divergence" | "unsupported-semantics";
    readonly message: string;
  }
> => {
  const decodeResult = codec.work.record.decode(wireRecord);
  if (Result.isFailure(decodeResult)) {
    return Result.fail({
      _tag: "WorkRaisingError",
      reason: "decode-failed",
      message: "Failed to decode inbound wire Work record through bound codec",
    });
  }

  const domainRecord = decodeResult.success;

  // Validate semantic hash
  const computedHash = computeWorkRecordContentSha256(domainRecord as unknown as Record<string, unknown>);
  if (domainRecord.contentSha256 !== computedHash) {
    return Result.fail({
      _tag: "WorkRaisingError",
      reason: "hash-divergence",
      message: `Inbound wire Work record contentSha256 does not match computed semantic hash (${domainRecord.contentSha256} !== ${computedHash})`,
    });
  }

  const evaluation = evaluateSemanticCompatibility(
    domainRecord,
    (rec) => rec.contentSha256 === domainRecord.contentSha256,
  );

  return Result.succeed({
    domainRecord,
    rawRecord: wireRecord,
    evaluation,
  });
};

export interface PageOutboundWorkRouteOptions {
  readonly maxRecords?: number;
  readonly maxBytes?: number;
}

export interface PagedOutboundWorkRouteResult {
  readonly loweredRecords: ReadonlyArray<WorkLoweringResult>;
  readonly totalBytes: number;
  readonly unrepresentableRouteHead: WorkLoweringError | null;
  readonly advancedThroughSeq: string | null;
}

/**
 * Page outbound Work records along a single route using actual wire-encoded byte accounting.
 * Stops at the first unrepresentable record without skipping or advancing sequence.
 */
export const pageOutboundWorkRoute = (
  records: ReadonlyArray<WorkRecordValue>,
  options: PageOutboundWorkRouteOptions = {},
  codec: StationProtocol1Codecs = STATION_PROTOCOL_1_CODECS,
): PagedOutboundWorkRouteResult => {
  const maxRecords = options.maxRecords ?? 256;
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;

  const loweredRecords: WorkLoweringResult[] = [];
  let totalBytes = 0;
  let unrepresentableRouteHead: WorkLoweringError | null = null;
  let lastValidSeq: string | null = null;

  for (const record of records) {
    if (loweredRecords.length >= maxRecords) {
      break;
    }

    const loweringResult = lowerOutboundWorkRecord(record, codec);
    if (Result.isFailure(loweringResult)) {
      // Unrepresentable record at route head! Stop immediately.
      unrepresentableRouteHead = loweringResult.failure;
      break;
    }

    const lowered = loweringResult.success;
    if (totalBytes + lowered.encodedByteLength > maxBytes && loweredRecords.length > 0) {
      // Byte limit reached
      break;
    }

    loweredRecords.push(lowered);
    totalBytes += lowered.encodedByteLength;
    lastValidSeq = record.id.seq;
  }

  return {
    loweredRecords,
    totalBytes,
    unrepresentableRouteHead,
    advancedThroughSeq: lastValidSeq,
  };
};

/**
 * Preflight a synchronous claim command's response to guarantee encodability before commit.
 */
export const preflightClaimResponseEncodability = (
  claimFact: WorkRecordValue,
  appliedDisposition: WorkRecordValue,
  codec: StationProtocol1Codecs = STATION_PROTOCOL_1_CODECS,
): Result.Result<true, WorkLoweringError> => {
  const factLowering = lowerOutboundWorkRecord(claimFact, codec);
  if (Result.isFailure(factLowering)) {
    return Result.fail(factLowering.failure);
  }

  const dispLowering = lowerOutboundWorkRecord(appliedDisposition, codec);
  if (Result.isFailure(dispLowering)) {
    return Result.fail(dispLowering.failure);
  }

  return Result.succeed(true);
};
