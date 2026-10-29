/**
 * Real app, release checklist F2, the Files modal: the tree lists the root,
 * a row opens its file, F2 renames a file by keyboard (on disk, the open file
 * following), and the watch picks up a file made and a file deleted outside
 * Junto; create, move and trash by pointer, from the row's context menu and
 * the header buttons (product-shell's files-actions.spec.ts walks the keyboard).
 * The system Trash is stood in for, as files-actions does. Dark and bright; each check is reported on its own.
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

test("files modal: tree, open, rename by keyboard, the watch sees outside changes; create, move and trash by pointer", async () => {
  test.setTimeout(240_000);
  const stage = await stageFiles();
  const root = stage.fixture.root;
  const junto = await launchJunto({ windowContentSize: { width: 1500, height: 900 }, seedModels: { [CANVAS]: modelFixture([filesNode(root)]) } });
  const results: Result[] = [];
  const check = async (row: string, run: () => void | Promise<void>): Promise<void> => {
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

    // Create, move and trash, by pointer: the row's context menu and the header buttons.
    const trashed = join(stage.parent, "trash-stand-in");
    await junto.app.evaluate(({ shell }, into) => {
      const fs = process.getBuiltinModule("node:fs");
      const path = process.getBuiltinModule("node:path");
      shell.trashItem = async (absolute: string) => {
        fs.mkdirSync(into, { recursive: true });
        fs.renameSync(absolute, path.join(into, path.basename(absolute)));
      };
    }, trashed);
    await treeRow(modal, "GUIDE.md").click({ button: "right" });
    const menu = page.getByRole("menu", { name: "Actions for GUIDE.md" });
    await check("right-click opens the row menu: New file, New folder, Rename, Move to, Move to Trash", async () => {
      await expect(menu).toBeVisible({ timeout: 5_000 });
      await expect(menu.getByRole("menuitem")).toHaveText(["New file", "New folder", "Rename", "Move to", "Move to Trash"]);
    });
    await shoot(page, "4-row-menu");
    await check("New folder from the row menu makes the folder on disk", async () => {
      await menu.getByRole("menuitem", { name: "New folder", exact: true }).click();
      await page.getByRole("textbox", { name: "Name of the new folder" }).fill("drafts");
      await page.keyboard.press("Enter");
      await expect.poll(() => existsSync(join(root, "drafts")), { timeout: 10_000 }).toBe(true);
      await expect(treeRow(modal, "drafts")).toBeVisible({ timeout: 10_000 });
    });
    await check("New file from the sidebar header makes the file on disk and lists it", async () => {
      await modal.getByRole("button", { name: "New file", exact: true }).first().click();
      await page.getByRole("textbox", { name: "Name of the new file" }).fill("notes-new.md");
      await page.keyboard.press("Enter");
      await expect.poll(() => existsSync(join(root, "notes-new.md")), { timeout: 10_000 }).toBe(true);
      await expect(treeRow(modal, "notes-new.md")).toBeVisible({ timeout: 10_000 });
    });
    await shoot(page, "5-created");
    await check("Move to from the open file's header moves it into drafts", async () => {
      await openInTree(modal, "GUIDE.md");
      await modal.getByRole("button", { name: "Move to", exact: true }).first().click();
      const folder = page.getByRole("combobox", { name: "Folder to move GUIDE.md into" });
      await folder.fill("drafts");
      await page.getByRole("option", { name: "drafts" }).first().click({ timeout: 10_000 });
      const confirm = page.getByRole("dialog", { name: "Move GUIDE.md" }).getByRole("button", { name: /^Move/u });
      if ((await confirm.count()) > 0 && (await page.getByRole("dialog", { name: "Move GUIDE.md" }).count()) > 0) await confirm.first().click();
      await expect.poll(() => existsSync(join(root, "drafts", "GUIDE.md")), { timeout: 10_000 }).toBe(true);
      expect(existsSync(join(root, "GUIDE.md"))).toBe(false);
    });
    await check("Move to Trash from the open file's header asks, names it, and trashes it", async () => {
      await openInTree(modal, "notes-new.md");
      await modal.getByRole("button", { name: "Move to Trash", exact: true }).first().click();
      const ask = page.getByRole("alertdialog", { name: "Move notes-new.md to the Trash?" });
      await expect(ask).toBeVisible({ timeout: 5_000 });
      await shoot(page, "6-trash-ask");
      await ask.getByRole("button", { name: "Move to Trash" }).click();
      await expect.poll(() => existsSync(join(trashed, "notes-new.md")), { timeout: 10_000 }).toBe(true);
      expect(existsSync(join(root, "notes-new.md"))).toBe(false);
      await expect(treeRow(modal, "notes-new.md")).toHaveCount(0, { timeout: 10_000 });
    });
    await shoot(page, "7-trashed");
  } finally {
    console.log("F2", JSON.stringify(results));
    await junto.close();
    await stage.cleanup();
  }
  for (const r of results) expect.soft(r.pass, `${r.row}: ${r.detail ?? ""}`).toBe(true);
});
