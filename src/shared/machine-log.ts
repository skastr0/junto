import { Schema } from "effect";
import {
  OBSERVABILITY_LEVEL_RANK,
  ObservabilityLogLevel,
  ObservabilityLogSource,
} from "./observability";
import { EncodedFailure, OperationId } from "./failure";
import { MachineName } from "./machine-control";
import { CanvasName } from "./model/base";
import { NodeId } from "./physics/schema";

/**
 * The persistent machine log (docs/machines.md, Failures and logs): one JSON
 * line per row under `~/.junto/logs/`, on every machine. Every string here is
 * bounded so a row from another machine is decoded closed, and every free
 * text field is scrubbed before it is written (docs/security-doctrine.md).
 */

/** A message, or one message in a cause chain. */
export const LOG_MESSAGE_MAX_BYTES = 1_024;
export const LOG_ROW_MAX_BYTES = 16 * 1_024;
export const LOG_READ_DEFAULT_LIMIT = 200;
export const LOG_READ_MAX_LIMIT = 2_000;

const bounded = (max: number) => Schema.String.pipe(Schema.check(Schema.isMaxLength(max)));
const named = (max: number) =>
  Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(max)));

/** Where a row comes from: an Effect area annotation, or a console `[prefix]`. */
export const LogArea = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,47}$/u)));
export const LogOperationId = OperationId;
/** A seat's node id as rows carry it: a typed id, never scrubbed text. */
export const LogSeatId = NodeId.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9._-]{1,128}$/u)));
export const LogCanvasName = CanvasName;
export const LogProcess = Schema.Literals(["app", "core"]);
export type LogProcess = typeof LogProcess.Type;

/**
 * Annotation keys that carry link and seat ids: session, request,
 * installation, build, binding and generation (docs/security-doctrine.md).
 * operationId, seat and canvas are row columns, checked the same way. Their
 * values are checked against `LogAnnotationId` and dropped when they fail;
 * they are never scrubbed, because the scrub's id rules would erase them.
 */
export const LOG_ID_ANNOTATIONS: ReadonlySet<string> = new Set([
  "sessionId", "requestId", "installationId", "peerInstallationId", "peerBuild", "bindingId", "generation", "generationId",
]);
export const LogAnnotationId = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u)));
export const isLogAnnotationId = Schema.is(LogAnnotationId);

export const MachineLogRow = Schema.Struct({
  time: bounded(32),
  level: ObservabilityLogLevel,
  machine: named(64),
  process: LogProcess,
  source: ObservabilityLogSource,
  area: LogArea,
  message: bounded(LOG_MESSAGE_MAX_BYTES),
  operationId: Schema.optionalKey(LogOperationId),
  seat: Schema.optionalKey(LogSeatId),
  canvas: Schema.optionalKey(LogCanvasName),
  failure: Schema.optionalKey(EncodedFailure),
  spans: Schema.optionalKey(Schema.Array(named(128)).pipe(Schema.check(Schema.isMaxLength(16)))),
  annotations: Schema.optionalKey(Schema.Record(named(64), bounded(256))),
});
export type MachineLogRow = typeof MachineLogRow.Type;

export const MachineLogQuery = Schema.Struct({
  /** Rows at or after this time, epoch milliseconds. */
  since: Schema.optionalKey(Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)))),
  /** Rows at or above this level. */
  level: Schema.optionalKey(ObservabilityLogLevel),
  area: Schema.optionalKey(LogArea),
  operationId: Schema.optionalKey(LogOperationId),
  seat: Schema.optionalKey(LogSeatId),
  canvas: Schema.optionalKey(LogCanvasName),
  /** The newest rows that match, oldest first. */
  limit: Schema.optionalKey(Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: LOG_READ_MAX_LIMIT })))),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type MachineLogQuery = typeof MachineLogQuery.Type;

/** `junto machine logs`: the owner reads one machine's log, this one or a linked one. */
export const MachineLogsInput = Schema.Struct({
  name: MachineName,
  query: MachineLogQuery,
});
export type MachineLogsInput = typeof MachineLogsInput.Type;

export const MachineLogRead = Schema.Struct({
  machine: named(64),
  rows: Schema.Array(MachineLogRow).pipe(Schema.check(Schema.isMaxLength(LOG_READ_MAX_LIMIT))),
  /** More rows matched than were returned; narrow the query or raise the limit. */
  cut: Schema.Boolean,
  /** Lines in the files that did not decode as a row. */
  unreadable: Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
});
export type MachineLogRead = typeof MachineLogRead.Type;

export const matchesMachineLogQuery = (row: MachineLogRow, query: MachineLogQuery): boolean => {
  if (query.since !== undefined && Date.parse(row.time) < query.since) return false;
  if (query.level !== undefined && OBSERVABILITY_LEVEL_RANK[row.level] < OBSERVABILITY_LEVEL_RANK[query.level]) return false;
  if (query.area !== undefined && row.area !== query.area) return false;
  if (query.operationId !== undefined && row.operationId !== query.operationId && row.failure?.operationId !== query.operationId) return false;
  if (query.seat !== undefined && row.seat !== query.seat) return false;
  if (query.canvas !== undefined && row.canvas !== query.canvas) return false;
  return true;
};

const isLogSeatId = Schema.is(LogSeatId);

/** Whether a failure's channel detail carries a seatId at all, valid or not. */
export const failureDetailNamesSeat = (failure: EncodedFailure | undefined): boolean => {
  const detail = failure?.detail;
  return detail !== null && typeof detail === "object" && !Array.isArray(detail) && "seatId" in detail;
};

/** The seat a failure's channel detail names, when it names a valid one. */
export const failureDetailSeat = (failure: EncodedFailure | undefined): typeof LogSeatId.Type | undefined => {
  const detail = failure?.detail;
  if (detail === null || typeof detail !== "object" || Array.isArray(detail)) return undefined;
  const seatId = (detail as { readonly seatId?: unknown }).seatId;
  return isLogSeatId(seatId) ? seatId : undefined;
};
