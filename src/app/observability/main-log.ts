/**
 * Electron main's one log. Its rows cross to the core's ring, where the panel
 * reads them and where `appendScrubbed` scrubs them again with the registry
 * only the core holds; main knows no secret values, so it hands its log none.
 *
 * A value, not a slot: it is built here, and every main module that logs
 * imports this instance. Each row waits on `mainRows` until main's client of
 * the core sends it (`observability/ipc.ts`), so boot's rows reach the panel
 * too; the newest ring's worth is kept while none is sent.
 */
import { Effect, Queue } from "effect";
import { OBSERVABILITY_RING_CAPACITY, type ObservabilityAppendInput } from "@shared/observability";
import { createLogger } from "../../node/observability/logger";

export const mainRows: Queue.Queue<ObservabilityAppendInput> = Effect.runSync(
  Queue.sliding<ObservabilityAppendInput>(OBSERVABILITY_RING_CAPACITY),
);

export const mainLog = createLogger({
  process: "app",
  echo: true,
  sink: (entry) => {
    Queue.offerUnsafe(mainRows, entry);
  },
});
