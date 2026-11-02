/**
 * The Observability panel's reads (junto/observability/ipc.ts). The ring is
 * the core's, where every service row is written; Electron main's own lines
 * arrive on `observability.append` (its logger forwards them) so boot and
 * window rows are not lost. A new entry is published only while a panel is
 * watching, so a closed panel costs no push.
 */
import { Effect, Schema } from "effect";
import {
  ObservabilityQuery,
  type ObservabilityLogEntry,
  type ObservabilitySnapshot,
} from "@shared/observability";
import { OBSERVABILITY_CLEARED, OBSERVABILITY_LOG } from "../channels";
import { observabilityRing, type ObservabilityAppendInput } from "../../junto/observability/ring";
import { coreOps, type CoreOp } from "../ops";
import { publish } from "../push";

/** One entry a panel receives while it watches. */
export type ObservabilityPush = ObservabilityLogEntry;

type Clear = { readonly newestId: number; readonly total: number; readonly dropped: number };

declare module "../ops" {
  interface CoreOps {
    "observability.query": CoreOp<{ readonly query: unknown }, ObservabilitySnapshot>;
    "observability.clear": CoreOp<Record<string, never>, ObservabilitySnapshot>;
    "observability.watch": CoreOp<Record<string, never>, ObservabilitySnapshot>;
    "observability.unwatch": CoreOp<Record<string, never>, Record<string, never>>;
    /** Electron main's own rows, appended here where the ring lives. */
    "observability.append": CoreOp<{ readonly entry: ObservabilityAppendInput }, void>;
  }
}

/** Explorers watching: the ring always captures, the push is only sent while one is. */
let watching = 0;

observabilityRing.subscribe((entry) => {
  if (watching > 0) publish(OBSERVABILITY_LOG, entry);
});

/** Drop present-but-undefined keys (IPC / object literals break exact optionals). */
const stripUndefinedKeys = (raw: unknown): unknown => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
};

coreOps({
  "observability.query": ({ query }) =>
    Effect.sync(() => {
      if (query === undefined || query === null) return observabilityRing.query();
      // Soft-fail: a query this build does not read answers the ring unfiltered.
      const decoded = Schema.decodeUnknownResult(ObservabilityQuery)(stripUndefinedKeys(query));
      return decoded._tag === "Failure" ? observabilityRing.query() : observabilityRing.query(decoded.success);
    }),
  "observability.clear": () =>
    Effect.sync(() => {
      observabilityRing.clear();
      const snapshot = observabilityRing.query({ limit: 1 });
      if (watching > 0) {
        publish(OBSERVABILITY_CLEARED, { newestId: 0, total: 0, dropped: 0 } satisfies Clear);
      }
      return snapshot;
    }),
  "observability.watch": () =>
    Effect.sync(() => {
      watching += 1;
      return observabilityRing.query({ limit: 500 });
    }),
  "observability.unwatch": () =>
    Effect.sync(() => {
      watching = Math.max(0, watching - 1);
      return {};
    }),
  "observability.append": ({ entry }) => Effect.sync(() => void observabilityRing.append(entry)),
});
