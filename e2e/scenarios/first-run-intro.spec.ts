import type { Page } from "@playwright/test";
import { expect, launchJunto, test } from "../harness/launch";

// First launch meets the tour, once. Skipping or finishing it writes the seen
// flag to the settings row; the command bar brings it back. Every chapter is
// captured in dark and bright to test-results/first-run-intro/.

const SHOTS = "test-results/first-run-intro";

const setTheme = async (page: Page, theme: "dark" | "bright") => {
  await page.evaluate(async (next) => {
    await window.junto!.settingsPatch({ appearance: { theme: next } });
  }, theme);
  if (theme === "bright") await expect(page.locator("html")).toHaveAttribute("data-theme", "bright");
  else await expect(page.locator("html")).not.toHaveAttribute("data-theme", "bright");
};

/** Walk every chapter with the arrow keys, capturing each once its demo has run a little. */
const captureChapters = async (page: Page, theme: "dark" | "bright") => {
  const intro = page.getByRole("dialog", { name: "Welcome to Junto" });
  const slide = intro.getByTestId("first-run-intro-slide");
  const count = await intro.locator(".first-run-intro__chapter").count();
  expect(count).toBeGreaterThan(2);
  for (let step = 0; step < count; step += 1) {
    const id = await slide.getAttribute("data-slide");
    await page.waitForTimeout(1400);
    await page.screenshot({ path: `${SHOTS}/${theme}-${String(step + 1)}-${String(id)}.png` });
    if (step < count - 1) {
      await page.keyboard.press("ArrowRight");
      await expect(slide).not.toHaveAttribute("data-slide", String(id));
    }
  }
  return count;
};

test("a fresh install shows the tour once and keeps it on request", async () => {
  const junto = await launchJunto({ firstRunIntro: true, offline: true });
  try {
    const { page } = junto;
    await setTheme(page, "dark");
    const intro = page.getByRole("dialog", { name: "Welcome to Junto" });
    await expect(intro).toBeVisible({ timeout: 30_000 });
    const slide = intro.getByTestId("first-run-intro-slide");
    await expect(slide).toHaveAttribute("data-slide", "seats");
    // The first chapter's demo is the canvas's own seat, not a picture of one.
    await expect(slide.getByTestId("agent-seat").first()).toBeVisible();
    await expect(slide.locator(".junto-mark[data-mark-size='seat']").first()).toBeVisible();

    const count = await captureChapters(page, "dark");
    await expect(slide).toHaveAttribute("data-slide", "permissions");
    await expect(intro).toContainText("run with your permissions");
    await page.keyboard.press("ArrowLeft");
    await expect(slide).not.toHaveAttribute("data-slide", "permissions");

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

    // The command bar brings it back, from the first chapter.
    await setTheme(page, "bright");
    await page.keyboard.press("Meta+k");
    const input = page.getByTestId("command-bar-input");
    await expect(input).toBeVisible();
    await input.fill(">tour");
    await expect(page.locator(".command-bar__list")).toContainText("Show the tour");
    await page.keyboard.press("Enter");
    await expect(intro).toBeVisible();
    await expect(slide).toHaveAttribute("data-slide", "seats");
    expect(await captureChapters(page, "bright")).toBe(count);
    await page.keyboard.press("Escape");
    await expect(intro).toBeHidden();
  } finally {
    await junto.close();
  }
});
