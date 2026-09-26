/**
 * Settings, Sound: the master level and switch, the families, and the
 * preview strip. Frames land in test-results/sound-settings/ (disposable,
 * never committed).
 *
 *   electron-vite build
 *   bun run test:e2e:fast e2e/scenarios/sound-settings.spec.ts
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "sound-settings");

test("the Sound tab levels each family and previews every cue", async () => {
  test.setTimeout(180_000);
  await mkdir(SHOTS, { recursive: true });
  const junto = await launchJunto({});
  try {
    const { page } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 60_000 });

    for (const mode of ["dark", "bright"] as const) {
      await page.getByRole("button", { name: "Open settings" }).click();
      await page.locator(".settings-nav__item", { hasText: "Appearance" }).click();
      const choice = page
        .getByRole("radiogroup", { name: "Theme", exact: true })
        .getByRole("radio", { name: mode === "bright" ? "Bright" : "Dark", exact: true });
      await choice.click();
      await expect(choice).toHaveAttribute("aria-checked", "true");

      await page.locator(".settings-nav__item", { hasText: "Sound" }).click();
      const section = page.getByTestId("settings-sound-section");
      await expect(section).toBeVisible();
      await expect(page.getByRole("switch", { name: "All sounds" })).toBeChecked();

      // A family switch persists through main.
      const messages = page.getByRole("switch", { name: "Messages" });
      await messages.click();
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const result = await window.junto?.settingsGet();
            return result?.settings?.audio.sounds?.traffic.enabled ?? null;
          }),
        )
        .toBe(false);
      await messages.click();
      await expect(messages).toBeChecked();

      // Preview: the engine starts its own context and a chip says it is sounding.
      await section.getByRole("button", { name: "Waiting on you" }).click();
      await expect(section.getByRole("button", { name: "Waiting on you" })).toHaveAttribute("aria-pressed", "true");
      await page.mouse.move(4, 4);
      await page.waitForTimeout(300);
      await page.locator(".settings-panel").screenshot({ path: join(SHOTS, `${mode}.png`) });

      await page.getByRole("switch", { name: "All sounds" }).click();
      await expect(page.getByRole("button", { name: "Play every sound" })).toBeDisabled();
      await page.waitForTimeout(250);
      await page.locator(".settings-panel").screenshot({ path: join(SHOTS, `${mode}-silent.png`) });
      await page.getByRole("switch", { name: "All sounds" }).click();
      await page.locator(".settings-panel__close").click();
    }
  } finally {
    await junto.close();
  }
});
