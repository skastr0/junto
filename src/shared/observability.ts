import { Schema } from "effect";

/**
 * Process-local observability surface for the developer logs explorer.
 *
 * Capture is always-on (bounded ring in main). The UI is gated by
 * `settings.advanced.logsExplorer` — never a second durable store.
 */

export const OBSERVABILITY_RING_CAPACITY = 2_000 as const;
export const OBSERVABILITY_MESSAGE_MAX_CHARS = 4_096 as const;

export const ObservabilityLogLevel = Schema.Literal(
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
);
export type ObservabilityLogLevel = typeof ObservabilityLogLevel.Type;

export const ObservabilityLogSource = Schema.Literal(
  "effect",
  "main",
  "renderer",
  "system",
);
export type ObservabilityLogSource = typeof ObservabilityLogSource.Type;

export const ObservabilityLogEntry = Schema.Struct({
  id: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  ts: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  level: ObservabilityLogLevel,
  source: ObservabilityLogSource,
  message: Schema.String,
  fiber: Schema.optionalWith(Schema.String, { exact: true }),
  spans: Schema.optionalWith(Schema.Array(Schema.String), { exact: true }),
  annotations: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: Schema.String }),
    { exact: true },
  ),
});
export type ObservabilityLogEntry = typeof ObservabilityLogEntry.Type;

export const ObservabilityQuery = Schema.Struct({
  /** Inclusive sequence cursor — return entries with id > afterId. */
  afterId: Schema.optionalWith(
    Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
    { exact: true },
  ),
  /** Max rows (newest-first when afterId omitted; oldest-first when afterId set). */
  limit: Schema.optionalWith(
    Schema.Number.pipe(Schema.int(), Schema.between(1, OBSERVABILITY_RING_CAPACITY)),
    { exact: true },
  ),
  levels: Schema.optionalWith(
    Schema.Array(ObservabilityLogLevel).pipe(Schema.minItems(1)),
    { exact: true },
  ),
  sources: Schema.optionalWith(
    Schema.Array(ObservabilityLogSource).pipe(Schema.minItems(1)),
    { exact: true },
  ),
  /** Case-insensitive substring over message + annotation values. */
  q: Schema.optionalWith(Schema.String.pipe(Schema.maxLength(200)), { exact: true }),
});
export type ObservabilityQuery = typeof ObservabilityQuery.Type;

export const ObservabilitySnapshot = Schema.Struct({
  capacity: Schema.Number.pipe(Schema.int(), Schema.positive()),
  total: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  dropped: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  newestId: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
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
