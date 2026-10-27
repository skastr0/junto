/**
 * The pad's feel, measured in the real app: how long a tool change, a drawn
 * box, an ink stroke and a pan take from input to the next frame, over a
 * canvas with seats behind the modal. Event Timing gives each input's
 * latency; a CDP CPU profile of the whole run is the trace receipt.
 *
 *   PAD_PERF_LABEL=before PAD_PERF_SEATS=80 bun run test:e2e:fast e2e/scenarios/pad-perf.spec.ts
 *
 * Writes test-results/pad-perf/<label>.json (latencies) and
 * <label>.cpuprofile (open in Chrome DevTools, Performance panel).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { Schema } from "effect";
import { Node } from "../../src/shared/model";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelRegion, modelSeat } from "../harness/model";

const CANVAS = "pad-perf";
const OUT = "test-results/pad-perf";
const LABEL = process.env.PAD_PERF_LABEL ?? "run";
const SEATS = Number(process.env.PAD_PERF_SEATS ?? 24);

type Timing = { readonly name: string; readonly duration: number; readonly processing: number };

/** Every input slower than one frame, from the Event Timing API, and every long task. */
const startObservers = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __padPerf: { events: Timing[]; long: number[] } };
    w.__padPerf = { events: [], long: [] };
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as PerformanceEventTiming[]) {
        w.__padPerf.events.push({
          name: entry.name,
          duration: entry.duration,
          processing: entry.processingEnd - entry.processingStart,
        });
      }
    }).observe({ type: "event", durationThreshold: 16, buffered: false } as PerformanceObserverInit);
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) w.__padPerf.long.push(entry.duration);
    }).observe({ type: "longtask", buffered: false });
  });

const takeObserved = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __padPerf: { events: Timing[]; long: number[] } };
    const out = w.__padPerf;
    w.__padPerf = { events: [], long: [] };
    return out;
  });

/** Input to the frame after it: a press and the two frames that paint it. */
const frameAfter = (page: Page, run: () => Promise<void>): Promise<number> =>
  (async () => {
    const t0 = await page.evaluate(() => performance.now());
    await run();
    const t1 = await page.evaluate(
      () => new Promise<number>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now())))),
    );
    return t1 - t0;
  })();

const stats = (values: ReadonlyArray<number>) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { n: sorted.length, p50: Math.round(at(0.5)), p95: Math.round(at(0.95)), max: Math.round(sorted.at(-1) ?? 0) };
};

test("pad perf: tool change, box, ink and pan latency over a seated canvas", async () => {
  test.setTimeout(300_000);
  const seats = Array.from({ length: SEATS }, (_, i) =>
    modelSeat({ id: `s${i}`, key: `local:pad-perf-${i}`, label: `Seat ${i}`, x: (i % 6) * 260, y: 300 + Math.floor(i / 6) * 160 }),
  );
  const shelf = Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })({
    kind: "artifacts",
    id: "shelf",
    label: "Shelf",
    x: 40,
    y: 40,
    width: 280,
    height: 160,
    z: 0,
  });
  const region = modelRegion({ id: "ops", label: "Ops", x: 0, y: 0, width: 1700, height: 1000 });
  const junto = await launchJunto({ seedModels: { [CANVAS]: modelFixture([region, shelf, ...seats], []) } });
  try {
    const { page } = junto;
    const card = page.locator('.react-flow__node[data-id="shelf"]');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.dblclick();
    await expect(page.getByRole("list", { name: "Artifacts" })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "New artifact" }).click();
    await page.getByRole("group", { name: "New artifact" }).locator("button").filter({ hasText: "Pad" }).click();
    await expect(page.locator(".artifact-head__meta")).toHaveText("Pad, version 1", { timeout: 15_000 });
    // An A/B probe: PAD_PERF_STYLE is CSS added before measuring, to test a
    // cause (say, no scrim blur) without a build.
    if (process.env.PAD_PERF_STYLE) await page.addStyleTag({ content: process.env.PAD_PERF_STYLE });
    const svg = page.getByTestId("pad-svg");
    await expect(svg).toBeVisible();
    const box = (await svg.boundingBox())!;

    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
    await cdp.send("Profiler.start");
    await startObservers(page);

    // Tool changes: a click on each tool in turn.
    const tools = ["box", "ellipse", "triangle", "label", "ink", "select"];
    const toolMs: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      for (const tool of tools) {
        const button = page.getByTestId(`pad-tool-${tool}`);
        toolMs.push(await frameAfter(page, () => button.click()));
        await expect(button).toHaveAttribute("aria-pressed", "true");
      }
    }
    const toolEvents = await takeObserved(page);

    // Boxes: drag, release, and the shape on screen.
    const boxMs: number[] = [];
    await page.getByTestId("pad-tool-box").click();
    for (let i = 0; i < 8; i += 1) {
      const x = box.x + 60 + (i % 4) * 140;
      const y = box.y + 60 + Math.floor(i / 4) * 140;
      await page.getByTestId("pad-tool-box").click();
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 60, y + 40, { steps: 6 });
      boxMs.push(await frameAfter(page, () => page.mouse.up()));
    }
    const boxEvents = await takeObserved(page);

    // Ink: strokes of 40 moves each.
    const inkMoveMs: number[] = [];
    await page.getByTestId("pad-tool-ink").click();
    for (let i = 0; i < 4; i += 1) {
      const y = box.y + 360 + i * 30;
      await page.mouse.move(box.x + 60, y);
      await page.mouse.down();
      for (let step = 1; step <= 40; step += 1) {
        inkMoveMs.push(await frameAfter(page, () => page.mouse.move(box.x + 60 + step * 8, y + Math.sin(step / 3) * 12)));
      }
      await page.mouse.up();
    }
    const inkEvents = await takeObserved(page);

    // Pan: two-finger scroll on a trackpad arrives as wheel without Ctrl.
    const panMs: number[] = [];
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 20; i += 1) {
      panMs.push(await frameAfter(page, () => page.mouse.wheel(12, 8)));
    }
    const panEvents = await takeObserved(page);

    const { profile } = await cdp.send("Profiler.stop");
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, `${LABEL}.cpuprofile`), JSON.stringify(profile));
    await page.screenshot({ path: join(OUT, `${LABEL}.png`) });

    const slow = (events: { events: Timing[]; long: number[] }) => ({
      inputsOverAFrame: events.events.length,
      worstInput: stats(events.events.map((event) => event.duration)),
      longTasks: stats(events.long),
    });
    const report = {
      label: LABEL,
      seats: SEATS,
      toolChange: { frame: stats(toolMs), ...slow(toolEvents) },
      boxDrawn: { frame: stats(boxMs), ...slow(boxEvents) },
      inkMove: { frame: stats(inkMoveMs), ...slow(inkEvents) },
      wheel: { frame: stats(panMs), ...slow(panEvents) },
    };
    writeFileSync(join(OUT, `${LABEL}.json`), JSON.stringify(report, null, 2));
    console.log("PAD PERF", JSON.stringify(report));
  } finally {
    await junto.close();
  }
});
