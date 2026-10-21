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
 * every tier. The lease that composited the viewport made 809 layers here and
 * starved tiles on a near pan.
 *
 * At rest, seats move at every tier: rings step on the 90 ms attention clock,
 * only while on screen, so a still camera repaints the rings in view about 22
 * times in 2 s and rasters only the tiles under them. Measured: 60 to 470
 * paints and 30 to 100 raster tasks in 2 s, the overview (every seat on
 * screen) highest. The budget holds that to the clock's cadence: no more
 * than a few tiles per tick, and nothing else repainting.
 *
 * The 40 is headroom over those 12 to 16 static layers (df7eec87e): it
 * guards against overlap blowups like the 809. Motion is not headroom. The
 * motion law keeps every ring and ping moving on the compositor, and each
 * moving thing is a layer the board cannot give back: one per minimap ping,
 * one per turning ring part, and one holder per turning seat ring. The
 * holder is the design, asserted as such: up close the card (its own layer,
 * styles.css), at far and overview the scaled mark and never the card
 * (ba5b78088); a cluster's mark has none. Nothing paints over a turning
 * part, so the signal button holds no layer. A cluster body, and a resting
 * cluster's ring, are composited for overlapping what moves near them, not
 * for moving, so they count with the others. So the budget is 40 others on top of those, counted from the DOM
 * in the same phase. Parts and holders match exactly; only the minimap's
 * pings, which a pan carries in and out of view, get the 1 to 3 it moves.
 */
const PING_SLACK = 3;
const LAYER_BUDGET = 40;
const CLOCK_TICKS_AT_REST = Math.ceil(2_000 / 90);
const REST_PAINT_BUDGET = CLOCK_TICKS_AT_REST * 30;
const REST_RASTER_BUDGET = CLOCK_TICKS_AT_REST * 8;

type TraceEvent = { readonly name?: string; readonly ph?: string; readonly args?: Record<string, unknown> };
type SnapshotLayer = {
  readonly layer_name?: string;
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
  /** Layers of the kinds the motion law requires, as the compositor holds them, and as the DOM draws them. */
  readonly motionLayers: number;
  readonly motionDrawn: number;
  /** The DOM count by kind, for the log. */
  readonly motionKinds: Readonly<Record<string, number>>;
  /** The compositor's motion layers by kind, for the log. */
  readonly motionLayerKinds: Readonly<Record<string, number>>;
  readonly pinned: number;
};

/** A layer for a moving thing (a ping, a ring part, a ring's holder), or for what must never be one (the signal button). */
const MOTION_LAYER = /class='(junto-minimap-ping|junto-mark__part|junto-mark__flag|junto-mark|junto-node)[' ]/;

/**
 * The motion kind a layer is, if any. A seat's mark is relatively placed; a
 * cluster stack places its ring absolutely (canvas-lod.css), so a mark layer
 * that is not relative is a cluster's, and counts with the others.
 */
const motionKind = (name: string): string | undefined => {
  const kind = MOTION_LAYER.exec(name)?.[1];
  return kind === "junto-mark" && !name.includes("(relative positioned") ? undefined : kind;
};

/** What the DOM draws moving right now, in layers the motion law requires. */
const motionDrawn = (page: Page): Promise<Record<string, number>> =>
  page.evaluate(() => {
    const shown = (el: Element): boolean => {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && box.right > 0 && box.bottom > 0 &&
        box.left < innerWidth && box.top < innerHeight;
    };
    const moving = (el: Element): boolean => shown(el) && getComputedStyle(el).animationName !== "none";
    const pings = [...document.querySelectorAll(".junto-minimap-ping")].filter(moving).length;
    let parts = 0;
    let seatRings = 0;
    let clusterRings = 0;
    for (const mark of document.querySelectorAll(".junto-mark[data-mark-visible]")) {
      const turning = [...mark.querySelectorAll(":scope > .junto-mark__part")].filter(moving).length;
      if (turning === 0) continue;
      parts += turning;
      if (mark.closest(".react-flow__node .junto-node")) seatRings += 1;
      else clusterRings += 1;
    }
    return { pings, parts, seatRings, clusterRings };
  });

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
  const drawn = await motionDrawn(page);
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
    motionLayers: layers.filter((l) => motionKind(l.layer_name ?? "") !== undefined).length,
    motionDrawn: drawn.pings! + drawn.parts! + drawn.seatRings!,
    motionKinds: drawn,
    motionLayerKinds: layers.reduce<Record<string, number>>((kinds, l) => {
      const kind = motionKind(l.layer_name ?? "");
      if (kind !== undefined) kinds[kind] = (kinds[kind] ?? 0) + 1;
      return kinds;
    }, {}),
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
        // The first trace after a zoom records one full repaint, every
        // portrait included, whether it starts 1.5 s or 4 s after the camera
        // stops; the next window is quiet. Trace a warm-up window and drop it,
        // so the rest window measures rest.
        await traced(app, page, join(out, `${tier}-settle.json`), () => page.waitForTimeout(1_000));
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
          // The board is a handful of layers, not one per card or wire, on
          // top of the layers its motion requires; and that motion costs no
          // more layers than the DOM draws moving.
          const layerOf = (kind: string): number => phase.motionLayerKinds[kind] ?? 0;
          const drawnOf = (kind: string): number => phase.motionKinds[kind] ?? 0;
          const zoomedOut = row.tier === "far" || row.tier === "overview";
          expect(layerOf("junto-mark__part"), `${label}: a layer per turning part`).toBe(drawnOf("parts"));
          expect(layerOf(zoomedOut ? "junto-mark" : "junto-node"), `${label}: one holder per turning seat ring`)
            .toBe(drawnOf("seatRings"));
          expect(layerOf(zoomedOut ? "junto-node" : "junto-mark"), `${label}: no second holder`).toBe(0);
          expect(layerOf("junto-mark__flag"), `${label}: the signal button paints under the parts`).toBe(0);
          expect(Math.abs(layerOf("junto-minimap-ping") - drawnOf("pings")), `${label}: a layer per moving ping`)
            .toBeLessThanOrEqual(PING_SLACK);
          expect(phase.layers - phase.motionLayers, `${label}: compositor layers beside the motion`)
            .toBeLessThanOrEqual(LAYER_BUDGET);
        }
        // At rest only the clock repaints: the rings in view, a few tiles a tick.
        expect(row.rest.paints, `${label}: paints at rest`).toBeLessThanOrEqual(REST_PAINT_BUDGET);
        expect(row.rest.rasterTasks, `${label}: raster tasks at rest`).toBeLessThanOrEqual(REST_RASTER_BUDGET);
      }
    } finally {
      await junto.close();
    }
  });
}
