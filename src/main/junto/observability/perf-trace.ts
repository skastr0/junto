/**
 * A Chromium performance trace of the running app, packaged builds included,
 * with no debugging port: main records through Electron's `contentTracing`,
 * which covers every process (renderer, GPU, viz, utility processes and main)
 * and samples JavaScript in each isolate.
 *
 * WHY. The installed app is where the fans spin, and packaged builds refuse
 * any remote-debugging switch (scripts/packaged-runtime-smoke.ts). Without a
 * trace, a CPU sample names Chromium's frames but not our JavaScript; with
 * one, `bun scripts/perf-trace-summary.ts <trace> <seconds>` reads frames,
 * main-thread busy time and input latency, and the file opens in Perfetto
 * (ui.perfetto.dev) or chrome://tracing with JS stacks.
 *
 * TRIGGERS. The menu item (View, Record Performance Trace) and SIGUSR2 to the
 * main process, so an agent can capture without the operator:
 *   kill -USR2 <pid of /Applications/Junto.app/Contents/MacOS/Junto>
 * One capture at a time; a trigger while one runs is logged and ignored.
 * Builds before this module have no handler, and SIGUSR2's default action
 * quits them: scripts/perf-pass-scenario.sh signals only an app that has
 * written a [metrics] row in the last three minutes.
 *
 * WHERE. `<home>/.junto/traces/trace-<time>.json`, directory 0700, file 0600.
 * A trace holds function names, script URLs and timings, not terminal text or
 * page content, and never leaves the machine. The newest TRACE_KEEP are kept.
 */
import { chmodSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const TRACE_DIR = "traces";
export const TRACE_SECONDS = 30;
export const TRACE_KEEP = 10;

/**
 * Frames, compositing, GPU and input (the set e2e/scenarios/perf-terminal-baseline
 * records, which perf-trace-summary.ts reads), plus JavaScript sampling and
 * DevTools timeline events so stacks name our code.
 */
export const TRACE_CATEGORIES: ReadonlyArray<string> = [
  "toplevel",
  "blink",
  "blink.user_timing",
  "cc",
  "viz",
  "gpu",
  "input",
  "benchmark",
  "latencyInfo",
  "v8.execute",
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "disabled-by-default-devtools.timeline.stack",
  "disabled-by-default-v8.cpu_profiler",
];

export const traceDir = (juntoHome: string): string => join(juntoHome, TRACE_DIR);

/** `trace-2026-11-06T22-48-41Z.json`: sortable, and safe in every file system. */
export const traceFileName = (now: Date): string =>
  `trace-${now.toISOString().replace(/\.\d{3}Z$/u, "Z").replaceAll(":", "-")}.json`;

/** The traces to delete so only the newest `keep` remain. Names sort by time. */
export const tracesToPrune = (names: ReadonlyArray<string>, keep: number): ReadonlyArray<string> => {
  const traces = names.filter((name) => /^trace-.*\.json$/u.test(name)).sort();
  return traces.slice(0, Math.max(0, traces.length - keep));
};

export type PerfTraceTracing = {
  readonly startRecording: (options: { readonly included_categories: Array<string> }) => Promise<void>;
  readonly stopRecording: (resultFilePath: string) => Promise<string>;
};

export type PerfTraceDeps = {
  readonly juntoHome: string;
  readonly tracing: PerfTraceTracing;
  readonly write: (level: "info" | "warn", message: string) => void;
  readonly now?: () => Date;
  readonly wait?: (ms: number) => Promise<void>;
};

export type PerfTraceRecorder = {
  /** Record for `seconds` (default TRACE_SECONDS); resolves to the file, or undefined when one already runs or it failed. */
  readonly record: (reason: string, seconds?: number) => Promise<string | undefined>;
  readonly recording: () => boolean;
};

export const makePerfTraceRecorder = (deps: PerfTraceDeps): PerfTraceRecorder => {
  const now = deps.now ?? (() => new Date());
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let active = false;
  const record = async (reason: string, seconds = TRACE_SECONDS): Promise<string | undefined> => {
    if (active) {
      deps.write("info", `[trace] already recording; ignored the ${reason} request`);
      return undefined;
    }
    active = true;
    const dir = traceDir(deps.juntoHome);
    const path = join(dir, traceFileName(now()));
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      await deps.tracing.startRecording({ included_categories: [...TRACE_CATEGORIES] });
      deps.write("info", `[trace] recording ${String(seconds)} s, asked by ${reason}`);
      await wait(seconds * 1000);
      const written = await deps.tracing.stopRecording(path);
      chmodSync(written, 0o600);
      const mb = Math.round(statSync(written).size / 1024 / 102.4) / 10;
      deps.write("info", `[trace] wrote ${written} (${String(mb)} MB, ${String(seconds)} s); summarise with bun scripts/perf-trace-summary.ts ${written} ${String(seconds)}`);
      for (const old of tracesToPrune(readdirSync(dir), TRACE_KEEP)) rmSync(join(dir, old), { force: true });
      return written;
    } catch (cause) {
      deps.write("warn", `[trace] capture failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      return undefined;
    } finally {
      active = false;
    }
  };
  return { record, recording: () => active };
};
