/**
 * Pad editor e2e: activate the pad, draw a box with the tool contract (R),
 * persist via pad.read. No real harnesses.
 */
import type { Pad } from "../../src/shared/pad";
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const CANVAS = "pad-editor";
const PAD_ID = "pad-1";

const padNode = {
  id: PAD_ID,
  type: "text" as const,
  text: "pad",
  x: 320,
  y: 40,
  width: 240,
  height: 120,
  ether: { entity: { kind: "pad" as const } },
};

test.use({
  vellumOptions: {
    seedCanvases: {
      [CANVAS]: canvasDoc([
        agentTextNode({
          id: "seat",
          key: "local:pad-editor",
          label: "seat",
          x: 40,
          y: 40,
        }),
        padNode,
      ]),
    },
  },
});

const waitForApi = async (page: import("@playwright/test").Page): Promise<void> => {
  await expect
    .poll(
      async () =>
        page.evaluate(() => typeof window.vellumCommand?.workPadRead === "function"),
      { timeout: 30_000 },
    )
    .toBe(true);
};

const readPad = (page: import("@playwright/test").Page) =>
  page.evaluate(
    ([canvas, id]) => window.vellumCommand!.workPadRead(canvas, id),
    [CANVAS, PAD_ID] as const,
  );

const shapeCount = (pad: Pad): number => pad.shapes.filter((shape) => shape.type === "box").length;

test("pad editor: activate, draw box with R, persist", async ({ vellumCommand }) => {
  const { page } = vellumCommand;

  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await waitForApi(page);
  await expect(page.getByTestId("pad-card")).toBeVisible({ timeout: 15_000 });

  await page.locator(".react-flow__node").filter({ has: page.getByTestId("pad-card") }).dblclick();
  const detail = page.getByTestId("pad-detail");
  await expect(detail).toBeVisible({ timeout: 15_000 });

  const svg = page.getByTestId("pad-svg");
  await expect(svg).toBeVisible();
  await svg.click();
  await page.keyboard.press("r");
  await expect(svg).toHaveAttribute("data-tool", "box");

  const box = await svg.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + 90, box!.y + 80);
  await page.mouse.down();
  await page.mouse.move(box!.x + 200, box!.y + 160);
  await page.mouse.up();

  await expect
    .poll(async () => {
      const read = await readPad(page);
      return read.ok ? shapeCount(read.data.pad) : 0;
    }, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(1);

  await page.getByRole("button", { name: "Close pad" }).click();
  await expect(detail).toHaveCount(0);

  const persisted = await readPad(page);
  expect(persisted.ok).toBe(true);
  if (!persisted.ok) return;
  expect(shapeCount(persisted.data.pad)).toBeGreaterThanOrEqual(1);
  expect(persisted.data.pad.revision).toBeGreaterThan(0);
});
