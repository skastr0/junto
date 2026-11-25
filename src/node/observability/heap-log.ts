/**
 * A Node process's V8 heap against its limit, as a `[metrics]` row: read in
 * the process itself, since no other process can read its heap.
 *
 * WHY. 0.11.8 died of a main-process V8 out-of-memory after 29.5 h, and on
 * 0.11.11 the core process grew from 469 to 1,085 MB in 46 minutes under
 * fleet work, with nothing recording its heap (task #650). Main's own row
 * lives in `src/app/observability/process-metrics-log.ts`; the core writes
 * this one into its log, `core.jsonl`, once a minute.
 *
 * COST. One `process.memoryUsage()` and one `getHeapStatistics()` a minute,
 * on an unref'd timer; nothing on a hot path.
 *
 * WARNINGS. A `warn` row the first time heap use crosses 50% and 75% of the
 * limit, re-armed once it falls back below that line.
 */
import { getHeapStatistics } from "node:v8";

export type HeapInput = {
  readonly rss: number;
  readonly heapUsed: number;
  readonly heapTotal: number;
  readonly external: number;
  readonly arrayBuffers: number;
  readonly heapLimit: number;
  readonly nativeContexts: number;
  readonly detachedContexts: number;
};

export type HeapRow = {
  readonly rssMb: number;
  readonly heapUsedMb: number;
  readonly heapTotalMb: number;
  readonly externalMb: number;
  readonly arrayBuffersMb: number;
  readonly heapLimitMb: number;
  readonly heapUsedPct: number;
  readonly nativeContexts: number;
  readonly detachedContexts: number;
};

export const HEAP_LOG_INTERVAL_MS = 60_000;
export const HEAP_WARN_FRACTIONS: ReadonlyArray<number> = [0.5, 0.75];

const MB = 1024 * 1024;
const round1 = (value: number): number => Math.round(value * 10) / 10;
const mbOfBytes = (bytes: number): number => round1(bytes / MB);

/** This process's heap, now. */
export const readHeap = (): HeapInput => {
  const usage = process.memoryUsage();
  const heap = getHeapStatistics();
  return {
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
    heapLimit: heap.heap_size_limit,
    nativeContexts: heap.number_of_native_contexts,
    detachedContexts: heap.number_of_detached_contexts,
  };
};

export const heapRow = (heap: HeapInput): HeapRow => ({
  rssMb: mbOfBytes(heap.rss),
  heapUsedMb: mbOfBytes(heap.heapUsed),
  heapTotalMb: mbOfBytes(heap.heapTotal),
  externalMb: mbOfBytes(heap.external),
  arrayBuffersMb: mbOfBytes(heap.arrayBuffers),
  heapLimitMb: mbOfBytes(heap.heapLimit),
  heapUsedPct: heap.heapLimit > 0 ? round1((100 * heap.heapUsed) / heap.heapLimit) : 0,
  nativeContexts: heap.nativeContexts,
  detachedContexts: heap.detachedContexts,
});

/**
 * The heap lines crossed upward since the last call, given which were armed.
 * A line re-arms once use falls below it again.
 */
export const heapLinesCrossed = (
  usedFraction: number,
  armed: ReadonlySet<number>,
): { readonly crossed: ReadonlyArray<number>; readonly armed: ReadonlySet<number> } => {
  const next = new Set<number>();
  const crossed: Array<number> = [];
  for (const line of HEAP_WARN_FRACTIONS) {
    if (usedFraction < line) next.add(line);
    else if (armed.has(line)) crossed.push(line);
  }
  return { crossed, armed: next };
};

export type HeapLogDeps = {
  /** The process the row names: `[metrics] core heap {...}`. */
  readonly label: string;
  readonly read?: () => HeapInput;
  readonly write: (level: "info" | "warn", message: string) => void;
  readonly intervalMs?: number;
};

/** Start the minute heap rows; returns a stop that writes one last row. */
export const startHeapLog = (deps: HeapLogDeps): (() => void) => {
  const read = deps.read ?? readHeap;
  let armed: ReadonlySet<number> = new Set(HEAP_WARN_FRACTIONS);
  let failing = false;
  const sample = (): void => {
    try {
      const heap = read();
      const row = heapRow(heap);
      deps.write("info", `[metrics] ${deps.label} heap ${JSON.stringify(row)}`);
      const lines = heapLinesCrossed(heap.heapLimit > 0 ? heap.heapUsed / heap.heapLimit : 0, armed);
      armed = lines.armed;
      for (const line of lines.crossed) {
        deps.write(
          "warn",
          `[metrics] ${deps.label} heap passed ${String(Math.round(line * 100))}% of its limit: ${String(row.heapUsedMb)} of ${String(row.heapLimitMb)} MB`,
        );
      }
      failing = false;
    } catch (cause) {
      // One row per failing streak, not one a minute. The row itself may be
      // what failed: a throw from here would leave the timer as an uncaught
      // exception in the process it watches, so it goes no further.
      if (!failing) {
        try {
          deps.write("warn", `[metrics] ${deps.label} heap sample failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        } catch {
          // Nothing left to tell; the next sample tries again.
        }
      }
      failing = true;
    }
  };
  const timer = setInterval(sample, deps.intervalMs ?? HEAP_LOG_INTERVAL_MS);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    sample();
  };
};
