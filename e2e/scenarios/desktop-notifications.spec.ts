/**
 * Desktop notifications, the parts a harness can see: Settings >
 * Notifications (switches persist through main, the kinds follow the master
 * switch) and a test banner asked of main's plane, which answers that
 * banners are off in this run. The harness never shows a native banner (the
 * plane is off while it isolates focus), so a banner's click is proved on a
 * real banner, in desktop-notifications-live.spec.ts. Frames land in
 * test-results/desktop-notifications/ (disposable, never committed).
 *
 *   electron-vite build
 *   bun run test:e2e:fast e2e/scenarios/desktop-notifications.spec.ts
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = process.env.JUNTO_SHOTS_DIR ?? join(process.cwd(), "test-results", "desktop-notifications");

const storedNotifications = (page: import("@playwright/test").Page) =>
  page.evaluate(async () => (await window.junto?.settingsGet())?.settings?.notifications ?? null);

test("Settings > Notifications persists each switch, and a test banner reaches main's plane", async () => {
  test.setTimeout(180_000);
  await mkdir(SHOTS, { recursive: true });
  const junto = await launchJunto({});
  try {
    const { page, app } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 60_000 });

    for (const mode of ["dark", "bright"] as const) {
      await page.getByRole("button", { name: "Open settings" }).click();
      await page.locator(".settings-nav__item", { hasText: "Appearance" }).click();
      const choice = page
        .getByRole("radiogroup", { name: "Theme", exact: true })
        .getByRole("radio", { name: mode === "bright" ? "Bright" : "Dark", exact: true });
      await choice.click();
      await expect(choice).toHaveAttribute("aria-checked", "true");

      await page.locator(".settings-nav__item", { hasText: "Notifications" }).click();
      await expect(page.getByTestId("settings-notifications-section")).toBeVisible();
      const master = page.getByRole("switch", { name: "Send notifications" });
      const finished = page.getByRole("switch", { name: "Finished" });
      await expect(master).toBeChecked();
      await expect(finished).toBeEnabled();

      // One kind off persists through main, and back on.
      await finished.click();
      await expect.poll(async () => (await storedNotifications(page))?.done).toBe(false);
      await finished.click();
      await expect.poll(async () => (await storedNotifications(page))?.done).toBe(true);

      await page.mouse.move(4, 4);
      await page.waitForTimeout(250);
      await page.locator(".settings-panel").screenshot({ path: join(SHOTS, `${mode}.png`) });
      await page.getByTestId("notify-test").scrollIntoViewIfNeeded();
      await page.waitForTimeout(150);
      await page.locator(".settings-panel").screenshot({ path: join(SHOTS, `${mode}-dock.png`) });

      // The master switch holds the kinds; turning it off leaves them as set.
      await master.click();
      await expect(finished).toBeDisabled();
      await expect(finished).toBeChecked();
      await expect.poll(async () => (await storedNotifications(page))?.enabled).toBe(false);
      await page.waitForTimeout(250);
      await page.locator(".settings-panel").screenshot({ path: join(SHOTS, `${mode}-off.png`) });
      await master.click();
      await expect.poll(async () => (await storedNotifications(page))?.enabled).toBe(true);
      await page.locator(".settings-panel__close").click();
    }

    // A test banner goes to main's plane, which is off in this run and says so.
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.locator(".settings-nav__item", { hasText: "Notifications" }).click();
    await page.getByTestId("notify-test").click();
    await expect(page.getByRole("status").filter({ hasText: "Notifications are off in this run." })).toBeVisible();
  } finally {
    await junto.close();
  }
});
