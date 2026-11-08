/**
 * One `[metrics]` row a minute in the machine log, in every build, packaged
 * included: what each of the app's processes costs (CPU, idle wakeups,
 * memory), and the main process's V8 heap against its limit.
 *
 * WHY. Heat and lag are felt over hours, on the installed app, where no
 * profiler is attached. These rows let anyone read, after the fact, which
 * process burned the CPU (GPU, renderer, main, core, terminals) and whether
 * the main heap grew toward its ceiling. 0.11.8 died of a main-process V8
 * out-of-memory after 29.5 h with no such record (task #650).
 *
 * COST. One `app.getAppMetrics()` and one heap read a minute; no timers on
 * any hot path. Electron reports `percentCPUUsage` since the previous call,
 * so a row covers the minute before it.
 *
 * CPU UNIT. A row's `cpu` is one core = 100%, as `ps` and `top` read it.
 * Electron divides `percentCPUUsage` by the logical core count (Electron
 * 43.8.4, measured: one busy core reads 9.9 with 10 cores), so the row
 * multiplies it back.
 *
 * WARNINGS. A `warn` row the first time main heap use crosses 50% and 75% of
 * the heap limit, re-armed once it falls back below that line.
 */

/** The fields of Electron's `ProcessMetric` this log reads. */
export type ProcessMetricInput = {
  readonly pid: number;
  readonly type: string;
  readonly serviceName?: string;
  readonly name?: string;
  readonly cpu: { readonly percentCPUUsage: number; readonly idleWakeupsPerSecond?: number; readonly cumulativeCPUUsage?: number };
  /** Kilobytes, as Electron reports them. */
  readonly memory: { readonly workingSetSize: number; readonly peakWorkingSetSize: number };
};

export type MainHeapInput = {
  readonly rss: number;
  readonly heapUsed: number;
  readonly heapTotal: number;
  readonly external: number;
  readonly arrayBuffers: number;
  readonly heapLimit: number;
  readonly nativeContexts: number;
  readonly detachedContexts: number;
};

export type ProcessMetricsRow = {
  readonly procs: ReadonlyArray<{
    readonly kind: string;
    readonly pid: number;
    readonly cpu: number;
    readonly cpuTotalS?: number;
    readonly wakeups?: number;
    readonly mb: number;
    readonly peakMb: number;
  }>;
  readonly main: {
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
  readonly totals: { readonly cpu: number; readonly mb: number };
};

export const PROCESS_METRICS_INTERVAL_MS = 60_000;
export const HEAP_WARN_FRACTIONS: ReadonlyArray<number> = [0.5, 0.75];

const MB = 1024 * 1024;
const round1 = (value: number): number => Math.round(value * 10) / 10;
const mbOfBytes = (bytes: number): number => round1(bytes / MB);
const mbOfKb = (kb: number): number => round1(kb / 1024);

/** "GPU", "Tab", "Utility:Junto Core", ...: the type, and the service a utility process names. */
export const processKind = (metric: ProcessMetricInput): string => {
  const service = metric.serviceName ?? metric.name;
  return metric.type === "Utility" && service !== undefined && service.length > 0 ? `Utility:${service}` : metric.type;
};

/** `cores` is the logical core count Electron divided `percentCPUUsage` by. */
export const processMetricsRow = (
  metrics: ReadonlyArray<ProcessMetricInput>,
  heap: MainHeapInput,
  cores: number,
): ProcessMetricsRow => {
  const perCore = Math.max(1, cores);
  const procs = metrics
    .map((metric) => ({
      kind: processKind(metric),
      pid: metric.pid,
      cpu: round1(metric.cpu.percentCPUUsage * perCore),
      ...(metric.cpu.cumulativeCPUUsage === undefined ? {} : { cpuTotalS: round1(metric.cpu.cumulativeCPUUsage) }),
      ...(metric.cpu.idleWakeupsPerSecond === undefined ? {} : { wakeups: Math.round(metric.cpu.idleWakeupsPerSecond) }),
      mb: mbOfKb(metric.memory.workingSetSize),
      peakMb: mbOfKb(metric.memory.peakWorkingSetSize),
    }))
    .sort((a, b) => b.cpu - a.cpu || b.mb - a.mb);
  return {
    procs,
    main: {
      rssMb: mbOfBytes(heap.rss),
      heapUsedMb: mbOfBytes(heap.heapUsed),
      heapTotalMb: mbOfBytes(heap.heapTotal),
      externalMb: mbOfBytes(heap.external),
      arrayBuffersMb: mbOfBytes(heap.arrayBuffers),
      heapLimitMb: mbOfBytes(heap.heapLimit),
      heapUsedPct: heap.heapLimit > 0 ? round1((100 * heap.heapUsed) / heap.heapLimit) : 0,
      nativeContexts: heap.nativeContexts,
      detachedContexts: heap.detachedContexts,
    },
    totals: {
      cpu: round1(procs.reduce((sum, proc) => sum + proc.cpu, 0)),
      mb: round1(procs.reduce((sum, proc) => sum + proc.mb, 0)),
    },
  };
};

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

export type ProcessMetricsLogDeps = {
  readonly appMetrics: () => ReadonlyArray<ProcessMetricInput>;
  readonly mainHeap: () => MainHeapInput;
  /** Logical cores, `os.cpus().length`: what Electron divides CPU by. */
  readonly cores: number;
  readonly write: (level: "info" | "warn", message: string) => void;
  readonly intervalMs?: number;
};

/** Start the minute rows; returns a stop that writes one last row. */
export const startProcessMetricsLog = (deps: ProcessMetricsLogDeps): (() => void) => {
  let armed: ReadonlySet<number> = new Set(HEAP_WARN_FRACTIONS);
  let failing = false;
  const sample = (): void => {
    try {
      const heap = deps.mainHeap();
      const row = processMetricsRow(deps.appMetrics(), heap, deps.cores);
      deps.write("info", `[metrics] ${JSON.stringify(row)}`);
      const lines = heapLinesCrossed(heap.heapLimit > 0 ? heap.heapUsed / heap.heapLimit : 0, armed);
      armed = lines.armed;
      for (const line of lines.crossed) {
        deps.write(
          "warn",
          `[metrics] main heap passed ${String(Math.round(line * 100))}% of its limit: ${String(row.main.heapUsedMb)} of ${String(row.main.heapLimitMb)} MB`,
        );
      }
      failing = false;
    } catch (cause) {
      // One row per failing streak, not one a minute.
      if (!failing) deps.write("warn", `[metrics] sample failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      failing = true;
    }
  };
  // Electron's first percentCPUUsage reads 0; this primes it.
  try {
    deps.appMetrics();
  } catch {
    // The interval's own sample reports a lasting failure.
  }
  const timer = setInterval(sample, deps.intervalMs ?? PROCESS_METRICS_INTERVAL_MS);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    sample();
  };
};
