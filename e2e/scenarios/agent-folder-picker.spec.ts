import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, launchVellum, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "design-audit");
const REPO_ROOT = process.cwd();

/**
 * Folder selection is typed, not hunted: the input filters the listing, the
 * listing answers back into the input, and a folder only has to be named once.
 */
test("picking an agent folder is one typing surface", async () => {
  await mkdir(SHOTS, { recursive: true });
  const vellum = await launchVellum();

  try {
    const { page } = vellum;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });

    await page.getByRole("button", { name: "Add canvas item" }).click();
    await page.getByRole("button", { name: /Claude Code agent/ }).hover();
    await page
      .getByRole("menu", { name: "Claude Code models" })
      .getByRole("menuitem")
      .first()
      .click();

    const location = page.getByRole("dialog", { name: "Choose agent location" });
    await expect(location).toBeVisible();
    const input = location.getByLabel("Agent working directory");
    await expect(input).toHaveValue(/^\//, { timeout: 10_000 });

    // Typing a path walks the listing to it, without a separate "go" step.
    await input.click();
    await page.keyboard.press("ControlOrMeta+a");
    await input.pressSequentially(`${REPO_ROOT}/`);
    const listing = location.getByRole("list", {
      name: `Folders in ${REPO_ROOT}`,
    });
    await expect(listing).toBeVisible({ timeout: 10_000 });
    await expect(listing.getByRole("button", { name: "Select src" }))
      .toBeVisible();
    // Dotfolders stay out of the way until a word reaches for one.
    await expect(listing.getByRole("button", { name: "Select .git" }))
      .toHaveCount(0);

    // Clicking a folder is a selection: the input takes it, the listing keeps
    // its shape rather than collapsing to the one row that was clicked.
    await listing.getByRole("button", { name: "Select src" }).click();
    await expect(input).toHaveValue(join(REPO_ROOT, "src"));
    await expect(listing.getByRole("button", { name: "Select tests" }))
      .toBeVisible();
    await page.screenshot({
      path: join(SHOTS, "20d-agent-folder-selected.png"),
      fullPage: false,
    });

    // Opening moves in, and the input follows.
    await listing.getByRole("button", { name: "Open src" }).click();
    await expect(input).toHaveValue(`${join(REPO_ROOT, "src")}/`);
    const inner = location.getByRole("list", {
      name: `Folders in ${join(REPO_ROOT, "src")}`,
    });
    await expect(inner.getByRole("button", { name: "Select renderer" }))
      .toBeVisible();

    // Typing filters the listing, and an unambiguous word completes itself.
    await input.click();
    await page.keyboard.press("End");
    await input.pressSequentially("rend");
    await expect(input).toHaveValue(join(REPO_ROOT, "src", "renderer"));
    await expect(inner.getByRole("button", { name: "Select main" }))
      .toHaveCount(0);
    await page.screenshot({
      path: join(SHOTS, "20e-agent-folder-typeahead.png"),
      fullPage: false,
    });

    await expect(location.getByRole("button", { name: "create agent" }))
      .toBeEnabled();
    await location.getByRole("button", { name: "cancel" }).click();
  } finally {
    await vellum.close();
  }
});
