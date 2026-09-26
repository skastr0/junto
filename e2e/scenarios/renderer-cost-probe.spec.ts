/**
 * Renderer/GPU cost probe — a repeatable measurement, not a pass/fail gate.
 *
 * Boots the app onto a seeded canvas of agent seats, then samples for
 * ~15 seconds and prints one compact JSON line:
 *
 *   - per-process CPU%% over the window (Electron app.getAppMetrics():
 *     Browser = main, GPU, Tab = renderer, Utility)
 *   - frames/sec from an injected rAF counter
 *   - long tasks (PerformanceObserver 'longtask'): count + total blocking ms
 *   - CDP Performance.getMetrics deltas: LayoutCount, RecalcStyleCount,
 *     ScriptDuration, TaskDuration
 *
 * A/B toggle (the attribution lever): JUNTO_PROBE_MOTION=paused sets
 * document.documentElement.dataset.surfaceMotion = "paused" before sampling —
 * the product's own surface-motion gate attribute (src/renderer/lib/
 * surface-motion.ts), which stops every infinite CSS animation via
 * html[data-surface-motion="paused"] rules in styles.css. Run once live, once
 * paused, diff the JSON. Note: only the CSS side of the gate flips; components
 * gating on surfaceMotionLive$ (e.g. ActivityMark WebGL cells) stay mounted,
 * so the delta isolates pure CSS/compositor animation cost.
 *
 * The window must actually paint for FPS/GPU numbers to mean anything —
 * run with a visible window:
 *
 *   JUNTO_FEATURE_PROFILE=all-on bunx electron-vite build
 *   JUNTO_E2E_SHOW=1 bun run test:e2e:fast e2e/scenarios/renderer-cost-probe.spec.ts
 *   JUNTO_E2E_SHOW=1 JUNTO_PROBE_MOTION=paused bun run test:e2e:fast e2e/scenarios/renderer-cost-probe.spec.ts
 *
 * Optional: JUNTO_PROBE_SAMPLE_MS overrides the 15s window.
 * Result line is grep-able: RENDERER-COST-PROBE-RESULT {json}.
 */
import type { TextNode } from "../../src/shared/canvas";
import { agentTextNode, canvasDoc, tasksNode } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const SAMPLE_MS = Number(process.env.JUNTO_PROBE_SAMPLE_MS ?? 15_000);
const MOTION: "live" | "paused" =
  process.env.JUNTO_PROBE_MOTION === "paused" ? "paused" : "live";

const seat = (i: number): TextNode =>
  agentTextNode({
    id: `seat${i}`,
    key: `local:worker${i}`,
    label: `worker ${i}`,
    x: 60 + (i % 3) * 300,
    y: 60 + Math.floor(i / 3) * 180,
  });

/** Six agent seats + a tasks sink. */
const fixtureDoc = canvasDoc([
  tasksNode({ id: "tasks", x: 60, y: 460 }),
  ...Array.from({ length: 6 }, (_, i) => seat(i)),
]);

/** Authority-only boot: disk seed is not live. Install via writeCanvas
 * (pattern from pause-surface.spec.ts / work-plane.spec.ts). */
const installBoard = async (page: import("@playwright/test").Page): Promise<string> => {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const runtime = globalThis as unknown as {
            readonly junto?: { readonly listCanvases: () => Promise<unknown[]> };
          };
          return Boolean(runtime.junto?.listCanvases);
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
  return page.evaluate(async (document) => {
    const api = (
      globalThis as unknown as {
        readonly junto: {
          readonly listCanvases: () => Promise<ReadonlyArray<{ name: string }>>;
          readonly createCanvas: (name: string) => Promise<{ name: string; revision: string }>;
          readonly readCanvas: (name: string) => Promise<{ name: string; revision: string }>;
          readonly writeCanvas: (
            name: string,
            doc: unknown,
            expectedRevision?: string,
          ) => Promise<unknown>;
        };
      }
    ).junto;
    let list = await api.listCanvases();
    let name = list[0]?.name;
    if (!name) {
      const created = await api.createCanvas("cost-probe");
      name = created.name;
    }
    const read = await api.readCanvas(name);
    await api.writeCanvas(name, document, read.revision);
    return name;
  }, fixtureDoc);
};

interface PageProbeResult {
  readonly frames: number;
  readonly elapsedMs: number;
  readonly longTaskCount: number;
  readonly longTaskTotalMs: number;
  readonly visibilityState: string;
  readonly surfaceMotion: string | undefined;
}

interface AppMetric {
  readonly pid: number;
  readonly type: string;
  readonly name?: string;
  readonly cpu: { readonly percentCPUUsage: number };
}

const cdpMetric = (
  metrics: ReadonlyArray<{ readonly name: string; readonly value: number }>,
  name: string,
): number => metrics.find((m) => m.name === name)?.value ?? 0;

test("renderer cost probe: sample per-process CPU, FPS, long tasks, layout churn", async ({
  junto,
}) => {
  test.setTimeout(SAMPLE_MS + 120_000);
  const { app, page } = junto;

  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await installBoard(page);
  await expect(page.getByTestId("rf__node-seat0")).toBeVisible({ timeout: 30_000 });

  // Let the board settle (mount costs, initial layout) before sampling.
  await page.waitForTimeout(2_000);

  // A/B lever: flip the product's own surface-motion attribute. No product
  // code is modified; the gate only recomputes on visibilitychange /
  // reduced-motion events, so a manual stamp holds for the sample window.
  if (MOTION === "paused") {
    await page.evaluate(() => {
      document.documentElement.dataset.surfaceMotion = "paused";
    });
  }

  const cdp = await app.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const before = (await cdp.send("Performance.getMetrics")) as {
    metrics: ReadonlyArray<{ name: string; value: number }>;
  };

  // Prime per-process CPU counters: percentCPUUsage is measured since the
  // previous getAppMetrics call, so the first read is discarded.
  await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics());

  const probe = (await page.evaluate(
    (sampleMs) =>
      new Promise<{
        frames: number;
        elapsedMs: number;
        longTaskCount: number;
        longTaskTotalMs: number;
        visibilityState: string;
        surfaceMotion: string | undefined;
      }>((resolve) => {
        let frames = 0;
        let longTaskCount = 0;
        let longTaskTotalMs = 0;
        let running = true;

        let observer: PerformanceObserver | undefined;
        try {
          observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              longTaskCount += 1;
              longTaskTotalMs += entry.duration;
            }
          });
          observer.observe({ type: "longtask", buffered: false });
        } catch {
          // longtask unsupported — counts stay 0 and the report shows it.
        }

        const t0 = performance.now();
        const tick = (): void => {
          if (!running) return;
          frames += 1;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);

        setTimeout(() => {
          running = false;
          observer?.disconnect();
          resolve({
            frames,
            elapsedMs: performance.now() - t0,
            longTaskCount,
            longTaskTotalMs: Math.round(longTaskTotalMs),
            visibilityState: document.visibilityState,
            surfaceMotion: document.documentElement.dataset.surfaceMotion,
          });
        }, sampleMs);
      }),
    SAMPLE_MS,
  )) as PageProbeResult;

  const metricsAfter = (await app.evaluate(({ app: electronApp }) =>
    electronApp.getAppMetrics().map((m) => ({
      pid: m.pid,
      type: m.type,
      name: (m as { name?: string }).name,
      cpu: { percentCPUUsage: m.cpu.percentCPUUsage },
    })),
  )) as ReadonlyArray<AppMetric>;

  const after = (await cdp.send("Performance.getMetrics")) as {
    metrics: ReadonlyArray<{ name: string; value: number }>;
  };
  await cdp.detach().catch(() => undefined);

  const cpuByType = (type: string): number =>
    Math.round(
      metricsAfter
        .filter((m) => m.type === type)
        .reduce((sum, m) => sum + m.cpu.percentCPUUsage, 0) * 10,
    ) / 10;

  const delta = (name: string): number =>
    cdpMetric(after.metrics, name) - cdpMetric(before.metrics, name);

  const report = {
    mode: MOTION,
    sampleMs: Math.round(probe.elapsedMs),
    visibilityState: probe.visibilityState,
    surfaceMotion: probe.surfaceMotion ?? null,
    fps: Math.round((probe.frames / probe.elapsedMs) * 10_000) / 10,
    longTasks: { count: probe.longTaskCount, totalBlockingMs: probe.longTaskTotalMs },
    cpuPercent: {
      main: cpuByType("Browser"),
      gpu: cpuByType("GPU"),
      renderer: cpuByType("Tab"),
      utility: cpuByType("Utility"),
    },
    processes: metricsAfter.map((m) => ({
      pid: m.pid,
      type: m.type,
      ...(m.name !== undefined && m.name !== "" ? { name: m.name } : {}),
      cpuPercent: Math.round(m.cpu.percentCPUUsage * 10) / 10,
    })),
    cdpDeltas: {
      layoutCount: delta("LayoutCount"),
      recalcStyleCount: delta("RecalcStyleCount"),
      scriptDurationS: Math.round(delta("ScriptDuration") * 1000) / 1000,
      taskDurationS: Math.round(delta("TaskDuration") * 1000) / 1000,
    },
  };

  console.log(`RENDERER-COST-PROBE-RESULT ${JSON.stringify(report)}`);

  // Sanity floor only — this spec is a measurement instrument, not a budget
  // gate. It fails only when the sample itself is unusable.
  expect(probe.elapsedMs).toBeGreaterThan(SAMPLE_MS * 0.9);
});
