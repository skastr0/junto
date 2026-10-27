/**
 * A tip shows at once for keyboard focus, and a click does not bring it back:
 * the press hides it and the focus the click leaves behind keeps it hidden.
 */
import { expect, test } from "../harness/launch";

test("tooltip: keyboard focus shows the tip, a click leaves it hidden", async ({ junto }) => {
  const { page } = junto;
  const settings = page.getByRole("button", { name: "Open settings" });
  await expect(settings).toBeVisible({ timeout: 30_000 });
  const tip = page.locator("#junto-tooltip");

  // A click: hover may show the tip, the press hides it, and it stays hidden.
  await settings.hover();
  await page.mouse.down();
  await expect(tip).toHaveCount(0);
  await page.mouse.up();
  await page.waitForTimeout(150);
  await expect(tip).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Keyboard focus: the tip shows at once.
  await page.mouse.move(0, 0);
  await settings.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(settings).toBeFocused();
  await expect(tip).toBeVisible();
});
