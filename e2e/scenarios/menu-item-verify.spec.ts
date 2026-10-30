/**
 * Real app, 69854eca7: one MenuItem replaces three menu-row copies, with no
 * visible change. The label colour menu on a label chip, the artifact row
 * menu (Move to) and the Files row menu, dark and bright, each with one row
 * hovered and one on the keyboard where the menu has two rows. Every item is
 * read for its height, fill, colour, outline and ring, so a run before the
 * change and one after can be compared line for line.
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/menu-item-verify.spec.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { asNodeId, type Node } from "../../src/shared/model";
import { mintItemId, mintOpId } from "../../src/shared/resource-command";
import { filesNode, openFilesModal, stageFiles } from "../harness/files-scenario";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelNode } from "../harness/model";

const CANVAS = "menu-item";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/menu-item-verify";

const readItems = (menu: Locator) =>
  menu.locator('[role="menuitem"], [role="menuitemradio"]').evaluateAll((items) =>
    items.map((el) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        text: (el.textContent ?? "").trim().slice(0, 24),
        height: Math.round(r.height * 10) / 10,
        hovered: el.matches(":hover"),
        focused: el === document.activeElement,
        focusVisible: el.matches(":focus-visible"),
        background: s.backgroundColor,
        color: s.color,
        fontSize: s.fontSize,
        outline: `${s.outlineWidth} ${s.outlineStyle} ${s.outlineColor} ${s.outlineOffset}`,
        shadow: s.boxShadow,
        radius: s.borderRadius,
        padding: s.padding,
      };
    }),
  );

test("menu items: label colour, artifact row and Files row menus, hovered and keyboard rows, dark and bright", async () => {
  test.setTimeout(400_000);
  const stage = await stageFiles();
  const junto = await launchJunto({
    windowContentSize: { width: 1500, height: 900 },
    seedModels: {
      [CANVAS]: modelFixture([
        modelNode({ kind: "artifacts", id: "specs", label: "Specs", x: 60, y: 60, width: 300, height: 200, z: 0 }),
        modelNode({ kind: "artifacts", id: "shelf", label: "Shelf", x: 60, y: 320, width: 300, height: 200, z: 0 }),
        { ...filesNode(stage.fixture.root), x: 500, y: 60 } as Node,
      ]),
    },
  });
  const { page } = junto;
  const out: Record<string, unknown> = {};
  const misses: string[] = [];
  const step = async (name: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      misses.push(`${name}: ${String(error).replace(/\u001b\[[0-9;]*m/gu, "").split("\n").slice(0, 3).join(" ")}`);
    }
  };
  const frame = async (name: string, menu: Locator, hover: () => Promise<void>): Promise<void> => {
    for (const theme of ["dark", "bright"] as const) {
      mkdirSync(join(SHOTS, theme), { recursive: true });
      await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
      await page.waitForTimeout(350);
      await hover();
      await page.waitForTimeout(200);
      await page.screenshot({ path: join(SHOTS, theme, `${name}.png`) });
      await menu.screenshot({ path: join(SHOTS, theme, `${name}-crop.png`) }).catch(() => undefined);
      out[`${theme}/${name}`] = await readItems(menu);
    }
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
  };
  const row = (p: Page, title: string) => p.getByRole("list", { name: "Artifacts" }).locator("button").filter({ hasText: title }).first();
  try {
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    await expect(page.locator('.react-flow__node[data-id="specs"]')).toBeVisible({ timeout: 30_000 });
    await page.evaluate(
      ({ canvas, node, artifactId, opId }) =>
        window.junto!.resource!.artifact!.apply(canvas, node, artifactId as never, opId, { op: "create", title: "Plan", body: { type: "document", markdown: "# Plan\n\nA plan." }, labels: ["draft", "wip"] }),
      { canvas: CANVAS, node: asNodeId("specs"), artifactId: mintItemId(), opId: mintOpId() },
    );
    await page.locator('.react-flow__node[data-id="specs"]').dblclick();
    await expect(page.getByRole("list", { name: "Artifacts" })).toBeVisible({ timeout: 20_000 });
    await row(page, "Plan").click();

    await step("label colour menu", async () => {
      await page.locator(".artifact-labels__chip").filter({ hasText: "draft" }).locator("button.artifact-labels__colour").first().click({ timeout: 10_000 });
      const menu = page.getByRole("menu").last();
      await expect(menu).toBeVisible({ timeout: 10_000 });
      const items = menu.locator('[role="menuitem"], [role="menuitemradio"]');
      await expect(items.nth(2)).toBeVisible();
      await page.keyboard.press("ArrowDown");
      await frame("1-label-colour-menu", menu, () => items.nth(3).hover());
      await page.keyboard.press("Escape");
    });

    await step("artifact row menu", async () => {
      await row(page, "Plan").click({ button: "right" });
      const menu = page.getByRole("menu").last();
      await expect(menu).toBeVisible({ timeout: 10_000 });
      const item = menu.getByRole("menuitem").first();
      await expect(item).toBeFocused({ timeout: 5_000 });
      // One row only: framed on the keyboard, then hovered while keyboard-focused.
      await frame("2a-row-menu-keyboard", menu, () => page.mouse.move(5, 5));
      await frame("2b-row-menu-hovered", menu, () => item.hover());
      await page.keyboard.press("Escape");
    });

    await step("files row menu", async () => {
      for (let i = 0; i < 3; i += 1) await page.keyboard.press("Escape");
      const modal = await openFilesModal(page);
      const readme = modal.locator('[role="treeitem"][data-item-path="README.md"]');
      await expect(readme).toBeVisible({ timeout: 15_000 });
      await readme.click({ button: "right" });
      const menu = page.getByRole("menu").last();
      await expect(menu).toBeVisible({ timeout: 10_000 });
      const items = menu.getByRole("menuitem");
      await expect(items.nth(1)).toBeVisible();
      await page.keyboard.press("ArrowDown");
      const last = (await items.count()) - 1;
      await frame("3-files-row-menu", menu, () => items.nth(last).hover());
      await page.keyboard.press("Escape");
    });
  } finally {
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(join(SHOTS, "items.json"), JSON.stringify({ out, misses }, null, 2));
    await junto.close();
    await stage.cleanup();
  }
  console.log("MENU-MISSES", JSON.stringify(misses));
  expect(misses).toEqual([]);
});
