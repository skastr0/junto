/**
 * Measurement proof for gathered-seat wire folds: real Electron, GPU canvas,
 * the factory board at the mini's 1x display scale. It walks near, mid, far
 * and overview in order and back, and reports the longest rAF gap, engine
 * frame, fold count and wire rebuild count at every crossing.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, launchJunto, test } from "../harness/launch";
import { camera, cameraSettled, canvasReady, pane, regionCount } from "../harness/canvas";
import type { NestedCanvasFixture } from "../harness/nested-canvas-fixture";
import { buildProofBoard } from "../harness/gpu-proof";

const FIXTURE = "e2e/scenarios/zz-idle-probe.factory.json";

const loadFixture = async (): Promise<NestedCanvasFixture> => {
  const parsed = JSON.parse(await readFile(join(process.cwd(), FIXTURE), "utf8")) as Omit<
    NestedCanvasFixture,
    "signals"
  > & { signalRows: ReturnType<NestedCanvasFixture["signals"]> };
  return { ...parsed, signals: () => parsed.signalRows };
};

const placeCamera = async (page: Page, target: { x: number; y: number; zoom: number }): Promise<void> => {
  await page.evaluate((to) => {
    const hook = (window as any).__juntoCanvas;
    if (hook?.moveCamera === undefined) throw new Error("no canvas hook");
    hook.moveCamera(to);
  }, target);
  await expect
    .poll(async () => {
      const at = await camera(page);
      return Math.max(Math.abs(at.x - target.x), Math.abs(at.y - target.y), Math.abs(at.zoom - target.zoom));
    }, { timeout: 10_000 })
    .toBeLessThanOrEqual(0.02);
};

const read = (page: Page) =>
  page.evaluate(() => {
    const hook = (window as any).__juntoCanvas;
    return { wire: hook?.wireStats?.() ?? null, stats: hook?.stats?.() ?? null };
  });

test("folded wires: zoom crossings on the factory board", async () => {
  test.setTimeout(240_000);
  const fixture = await loadFixture();
  const board = buildProofBoard(fixture, 1);
  const canvas: NestedCanvasFixture = {
    model: board.model,
    stats: {
      ...fixture.stats,
      regions: board.stats.regions,
      seats: board.stats.seats,
      notes: board.stats.notes,
      terminals: board.stats.terminals,
      edges: board.stats.edges,
      bounds: board.stats.bounds,
    },
    signals: fixture.signals,
  };
  const nodes = board.model.nodes as ReadonlyArray<any>;
  const seats = nodes.filter((node) => node.kind === "agent");
  const focusSeat = seats[Math.floor(seats.length / 2)]!;
  const focus = { x: focusSeat.x + focusSeat.width / 2, y: focusSeat.y + focusSeat.height / 2 };

  const junto = await launchJunto({
    windowContentSize: { width: 1726, height: 1083 },
    nestedCanvas: { fixture: canvas, name: "factory" },
    seedExperimentalFeatures: ["gpuCanvas"] as const,
  });
  try {
    const { page } = junto;
    await expect.poll(() => regionCount(page), { timeout: 180_000 }).toBe(board.stats.regions);
    await canvasReady(page);
    const box = (await pane(page).box())!;
    const at = (zoom: number) => ({
      x: Math.round(box.width / 2 - focus.x * zoom),
      y: Math.round(box.height / 2 - focus.y * zoom),
      zoom,
    });

    const settle = async (zoom: number): Promise<void> => {
      await placeCamera(page, at(zoom));
      await page.waitForTimeout(350);
      await cameraSettled(page);
    };

    // Warm every tier's strip cache first: the measured far-to-mid crossing
    // is the fold visibility swap, never a first visit's pill geometry.
    for (const zoom of [1.0, 0.52, 0.3, 0.15, 0.3, 0.52, 1.0]) await settle(zoom);

    const crossing = async (from: number, to: number): Promise<void> => {
      await settle(from);
      const before = await read(page);
      await page.evaluate(() => {
        const w = window as any;
        w.__foldRaf = [] as number[];
        const loop = (time: number): void => {
          w.__foldRaf.push(time);
          if (w.__foldRaf.length < 80) requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      });
      await placeCamera(page, at(to));
      const engineFrames: number[] = [];
      for (let index = 0; index < 18; index += 1) {
        await page.waitForTimeout(20);
        const sample = await read(page);
        if (sample.stats?.lastFrameMs !== undefined) engineFrames.push(sample.stats.lastFrameMs);
      }
      const after = await read(page);
      const raf = await page.evaluate(() => ((window as any).__foldRaf ?? []) as number[]);
      let maxRaf = 0;
      for (let index = 1; index < raf.length; index += 1) maxRaf = Math.max(maxRaf, raf[index]! - raf[index - 1]!);
      console.log(
        "FOLD_CROSS",
        JSON.stringify({
          displayScale: 1,
          from,
          to,
          maxRafMs: +maxRaf.toFixed(2),
          maxEngineFrameMs: +Math.max(...engineFrames, 0).toFixed(3),
          rebuilds: (after.wire?.rebuilds ?? 0) - (before.wire?.rebuilds ?? 0),
          folds: after.wire?.folds ?? null,
          wires: after.wire?.wires ?? null,
          frames: (after.wire?.frames ?? 0) - (before.wire?.frames ?? 0),
          refreshMs: after.wire?.refreshMs ?? null,
          stepMs: after.wire?.stepMs ?? null,
        }),
      );
    };

    for (const [from, to] of [
      [1.0, 0.52],
      [0.52, 0.3],
      [0.3, 0.15],
      [0.15, 0.3],
      [0.3, 0.52],
      [0.52, 1.0],
    ] as const) {
      await crossing(from, to);
    }
  } finally {
    await junto.close();
  }
});
