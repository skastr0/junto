/**
 * Settings, Keyboard shortcuts: the list reads the key table, a row records
 * a new chord without that chord reaching any other shortcut, a chord
 * another shortcut has is named before anything is saved, and the chord
 * chosen is the one the app then answers.
 *
 *   bun run test:e2e:fast e2e/scenarios/keyboard-shortcuts-settings.spec.ts
 */
import { expect, launchJunto, test } from "../harness/launch";

test("a shortcut is listed, recorded, refused on a clash, and then answered", async ({}, testInfo) => {
  test.setTimeout(150_000);
  const junto = await launchJunto({});
  try {
    const { page } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 60_000 });
    const overrides = () =>
      page.evaluate(async () => (await window.junto?.settingsGet())?.settings?.keyboard?.overrides ?? {});
    // The pointer rests off the page for a frame, so no tooltip covers a row.
    const shot = async (name: string) => {
      await page.mouse.move(2, 2);
      await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
    };
    // The saved theme is "system": name the one the first frames are taken in.
    const theme = () => page.evaluate(() => document.documentElement.dataset.theme ?? "dark");
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    await expect.poll(theme).toBe("dark");

    await page.getByRole("button", { name: "Open settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await page.locator(".settings-nav__item", { hasText: "Keyboard shortcuts" }).click();
    const section = page.getByTestId("settings-keyboard-section");
    await expect(section).toBeVisible();
    for (const group of ["Anywhere", "Search and feed", "Canvas", "Agent and terminal"]) {
      await expect(section.getByRole("region", { name: group, exact: true })).toBeVisible();
    }
    await shot("list-dark");

    // Recording: the row says so, and Cmd+K is recorded here, not run.
    const feedRow = () => section.getByRole("button", { name: "Change the keys for Open the needs-you feed" });
    await feedRow().click();
    const recording = section.getByRole("button", { name: "Press keys for Open the needs-you feed" });
    await expect(recording).toHaveText("Press keys");
    await shot("recording-dark");
    await page.keyboard.press("Meta+k");
    await expect(page.getByTestId("command-bar-input")).toHaveCount(0);
    await expect(section).toContainText("Already used by Open search");
    expect(await overrides()).toEqual({});
    await shot("conflict-dark");
    await section.getByRole("button", { name: "Cancel", exact: true }).click();

    // A free chord is saved, and the row can go back to its default.
    await feedRow().click();
    await page.keyboard.press("Meta+j");
    await expect.poll(overrides).toEqual({ "feed.open": ["Cmd+J"] });
    await expect(
      section.getByRole("button", { name: "Reset Open the needs-you feed to its default keys" }),
    ).toBeVisible();

    // Escape while recording cancels in place: Settings stays open.
    await feedRow().click();
    await page.keyboard.press("Escape");
    await expect(settings).toBeVisible();
    await expect(feedRow()).toBeVisible();

    // The filter narrows by name or by key.
    await section.getByRole("searchbox", { name: "Filter shortcuts" }).fill("zoom");
    await expect(section).not.toContainText("Open search");
    await expect(section).toContainText("Zoom the canvas in");
    await shot("filter-dark");
    await section.getByRole("searchbox", { name: "Filter shortcuts" }).fill("");
    await shot("changed-dark");

    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "bright" } }));
    await expect.poll(theme).toBe("bright");
    await shot("changed-bright");
    await feedRow().click();
    await shot("recording-bright");
    await page.keyboard.press("Escape");

    // The app answers the chosen chord, and no longer the default.
    await page.keyboard.press("Meta+w");
    await expect(settings).toHaveCount(0);
    await page.keyboard.press("Meta+i");
    await expect(page.getByTestId("operator-feed")).toHaveCount(0);
    await page.keyboard.press("Meta+j");
    await expect(page.getByTestId("operator-feed")).toBeVisible();
  } finally {
    await junto.close();
  }
});
