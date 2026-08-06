import type { CanvasEdge } from "../../src/shared/canvas";
import { canvasDoc, textNode } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const edge: CanvasEdge = {
  id: "e-settings",
  fromNode: "source",
  toNode: "target",
};

test.use({
  vellumOptions: {
    seedCanvases: {
      "edge-settings": canvasDoc([
        textNode("source", "Source node", 0, 0),
        textNode("target", "Target node", 420, 0),
      ], [edge]),
    },
  },
});

test("double-clicking an edge opens its settings fields", async ({ vellumCommand }) => {
  const { page } = vellumCommand;
  const flowEdge = page.getByTestId("rf__edge-e-settings");
  const source = page.getByTestId("rf__node-source");
  const target = page.getByTestId("rf__node-target");

  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await expect(flowEdge).toHaveCount(1, { timeout: 30_000 });
  await expect(source).toBeVisible({ timeout: 30_000 });
  await expect(target).toBeVisible({ timeout: 30_000 });

  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  expect(sourceBox).toBeTruthy();
  expect(targetBox).toBeTruthy();
  if (!sourceBox || !targetBox) return;
  await page.mouse.dblclick(
    (sourceBox.x + sourceBox.width + targetBox.x) / 2,
    (sourceBox.y + sourceBox.height / 2 + targetBox.y + targetBox.height / 2) / 2,
  );

  const fields = page.locator(".rts-kind-form-panel");
  await expect(fields).toBeVisible({ timeout: 10_000 });
  await expect(fields.getByText("execution edge", { exact: true })).toBeVisible();
  await expect(fields.getByLabel("Edit edge label")).toBeVisible();
});
