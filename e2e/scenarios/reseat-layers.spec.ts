import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

test.use({ juntoOptions: { seedCanvases: { probe: canvasDoc([
  agentTextNode({ id: "seat", key: "local:e2e-reseat", label: "seat-one", harness: "claude", x: 0, y: 0 }),
]) } } });

/**
 * Re-seat rides the shared layer shells: the harness pick is a popover above
 * its key, and the confirm is a working dialog that replaces it.
 */
test("re-seat pick is a popover and its confirm a working dialog", async ({ junto }) => {
  const { page } = junto;
  await expect(page.locator('.react-flow__node[data-id="seat"]')).toBeVisible({ timeout: 30_000 });
  await page.locator('.react-flow__node[data-id="seat"]').click();
  const key = page.getByRole("button", { name: "Re-seat agent" });
  const pop = page.locator('[data-layer="popover"].agent-reseat-pop');
  const dialog = page.locator('[data-layer="working-dialog"]');

  // The key toggles the popover; Escape closes it.
  await key.click();
  await expect(pop).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(pop).toHaveCount(0);
  await key.click();
  await expect(pop).toBeVisible();
  await key.click();
  await expect(pop).toHaveCount(0);

  // The list loads after the popover opens: it still sits above its key.
  await key.click();
  await expect(pop.getByText("Hermes")).toBeVisible();
  const popBox = await pop.boundingBox();
  const keyBox = await key.boundingBox();
  expect(popBox!.y + popBox!.height).toBeLessThanOrEqual(keyBox!.y);

  // A pick hands over to the confirm; Escape answers Cancel and nothing is left open.
  await pop.getByText("Hermes").click();
  await expect(dialog).toBeVisible();
  await expect(pop).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Cancel" }).last()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});
