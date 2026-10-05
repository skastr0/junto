/**
 * Settings, reset section: the header's reset asks before it resets. The
 * confirm is a working dialog over Settings, so Escape closes the confirm
 * only; Providers says its keys are deleted; Machine has no reset at all.
 *
 *   bun run test:e2e:fast e2e/scenarios/settings-reset-confirm.spec.ts
 */
import { expect, launchJunto, test } from "../harness/launch";

test("reset section asks first, and Escape closes only the confirm", async () => {
  test.setTimeout(120_000);
  const junto = await launchJunto({});
  try {
    const { page } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 60_000 });
    const theme = () =>
      page.evaluate(async () => (await window.junto?.settingsGet())?.settings?.appearance.theme ?? null);

    await page.getByRole("button", { name: "Open settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    // Settings sits in the centre of the window once its entrance settles.
    await expect
      .poll(() =>
        page.locator(".settings-panel").evaluate((panel) => {
          const box = panel.getBoundingClientRect();
          return Math.abs(box.top + box.height / 2 - window.innerHeight / 2);
        }),
      )
      .toBeLessThanOrEqual(1);
    await page.locator(".settings-nav__item", { hasText: "Appearance" }).click();
    await page.getByRole("radiogroup", { name: "Theme", exact: true }).getByRole("radio", { name: "Bright", exact: true }).click();
    await expect.poll(theme).toBe("bright");

    // One click no longer resets: it asks, naming the section.
    const confirm = page.getByTestId("settings-reset-confirm");
    await page.getByRole("button", { name: "Reset Appearance" }).click();
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("Reset Appearance?");
    await expect(confirm).toContainText("Every setting in Appearance goes back to its default.");
    await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
    expect(await theme()).toBe("bright");

    // Escape closes the confirm and only the confirm.
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    await expect(settings).toBeVisible();
    expect(await theme()).toBe("bright");

    // Confirming resets the section.
    await page.getByRole("button", { name: "Reset Appearance" }).click();
    await confirm.getByRole("button", { name: "Reset Appearance" }).click();
    await expect(confirm).toHaveCount(0);
    await expect.poll(theme).toBe("system");
    await expect(settings).toBeVisible();

    // Providers says what is lost in plain words, and means it: Cancel keeps
    // a stored key, confirming deletes it.
    const keyStored = () =>
      page.evaluate(
        async () => (await window.junto?.settingsGet())?.settings?.providers?.openai?.apiKeyConfigured === true,
      );
    const saved = await page.evaluate(() =>
      window.junto!.settingsPatch({ providers: { openai: { apiKey: "sk-e2e-reset-confirm" } } }),
    );
    expect(saved.ok, `storing a test key: ${saved.message ?? ""}`).toBe(true);
    await expect.poll(keyStored).toBe(true);
    await page.locator(".settings-nav__item", { hasText: "Providers" }).click();
    await page.getByRole("button", { name: "Reset Providers" }).click();
    await expect(confirm).toContainText("Every stored provider key is deleted and must be entered again.");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toHaveCount(0);
    expect(await keyStored(), "Cancel keeps the stored key").toBe(true);

    await page.getByRole("button", { name: "Reset Providers" }).click();
    await confirm.getByRole("button", { name: "Reset Providers" }).click();
    await expect(confirm).toHaveCount(0);
    await expect.poll(keyStored, { message: "confirming deletes the stored key" }).toBe(false);

    // A button in a settings row keeps its own name.
    await page.locator(".settings-nav__item", { hasText: "Advanced" }).click();
    await expect(page.getByRole("button", { name: "show again", exact: true })).toHaveCount(1);

    // Machine cannot be reset from Settings, so it offers no reset.
    const machine = page.locator(".settings-nav__item", { hasText: "Machine" });
    if ((await machine.count()) > 0) {
      await machine.click();
      await expect(page.getByRole("button", { name: "Reset Machine" })).toHaveCount(0);
    }
  } finally {
    await junto.close();
  }
});
