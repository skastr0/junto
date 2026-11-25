/**
 * Scratch probe (untracked, measurement only): the FIRST grid open after boot,
 * traced, so the idle xterm warm-up can be judged by what it removes.
 *
 * One arm per app launch, so the arm is a build difference, not a flag: run
 * this spec in a checkout WITH terminal-code-warmup (App.tsx calls
 * scheduleTerminalCodeWarmup) and in one WITHOUT it, and compare.
 *
 * The trace comes from the app's own recorder (SIGUSR2, 30 s, TRACE_CATEGORIES
 * in src/app/observability/perf-trace.ts); scripts/perf-trace-summary.ts reads
 * it for EventDispatch, frames and input. The warm-up leaves
 * `terminal-warmup` (measure) in the page, so its own cost and moment ride
 * along.
 *
 * usage on the mini: JUNTO_ARM=on scripts/run-e2e.sh e2e/scenarios/zz-first-open-trace.spec.ts
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { card, selectedIds } from "../harness/canvas";
import { modelFixture, modelSeat } from "../harness/model";
import { expect, test } from "../harness/launch";

const IDS = ["g1", "g2", "g3", "g4"] as const;
const ARM = process.env.JUNTO_ARM ?? "unlabelled";
const OUT = `${homedir()}/grid-attrib`;

test.use({
  juntoOptions: {
    seedModels: {
      grid: modelFixture(
        IDS.map((id, i) =>
          modelSeat({
            id,
            label: id,
            launch: { kind: "command", argv: ["/bin/sh", "-c", "exec sleep 3600"], cwd: "/tmp" },
            x: (i % 2) * 320,
            y: Math.floor(i / 2) * 180,
          }),
        ),
      ),
    },
  },
});

test("first grid open after boot, traced", async ({ junto }) => {
  test.setTimeout(600_000);
  const { page, sandbox, app } = junto;
  mkdirSync(OUT, { recursive: true });

  // JUNTO_PERF is armed before the bundle loads by out/renderer/index.html (the
  // run patches it), because PERF_ENABLED resolves once and a reload of the
  // Electron window aborts. Prove it rather than measure nothing.
  const perfOn = await page.evaluate(() => (window as unknown as { JUNTO_PERF?: unknown }).JUNTO_PERF);
  if (perfOn === undefined) throw new Error("JUNTO_PERF is not injected into out/renderer/index.html");
  for (const id of IDS) await card(page, id).visible({ timeout: 120_000 });
  // Idle after boot: this is where the warm-up is scheduled to run.
  await page.waitForTimeout(6_000);

  const warmup = await page.evaluate(() =>
    performance
      .getEntriesByType("measure")
      .filter((entry) => entry.name === "terminal-warmup")
      .map((entry) => ({ start: entry.startTime, duration: entry.duration })),
  );
  console.log(`arm ${ARM}: warm-up measure ${JSON.stringify(warmup)}`);

  // No trace and no signal here: a spec may only use process.kill as an
  // existence probe (tests/tooling-process-safety-architecture.test.ts).
  // Frames and long tasks below are page-side and need neither.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await card(page, IDS[0]).click();
    for (const id of IDS.slice(1)) await card(page, id).click({ modifiers: ["Shift"] });
    const picked = [...(await selectedIds(page))].sort().join();
    if (picked === [...IDS].sort().join()) break;
    await page.waitForTimeout(400);
  }
  const clickAt = await page.evaluate(() => {
    performance.mark("junto-first-open:click");
    // Frames and long tasks for the open window, page-side, so the worst frame
    // is measured without the profiler or the trace in the way.
    const host = window as unknown as {
      __frames?: number[];
      __longtasks?: Array<{ start: number; duration: number }>;
      __raf?: number;
    };
    host.__frames = [];
    host.__longtasks = [];
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) host.__longtasks?.push({ start: entry.startTime, duration: entry.duration });
      }).observe({ entryTypes: ["longtask"] });
    } catch {
      // No longtask entries here; frames still land.
    }
    let last = performance.now();
    const tick = (): void => {
      const at = performance.now();
      host.__frames?.push(at - last);
      last = at;
      host.__raf = requestAnimationFrame(tick);
    };
    host.__raf = requestAnimationFrame(tick);
    return performance.now();
  });
  await page.getByTestId("rts-open-grid").click();
  const grid = page.locator("[data-testid='terminal-grid-focus']");
  await expect(grid).toBeVisible({ timeout: 30_000 });
  await expect(grid.locator(".native-terminal-surface--grid .xterm")).toHaveCount(4, { timeout: 60_000 });
  await page.waitForTimeout(5_000);
  const pageMetrics = await page.evaluate(() => {
    const host = window as unknown as {
      __frames?: number[];
      __longtasks?: Array<{ start: number; duration: number }>;
      __raf?: number;
    };
    if (host.__raf !== undefined) cancelAnimationFrame(host.__raf);
    const frames = host.__frames ?? [];
    const longtasks = host.__longtasks ?? [];
    const paintAt = performance.now();
    return {
      paintAt,
      frames,
      longtasks: longtasks.sort((a, b) => b.duration - a.duration).slice(0, 6),
      worstFrame: Math.max(...frames.slice(1), 0),
    };
  });
  writeFileSync(`${OUT}/first-open-${ARM}-page.json`, JSON.stringify({ clickAt, ...pageMetrics }));
  console.log(
    `arm ${ARM}: click at ${clickAt.toFixed(1)} ms, worst frame ${pageMetrics.worstFrame.toFixed(1)} ms, long tasks ${JSON.stringify(pageMetrics.longtasks)}`,
  );

});
