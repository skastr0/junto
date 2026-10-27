/**
 * 0.11 F1 and the card half of F5, in the real app. With the files toggle on,
 * the palette offers Files after Git; a node with no label is called by its
 * folder and counts what is under its root; Finder files dropped on the card
 * copy into the root, and a taken name lands as " 2"; double-clicking the
 * card opens the Files modal. Each in the dark and the bright theme, for the
 * operator's feedback.
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/files-node-card.spec.ts
 */
import { mkdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Page } from "@playwright/test";
import { THIS_MACHINE } from "../../tests/support/machines";
import { FILES_ID, filesCard, openFilesModal, stageFiles, transferOf, drop } from "../harness/files-scenario";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelNode } from "../harness/model";

const CANVAS = "files-node-card";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/files-node-card";

const setTheme = async (page: Page, theme: "dark" | "bright"): Promise<void> => {
  await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
  if (theme === "bright") await expect(page.locator("html")).toHaveAttribute("data-theme", "bright");
  else await expect(page.locator("html")).not.toHaveAttribute("data-theme", "bright");
};

test("the palette offers Files, the card takes a drop and opens the modal, dark and bright", async () => {
  test.setTimeout(180_000);
  mkdirSync(SHOTS, { recursive: true });
  const stage = await stageFiles();
  const root = stage.fixture.root;
  const unlabeled = modelNode({ kind: "files", id: FILES_ID, x: 60, y: 60, width: 280, height: 160, z: 0, host: THIS_MACHINE, root });
  const junto = await launchJunto({ seedModels: { [CANVAS]: modelFixture([unlabeled]) } });
  const errors: string[] = [];
  junto.page.on("pageerror", (error) => errors.push(error.message));
  try {
    const { page } = junto;
    await page.waitForFunction(() => Boolean(window.junto?.settingsPatch), undefined, { timeout: 30_000 });
    await page.evaluate(() => window.junto!.settingsPatch({ advanced: { experimental: { files: true } } }));
    const card = filesCard(page);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText(basename(root));
    // The count comes from files.count with no session open.
    await expect(card).toContainText(/\d[\d,]*\+? files?/, { timeout: 20_000 });

    for (const [index, theme] of (["dark", "bright"] as const).entries()) {
      await setTheme(page, theme);

      await page.getByRole("button", { name: "Add canvas item" }).click();
      const catalog = page.getByRole("region", { name: "Node catalog" });
      await expect(catalog.getByText("Files", { exact: true })).toBeVisible();
      await page.screenshot({ path: join(SHOTS, `palette-${theme}.png`) });
      // No region holds a folder for this machine here, so the wizard asks for one.
      await catalog.getByText("Files", { exact: true }).click();
      const wizard = page.getByRole("dialog", { name: "New files" });
      await expect(wizard).toBeVisible();
      await page.screenshot({ path: join(SHOTS, `wizard-${theme}.png`) });
      await wizard.getByRole("button", { name: "cancel" }).click();
      await expect(wizard).toBeHidden();

      await card.screenshot({ path: join(SHOTS, `card-${theme}.png`) });

      const dropped = await stage.incoming(`${theme}/README.md`, `dropped in ${theme}\n`);
      await drop(card.getByTestId("files-card"), await transferOf(page, [dropped]));
      // README.md is taken, and so is the last drop's copy.
      await expect(card).toContainText(`Copied as README ${index + 2}.md.`);
      await card.screenshot({ path: join(SHOTS, `card-drop-${theme}.png`) });
      // The notice gives the line back to the count, which counted the copy.
      await expect(card).toContainText(/\d[\d,]*\+? files?/, { timeout: 10_000 });
      await card.screenshot({ path: join(SHOTS, `card-count-after-drop-${theme}.png`) });

      const modal = await openFilesModal(page);
      await page.screenshot({ path: join(SHOTS, `modal-${theme}.png`) });
      await page.keyboard.press("Escape");
      await expect(modal).toBeHidden();
    }

    const names = await readdir(root);
    expect(names).toContain("README 2.md");
    expect(names).toContain("README 3.md");
    expect(errors).toEqual([]);
  } finally {
    await junto.close();
    await stage.cleanup();
  }
});
