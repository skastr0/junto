/**
 * Canvas tier budget: on the nested stress boards at the operator's display,
 * each level-of-detail tier stays inside its paint, layer and tile budget,
 * at rest and while panning.
 *
 * Reads the compositor's own record from a trace per tier (2 s at rest, then
 * a 1.5 s pan): cc's layer tree (how many layers, and whether any is rastered
 * far above the zoom it is seen at), the tile manager's memory verdicts, the
 * checkerboard quads it drew, and Blink's Paint and cc's RasterTask counts.
 * Counts, not milliseconds, so a loaded machine does not move the verdict.
 *
 *   bun run test:e2e:fast e2e/scenarios/canvas-tier-budget.spec.ts
 */
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import {
  buildNestedCanvasFixture,
  OPERATOR_DISPLAY,
  type NestedCanvasPresetName,
} from "../harness/nested-canvas-fixture";
import { expect, launchJunto, test } from "../harness/launch";

type Tier = "near" | "mid" | "far" | "overview";
const TIERS: ReadonlyArray<readonly [Tier, number]> = [
  ["near", 0.8],
  ["mid", 0.45],
  ["far", 0.26],
  ["overview", 0.15],
];

/**
 * Measured on these boards without a composited viewport: 12 to 16 layers at
 * every tier, 3 paints in 2 s at rest below near. The lease that composited
 * the viewport made 809 layers here and starved tiles on a near pan.
 */
const LAYER_BUDGET = 40;
const REST_PAINT_BUDGET = 20;

type TraceEvent = { readonly name?: string; readonly ph?: string; readonly args?: Record<string, unknown> };
type SnapshotLayer = {
  readonly draws_content?: number | boolean;
  readonly ideal_contents_scale?: number;
  readonly raster_scales?: { readonly contents_scale?: readonly number[] };
};

type PhaseReading = {
  /** Frames the page drew, per second, and main-thread task time, ms per second. */
  readonly fps: number;
  readonly taskMsPerS: number;
  readonly paints: number;
  readonly rasterTasks: number;
  readonly starved: number;
  readonly missingTiles: number;
  readonly layers: number;
  readonly pinned: number;
};

const scale = (page: Page): Promise<number> =>
  page.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector(".react-flow__viewport")!).transform).a);

const zoomTo = async (page: Page, target: number): Promise<number> => {
  await page.evaluate((goal) => {
    const read = (): number =>
      new DOMMatrix(getComputedStyle(document.querySelector(".react-flow__viewport")!).transform).a;
    const flow = document.querySelector(".react-flow")!.getBoundingClientRect();
    for (let i = 0; i < 200; i += 1) {
      const now = read();
      if (Math.abs(now - goal) / goal < 0.04) break;
      document.querySelector(".react-flow__pane")?.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: now > goal ? 20 : -20,
          ctrlKey: true,
          clientX: flow.x + flow.width / 2,
          clientY: flow.y + flow.height / 2 - 60,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  }, target);
  await page.waitForTimeout(1_500);
  return scale(page);
};

const pan = async (page: Page, steps: number): Promise<void> => {
  for (let i = 0; i < steps; i += 1) {
    const dir = Math.floor(i / 25) % 2 === 0 ? 1 : -1;
    await page.evaluate((d) => {
      const flow = document.querySelector(".react-flow")!.getBoundingClientRect();
      document.querySelector(".react-flow__pane")?.dispatchEvent(
        new WheelEvent("wheel", {
          deltaX: 28 * d,
          deltaY: 10 * d,
          clientX: flow.x + flow.width / 2,
          clientY: flow.y + flow.height / 2,
          bubbles: true,
          cancelable: true,
        }),
      );
    }, dir);
    await page.waitForTimeout(16);
  }
};

const traced = async (
  app: ElectronApplication,
  page: Page,
  path: string,
  run: () => Promise<void>,
): Promise<PhaseReading> => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const taskSeconds = async (): Promise<number> =>
    (await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === "TaskDuration")?.value ?? 0;
  await app.evaluate(async ({ contentTracing }) => {
    await contentTracing.startRecording({
      included_categories: ["cc", "disabled-by-default-cc.debug", "devtools.timeline"],
    });
  });
  await page.evaluate(() => {
    const w = window as unknown as { __tierFrames: number; __tierStop: boolean };
    w.__tierFrames = 0;
    w.__tierStop = false;
    const tick = () => {
      w.__tierFrames += 1;
      if (!w.__tierStop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const taskBefore = await taskSeconds();
  const started = Date.now();
  await run();
  const seconds = (Date.now() - started) / 1000;
  const taskAfter = await taskSeconds();
  const frames = await page.evaluate(() => {
    const w = window as unknown as { __tierFrames: number; __tierStop: boolean };
    w.__tierStop = true;
    return w.__tierFrames;
  });
  await cdp.detach();
  await app.evaluate(async ({ contentTracing }, out) => contentTracing.stopRecording(out), path);
  const raw = JSON.parse(await readFile(path, "utf8")) as { traceEvents?: TraceEvent[] } | TraceEvent[];
  const events = Array.isArray(raw) ? raw : (raw.traceEvents ?? []);
  const count = (name: string) => events.filter((e) => e.name === name && e.ph !== "E").length;
  const snapshots = events.filter((e) => {
    const tree = (e.args?.["snapshot"] as { active_tree?: { layers?: unknown[] } } | undefined)?.active_tree;
    return e.name === "LayerTreeHostImpl:snapshot" && (tree?.layers?.length ?? 0) > 3;
  });
  const layers =
    snapshots.length === 0
      ? []
      : (snapshots[snapshots.length - 1]!.args!["snapshot"] as { active_tree: { layers: SnapshotLayer[] } }).active_tree
          .layers;
  return {
    fps: Math.round(frames / seconds),
    taskMsPerS: Math.round(((taskAfter - taskBefore) * 1000) / seconds),
    paints: count("Paint"),
    rasterTasks: count("RasterTask"),
    starved: events.filter(
      (e) =>
        e.name === "TileManager::AssignGpuMemoryToTiles" &&
        e.args?.["had_enough_memory_to_schedule_tiles_needed_now"] === false,
    ).length,
    missingTiles: events
      .filter((e) => e.name === "TileBasedLayerImpl::AppendQuads checkerboard")
      .reduce((sum, e) => sum + Number(e.args?.["missing_tile_count"] ?? 0), 0),
    layers: layers.length,
    pinned: layers.filter((l) => {
      const ideal = l.ideal_contents_scale ?? 1;
      const raster = l.raster_scales?.contents_scale?.[0] ?? ideal;
      return Boolean(l.draws_content) && ideal < 0.5 && raster > Math.max(ideal * 2, ideal + 0.05);
    }).length,
  };
};

for (const preset of ["nested", "deep"] as const satisfies readonly NestedCanvasPresetName[]) {
  test(`${preset} board: every tier inside its paint, layer and tile budget`, async () => {
    test.setTimeout(300_000);
    const fixture = buildNestedCanvasFixture(preset);
    const junto = await launchJunto({ ...OPERATOR_DISPLAY, nestedCanvas: { fixture, name: preset } });
    try {
      const { app, page } = junto;
      await expect(page.locator(".react-flow__node-group")).toHaveCount(fixture.stats.regions, { timeout: 60_000 });
      const out = join(test.info().outputDir, preset);
      await mkdir(out, { recursive: true });
      const rows: { tier: Tier; zoom: number; rest: PhaseReading; pan: PhaseReading }[] = [];
      for (const [tier, zoom] of TIERS) {
        await page.getByRole("button", { name: /fit all/i }).first().click();
        await page.waitForTimeout(1_000);
        const at = await zoomTo(page, zoom);
        await expect(page.locator("html")).toHaveAttribute("data-canvas-tier", tier);
        const rest = await traced(app, page, join(out, `${tier}-rest.json`), () => page.waitForTimeout(2_000));
        const panning = await traced(app, page, join(out, `${tier}-pan.json`), async () => {
          await pan(page, 90);
          await page.waitForTimeout(600);
        });
        rows.push({ tier, zoom: +at.toFixed(3), rest, pan: panning });
      }
      console.log(`TIER-BUDGET ${preset} ${JSON.stringify(rows)}`);
      for (const row of rows) {
        const label = `${preset} ${row.tier}`;
        for (const phase of [row.rest, row.pan]) {
          // The flicker: tiles the compositor had no memory for, or drew missing.
          expect(phase.starved, `${label}: tile assigns without memory for tiles needed now`).toBe(0);
          expect(phase.missingTiles, `${label}: checkerboarded tiles`).toBe(0);
          expect(phase.pinned, `${label}: layers rastered far above their zoom`).toBe(0);
          // The board is a handful of layers, not one per card or wire.
          expect(phase.layers, `${label}: compositor layers`).toBeLessThanOrEqual(LAYER_BUDGET);
        }
        // Far and overview draw no loops: a camera at rest paints (almost)
        // nothing. (Mid still paints about 110 times a second at rest on these
        // boards; seat and card visuals own that tier.)
        if (row.tier === "far" || row.tier === "overview") {
          expect(row.rest.paints, `${label}: paints at rest`).toBeLessThanOrEqual(REST_PAINT_BUDGET);
        }
      }
    } finally {
      await junto.close();
    }
  });
}
