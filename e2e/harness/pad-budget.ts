/**
 * What one input costs the app, engine by engine: the pad's budget harness.
 *
 * `measureInputs` runs a set of inputs under a CDP trace and reports, per
 * input: frame latency (input to the second frame after it), renderer main
 * thread time, React commits, paints and the area they cover, layers in the
 * tree, raster time, and GPU process time. `withLoad` holds the machine under
 * a fixed number of busy processes while a phase runs, so "under load" is the
 * same load on every build.
 *
 * Any pad engine can use it: the spec hands it the inputs, the harness owns
 * the measuring. React commits are counted through a devtools hook installed
 * before the renderer loads (`installCommitCounter`, then reload).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import type { CDPSession, Page } from "@playwright/test";

type TraceEvent = {
  readonly name: string;
  readonly ph: string;
  readonly ts: number;
  readonly dur?: number;
  readonly pid: number;
  readonly tid: number;
  readonly cat?: string;
  readonly args?: { readonly name?: string; readonly data?: { readonly clip?: ReadonlyArray<number> } };
};

/** Counts React commits: React reads this hook once, when its renderer loads. */
export const installCommitCounter = async (page: Page): Promise<void> => {
  await page.context().addInitScript(() => {
    const w = window as unknown as { __padCommits: number; __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown };
    w.__padCommits = 0;
    if (w.__REACT_DEVTOOLS_GLOBAL_HOOK__ !== undefined) return;
    let id = 0;
    w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      renderers: new Map(),
      inject: () => (id += 1),
      onCommitFiberRoot: () => {
        w.__padCommits += 1;
      },
      onCommitFiberUnmount: () => {},
      onPostCommitFiberRoot: () => {},
      checkDCE: () => {},
    };
  });
  // The app may take over a plain reload; ask the page itself, then wait for it.
  await page.evaluate(() => location.reload()).catch(() => undefined);
  await page.waitForLoadState("domcontentloaded");
};

const commitsOf = (page: Page) =>
  page.evaluate(() => (window as unknown as { __padCommits?: number }).__padCommits ?? -1);

/** Busy processes for the length of `run`; the load average is sampled at the end. */
export const withLoad = async <A>(busy: number, run: () => Promise<A>): Promise<{ readonly value: A; readonly load: number }> => {
  const workers: ChildProcess[] = [];
  for (let i = 0; i < busy; i += 1) {
    workers.push(spawn(process.execPath, ["-e", "for(;;){}"], { stdio: "ignore", env: { ELECTRON_RUN_AS_NODE: "1" } }));
  }
  try {
    // Load average is a one minute mean: give it time to climb before measuring.
    if (busy > 0) await new Promise((resolve) => setTimeout(resolve, 45_000));
    const value = await run();
    return { value, load: Math.round(loadavg()[0] ?? 0) };
  } finally {
    for (const worker of workers) worker.kill("SIGKILL");
  }
};

const CATEGORIES = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "toplevel",
  "cc",
  "gpu",
  "viz",
  "blink",
  "disabled-by-default-devtools.timeline.invalidationTracking",
].join(",");

const trace = async (cdp: CDPSession, run: () => Promise<void>): Promise<TraceEvent[]> => {
  const events: TraceEvent[] = [];
  const onData = (payload: { value: ReadonlyArray<object> }) => {
    events.push(...(payload.value as ReadonlyArray<TraceEvent>));
  };
  cdp.on("Tracing.dataCollected", onData);
  await cdp.send("Tracing.start", { categories: CATEGORIES, transferMode: "ReportEvents" });
  await run();
  const done = new Promise<void>((resolve) => cdp.once("Tracing.tracingComplete", () => resolve()));
  await cdp.send("Tracing.end");
  await done;
  cdp.off("Tracing.dataCollected", onData);
  return events;
};

const quadArea = (clip: ReadonlyArray<number> | undefined): number => {
  if (!clip || clip.length < 8) return 0;
  const xs = [clip[0]!, clip[2]!, clip[4]!, clip[6]!];
  const ys = [clip[1]!, clip[3]!, clip[5]!, clip[7]!];
  return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
};

/** Sums one input's trace into the budget's columns, all times in ms. */
const summarize = (events: ReadonlyArray<TraceEvent>, viewportArea: number) => {
  const threadName = new Map<string, string>();
  const processName = new Map<number, string>();
  for (const event of events) {
    if (event.ph !== "M") continue;
    if (event.name === "thread_name") threadName.set(`${event.pid}:${event.tid}`, event.args?.name ?? "");
    if (event.name === "process_name") processName.set(event.pid, event.args?.name ?? "");
  }
  const rendererMain = new Set(
    [...threadName].filter(([, name]) => name === "CrRendererMain").map(([key]) => key),
  );
  const gpuPids = new Set([...processName].filter(([, name]) => /gpu/i.test(name)).map(([pid]) => pid));
  let main = 0;
  let paints = 0;
  let paintArea = 0;
  let raster = 0;
  let gpu = 0;
  let layerize = 0;
  let style = 0;
  for (const event of events) {
    const dur = (event.dur ?? 0) / 1000;
    const key = `${event.pid}:${event.tid}`;
    if (event.ph === "X" && event.name === "RunTask" && rendererMain.has(key)) main += dur;
    if (event.name === "Paint" && event.ph !== "E") {
      paints += 1;
      // A layer's clip can be unbounded; no paint covers more than the window.
      paintArea += Math.min(quadArea(event.args?.data?.clip), viewportArea);
    }
    if (event.ph === "X" && event.name === "RasterTask") raster += dur;
    if (event.ph === "X" && (event.name === "Layerize" || event.name === "UpdateLayerTree")) layerize += dur;
    if (event.ph === "X" && event.name === "UpdateLayoutTree" && rendererMain.has(key)) style += dur;
    // RunTask is the outermost slice of a task; the slices inside it would count twice.
    if (event.ph === "X" && gpuPids.has(event.pid) && event.name === "RunTask") {
      gpu += dur;
    }
  }
  return {
    mainMs: Math.round(main * 10) / 10,
    styleMs: Math.round(style * 10) / 10,
    layerizeMs: Math.round(layerize * 10) / 10,
    paints,
    paintAreaKpx: Math.round(paintArea / 1000),
    rasterMs: Math.round(raster * 10) / 10,
    gpuMs: Math.round(gpu * 10) / 10,
  };
};

const layerCount = (cdp: CDPSession): Promise<number> =>
  new Promise((resolve) => {
    let latest = -1;
    const onTree = (payload: { layers?: ReadonlyArray<object> }) => {
      if (payload.layers) latest = payload.layers.length;
    };
    cdp.on("LayerTree.layerTreeDidChange", onTree);
    void cdp.send("LayerTree.enable").then(() =>
      setTimeout(() => {
        cdp.off("LayerTree.layerTreeDidChange", onTree);
        void cdp.send("LayerTree.disable").then(() => resolve(latest));
      }, 400),
    );
  });

const nextFrames = (page: Page) =>
  page.evaluate(
    () => new Promise<number>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now())))),
  );

export type InputBudget = {
  readonly frameMs: number;
  readonly commits: number;
  readonly mainMs: number;
  readonly styleMs: number;
  readonly layerizeMs: number;
  readonly paints: number;
  readonly paintAreaKpx: number;
  readonly rasterMs: number;
  readonly gpuMs: number;
};

/** One input, traced: what it costs from the press to the second frame after it. */
export const measureInput = async (
  page: Page,
  cdp: CDPSession,
  input: () => Promise<void>,
  /** Writes this input's raw trace here, to open in the Performance panel. */
  savePath?: string,
): Promise<InputBudget> => {
  let frameMs = 0;
  let commits = 0;
  const events = await trace(cdp, async () => {
    const c0 = await commitsOf(page);
    const t0 = await page.evaluate(() => performance.now());
    await input();
    frameMs = (await nextFrames(page)) - t0;
    commits = (await commitsOf(page)) - c0;
  });
  if (savePath) writeFileSync(savePath, JSON.stringify({ traceEvents: events }));
  const viewportArea = await page.evaluate(() => innerWidth * innerHeight * devicePixelRatio ** 2);
  return { frameMs: Math.round(frameMs), commits, ...summarize(events, viewportArea) };
};

const median = (values: ReadonlyArray<number>) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

/** The median of each column over repeated inputs, plus the worst frame. */
export const budgetOf = (runs: ReadonlyArray<InputBudget>) => {
  const keys = Object.keys(runs[0] ?? {}) as Array<keyof InputBudget>;
  const out: Record<string, number> = { n: runs.length };
  for (const key of keys) out[key] = median(runs.map((run) => run[key]));
  out.worstFrameMs = Math.max(0, ...runs.map((run) => run.frameMs));
  return out;
};

export const layersNow = layerCount;
