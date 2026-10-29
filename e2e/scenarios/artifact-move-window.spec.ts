/**
 * Real app, plan 0.11.1 10 M2: the window side of moving artifacts, dark and
 * bright. (1) M on a focused row opens Move to; the picker lists the other
 * Artifacts nodes by name and region, the current one left out; a pick in
 * another region says whose reach changes, and Enter moves. (2) Shift and an
 * arrow pick a second row; the row menu's Move to takes both. (3) The header's
 * Move to, and the moved artifact's history names the move.
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/artifact-move-window.spec.ts
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { Schema } from "effect";
import { asNodeId, Node } from "../../src/shared/model";
import { mintItemId, mintOpId } from "../../src/shared/resource-command";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelRegion } from "../harness/model";

const CANVAS = "move-window";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/artifact-move-window";
const node = (raw: object) => Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })(raw);
const specs = node({ kind: "artifacts", id: "specs", label: "Specs", x: 40, y: 60, width: 280, height: 160, z: 0 });
const drafts = node({ kind: "artifacts", id: "drafts", label: "Drafts", x: 40, y: 260, width: 280, height: 160, z: 0 });
const shelf = node({ kind: "artifacts", id: "shelf", label: "Shelf", x: 940, y: 60, width: 280, height: 160, z: 0 });

const seed = (page: Page, title: string): Promise<{ kind: string }> =>
  page.evaluate(
    ({ canvas, node, artifactId, opId, title }) =>
      window.junto!.resource!.artifact!.apply(canvas, node, artifactId, opId, {
        op: "create",
        title,
        body: { type: "document", markdown: `# ${title}` },
      }) as Promise<{ kind: string }>,
    { canvas: CANVAS, node: asNodeId("specs"), artifactId: mintItemId(), opId: mintOpId(), title },
  );

const setTheme = async (page: Page, theme: "bright" | "dark"): Promise<void> => {
  await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
  if (theme === "bright") await expect(page.locator("html")).toHaveAttribute("data-theme", "bright");
  else await expect(page.locator("html")).not.toHaveAttribute("data-theme", "bright");
};

const shoot = async (page: Page, name: string): Promise<void> => {
  for (const theme of ["dark", "bright"] as const) {
    mkdirSync(join(SHOTS, theme), { recursive: true });
    await setTheme(page, theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, theme, `${name}.png`) });
  }
  await setTheme(page, "dark");
};

const row = (page: Page, title: string) =>
  page.getByRole("list", { name: "Artifacts" }).locator("button").filter({ hasText: title }).first();

const titlesIn = async (page: Page, nodeId: string): Promise<ReadonlyArray<string>> =>
  page.evaluate(
    async ({ canvas, nodeId }) =>
      ((await window.junto!.resource!.artifact!.list(canvas, nodeId)) as ReadonlyArray<{ artifact: { title: string } }>)
        .map((head) => head.artifact.title)
        .sort(),
    { canvas: CANVAS, nodeId: asNodeId(nodeId) },
  );

test("artifact move window: M, the reach line, several rows, the row menu, the header and history, dark and bright", async () => {
  test.setTimeout(240_000);
  const product = modelRegion({ id: "product", label: "Product", x: 0, y: 0, width: 800, height: 500 });
  const release = modelRegion({ id: "release", label: "Release", x: 900, y: 0, width: 800, height: 500 });
  const junto = await launchJunto({
    windowContentSize: { width: 1500, height: 900 },
    seedModels: { [CANVAS]: modelFixture([product, release, specs, drafts, shelf], []) },
  });
  try {
    const { page } = junto;
    await expect(page.locator('.react-flow__node[data-id="specs"]')).toBeVisible({ timeout: 30_000 });
    for (const title of ["Alpha", "Beta", "Gamma", "Delta"]) expect((await seed(page, title)).kind).toBe("applied");
    await page.locator('.react-flow__node[data-id="specs"]').dblclick();
    await expect(page.getByRole("list", { name: "Artifacts" })).toBeVisible({ timeout: 20_000 });

    // (1) M on a focused row: the picker, the reach line, Enter.
    await row(page, "Alpha").click();
    await row(page, "Alpha").focus();
    await page.keyboard.press("m");
    const dialog = page.getByRole("dialog", { name: "Move Alpha" });
    await expect(dialog).toBeVisible();
    const field = dialog.getByRole("combobox");
    await expect(field).toBeFocused();
    await expect(dialog.getByRole("option")).toHaveText(["DraftsProduct", "ShelfRelease"]);
    await page.keyboard.press("ArrowDown");
    await expect(dialog.locator(".artifact-move__reach")).toHaveText("");
    await page.keyboard.press("ArrowDown");
    await expect(dialog.locator(".artifact-move__reach")).toHaveText("Seats in Product will no longer reach this; seats in Release will.");
    await shoot(page, "1-picker-reach-line");
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(page.locator(".artifacts-moved")).toHaveText("Moved Alpha to Shelf.");
    expect(await titlesIn(page, "shelf")).toEqual(["Alpha"]);
    await shoot(page, "1-moved-line");

    // (2) Shift and an arrow pick a second row; the row menu moves both.
    await row(page, "Beta").click();
    await row(page, "Beta").focus();
    // Newest first: Delta, Gamma, Beta. Beta is last, so the run grows up to Gamma.
    await page.keyboard.press("Shift+ArrowUp");
    await expect(page.locator(".artifacts-picked")).toHaveText("2 picked. M or Move to moves them together.");
    await expect(page.locator('.artifacts-list__item[data-picked="true"]')).toHaveCount(2);
    await shoot(page, "2-two-picked");
    await page.keyboard.press("Shift+F10");
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem")).toHaveText(["Move 2 to…"]);
    await shoot(page, "2-row-menu");
    await page.keyboard.press("Enter");
    const two = page.getByRole("dialog", { name: "Move 2 artifacts" });
    await expect(two).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(two).toBeHidden();
    await expect(page.locator(".artifacts-moved")).toHaveText("Moved 2 artifacts to Drafts.");
    expect(await titlesIn(page, "drafts")).toEqual(["Beta", "Gamma"]);

    // Cancel from a row's menu gives the keyboard back to the row.
    await row(page, "Delta").click();
    await row(page, "Delta").focus();
    await page.keyboard.press("Shift+F10");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Move Delta" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Move Delta" })).toBeHidden();
    await expect(row(page, "Delta")).toBeFocused();

    // (3) The header's Move to, then the history line on the moved artifact, read from Shelf.
    await row(page, "Delta").click();
    await page.getByRole("button", { name: "Move to…" }).click();
    const header = page.getByRole("dialog", { name: "Move Delta" });
    await expect(header).toBeVisible();
    // Across regions a double press only picks, so the line is read; Enter moves.
    await header.getByRole("option").filter({ hasText: "Shelf" }).dblclick();
    await expect(header.locator(".artifact-move__reach")).toHaveText("Seats in Product will no longer reach this; seats in Release will.");
    await expect(header).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(header).toBeHidden();
    expect(await titlesIn(page, "specs")).toEqual([]);
    await page.keyboard.press("Escape");
    await page.locator('.react-flow__node[data-id="shelf"]').dblclick();
    await row(page, "Alpha").click();
    await page.getByRole("button", { name: "History" }).click();
    await expect(page.locator(".artifact-history__list")).toContainText("Moved from Specs to Shelf");
    await shoot(page, "3-history-line");
  } finally {
    await junto.close();
  }
});
