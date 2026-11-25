/**
 * Scratch analysis (untracked): style recalculation around an overlay on a big
 * board, from the app's own Chrome trace.
 *
 * usage: bun scripts/zz-style-recalc.ts <trace.json>
 *
 * Prints every style recalculation the renderer's main thread ran, with the
 * element count Chromium reports, the totals, and the two clusters (open and
 * close) the spec produces, each its own sum and worst.
 */
import { readFileSync } from "node:fs";

type TraceEvent = {
  readonly ph?: string;
  readonly name?: string;
  readonly cat?: string;
  readonly pid?: number;
  readonly tid?: number;
  readonly ts: number;
  readonly dur?: number;
  readonly args?: { readonly elementCount?: number; readonly beginData?: { readonly elementCount?: number } };
};

const STYLE_EVENTS = new Set(["UpdateLayoutTree", "RecalculateStyles"]);

const path = process.argv[2];
if (path === undefined) throw new Error("usage: bun scripts/zz-style-recalc.ts <trace.json>");
const data = JSON.parse(readFileSync(path, "utf8")) as { traceEvents?: TraceEvent[] } | TraceEvent[];
const events = Array.isArray(data) ? data : (data.traceEvents ?? []);

// The renderer main thread: the one whose top-level tasks hold the most time.
const threads = new Map<string, string>();
const procs = new Map<number, string>();
for (const event of events) {
  if (event.ph !== "M") continue;
  if (event.name === "thread_name") threads.set(`${String(event.pid)}:${String(event.tid)}`, String(event.args));
  if (event.name === "process_name") procs.set(event.pid ?? 0, String(event.args));
}
const busy = new Map<string, number>();
for (const event of events) {
  if (event.ph !== "X" || event.dur === undefined) continue;
  if (event.name !== "RunTask" && event.name !== "ThreadControllerImpl::RunTask") continue;
  const key = `${String(event.pid)}:${String(event.tid)}`;
  busy.set(key, (busy.get(key) ?? 0) + event.dur);
}
const [mainKey] = [...busy.entries()].filter(([key]) => key.includes(":")).sort((a, b) => b[1] - a[1])[0] ?? [""];
const [mainPid, mainTid] = mainKey.split(":");
const mainTidKey = `${mainPid}:${mainTid}`;
const mainThreadName = threads.get(mainTidKey) ?? "?";
const mainProcessName = procs.get(Number(mainPid)) ?? "?";

const rows = events
  .filter(
    (event) =>
      event.ph === "X" &&
      event.name !== undefined &&
      STYLE_EVENTS.has(event.name) &&
      String(event.pid) === mainPid &&
      String(event.tid) === mainTid &&
      event.dur !== undefined,
  )
  .map((event) => ({
    ts: event.ts,
    ms: (event.dur ?? 0) / 1000,
    elements: event.args?.elementCount ?? event.args?.beginData?.elementCount ?? 0,
  }))
  .sort((a, b) => a.ts - b.ts);

const total = rows.reduce((sum, row) => sum + row.ms, 0);
const rounded = (value: number): string => value.toFixed(2);
console.log(
  `trace ${path}: main thread ${mainThreadName} of ${mainProcessName}, ${String(rows.length)} style recalculations, ${rounded(total)} ms total`,
);

const biggest = [...rows].sort((a, b) => b.ms - a.ms).slice(0, 12);
for (const row of biggest) {
  console.log(`  ${rounded(row.ms).padStart(8)} ms  ${String(row.elements).padStart(7)} elements  at ${(row.ts / 1000).toFixed(0)} ms`);
}

// The spec opens the overlay about 1.5 s after the trace starts and closes it
// about 4.5 s in: two clusters, and each one's sum is what an operator pays.
const cluster = (from: number, to: number) => {
  const start = rows.length > 0 ? rows[0].ts : 0;
  const picked = rows.filter((row) => (row.ts - start) / 1e6 >= from && (row.ts - start) / 1e6 <= to);
  const sum = picked.reduce((totalMs, row) => totalMs + row.ms, 0);
  const worst = picked.reduce((max, row) => Math.max(max, row.ms), 0);
  const elements = picked.reduce((max, row) => Math.max(max, row.elements), 0);
  return { count: picked.length, sum, worst, elements };
};
const open = cluster(1.0, 3.0);
const close = cluster(3.0, 6.0);
for (const [label, value] of [["open", open], ["close", close]] as const) {
  console.log(
    `${label}: ${String(value.count)} recalcs, ${rounded(value.sum)} ms total, worst ${rounded(value.worst)} ms, ${String(value.elements)} elements at most`,
  );
}
