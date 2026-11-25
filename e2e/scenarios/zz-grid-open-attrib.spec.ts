/**
 * Scratch probe (untracked, measurement only): where a grid open spends its
 * time, per cell and per function.
 *
 * It seeds four agent seats, turns JUNTO_PERF on, opens the grid twice (the
 * first open pays the code warm-up, the second is the warm open the lead asked
 * about), and on the second open records:
 *   - the mark pairs TerminalSurface writes per cell (ctor, fit-addon, open,
 *     webgl, fit) and the first painted frame,
 *   - a CDP CPU profile of the same window, for self time by function,
 *   - rAF frame intervals, for the worst frame.
 *
 * Writes ~/grid-attrib/run.json on the machine that runs it and prints the
 * phase table. Real Electron, real GPU: it belongs on the Mac mini.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { card, selectedIds } from "../harness/canvas";
import { modelFixture, modelSeat } from "../harness/model";
import { expect, test } from "../harness/launch";

const IDS = ["g1", "g2", "g3", "g4"] as const;
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

const settle = async (page: import("@playwright/test").Page, ms: number): Promise<void> => {
  await page.waitForTimeout(ms);
};

const readMarks = (page: import("@playwright/test").Page): Promise<unknown> =>
  page.evaluate(() =>
    performance
      .getEntriesByType("mark")
      .filter((entry) => entry.name.startsWith("junto-term-open") || entry.name.startsWith("junto-grid-open"))
      .map((entry) => ({ name: entry.name, at: entry.startTime })),
  );

const readFrames = (page: import("@playwright/test").Page): Promise<unknown> =>
  page.evaluate(() => {
    const host = window as unknown as { __frames?: number[]; __raf?: number };
    if (host.__raf !== undefined) cancelAnimationFrame(host.__raf);
    return host.__frames ?? [];
  });

const startFrames = (page: import("@playwright/test").Page): Promise<unknown> =>
  page.evaluate(() => {
    const host = window as unknown as { __frames?: number[]; __raf?: number };
    host.__frames = [];
    let last = performance.now();
    const tick = (): void => {
      const at = performance.now();
      host.__frames?.push(at - last);
      last = at;
      host.__raf = requestAnimationFrame(tick);
    };
    host.__raf = requestAnimationFrame(tick);
    // CDP profile times are monotonic microseconds; timeOrigin is the offset
    // that turns one into a performance.now() reading.
    return { timeOrigin: performance.timeOrigin, now: performance.now() };
  });

test("grid open attribution", async ({ junto }) => {
  test.setTimeout(900_000);
  const { page } = junto;
  mkdirSync(OUT, { recursive: true });

  // JUNTO_PERF must be armed before the renderer bundle loads (PERF_ENABLED
  // resolves once), so this run's built out/renderer/index.html sets
  // globalThis.JUNTO_PERF="1". Prove it here rather than measure nothing.
  const perfOn = await page.evaluate(() => (window as unknown as { JUNTO_PERF?: unknown }).JUNTO_PERF);
  if (perfOn === undefined) throw new Error("JUNTO_PERF is not injected into out/renderer/index.html; marks would be off");
  for (const id of IDS) await card(page, id).visible({ timeout: 120_000 });
  await settle(page, 4_000);

  const selectAll = async (): Promise<void> => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await card(page, IDS[0]).click();
      for (const id of IDS.slice(1)) await card(page, id).click({ modifiers: ["Shift"] });
      const picked = [...(await selectedIds(page))].sort().join();
      if (picked === [...IDS].sort().join()) return;
      await settle(page, 400);
    }
    throw new Error(`selection is ${JSON.stringify(await selectedIds(page))}`);
  };

  const gridOpen = async (): Promise<void> => {
    await page.getByTestId("rts-open-grid").click();
    const grid = page.locator("[data-testid='terminal-grid-focus']");
    await expect(grid).toBeVisible({ timeout: 30_000 });
    await expect(grid.locator(".native-terminal-surface--grid .xterm")).toHaveCount(4, { timeout: 60_000 });
  };

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 100 });

  // The profile can wrap either open: the first one after boot pays whatever
  // code warm-up is left (ARM=cold), the second shows the open without it
  // (ARM=warm, the default).
  const ARM = process.env.JUNTO_PROFILE_ARM === "cold" ? "cold" : "warm";
  const measured = async (): Promise<void> => {
    await selectAll();
    await settle(page, 600);
    await page.evaluate(() => performance.clearMarks());
    const anchor = await startFrames(page);
    // Where the profile's own zero sits on the page clock: recorded immediately
    // before the profile starts, so sample times map onto the marks.
    const profileStartAt = await page.evaluate(() => performance.now());
    await cdp.send("Profiler.start");
    // The click mark sits as close to the click as a round trip allows.
    const clickAt = await page.evaluate(() => {
      performance.mark("junto-grid-open:click");
      return performance.now();
    });
    await page.getByTestId("rts-open-grid").click();
    const gridNow = page.locator("[data-testid='terminal-grid-focus']");
    await expect(gridNow).toBeVisible({ timeout: 30_000 });
    await expect(gridNow.locator(".native-terminal-surface--grid .xterm")).toHaveCount(4, { timeout: 60_000 });
    await settle(page, 3_000);
    const profile = await cdp.send("Profiler.stop");
    const frames = await readFrames(page);
    const marks = await readMarks(page);
    const payload = { arm: ARM, anchor, profileStartAt, clickAt, frames, marks, profile: profile.profile };
    const file = `${OUT}/run-${ARM}.json`;
    writeFileSync(file, JSON.stringify(payload));
    const worst = Math.max(...(frames as number[]).slice(1));
    console.log(`grid-attrib ${ARM}: ${file}, worst ${worst.toFixed(1)} ms, ${(profile.profile as { samples: number[] }).samples.length} samples`);
  };

  const closeGrid = async (): Promise<void> => {
    const close = page.getByRole("button", { name: "Close grid" });
    if ((await close.count()) > 0) await close.first().click();
    await settle(page, 2_500);
  };

  if (ARM === "cold") {
    await measured();
  } else {
    // Arm 0: the first open, unmeasured; it pays whatever code warm-up is left.
    await selectAll();
    await gridOpen();
    await settle(page, 3_000);
    await closeGrid();
    await measured();
  }
  await cdp.detach();
});
