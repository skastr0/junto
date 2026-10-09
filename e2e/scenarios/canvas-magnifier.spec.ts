import { modelFixture, modelNode } from "../harness/model";
import { expect, test } from "../harness/launch";
import { THIS_MACHINE } from "../../tests/support/machines";

const worker = modelNode({
  kind: "agent", id: "worker", agentKey: "local:worker", label: "Scanner worker",
  bindingId: "local:worker", harness: "codex", host: THIS_MACHINE, overseer: false, onRemove: "detach",
  x: 0, y: 0, width: 240, height: 120, z: 0,
});

test.use({
  juntoOptions: {
    seedModels: {
      scanner: modelFixture([worker]),
    },
  },
});

test("Option reveals the bounded semantic scanner and release dismisses it", async ({ junto }) => {
  const { page } = junto;
  const node = page.getByTestId("rf__node-worker");
  const magnifier = page.getByTestId("canvas-magnifier");

  await expect(node).toBeVisible({ timeout: 30_000 });
  const box = await node.boundingBox();
  expect(box).toBeTruthy();
  if (!box) return;

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down("Alt");

  await expect(magnifier).toHaveAttribute("data-active", "true");
  await expect(magnifier.locator(".canvas-magnifier__subject")).toHaveText("Scanner worker");
  await expect(magnifier.locator(".canvas-magnifier__status")).toHaveText(/\S/);

  const canvasSize = await magnifier.locator("canvas").evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    return { width: canvas.width, height: canvas.height };
  });
  expect(canvasSize.width).toBeGreaterThan(300);
  expect(canvasSize.width).toBeLessThanOrEqual(468);
  expect(canvasSize.height).toBe(canvasSize.width);

  const t0 = Date.now();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 40, { steps: 24 });
  expect(Date.now() - t0).toBeLessThan(1_000);

  await page.keyboard.up("Alt");
  await expect(magnifier).toHaveAttribute("data-active", "false");
});
