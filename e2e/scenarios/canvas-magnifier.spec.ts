import { canvasDoc, textNode } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const worker = {
  ...textNode("worker", "Scanner worker\nWatching the line", 0, 0),
  ether: {
    entity: { kind: "agent", name: "local:worker" },
    // Actor-seat law: an agent node is a managed terminal seat. Without a
    // bindingId + harness the portfolio compiler rejects the whole canvas.
    terminal: { bindingId: "local:worker", harness: "codex" as const },
  },
};

test.use({
  juntoOptions: {
    seedCanvases: {
      scanner: canvasDoc([worker]),
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
