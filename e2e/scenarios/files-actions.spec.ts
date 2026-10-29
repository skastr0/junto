/**
 * Real app, release checklist F2, the Files modal's create, move and trash,
 * every one from the keyboard (WCAG 2.1.1):
 *   - Shift+F10 on the focused row opens its menu, role=menu with menuitems,
 *     focus on the first; arrows move, Escape and Tab give it back to the row.
 *   - New file and New folder take a name; a taken name is refused as an alert.
 *   - Move to lists the folders, arrows and Enter pick one; the file moves on
 *     disk and the keyboard is on its row in the new folder. A path typed
 *     outside the root is refused.
 *   - Move to Trash asks first, naming the entry, says where it went, and the
 *     keyboard lands on the next row. Delete and Cmd+Backspace on a row ask
 *     the same; a trash the system refuses is said as an alert in the ask.
 *   - The menu also opens by the Menu key and by right-click.
 * The system Trash is stood in for in main, so no run fills the real one.
 *   JUNTO_SHOTS_DIR=<dir> scripts/with-app-run-lock.sh bun run test:e2e:fast e2e/scenarios/files-actions.spec.ts
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture } from "../harness/model";
import { filesNode, openFilesModal, stageFiles, treeRow } from "../harness/files-scenario";

const CANVAS = "files-actions";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/files-actions";

const shoot = async (page: Page, name: string): Promise<void> => {
  for (const theme of ["dark", "bright"] as const) {
    mkdirSync(join(SHOTS, theme), { recursive: true });
    await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, theme, `${name}.png`) });
  }
  await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
};

/** The row that holds the keyboard, by its tree path, read through the tree's shadow root. */
const focusedRowPath = (page: Page): Promise<string | null> =>
  page.evaluate(() => {
    let at: Element | null = document.activeElement;
    while (at?.shadowRoot?.activeElement) at = at.shadowRoot.activeElement;
    return at instanceof HTMLElement && at.getAttribute("role") === "treeitem" ? (at.dataset.itemPath ?? null) : null;
  });

const openMenu = async (page: Page, modal: Locator, path: string): Promise<Locator> => {
  await treeRow(modal, path).focus();
  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu", { name: `Actions for ${path.split("/").pop()!.replace(/\/$/u, "")}` });
  await expect(menu).toBeVisible({ timeout: 5_000 });
  return menu;
};

/** Down from the first item to the one named, then Enter. */
const choose = async (page: Page, menu: Locator, name: string): Promise<void> => {
  const names = (await menu.getByRole("menuitem").allTextContents()).map((text) => text.trim());
  const at = names.indexOf(name);
  expect(at, JSON.stringify(names)).toBeGreaterThanOrEqual(0);
  for (let step = 0; step < at; step += 1) await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name, exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
};

test("files actions: the row menu, create, move and trash, all from the keyboard", async () => {
  test.setTimeout(240_000);
  const stage = await stageFiles();
  const root = stage.fixture.root;
  const trashed = join(stage.parent, "trash-stand-in");
  const junto = await launchJunto({ windowContentSize: { width: 1500, height: 900 }, seedModels: { [CANVAS]: modelFixture([filesNode(root)]) } });
  try {
    const { page, app } = junto;
    // The system Trash, stood in for: the entry is moved beside the root instead.
    await app.evaluate(({ shell }, into) => {
      const fs = process.getBuiltinModule("node:fs");
      const path = process.getBuiltinModule("node:path");
      shell.trashItem = async (absolute: string) => {
        // README.md stands for an entry the system Trash refuses.
        if (path.basename(absolute) === "README.md") throw new Error("refused by the stand-in");
        fs.mkdirSync(into, { recursive: true });
        fs.renameSync(absolute, path.join(into, path.basename(absolute)));
      };
    }, trashed);
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    const modal = await openFilesModal(page);
    await expect(treeRow(modal, "README.md")).toBeVisible({ timeout: 15_000 });

    // The menu from the keyboard: first item focused, arrows, Escape and Tab back to the row.
    let menu = await openMenu(page, modal, "README.md");
    await expect(menu.getByRole("menuitem")).toHaveText(["New file", "New folder", "Rename", "Move to", "Move to Trash"]);
    await expect(menu.getByRole("menuitem", { name: "New file" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: "New folder" })).toBeFocused();
    await shoot(page, "1-row-menu");
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect.poll(() => focusedRowPath(page)).toBe("README.md");
    menu = await openMenu(page, modal, "README.md");
    await page.keyboard.press("Tab");
    await expect(menu).toHaveCount(0);
    await expect.poll(() => focusedRowPath(page)).toBe("README.md");

    // New folder at the root, from the root file's row.
    menu = await openMenu(page, modal, "README.md");
    await choose(page, menu, "New folder");
    const nameField = page.getByRole("textbox", { name: "Name of the new folder" });
    await expect(nameField).toBeFocused();
    await page.keyboard.type("archive");
    await page.keyboard.press("Enter");
    await expect.poll(() => existsSync(join(root, "archive"))).toBe(true);
    await expect(treeRow(modal, "archive/")).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => focusedRowPath(page), { timeout: 5_000 }).toBe("archive/");
    await expect(modal.getByRole("status").filter({ hasText: "Made archive" })).toBeVisible();

    // New file, a taken name first: refused as an alert, then a free one.
    menu = await openMenu(page, modal, "README.md");
    await choose(page, menu, "New file");
    await expect(page.getByRole("textbox", { name: "Name of the new file" })).toBeFocused();
    await page.keyboard.type("README.md");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "New file" }).getByRole("alert")).toHaveText("A file with that name is already here.");
    await shoot(page, "2-create-refused");
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type("plan.md");
    await page.keyboard.press("Enter");
    await expect.poll(() => existsSync(join(root, "plan.md"))).toBe(true);
    await expect.poll(() => focusedRowPath(page), { timeout: 5_000 }).toBe("plan.md");

    // Move to: outside the root is refused; then arrows and Enter into archive.
    menu = await openMenu(page, modal, "plan.md");
    await choose(page, menu, "Move to");
    const folderField = page.getByRole("combobox", { name: "Folder to move plan.md into" });
    await expect(folderField).toBeFocused();
    await page.keyboard.type("link-outside");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Move plan.md" }).getByRole("alert")).toHaveText("That path leads outside this folder.");
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type("arch");
    await expect(page.getByRole("option", { name: "archive" })).toBeVisible({ timeout: 10_000 });
    await shoot(page, "3-move-to");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect.poll(() => existsSync(join(root, "archive", "plan.md"))).toBe(true);
    expect(existsSync(join(root, "plan.md"))).toBe(false);
    await expect.poll(() => focusedRowPath(page), { timeout: 5_000 }).toBe("archive/plan.md");
    await expect(modal.getByRole("status").filter({ hasText: "Moved plan.md to archive" })).toBeVisible();

    // Move to Trash from the menu: asked, named, said where it went.
    menu = await openMenu(page, modal, "archive/plan.md");
    await choose(page, menu, "Move to Trash");
    const ask = page.getByRole("alertdialog", { name: "Move plan.md to the Trash?" });
    await expect(ask).toBeVisible();
    await shoot(page, "4-trash-ask");
    await ask.getByRole("button", { name: "Move to Trash" }).click();
    await expect.poll(() => existsSync(join(trashed, "plan.md"))).toBe(true);
    await expect(treeRow(modal, "archive/plan.md")).toHaveCount(0, { timeout: 10_000 });
    await expect(modal.getByRole("status").filter({ hasText: "plan.md is in the Trash." })).toBeVisible();
    await expect.poll(() => focusedRowPath(page), { timeout: 5_000 }).toBe("data/");

    // The Menu key and a right-click open the same menu.
    await treeRow(modal, "README.md").focus();
    await page.keyboard.press("ContextMenu");
    menu = page.getByRole("menu", { name: "Actions for README.md" });
    await expect(menu.getByRole("menuitem", { name: "New file" })).toBeFocused();
    await page.keyboard.press("Escape");
    await treeRow(modal, "README.md").click({ button: "right" });
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    // Cmd+Backspace asks; a trash the system refuses is an alert in the ask, which stays.
    await treeRow(modal, "README.md").focus();
    await page.keyboard.press("Meta+Backspace");
    const refused = page.getByRole("alertdialog", { name: "Move README.md to the Trash?" });
    await expect(refused).toBeVisible();
    await refused.getByRole("button", { name: "Move to Trash" }).click();
    await expect(refused.getByRole("alert")).toBeVisible({ timeout: 10_000 });
    await shoot(page, "5-trash-refused");
    expect(existsSync(join(root, "README.md"))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(refused).toHaveCount(0);
    await expect.poll(() => focusedRowPath(page), { timeout: 5_000 }).toBe("README.md");

    // Delete on a row asks the same; Cancel leaves it and the keyboard on it.
    await treeRow(modal, "archive/").focus();
    await page.keyboard.press("Delete");
    await expect(page.getByRole("alertdialog", { name: "Move archive to the Trash?" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    expect(existsSync(join(root, "archive"))).toBe(true);
    await expect.poll(() => focusedRowPath(page), { timeout: 5_000 }).toBe("archive/");
    await shoot(page, "6-after");
  } finally {
    await junto.close();
    await stage.cleanup();
  }
});
