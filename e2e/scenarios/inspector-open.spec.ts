import { textNode, canvasDoc } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const FIXTURE_TEXT = "Inspect this note";

test.use({
  juntoOptions: {
    seedCanvases: {
      inspector: canvasDoc([textNode("n1", FIXTURE_TEXT, 0, 0)]),
    },
  },
});

test("clicking a node shows its content in the RTS command bar", async ({ junto }) => {
  const { page } = junto;

  const node = page.locator(".react-flow__node", { hasText: FIXTURE_TEXT });
  await expect(node).toBeVisible({ timeout: 30_000 });
  await node.click();

  // The sidebar inspector is retired; node selection now surfaces in the RTS
  // command bar, which shows the selected node's content.
  const bar = page.locator(".rts-shell");
  await expect(bar).toBeVisible({ timeout: 10_000 });
  await expect(bar).toContainText(FIXTURE_TEXT);
});
