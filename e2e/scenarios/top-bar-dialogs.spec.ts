import { canvasDoc } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

/**
 * Top bar overlays ride the shared layer shells: the help map is a popover
 * that closes on Escape or any press outside it, and the canvas dialogs are
 * working dialogs that trap Tab and close on Escape.
 */

test.use({ juntoOptions: { seedCanvases: { probe: canvasDoc([
  { id: "n", type: "text", x: 0, y: 0, width: 240, height: 90, text: "note" },
]) } } });

test("top bar help popover and canvas dialogs open, hold focus, and close", async ({ junto }) => {
  const { page } = junto;
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });

  // Help: opens, stays in the popover layer, closes on a press on another bar control and on Escape.
  const help = page.getByRole("button", { name: "Open interaction help" });
  await help.click();
  const pop = page.locator('[data-layer="popover"].station-help');
  await expect(pop).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(pop).toHaveCount(0);
  await help.click();
  await expect(pop).toBeVisible();
  await help.click();
  await expect(pop).toHaveCount(0);
  await help.click();
  await expect(pop).toBeVisible();
  await page.locator(".station-save").click();
  await expect(pop).toHaveCount(0);

  // New canvas: focus in the field, Tab stays inside, Escape closes, Enter creates.
  await page.getByRole("button", { name: "New canvas" }).click();
  const dialog = page.locator('[data-layer="working-dialog"]');
  await expect(dialog).toBeVisible();
  await expect(page.getByLabel("Canvas name")).toBeFocused();
  for (let i = 0; i < 6; i++) await page.keyboard.press("Tab");
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[data-layer="working-dialog"]')))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "New canvas" }).click();
  await page.getByLabel("Canvas name").fill("second");
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".station-select")).toContainText(/second/i);

  // Delete canvas: focus starts on Cancel; confirm deletes.
  await page.getByRole("button", { name: "Delete canvas" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" }).last()).toBeFocused();
  await dialog.getByRole("button", { name: "Delete canvas" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".station-select")).not.toContainText(/second/i);
});
