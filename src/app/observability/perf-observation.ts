/**
 * Boot wiring for the app's always-on performance observation: the minute
 * `[metrics]` rows (process-metrics-log.ts) and the trace recorder with its
 * SIGUSR2 trigger (perf-trace.ts). Electron-facing on purpose; the logic it
 * wires is plain and tested on its own.
 */
import { cpus } from "node:os";
import { app, contentTracing } from "electron";
import { readHeap } from "../../node/observability/heap-log";
import { mainLog } from "./main-log";
import { startProcessMetricsLog } from "./process-metrics-log";
import { makePerfTraceRecorder, type PerfTraceRecorder } from "./perf-trace";

export type PerfObservation = {
  readonly trace: PerfTraceRecorder;
  readonly stop: () => void;
};

const write = (level: "info" | "warn", message: string): void => {
  mainLog.writeLog({ level, source: "main", message });
};

export const startPerfObservation = (juntoHome: string): PerfObservation => {
  const stopMetrics = startProcessMetricsLog({
    appMetrics: () => app.getAppMetrics(),
    cores: cpus().length,
    mainHeap: readHeap,
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
