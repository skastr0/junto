/**
 * Settings, Experimental — the tab that lists features compiled in but off
 * until the operator turns them on. Frames land in
 * test-results/experimental-settings/ (disposable, never committed).
 *
 * Needs a build that carries seat awareness as experimental: the ship profile
 * does. The all-on profile ships it on, which hides the tab, so on an all-on
 * build (the e2e gate's) the spec asserts the tab is absent, as the build
 * recorded its profile in out/build-source.json.
 *
 *   JUNTO_FEATURE_PROFILE=ship bun run build:bundles
 *   bun run test:e2e:fast e2e/scenarios/experimental-settings.spec.ts
 */
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "experimental-settings");

/** The feature profile the build under test was made with, as the build recorded it. */
const builtProfile = async (): Promise<"ship" | "all-on"> => {
  const stamp = JSON.parse(await readFile(join(process.cwd(), "out", "build-source.json"), "utf8")) as { readonly featureProfile?: unknown };
  if (stamp.featureProfile !== "ship" && stamp.featureProfile !== "all-on") throw new Error("out/build-source.json records no feature profile: rebuild from this commit");
  return stamp.featureProfile;
};

test("the Experimental tab turns seat awareness on and off, and is absent where the build ships it on", async () => {
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

      // The retired Advanced opt-out is gone.
      await page.locator(".settings-nav__item", { hasText: "Advanced" }).click();
      await expect(page.getByLabel("Seat awareness")).toHaveCount(0);

      if ((await builtProfile()) === "all-on") {
        await expect(page.locator(".settings-nav__item", { hasText: "Experimental" })).toHaveCount(0);
        await page.locator(".settings-panel__close").click();
        continue;
      }
      await page.locator(".settings-nav__item", { hasText: "Experimental" }).click();
      const toggle = page.getByRole("switch", { name: "Seat awareness (Jev)" });
      await expect(toggle).toBeVisible();
      if (await toggle.isChecked()) await toggle.click();
      await expect(toggle).not.toBeChecked();
      await page.waitForTimeout(300);
      await page.locator(".settings-panel").screenshot({ path: join(SHOTS, `${mode}-off.png`) });

      await toggle.click();
      await expect(toggle).toBeChecked();
      // Persisted through main, not held by the renderer.
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const result = await window.junto?.settingsGet();
            return result?.settings?.advanced.experimental?.seatAwareness ?? null;
          }),
        )
        .toBe(true);
      await page.waitForTimeout(300);
      await page.locator(".settings-panel").screenshot({ path: join(SHOTS, `${mode}-on.png`) });
      await page.locator(".settings-panel__close").click();
    }
  } finally {
    await junto.close();
  }
});
