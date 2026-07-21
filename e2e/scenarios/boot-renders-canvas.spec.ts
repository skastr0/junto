import { textNode, canvasDoc } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const FIXTURE_TEXT = "Hello Vellum e2e";

test.use({
  vellumOptions: {
    seedCanvases: {
      boot: canvasDoc([textNode("n1", FIXTURE_TEXT, 0, 0)]),
    },
  },
});

test("boots straight into the seeded canvas and renders its node", async ({ vellum }) => {
  const { page } = vellum;

  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  const node = page.locator(".react-flow__node", { hasText: FIXTURE_TEXT });
  await expect(node).toBeVisible();
});
