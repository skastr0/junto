import { textNode, canvasDoc } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const FIXTURE_TEXT = "Inspect this note";

test.use({
  vellumOptions: {
    seedCanvases: {
      inspector: canvasDoc([textNode("n1", FIXTURE_TEXT, 0, 0)]),
    },
  },
});

test("clicking a node opens the inspector showing that node's content", async ({ vellum }) => {
  const { page } = vellum;

  const node = page.locator(".react-flow__node", { hasText: FIXTURE_TEXT });
  await expect(node).toBeVisible({ timeout: 30_000 });
  await node.click();

  const title = page.locator(".inspector-title");
  await expect(title).toBeVisible();
  await expect(title).toHaveText(FIXTURE_TEXT);
});
