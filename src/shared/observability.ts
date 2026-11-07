import { Result, Schema } from "effect";

/**
 * Process-local observability surface for the developer logs explorer.
 *
 * Capture is always-on (bounded ring in main): Effect.log* (Info+ default
 * min level), main console.*, and renderer console-message. Not the durable
 * work ledger, LaunchAgent files, or child protocol streams — those are
 * separate planes. The UI is gated by `settings.advanced.logsExplorer`.
 */

export const OBSERVABILITY_RING_CAPACITY = 2_000 as const;
export const OBSERVABILITY_MESSAGE_MAX_CHARS = 4_096 as const;

export const ObservabilityLogLevel = Schema.Literals(["trace", "debug",
"info",
"warn",
"error",
"fatal",]);
export type ObservabilityLogLevel = typeof ObservabilityLogLevel.Type;

export const ObservabilityLogSource = Schema.Literals(["effect", "main",
"renderer",
"system",]);
export type ObservabilityLogSource = typeof ObservabilityLogSource.Type;

export const ObservabilityLogEntry = Schema.Struct({
  id: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  ts: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  level: ObservabilityLogLevel,
  source: ObservabilityLogSource,
  message: Schema.String,
  fiber: Schema.optionalKey(Schema.String),
  spans: Schema.optionalKey(Schema.Array(Schema.String)),
  annotations: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
export type ObservabilityLogEntry = typeof ObservabilityLogEntry.Type;

export const ObservabilityQuery = Schema.Struct({
  /** Inclusive sequence cursor — return entries with id > afterId. */
  afterId: Schema.optionalKey(Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
  /** Max rows (newest-first when afterId omitted; oldest-first when afterId set). */
  limit: Schema.optionalKey(Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isBetween({ minimum: 1, maximum: OBSERVABILITY_RING_CAPACITY })))),
  levels: Schema.optionalKey(Schema.Array(ObservabilityLogLevel).pipe(Schema.check(Schema.isMinLength(1)))),
  sources: Schema.optionalKey(Schema.Array(ObservabilityLogSource).pipe(Schema.check(Schema.isMinLength(1)))),
  /** Case-insensitive substring over message + annotation values. */
  q: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMaxLength(200)))),
});
export type ObservabilityQuery = typeof ObservabilityQuery.Type;

export const ObservabilitySnapshot = Schema.Struct({
  capacity: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThan(0))),
  total: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  dropped: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  newestId: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  entries: Schema.Array(ObservabilityLogEntry),
});
export type ObservabilitySnapshot = typeof ObservabilitySnapshot.Type;

/**
 * One row as a process hands it to the core's ring, before the ring gives it
 * an id: Electron main's own rows cross the port in this shape.
 */
export const ObservabilityAppendInput = Schema.Struct({
  level: ObservabilityLogLevel,
  source: ObservabilityLogSource,
  message: Schema.String,
  ts: Schema.optionalKey(Schema.Number),
  fiber: Schema.optionalKey(Schema.String),
  spans: Schema.optionalKey(Schema.Array(Schema.String)),
  annotations: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
export type ObservabilityAppendInput = typeof ObservabilityAppendInput.Type;

/** Drop present-but-undefined keys (IPC / object literals break exact optionals). */
const withoutUndefinedKeys = (raw: unknown): unknown =>
  raw === null || typeof raw !== "object" || Array.isArray(raw)
    ? raw
    : Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined));

/**
 * A panel's query at main's edge, decoded closed. Soft: none, or a query this
 * build does not read, asks for the ring unfiltered.
 */
export const observabilityQueryFromWindow = (raw: unknown): ObservabilityQuery | undefined => {
  if (raw === undefined || raw === null) return undefined;
  const decoded = Schema.decodeUnknownResult(ObservabilityQuery)(withoutUndefinedKeys(raw), { onExcessProperty: "error" });
  return Result.isSuccess(decoded) ? decoded.success : undefined;
};

export const OBSERVABILITY_LEVEL_RANK: Record<ObservabilityLogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};

export const matchesObservabilityQuery = (
  entry: ObservabilityLogEntry,
  query: ObservabilityQuery,
): boolean => {
  if (query.levels && !query.levels.includes(entry.level)) return false;
  if (query.sources && !query.sources.includes(entry.source)) return false;
  const q = query.q?.trim().toLowerCase();
  if (!q) return true;
  if (entry.message.toLowerCase().includes(q)) return true;
  if (entry.fiber?.toLowerCase().includes(q)) return true;
  if (entry.spans?.some((span) => span.toLowerCase().includes(q))) return true;
  if (entry.annotations) {
    for (const [key, value] of Object.entries(entry.annotations)) {
      if (key.toLowerCase().includes(q) || value.toLowerCase().includes(q)) {
        return true;
      }
    }
  }
  return false;
};
