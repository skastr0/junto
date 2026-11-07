/**
 * The core's handlers of the observability group
 * (src/contract/core/observability.ts). The ring is the core's, where every
 * service row is written; Electron main's own lines arrive on
 * `ObservabilityAppend` (its logger forwards them) so boot and window rows
 * are not lost. A new entry is published only while a panel is watching, so a
 * closed panel costs no push.
 */
import { Effect } from "effect";
import { OBSERVABILITY_CLEARED, OBSERVABILITY_LOG } from "../../contract/core/channels";
import { ObservabilityRpcs } from "../../contract/core/observability";
import { appendScrubbed, observabilityRing } from "../observability/ring";
import { CorePushes } from "../push";

export const ObservabilityHandlers = ObservabilityRpcs.toLayer(
  Effect.gen(function* () {
    const pushes = yield* CorePushes;
    /** Panels watching this server: the ring always captures, the push is only sent while one is. */
    let watching = 0;
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        observabilityRing.subscribe((entry) => {
          if (watching > 0) Effect.runSync(pushes.publish(OBSERVABILITY_LOG, entry));
        }),
      ),
      (stop) => Effect.sync(stop),
    );
    return {
      ObservabilityQuery: ({ query }) => Effect.sync(() => observabilityRing.query(query)),
      ObservabilityClear: () =>
        Effect.gen(function* () {
          observabilityRing.clear();
          const snapshot = observabilityRing.query({ limit: 1 });
          if (watching > 0) yield* pushes.publish(OBSERVABILITY_CLEARED, { newestId: 0, total: 0, dropped: 0 });
          return snapshot;
        }),
      ObservabilityWatch: () =>
        Effect.sync(() => {
          watching += 1;
          return observabilityRing.query({ limit: 500 });
        }),
      ObservabilityUnwatch: () =>
        Effect.sync(() => {
          watching = Math.max(0, watching - 1);
        }),
      // Scrubbed again in this process: the registry of known secret values lives here.
      ObservabilityAppend: ({ entry }) => Effect.sync(() => void appendScrubbed(entry)),
    };
  }),
);
