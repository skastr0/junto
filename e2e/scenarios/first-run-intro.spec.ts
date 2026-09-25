import { expect, launchJunto, test } from "../harness/launch";

// First launch meets a short introduction, once. Skipping or finishing it
// writes the seen flag to the settings row; the help map brings it back.

const SHOTS = "test-results/first-run-intro";

test("a fresh install shows the introduction once and keeps it on request", async () => {
  const junto = await launchJunto({ firstRunIntro: true, offline: true });
  try {
    const { page } = junto;
    await page.evaluate(async () => {
      await window.junto!.settingsPatch({ appearance: { theme: "dark" } });
    });
    const intro = page.getByRole("dialog", { name: "Welcome to Junto" });
    await expect(intro).toBeVisible({ timeout: 30_000 });
    const slide = intro.getByTestId("first-run-intro-slide");
    await expect(slide).toHaveAttribute("data-slide", "canvas");
    await page.screenshot({ path: `${SHOTS}/1-canvas.png`, animations: "disabled" });

    await intro.getByTestId("first-run-intro-next").click();
    await expect(slide).toHaveAttribute("data-slide", "start");
    await page.screenshot({ path: `${SHOTS}/2-start.png`, animations: "disabled" });

    await page.keyboard.press("ArrowRight");
    await expect(slide).toHaveAttribute("data-slide", "play");
    await expect(intro).toContainText("starts paused");
    await page.screenshot({ path: `${SHOTS}/3-play.png`, animations: "disabled" });

    await page.keyboard.press("ArrowRight");
    await expect(slide).toHaveAttribute("data-slide", "permissions");
    await expect(intro).toContainText("run with your permissions");
    await page.screenshot({ path: `${SHOTS}/4-permissions.png`, animations: "disabled" });

    await page.keyboard.press("ArrowLeft");
    await expect(slide).toHaveAttribute("data-slide", "play");

    await intro.getByTestId("first-run-intro-skip").click();
    await expect(intro).toBeHidden();
    await expect
      .poll(async () =>
        page.evaluate(async () => (await window.junto!.settingsGet()).settings?.advanced.onboardingSeen),
      )
      .toBe(true);

    // A reload is the next launch as far as the renderer knows.
    await page.reload();
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await expect(intro).toBeHidden();

    await page.getByRole("button", { name: "Open interaction help" }).click();
    await page.getByRole("button", { name: "show the introduction" }).click();
    await expect(intro).toBeVisible();
    await expect(slide).toHaveAttribute("data-slide", "canvas");
    await page.keyboard.press("Escape");
    await expect(intro).toBeHidden();
  } finally {
    await junto.close();
  }
});

test("the introduction shows in bright mode too", async () => {
  const junto = await launchJunto({ firstRunIntro: true, offline: true });
  try {
    const { page } = junto;
    await page.evaluate(async () => {
      await window.junto!.settingsPatch({ appearance: { theme: "bright" } });
    });
    const intro = page.getByRole("dialog", { name: "Welcome to Junto" });
    await expect(intro).toBeVisible({ timeout: 30_000 });
    await intro.getByTestId("first-run-intro-next").click();
    await intro.getByTestId("first-run-intro-next").click();
    await page.screenshot({ path: `${SHOTS}/3-play-bright.png`, animations: "disabled" });
    await intro.getByTestId("first-run-intro-next").click();
    await page.screenshot({ path: `${SHOTS}/4-permissions-bright.png`, animations: "disabled" });
    await intro.getByTestId("first-run-intro-done").click();
    await expect(intro).toBeHidden();
  } finally {
    await junto.close();
  }
});
