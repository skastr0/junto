/**
 * Real app, release checklist F2, the Files modal: the tree lists the root,
 * a row opens its file, F2 renames a file by keyboard (on disk, the open file
 * following), and the watch picks up a file made and a file deleted outside
 * Junto. Create and trash are probed in the row's context menu and reported
 * as found or not. Dark and bright; each check is reported on its own.
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/files-modal-verify.spec.ts
 */
import { existsSync, mkdirSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture } from "../harness/model";
import { filesNode, openFilesModal, openInTree, stageFiles, treeRow } from "../harness/files-scenario";

const CANVAS = "files-modal-verify";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/files-modal-verify";

const shoot = async (page: Page, name: string): Promise<void> => {
  for (const theme of ["dark", "bright"] as const) {
    mkdirSync(join(SHOTS, theme), { recursive: true });
    await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, theme, `${name}.png`) });
  }
  await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
};

type Result = { row: string; pass: boolean; detail?: string };

test("files modal: tree, open, rename by keyboard, the watch sees outside changes; create and trash probed", async () => {
  test.setTimeout(240_000);
  const stage = await stageFiles();
  const root = stage.fixture.root;
  const junto = await launchJunto({ windowContentSize: { width: 1500, height: 900 }, seedModels: { [CANVAS]: modelFixture([filesNode(root)]) } });
  const results: Result[] = [];
  const check = async (row: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
      results.push({ row, pass: true });
    } catch (error) {
      results.push({ row, pass: false, detail: String(error).replace(/\u001b\[[0-9;]*m/gu, "").split("\n").slice(0, 4).join(" ") });
    }
  };
  try {
    const { page } = junto;
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    const modal = await openFilesModal(page);

    await check("tree lists the root", async () => {
      await expect(treeRow(modal, "README.md")).toBeVisible({ timeout: 15_000 });
      await expect(treeRow(modal, "src")).toBeVisible();
    });
    await check("a row opens its file", async () => {
      await openInTree(modal, "README.md");
      await expect(modal.getByText("README.md", { exact: true }).last()).toBeVisible({ timeout: 10_000 });
    });
    await shoot(page, "1-open");

    // Rename by keyboard: F2 on the focused row, a new name, Enter.
    await check("F2 renames a file on disk and the tree shows the new name", async () => {
      await treeRow(modal, "README.md").focus();
      await page.keyboard.press("F2");
      await page.waitForTimeout(200);
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.type("GUIDE.md");
      await page.keyboard.press("Enter");
      await expect.poll(() => existsSync(join(root, "GUIDE.md")), { timeout: 10_000 }).toBe(true);
      expect(existsSync(join(root, "README.md"))).toBe(false);
      await expect(treeRow(modal, "GUIDE.md")).toBeVisible({ timeout: 10_000 });
      await expect(treeRow(modal, "README.md")).toHaveCount(0);
    });
    await shoot(page, "2-renamed");

    // The watch: a file made and a file deleted outside Junto.
    await writeFile(join(root, "outside-made.txt"), "made outside\n");
    await check("the watch shows a file made outside Junto", () => expect(treeRow(modal, "outside-made.txt")).toBeVisible({ timeout: 15_000 }));
    await shoot(page, "3-outside-made");
    await rm(join(root, "outside-made.txt"));
    await check("the watch drops a file deleted outside Junto", () => expect(treeRow(modal, "outside-made.txt")).toHaveCount(0, { timeout: 15_000 }));

    // Create and trash: whatever the row's context menu offers.
    await treeRow(modal, "GUIDE.md").click({ button: "right" });
    await page.waitForTimeout(500);
    const menu = (await page.getByRole("menuitem").allTextContents()).map((t) => t.trim()).filter(Boolean);
    const buttons = (await modal.getByRole("button").evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? el.textContent ?? ""))).map((t) => t.trim());
    console.log("F2MENU", JSON.stringify({ menu, buttons }));
    await shoot(page, "4-row-menu");
    await check("create is offered in the modal", () => expect([...menu, ...buttons].some((t) => /new file|new folder|create/iu.test(t)), JSON.stringify({ menu, buttons })).toBe(true));
    await check("trash is offered in the modal", () => expect([...menu, ...buttons].some((t) => /trash|delete/iu.test(t)), JSON.stringify({ menu, buttons })).toBe(true));
  } finally {
    console.log("F2", JSON.stringify(results));
    await junto.close();
    await stage.cleanup();
  }
  for (const r of results) expect.soft(r.pass, `${r.row}: ${r.detail ?? ""}`).toBe(true);
});
