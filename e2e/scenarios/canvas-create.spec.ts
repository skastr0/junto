/**
 * Making a new canvas from the top bar and landing on it, in the real app, on
 * a canvas shaped like an operator's: one canvas with a region and many seats.
 *
 * The operator presses New canvas, names it, presses Create. The canvas must
 * exist in main, the picker must read its name, nothing may throw in the
 * window on the way, and a refusal must say why where the operator looks.
 *   bun run test:e2e:fast e2e/scenarios/canvas-create.spec.ts
 */
import type { Page } from "@playwright/test";
import { canvasReady } from "../harness/canvas";
import { expect, test } from "../harness/launch";
import { modelFixture, modelRegion, modelSeat } from "../harness/model";

const BOARD = "board";
const board = modelFixture([
  modelRegion({ id: "region-core", label: "Core", x: 0, y: 0, width: 2400, height: 900 }),
  ...Array.from({ length: 40 }, (_, n) =>
    modelSeat({ id: `seat-${n}`, label: `Seat ${n}`, x: 60 + (n % 10) * 230, y: 120 + Math.floor(n / 10) * 180 }),
  ),
]);

test.use({ juntoOptions: { seedModels: { [BOARD]: board } } });

const names = (page: Page): Promise<string[]> =>
  page.evaluate(async () => (await window.junto!.modelCanvases()).map((canvas) => canvas.name));

const create = async (page: Page, name: string): Promise<void> => {
  await page.getByRole("button", { name: "New canvas" }).click();
  await page.getByRole("textbox", { name: "Canvas name" }).fill(name);
  await page.getByRole("button", { name: "Create" }).click();
};

test("a new canvas is made from the top bar and opened", async ({ junto: { page } }) => {
  const thrown: string[] = [];
  page.on("pageerror", (error) => thrown.push(error.message));
  await canvasReady(page, { timeout: 30_000 });
  expect(await names(page)).toEqual([BOARD]);

  await create(page, "second");

  await expect.poll(() => names(page), { timeout: 20_000 }).toEqual(expect.arrayContaining([BOARD, "second"]));
  await expect(page.getByRole("button", { name: "Active canvas" })).toContainText(/second/i, { timeout: 20_000 });
  expect(thrown).toEqual([]);
});

test("a name already taken is refused in words in the window", async ({ junto: { page } }) => {
  await canvasReady(page, { timeout: 30_000 });
  await create(page, BOARD);
  // Nothing is made; the operator is told why, not left with a closed dialog and no word.
  await expect(page.getByRole("alert")).toContainText(/already exist/i, { timeout: 20_000 });
  expect(await names(page)).toEqual([BOARD]);
});
