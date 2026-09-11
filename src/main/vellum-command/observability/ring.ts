import type {
  ObservabilityLogEntry,
  ObservabilityLogLevel,
  ObservabilityLogSource,
  ObservabilityQuery,
  ObservabilitySnapshot,
} from "@shared/observability";
import {
  OBSERVABILITY_MESSAGE_MAX_CHARS,
  OBSERVABILITY_RING_CAPACITY,
  matchesObservabilityQuery,
} from "@shared/observability";

export type ObservabilityAppendInput = {
  readonly level: ObservabilityLogLevel;
  readonly source: ObservabilityLogSource;
  readonly message: string;
  readonly ts?: number;
  readonly fiber?: string;
  readonly spans?: ReadonlyArray<string>;
  readonly annotations?: Readonly<Record<string, string>>;
};

export type ObservabilityRing = {
  readonly append: (input: ObservabilityAppendInput) => ObservabilityLogEntry;
  readonly query: (query?: ObservabilityQuery) => ObservabilitySnapshot;
  readonly clear: () => void;
  readonly subscribe: (
    listener: (entry: ObservabilityLogEntry) => void,
  ) => () => void;
  readonly capacity: number;
};

const truncateMessage = (message: string): string => {
  if (message.length <= OBSERVABILITY_MESSAGE_MAX_CHARS) return message;
  return `${message.slice(0, OBSERVABILITY_MESSAGE_MAX_CHARS - 1)}…`;
};

const sanitizeAnnotations = (
  annotations: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined => {
  if (!annotations) return undefined;
  const entries = Object.entries(annotations);
  if (entries.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of entries.slice(0, 32)) {
    out[key.slice(0, 64)] = truncateMessage(value).slice(0, 512);
  }
  return out;
};

/**
 * Bounded process-local ring. Always on; zero disk. Subscribers get live
 * appends (used for renderer push when the explorer is open).
 */
export const makeObservabilityRing = (
  capacity: number = OBSERVABILITY_RING_CAPACITY,
): ObservabilityRing => {
  const buf: ObservabilityLogEntry[] = [];
  const listeners = new Set<(entry: ObservabilityLogEntry) => void>();
  let nextId = 1;
  let dropped = 0;

  const append = (input: ObservabilityAppendInput): ObservabilityLogEntry => {
    const annotations = sanitizeAnnotations(input.annotations);
    const entry: ObservabilityLogEntry = {
      id: nextId++,
      ts: input.ts ?? Date.now(),
      level: input.level,
      source: input.source,
      message: truncateMessage(input.message),
      ...(input.fiber ? { fiber: input.fiber.slice(0, 64) } : {}),
      ...(input.spans && input.spans.length > 0
        ? { spans: input.spans.slice(0, 16).map((s) => s.slice(0, 128)) }
        : {}),
      ...(annotations ? { annotations } : {}),
    };
    buf.push(entry);
    while (buf.length > capacity) {
      buf.shift();
      dropped += 1;
    }
    for (const listener of listeners) {
      try {
        listener(entry);
      } catch {
        // Subscriber faults must not break the ring.
      }
    }
    return entry;
  };

  const query = (queryInput: ObservabilityQuery = {}): ObservabilitySnapshot => {
    const limit = queryInput.limit ?? 200;
    const afterId = queryInput.afterId;
    let matched = buf.filter((entry) => matchesObservabilityQuery(entry, queryInput));
    if (afterId !== undefined) {
      matched = matched.filter((entry) => entry.id > afterId);
      // Live tail: oldest-first so the client can append in order.
      matched = matched.slice(0, limit);
    } else {
      // Snapshot: newest-first then reverse so the UI can reverse for display.
      matched = matched.slice(-limit);
    }
    const newestId = buf.length === 0 ? 0 : buf[buf.length - 1]!.id;
    return {
      capacity,
      total: buf.length,
      dropped,
      newestId,
      entries: matched,
    };
  };

  const clear = (): void => {
    buf.length = 0;
    dropped = 0;
  };

  const subscribe = (
    listener: (entry: ObservabilityLogEntry) => void,
  ): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return { append, query, clear, subscribe, capacity };
};

/** Singleton for the app process (Command Center + Remote share one process). */
export const observabilityRing = makeObservabilityRing();

/** Convenience for call sites outside Effect (console bridge, crash handlers). */
export const recordObservabilityLog = (
  input: ObservabilityAppendInput,
): ObservabilityLogEntry => observabilityRing.append(input);
