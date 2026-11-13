/**
 * The minimap drives the camera on the GPU canvas (docs/canvas-gpu-plan.md,
 * track G): a click centres, a double click zooms in, a drag pans and a wheel
 * zooms, all read back through the canvas hook.
 * Run: `bunx electron-vite build && bun run test:e2e:fast e2e/scenarios/canvas-minimap.spec.ts`
 */
import type { Page } from "@playwright/test";
import { camera, canvasReady, card } from "../harness/canvas";
import { expect, test } from "../harness/launch";
import { commandModel, modelFixture, modelNote } from "../harness/model";

const fixture = modelFixture([
  modelNote("first", "first note", 40, 40),
  modelNote("second", "second note", 340, 40),
  modelNote("third", "third note", 640, 40),
]);

const installBoard = async (page: Page): Promise<string> => {
  await page.waitForFunction(() => Boolean(window.junto?.modelCanvases), undefined, { timeout: 30_000 });
  const names = await page.evaluate(() => window.junto!.modelCanvases());
  const canvas = names[0]?.name ?? "minimap";
  if (names.length === 0) await commandModel(page, { _tag: "CreateCanvas", canvas });
  await commandModel(page, { _tag: "Add", canvas, nodes: fixture.nodes, wires: fixture.wires });
  return canvas;
};

test("click, double click, drag and wheel on the minimap move the GPU camera", async ({ junto }) => {
  const { page } = junto;
  await canvasReady(page, { timeout: 30_000 });
  await installBoard(page);
  await card(page, "first").visible({ timeout: 30_000 });

  const minimap = page.getByTestId("rf__minimap");
  await expect(minimap).toBeVisible({ timeout: 30_000 });
  const box = await minimap.boundingBox();
  expect(box).toBeTruthy();
  if (!box) return;

  const at = (fx: number, fy: number) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });

  // Click: the camera centres on the board point under the pointer.
  const before = await camera(page);
  const clickAt = at(0.28, 0.34);
  await page.mouse.click(clickAt.x, clickAt.y);
  await expect.poll(async () => {
    const now = await camera(page);
    return Math.abs(now.x - before.x) + Math.abs(now.y - before.y);
  }, { timeout: 5_000 }).toBeGreaterThan(1);

  // Double click: the camera zooms in on that point.
  const zoomBefore = (await camera(page)).zoom;
  const doubleAt = at(0.62, 0.58);
  await page.mouse.dblclick(doubleAt.x, doubleAt.y);
  await expect.poll(async () => (await camera(page)).zoom, { timeout: 5_000 }).toBeGreaterThan(zoomBefore + 0.01);

  // Drag: the camera pans with the pointer.
  const dragFrom = at(0.5, 0.5);
  const panBefore = await camera(page);
  await page.mouse.move(dragFrom.x, dragFrom.y);
  await page.mouse.down();
  await page.mouse.move(dragFrom.x + 30, dragFrom.y + 18, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => {
    const now = await camera(page);
    return Math.abs(now.x - panBefore.x) + Math.abs(now.y - panBefore.y);
  }, { timeout: 5_000 }).toBeGreaterThan(1);

  // Wheel: a zoom step through the canvas's own zoom path.
  const wheelBefore = (await camera(page)).zoom;
  await page.mouse.move(at(0.5, 0.5).x, at(0.5, 0.5).y);
  await page.mouse.wheel(0, -240);
  await expect.poll(async () => (await camera(page)).zoom, { timeout: 5_000 }).not.toBeCloseTo(wheelBefore, 3);
});
