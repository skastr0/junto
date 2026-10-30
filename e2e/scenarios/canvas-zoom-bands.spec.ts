/**
 * Zoom-band rig: frame times and root style writes per zoom band on the
 * operator's board shape, and the cost of a Shift press on the stopped board.
 * It measures; it asserts only that the camera landed in the band it asked
 * for. Named by hand, never part of a suite run.
 *
 * Three bands, each one zoom burst from the band's low end to its high end:
 *   A 1.2  to 2.49   near tier at high zoom, every scale already at its floor
 *   B 0.69 to 1.0    near tier, the inverse-zoom instruments change
 *   C 0.23 to 0.48   the region glance band and the mid to far step
 *
 * Then a Shift press on the stopped board: frames, layout, style and main
 * task time per press, against a quiet window of the same length.
 *
 * Run (after a build, with the board layout fixture present):
 *   ZOOM_BANDS=1 ZOOM_LABEL=before ZOOM_REPS=3 scripts/run-e2e.sh e2e/scenarios/canvas-zoom-bands.spec.ts
 * It writes .amp/in/artifacts/zoom-bands/<label>.json and <label>-far.png,
 * <label>-overview.png.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";
import type { Node as ModelNode, Wire as ModelWire } from "../../src/shared/model";
import { crewPlayFactory } from "../harness/crew-fixture";
import { launchJunto, test } from "../harness/launch";
import { modelFixture, modelNote, modelRegion, modelSeat, modelWire } from "../harness/model";

const ARMED = process.env.ZOOM_BANDS === "1";
const CANVAS = "zoom-bands";
const LABEL = process.env.ZOOM_LABEL ?? "run";
const OUT_DIR = join(process.cwd(), ".amp/in/artifacts/zoom-bands");
const BANDS = [
  { id: "A", lo: 1.2, hi: 2.49 },
  { id: "B", lo: 0.69, hi: 1.0 },
  { id: "C", lo: 0.23, hi: 0.48 },
] as const;
const REPS = Number(process.env.ZOOM_REPS ?? "3");
const EVENTS = 48;
const GAP_MS = 8;
const BUDGET_MS = 8.3;

const boardNodes: ModelNode[] = [];
type LaidOut = { kind: string; x: number; y: number; w: number; h: number; hold?: boolean };
const layout = JSON.parse(readFileSync(join(process.cwd(), "e2e/fixtures/perf-board-layout.json"), "utf8")) as {
  nodes: LaidOut[];
  wires: Array<[number, number]>;
};
layout.nodes.forEach((item, i) => {
  const id = `ly-${item.kind}-${String(i).padStart(3, "0")}`;
  if (item.kind === "agent") {
    boardNodes.push({ ...modelSeat({ id, key: `local:${id}`, label: id, x: item.x, y: item.y }), width: item.w, height: item.h } as ModelNode);
  } else if (item.kind === "region") {
    boardNodes.push(modelRegion({ id, label: `region ${String(i)}`, x: item.x, y: item.y, width: item.w, height: item.h, hold: item.hold === true }));
  } else {
    boardNodes.push({ ...modelNote(id, `note ${String(i)}`, item.x, item.y), width: item.w, height: item.h } as ModelNode);
  }
});
const pairs = new Set<string>();
const boardWires: ModelWire[] = layout.wires.flatMap(([from, to], i) => {
  const a = boardNodes[from]!;
  const b = boardNodes[to]!;
  const pair = `${a.id}>${b.id}`;
  if (a.id === b.id || a.kind !== "agent" || b.kind !== "agent" || pairs.has(pair)) return [];
  pairs.add(pair);
  return [modelWire(`ly-wire-${String(i).padStart(3, "0")}`, a.id, b.id, "messages", boardNodes)];
});
const fixture = modelFixture(boardNodes, boardWires);

type Frame = { t: number; zoom: number; tier: string | null };
type StyleWrite = { props: string[]; at: number };

const median = (values: readonly number[]): number => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};
const pct = (values: readonly number[], share: number): number => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? Number.NaN;
};
const round = (value: number, places = 2): number => {
  if (!Number.isFinite(value)) return Number.NaN;
  return Math.round(value * 10 ** places) / 10 ** places;
};
const share = (values: readonly number[], test: (value: number) => boolean): number =>
  round((100 * values.filter(test).length) / Math.max(1, values.length), 1);

const readZoom = async (page: import("@playwright/test").Page): Promise<number> =>
  page.evaluate(() => new DOMMatrixReadOnly(getComputedStyle(document.querySelector(".react-flow__viewport")!).transform).a);

const settle = async (page: import("@playwright/test").Page): Promise<void> => {
  await page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        let last = getComputedStyle(document.querySelector(".react-flow__viewport")!).transform;
        let still = 0;
        const tick = (): void => {
          const now = getComputedStyle(document.querySelector(".react-flow__viewport")!).transform;
          still = now === last ? still + 1 : 0;
          last = now;
          if (still >= 24) resolve(true);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
  await page.waitForTimeout(260);
};

/** Wheel the camera to `goal`, then let it rest. */
const place = async (page: import("@playwright/test").Page, goal: number): Promise<number> => {
  const reached = await page.evaluate(
    async (target: number) => {
      const pane = document.querySelector(".react-flow__pane")!;
      const viewport = document.querySelector(".react-flow__viewport")!;
      const zoom = (): number => new DOMMatrixReadOnly(getComputedStyle(viewport).transform).a;
      for (let i = 0; i < 400; i += 1) {
        const z = zoom();
        if (Math.abs(z / target - 1) < 0.02) return z;
        pane.dispatchEvent(
          new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            deltaY: z < target ? -20 : 20,
            deltaMode: 0,
            clientX: 720,
            clientY: 450,
            metaKey: true,
          }),
        );
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      }
      return zoom();
    },
    goal,
  );
  await settle(page);
  return reached;
};

/** One zoom burst through a band, recording frames and the root's style writes. */
const sweep = (page: import("@playwright/test").Page, per: number) =>
  page.evaluate(
    async (input: { readonly per: number; readonly events: number; readonly gapMs: number }) => {
      const pane = document.querySelector(".react-flow__pane")!;
      const viewport = document.querySelector(".react-flow__viewport")!;
      const zoom = (): number => new DOMMatrixReadOnly(getComputedStyle(viewport).transform).a;
      const tier = (): string | null => document.documentElement.getAttribute("data-canvas-tier");
      const frames: Array<{ t: number; zoom: number; tier: string | null }> = [];
      const styles: Array<{ props: string[]; at: number }> = [];
      const longs: number[] = [];
      const writesByName: Record<string, number> = {};
      let stop = false;
      const parse = (css: string): Map<string, string> => {
        const out = new Map<string, string>();
        for (const decl of css.split(";")) {
          const at = decl.indexOf(":");
          if (at > 0) out.set(decl.slice(0, at).trim(), decl.slice(at + 1).trim());
        }
        return out;
      };
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          const before = parse(record.oldValue ?? "");
          const after = parse((record.target as Element).getAttribute("style") ?? "");
          const changed: string[] = [];
          for (const [key, value] of after) if (before.get(key) !== value) changed.push(`${key}=${value}`);
          if (changed.length === 0) continue;
          for (const name of changed) writesByName[name.slice(0, name.indexOf("="))] = (writesByName[name.slice(0, name.indexOf("="))] ?? 0) + 1;
          styles.push({ props: changed, at: performance.now() });
        }
      });
      observer.observe(document.querySelector(".react-flow")!, { attributes: true, attributeFilter: ["style"], attributeOldValue: true });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longs.push(entry.duration);
      }).observe({ type: "longtask", buffered: false });
      const tick = (t: number): void => {
        frames.push({ t, zoom: zoom(), tier: tier() });
        if (!stop) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
      await sleep(60);
      const startAt = performance.now();
      for (let i = 0; i < input.events; i += 1) {
        pane.dispatchEvent(
          new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            deltaY: -input.per,
            deltaMode: 0,
            clientX: 720,
            clientY: 450,
            metaKey: true,
          }),
        );
        await sleep(input.gapMs);
      }
      const burstEnd = performance.now();
      await sleep(500);
      stop = true;
      observer.disconnect();
      await new Promise((done) => requestAnimationFrame(done));
      return { frames, styles, longs, startAt, burstEnd, endAt: performance.now(), writesByName };
    },
    { per, events: EVENTS, gapMs: GAP_MS },
  );

test.skip(!ARMED, "run with ZOOM_BANDS=1");

test("zoom bands: frame times per band", async () => {
  test.setTimeout(20 * 60_000);
  const junto = await launchJunto({
    seedModels: { [CANVAS]: fixture },
    windowContentSize: { width: 1440, height: 900 },
  });
  try {
    const { page } = junto;
    // The window is still navigating when the fixture hands it over: let the
    // board mount before the reload that arms the perf flag.
    await page.waitForSelector(".react-flow", { timeout: 60_000 });
    await page.waitForFunction(() => Boolean(window.junto?.modelCanvases), undefined, { timeout: 60_000 });
    await page.waitForFunction(() => document.querySelectorAll(".react-flow__node").length >= 300, undefined, { timeout: 120_000 });
    await page.addInitScript(() => {
      (globalThis as Record<string, unknown>).JUNTO_PERF = true;
      (globalThis as Record<string, unknown>).JUNTO_PERF_FRAMES = true;
    });
    await page.reload();
    await page.waitForSelector(".react-flow", { timeout: 60_000 });
    try {
      await page.waitForFunction(() => document.querySelectorAll(".react-flow__node").length >= 300, undefined, { timeout: 120_000 });
    } catch (error) {
      const seen = await page.evaluate(() => ({
        url: location.href,
        nodes: document.querySelectorAll(".react-flow__node").length,
        body: (document.body.innerText ?? "").slice(0, 300),
      }));
      console.log(`[zoom-band] DIAG ${JSON.stringify(seen)}`);
      throw error;
    }
    await page.evaluate(() => {
      [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "skip the tour")?.click();
    });
    await page.locator(".react-flow__pane").first().click({ position: { x: 6, y: 6 } }).catch(() => undefined);
    await crewPlayFactory(page);

    // Hold Cmd for the whole run: it turns the wheel into zoom (panOnScroll).
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta", code: "MetaLeft", bubbles: true, metaKey: true }));
    });
    await page.waitForTimeout(400);

    const runs: Array<Record<string, unknown>> = [];
    for (const band of BANDS) {
      for (let rep = 0; rep < REPS; rep += 1) {
        const from = await place(page, band.lo);
        const placed = await readZoom(page);
        if (!(Math.abs(placed / band.lo - 1) <= 0.03)) throw new Error(`band ${band.id}: placed at ${placed}, wanted ${band.lo}`);
        const tierAtStart = await page.evaluate(() => document.documentElement.getAttribute("data-canvas-tier"));
        const per = Math.round(Math.log(band.hi / band.lo) / Math.LN2 / 0.002 / EVENTS);
        const data = await sweep(page, per);
        const gaps: number[] = [];
        const zoomGaps: number[] = [];
        let framesWritten = 0;
        for (let i = 1; i < data.frames.length; i += 1) {
          const frame = data.frames[i]!;
          const previousFrame = data.frames[i - 1]!;
          if (previousFrame.t < data.startAt || frame.t > data.endAt) continue;
          const gap = frame.t - previousFrame.t;
          if (!Number.isFinite(gap) || gap <= 0) continue;
          gaps.push(gap);
          if (frame.zoom === previousFrame.zoom) continue;
          // A zoom frame: the camera moved between these two paints. This is
          // the population the five writes landed on.
          zoomGaps.push(gap);
          if (data.styles.some((write) => write.at > previousFrame.t && write.at <= frame.t)) framesWritten += 1;
        }
        runs.push({
          band: band.id,
          rep,
          from: round(from, 3),
          placed: round(placed, 3),
          ended: round(data.frames.at(-1)?.zoom ?? Number.NaN, 3),
          tierAtStart,
          tierAtEnd: data.frames.at(-1)?.tier ?? null,
          frames: gaps.length,
          zoomFrames: zoomGaps.length,
          zoomMedian: round(median(zoomGaps)),
          zoomP90: round(pct(zoomGaps, 0.9)),
          zoomMax: round(Math.max(...zoomGaps)),
          zoomOverBudgetPct: share(zoomGaps, (gap) => gap > BUDGET_MS),
          median: round(median(gaps)),
          framesWrittenPct: round((100 * framesWritten) / Math.max(1, zoomGaps.length), 1),
          styleRecords: data.styles.length,
          styleWrites: data.styles.reduce((sum, record) => sum + record.props.length, 0),
          styleProps: data.writesByName,
          longTasks: data.longs.length,
          burstMs: round(data.burstEnd - data.startAt),
        });
        console.log(`[zoom-band] ${JSON.stringify(runs.at(-1))}`);
      }
    }

    // What the camera resting leaves on screen: the published scales are the
    // ones this zoom asks for, and a seat ring draws at its screen size.
    const restShots: Array<Record<string, unknown>> = [];
    for (const [tier, zoom] of [["far", 0.26], ["overview", 0.19]] as const) {
      await place(page, zoom);
      const atRest = await page.evaluate(() => {
        const root = document.querySelector(".react-flow") as HTMLElement;
        const seat = document.querySelector('.react-flow__node .junto-mark[data-mark-size="seat"]') as HTMLElement | null;
        const box = seat?.getBoundingClientRect();
        return {
          tier: document.documentElement.getAttribute("data-canvas-tier"),
          zoom: new DOMMatrixReadOnly(getComputedStyle(document.querySelector(".react-flow__viewport")!).transform).a,
          farScale: root.style.getPropertyValue("--far-seat-scale"),
          floorScale: root.style.getPropertyValue("--seat-floor-scale"),
          nodeScale: root.style.getPropertyValue("--node-s"),
          ringPx: box === undefined ? null : Math.round(box.width * 10) / 10,
        };
      });
      await page.screenshot({ path: join(OUT_DIR, `${LABEL}-${tier}.png`) });
      restShots.push(atRest);
    }
    console.log(`[zoom-band] REST ${JSON.stringify(restShots)}`);

    // A Shift press on the stopped board: xyflow's selection key used to flip
    // FlowRenderer on every press and re-register its wheel listener, which
    // repaints the board. A quiet window of the same length is the control.
    await place(page, 1);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const metrics = async (): Promise<Record<string, number>> => {
      const reply = (await cdp.send("Performance.getMetrics")) as { metrics: Array<{ name: string; value: number }> };
      return Object.fromEntries(reply.metrics.map((entry) => [entry.name, entry.value]));
    };
    const recordFrames = () =>
      page.evaluate(() => {
        const run: { frames: number[]; stop: boolean } = { frames: [], stop: false };
        (window as unknown as { __shiftRun?: typeof run }).__shiftRun = run;
        let last = performance.now();
        const tick = (t: number): void => {
          run.frames.push(t - last);
          last = t;
          if (!run.stop) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    const takeFrames = (): Promise<number[]> =>
      page.evaluate(() => {
        const run = (window as unknown as { __shiftRun: { frames: number[]; stop: boolean } }).__shiftRun;
        run.stop = true;
        return run.frames.slice(1);
      });
    const quietBefore = await metrics();
    await recordFrames();
    await page.waitForTimeout(2_400);
    const quietFrames = await takeFrames();
    const quietAfter = await metrics();
    const pressedBefore = await metrics();
    await recordFrames();
    for (let i = 0; i < 20; i += 1) {
      await page.keyboard.press("Shift");
      await page.waitForTimeout(120);
    }
    const shiftFrames = await takeFrames();
    const pressedAfter = await metrics();
    const delta = (from: Record<string, number>, to: Record<string, number>, name: string): number =>
      round((to[name] ?? 0) - (from[name] ?? 0), 3);
    const stats = (from: Record<string, number>, to: Record<string, number>, frames: number[]) => ({
      frames: frames.length,
      fps: round((frames.length * 1000) / Math.max(1, frames.reduce((sum, gap) => sum + gap, 0)), 1),
      median: round(median(frames)),
      p90: round(pct(frames, 0.9)),
      max: round(Math.max(...frames)),
      overBudgetPct: share(frames, (gap) => gap > BUDGET_MS),
      layoutCount: delta(from, to, "LayoutCount"),
      recalcStyleCount: delta(from, to, "RecalcStyleCount"),
      taskMs: round(delta(from, to, "TaskDuration") * 1000, 1),
      layoutMs: round(delta(from, to, "LayoutDuration") * 1000, 1),
      recalcStyleMs: round(delta(from, to, "RecalcStyleDuration") * 1000, 1),
    });
    const quiet = stats(quietBefore, quietAfter, quietFrames);
    const pressed = stats(pressedBefore, pressedAfter, shiftFrames);
    const shift = {
      presses: 20,
      quiet,
      pressed,
      pressTaskMs: round((pressed.taskMs - quiet.taskMs) / 20, 2),
      pressTaskMsPerSecond: round(((pressed.taskMs - quiet.taskMs) * 1000) / 2400, 1),
      pressRecalcStyles: round((pressed.recalcStyleCount - quiet.recalcStyleCount) / 20, 2),
      pressLayouts: round((pressed.layoutCount - quiet.layoutCount) / 20, 2),
    };
    console.log(`[zoom-band] SHIFT ${JSON.stringify(shift)}`);
    await cdp.detach();

    const summary = BANDS.map((band) => {
      const rows = runs.filter((row) => row.band === band.id);
      const pick = (key: string): number => median(rows.map((row) => Number(row[key])));
      return {
        band: band.id,
        lo: band.lo,
        hi: band.hi,
        zoomFrames: pick("zoomFrames"),
        zoomMedian: pick("zoomMedian"),
        zoomP90: pick("zoomP90"),
        zoomOverBudgetPct: pick("zoomOverBudgetPct"),
        framesWrittenPct: pick("framesWrittenPct"),
        styleWrites: pick("styleWrites"),
        styleRecords: pick("styleRecords"),
        longTasks: pick("longTasks"),
      };
    });
    const report = { label: LABEL, load1: loadavg()[0]!, ranAt: new Date().toISOString(), summary, restShots, shift, runs };
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, `${LABEL}.json`), JSON.stringify(report, null, 2));
    console.log(`[zoom-band] SUMMARY ${JSON.stringify({ label: LABEL, load1: report.load1, summary }, null, 2)}`);
  } finally {
    await junto.close();
  }
});
