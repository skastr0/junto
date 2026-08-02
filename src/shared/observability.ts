import { Schema } from "effect";

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
  levels: Schema.optionalKey(Schema.Array(ObservabilityLogLevel).pipe(Schema.check(Schema.isMinSize(1)))),
  sources: Schema.optionalKey(Schema.Array(ObservabilityLogSource).pipe(Schema.check(Schema.isMinSize(1)))),
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

export const defaultObservabilityQuery = (): ObservabilityQuery => ({
  limit: 200,
});

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
