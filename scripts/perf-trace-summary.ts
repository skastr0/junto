/**
 * Frame, main-thread and input numbers from one Chromium trace window, for the
 * terminal performance baseline (e2e/scenarios/perf-terminal-baseline.spec.ts).
 *
 * The renderer main thread is the CrRendererMain thread with the most top-level
 * task time. Presented frames are viz Display::DrawAndSwap events. Input
 * latency is EventLatency (browser input to presentation) by event type.
 *
 * usage: bun scripts/perf-trace-summary.ts <trace.json> <window seconds>
 */
import { readFileSync } from "node:fs";

type TraceEvent = {
  readonly ph?: string;
  readonly name?: string;
  readonly pid?: number;
  readonly tid?: number;
  readonly ts: number;
  readonly dur?: number;
  readonly id?: string;
  readonly id2?: { readonly local?: string };
  readonly args?: Record<string, any>;
};

export type Spread = { n: number; p50: number | null; p95: number | null; p99: number | null; max: number | null };

export type TraceSummary = {
  readonly main: {
    readonly busyMsPerS: number;
    readonly tasks: number;
    readonly taskMs: Spread;
    readonly tasksOver16ms: number;
    readonly tasksOver50ms: number;
    /** Inclusive ms and count of the rendering phases on the main thread. */
    readonly events: Record<string, { count: number; ms: number }>;
  };
  readonly frames: {
    readonly presented: number;
    readonly presentedPerS: number;
    readonly gapMs: Spread;
    readonly gapsOver12_5: number;
    readonly gapsOver16_7: number;
  };
  readonly inputLatencyMs: Record<string, Spread>;
  /** Mean ms of each EventLatency stage, 0.1 ms and over: where input time goes. */
  readonly inputStagesMeanMs: Record<string, number>;
  /** Heaviest Paint by DOM node (backend node ids; the spec names them). */
  readonly paintByNode: Array<{ nodeId: number; count: number; ms: number }>;
  readonly otherThreadsMsPerS: Record<string, number>;
};

const RUN_TASK = new Set(["RunTask", "ThreadControllerImpl::RunTask"]);
const MAIN_EVENTS = new Set([
  "UpdateLayoutTree", "Layout", "PrePaint", "Paint", "PaintArtifactCompositor::Update",
  "FunctionCall", "EventDispatch", "FireAnimationFrame", "RunMicrotasks", "HitTest",
  "Commit", "UpdateLayer", "TimerFire", "V8.Execute", "MajorGC", "MinorGC",
]);

const round = (value: number, places = 2): number => Math.round(value * 10 ** places) / 10 ** places;

const pct = (sorted: readonly number[], p: number): number | null =>
  sorted.length ? round(sorted[Math.min(sorted.length - 1, Math.round((p / 100) * (sorted.length - 1)))]!) : null;

export const spread = (values: readonly number[]): Spread => {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, p50: pct(sorted, 50), p95: pct(sorted, 95), p99: pct(sorted, 99), max: sorted.length ? round(sorted.at(-1)!) : null };
};

const asyncId = (event: TraceEvent): string | undefined => event.id ?? event.id2?.local;

export const summarizeTraceEvents = (events: readonly TraceEvent[], windowS: number): TraceSummary => {
  const threads = new Map<string, string>();
  const procs = new Map<number, string>();
  for (const e of events) {
    if (e.ph !== "M") continue;
    if (e.name === "thread_name") threads.set(`${e.pid}:${e.tid}`, e.args?.name);
    if (e.name === "process_name") procs.set(e.pid!, e.args?.name);
  }

  const busy = new Map<string, number>();
  for (const e of events) {
    if (e.ph === "X" && RUN_TASK.has(e.name!)) {
      const key = `${e.pid}:${e.tid}`;
      busy.set(key, (busy.get(key) ?? 0) + (e.dur ?? 0));
    }
  }
  const mainKey = [...busy].filter(([key]) => threads.get(key) === "CrRendererMain").sort((a, b) => b[1] - a[1])[0]?.[0];
  if (mainKey === undefined) throw new Error("no CrRendererMain tasks in the trace");

  const tasks: number[] = [];
  const mainEvents: Record<string, { count: number; ms: number }> = {};
  const paint = new Map<number, { count: number; ms: number }>();
  const swaps: number[] = [];
  for (const e of events) {
    if (e.ph !== "X") continue;
    if (e.name === "Display::DrawAndSwap") swaps.push(e.ts);
    if (`${e.pid}:${e.tid}` !== mainKey) continue;
    const ms = (e.dur ?? 0) / 1000;
    if (RUN_TASK.has(e.name!)) tasks.push(ms);
    if (MAIN_EVENTS.has(e.name!)) {
      const slot = (mainEvents[e.name!] ??= { count: 0, ms: 0 });
      slot.count += 1;
      slot.ms += ms;
    }
    if (e.name === "Paint") {
      const nodeId = Number(e.args?.data?.nodeId);
      const slot = paint.get(nodeId) ?? { count: 0, ms: 0 };
      slot.count += 1;
      slot.ms += ms;
      paint.set(nodeId, slot);
    }
  }
  swaps.sort((a, b) => a - b);
  const swapGaps = swaps.slice(1).map((ts, i) => (ts - swaps[i]!) / 1000);

  // EventLatency spans, and their stage spans (children sharing the async id).
  const opened = new Map<string, TraceEvent>();
  const latency: Record<string, number[]> = {};
  const latencyIds = new Set<string>();
  for (const e of events) {
    if (e.name !== "EventLatency" || (e.ph !== "b" && e.ph !== "e")) continue;
    const key = `${e.pid}:${asyncId(e)}`;
    if (e.ph === "b") {
      opened.set(key, e);
      latencyIds.add(key);
      continue;
    }
    const begin = opened.get(key);
    if (!begin) continue;
    opened.delete(key);
    const args = { ...begin.args, ...e.args };
    const type = String(args.event_latency?.event_type ?? args.data?.event_type ?? args.event_type ?? "?");
    (latency[type] ??= []).push((e.ts - begin.ts) / 1000);
  }
  const stageOpen = new Map<string, number>();
  const stages: Record<string, number[]> = {};
  for (const e of events) {
    if ((e.ph !== "b" && e.ph !== "e") || e.name === "EventLatency") continue;
    const id = `${e.pid}:${asyncId(e)}`;
    if (!latencyIds.has(id)) continue;
    const key = `${id}:${e.name}`;
    if (e.ph === "b") stageOpen.set(key, e.ts);
    else if (stageOpen.has(key)) {
      (stages[e.name!] ??= []).push((e.ts - stageOpen.get(key)!) / 1000);
      stageOpen.delete(key);
    }
  }

  const other: Record<string, number> = {};
  for (const [key, us] of busy) {
    if (key === mainKey) continue;
    const label = `${procs.get(Number(key.split(":")[0])) ?? "?"}/${threads.get(key) ?? "?"}`;
    other[label] = (other[label] ?? 0) + us / 1000 / windowS;
  }

  return {
    main: {
      busyMsPerS: round((busy.get(mainKey)! / 1000) / windowS, 1),
      tasks: tasks.length,
      taskMs: spread(tasks),
      tasksOver16ms: tasks.filter((t) => t > 16.7).length,
      tasksOver50ms: tasks.filter((t) => t > 50).length,
      events: Object.fromEntries(Object.entries(mainEvents).map(([k, v]) => [k, { count: v.count, ms: round(v.ms, 1) }])),
    },
    frames: {
      presented: swaps.length,
      presentedPerS: round(swaps.length / windowS, 1),
      gapMs: spread(swapGaps),
      gapsOver12_5: swapGaps.filter((g) => g > 12.5).length,
      gapsOver16_7: swapGaps.filter((g) => g > 16.7).length,
    },
    inputLatencyMs: Object.fromEntries(Object.entries(latency).map(([k, v]) => [k, spread(v)])),
    inputStagesMeanMs: Object.fromEntries(
      Object.entries(stages)
        .map(([k, v]) => [k, round(v.reduce((a, b) => a + b, 0) / v.length)] as const)
        .filter(([, mean]) => mean >= 0.1)
        .sort((a, b) => b[1] - a[1]),
    ),
    paintByNode: [...paint]
      .sort((a, b) => b[1].ms - a[1].ms)
      .slice(0, 6)
      .map(([nodeId, v]) => ({ nodeId, count: v.count, ms: round(v.ms, 1) })),
    otherThreadsMsPerS: Object.fromEntries(
      Object.entries(other).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => [k, round(v, 1)]),
    ),
  };
};

export const summarizeTrace = (path: string, windowS: number): TraceSummary => {
  const data = JSON.parse(readFileSync(path, "utf8")) as { traceEvents?: TraceEvent[] } | TraceEvent[];
  return summarizeTraceEvents(Array.isArray(data) ? data : (data.traceEvents ?? []), windowS);
};

if (import.meta.main) {
  const [path, seconds] = process.argv.slice(2);
  if (!path || !seconds) throw new Error("usage: bun scripts/perf-trace-summary.ts <trace.json> <window seconds>");
  console.log(JSON.stringify(summarizeTrace(path, Number(seconds)), null, 2));
}
