/**
 * Boot wiring for the app's always-on performance observation: the minute
 * `[metrics]` rows (process-metrics-log.ts) and the trace recorder with its
 * SIGUSR2 trigger (perf-trace.ts). Electron-facing on purpose; the logic it
 * wires is plain and tested on its own.
 */
import { getHeapStatistics } from "node:v8";
import { app, contentTracing } from "electron";
import { writeLog } from "./logger";
import { startProcessMetricsLog } from "./process-metrics-log";
import { makePerfTraceRecorder, type PerfTraceRecorder } from "./perf-trace";

export type PerfObservation = {
  readonly trace: PerfTraceRecorder;
  readonly stop: () => void;
};

const write = (level: "info" | "warn", message: string): void => {
  writeLog({ level, source: "main", message });
};

export const startPerfObservation = (juntoHome: string): PerfObservation => {
  const stopMetrics = startProcessMetricsLog({
    appMetrics: () => app.getAppMetrics(),
    mainHeap: () => {
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
    },
    write,
  });
  const trace = makePerfTraceRecorder({ juntoHome, tracing: contentTracing, write });
  const onSignal = (): void => {
    void trace.record("SIGUSR2");
  };
  process.on("SIGUSR2", onSignal);
  return {
    trace,
    stop: () => {
      process.off("SIGUSR2", onSignal);
      stopMetrics();
    },
  };
};
