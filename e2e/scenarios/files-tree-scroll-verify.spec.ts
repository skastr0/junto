/**
 * Real app, 0.11.1 (fix 206ffac86): in a Files node with a long tree, scroll far down, open a file, then
 * another. The tree keeps its scroll and each picked row stays where it was on screen. The comments rail
 * opens from its edge, posts a comment, shuts, and its edge shows the count. Dark and bright.
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/files-tree-scroll-verify.spec.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture } from "../harness/model";
import { expandInTree, filesNode, openFilesModal, stageFiles, treeRow } from "../harness/files-scenario";

const CANVAS = "files-tree-scroll";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/files-tree-scroll-verify";
const LONG = "long";
const ITEMS = 160;

const padded = (n: number): string => String(n).padStart(3, "0");
const itemPath = (n: number): string => `${LONG}/item-${padded(n)}.ts`;

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

test("Files: opening files far down a long tree keeps its scroll and the picked row; the comments rail opens, posts, shuts and counts on its edge", async () => {
  test.setTimeout(300_000);
  const stage = await stageFiles();
  const root = stage.fixture.root;
  mkdirSync(join(root, LONG), { recursive: true });
  for (let n = 1; n <= ITEMS; n += 1)
    writeFileSync(join(root, itemPath(n)), `// Item ${String(n)}\n// Line one of item ${String(n)}.\nexport const item${String(n)} = ${String(n)};\n`);
  const junto = await launchJunto({
    windowContentSize: { width: 1500, height: 900 },
    seedModels: { [CANVAS]: modelFixture([filesNode(root)]) },
  });
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
    const modal = await openFilesModal(page);
    await expandInTree(modal, LONG);
    const row = (n: number): Locator => treeRow(modal, itemPath(n));

    // The tree's scroller: the first ancestor of a row that scrolls. Marked so the spec can read it.
    await row(10).evaluate((element) => {
      let node: HTMLElement | null = element.parentElement;
      while (node !== null && node.scrollHeight <= node.clientHeight) node = node.parentElement;
      node?.setAttribute("data-e2e-tree-scroll", "");
    });
    const scroller = modal.locator("[data-e2e-tree-scroll]");
    const scrollTop = (): Promise<number> => scroller.evaluate((element) => element.scrollTop);
    await check("the tree scrolls: its scroller is taller than its view", async () => {
      await expect(scroller).toHaveCount(1);
      expect(await scroller.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(500);
    });

    // Far down: the last rows, the ones a long tree leaves for last.
    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(row(ITEMS)).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(200);
    await shoot(page, "0-tree-far-down");

    // Open a file, then measure: the tree's scroll and the picked row's place on screen must not move.
    const pick = async (n: number): Promise<{ scrolled: number; shifted: number }> => {
      const target = row(n);
      const before = await target.boundingBox();
      const top = await scrollTop();
      await target.click();
      await expect
        .poll(async () => (await modal.innerText()).includes(`Line one of item ${String(n)}`), { timeout: 15_000 })
        .toBe(true);
      await page.waitForTimeout(400);
      const after = await target.boundingBox();
      return {
        scrolled: Math.abs((await scrollTop()) - top),
        shifted: before !== null && after !== null ? Math.abs(after.y - before.y) : Number.NaN,
      };
    };

    await check("opening a file far down keeps the tree's scroll and the picked row's place", async () => {
      const outcome = await pick(ITEMS - 2);
      expect(outcome.scrolled, "tree scrollTop moved").toBeLessThanOrEqual(2);
      expect(outcome.shifted, "picked row moved on screen").toBeLessThanOrEqual(2);
    });
    await shoot(page, "1-opened-far-down");

    await check("opening another file keeps the tree's scroll and the picked row's place", async () => {
      const outcome = await pick(ITEMS - 3);
      expect(outcome.scrolled, "tree scrollTop moved").toBeLessThanOrEqual(2);
      expect(outcome.shifted, "picked row moved on screen").toBeLessThanOrEqual(2);
    });
    await shoot(page, "2-opened-another");

    // The comments rail: open from its edge, post one comment on line 1, shut, and the edge shows the count.
    const composer = modal.getByLabel("New comment");
    const edge = modal.locator(".artifact-comments-edge");
    const collapse = modal.locator('[data-comments-toggle][aria-expanded="true"]');
    await check("the comments rail opens from its edge", async () => {
      if (!(await composer.isVisible())) await edge.click();
      await expect(composer).toBeVisible({ timeout: 10_000 });
    });
    await shoot(page, "3-rail-open");

    await check("a comment posts to the open file, and its thread lists", async () => {
      await modal.getByRole("button", { name: "Comment on line 1", exact: true }).click();
      await composer.fill("Scroll check note");
      await modal.locator(".artifact-comments").getByRole("button", { name: "Comment", exact: true }).click();
      await expect(modal.getByRole("list", { name: "Threads" })).toContainText("Scroll check note", { timeout: 10_000 });
    });

    await check("the rail shuts, and its edge shows the thread count", async () => {
      await collapse.click();
      await expect(composer).toBeHidden({ timeout: 10_000 });
      await expect(edge).toBeVisible({ timeout: 10_000 });
      await expect(edge).toHaveAttribute("aria-label", "Comments, 1");
      await expect(modal.getByTestId("comments-edge-count")).toHaveText("1");
    });
    await shoot(page, "4-rail-shut-with-count");

    await check("the rail opens again from the edge, then shuts", async () => {
      await edge.click();
      await expect(composer).toBeVisible({ timeout: 10_000 });
      await modal.locator('[data-comments-toggle][aria-expanded="true"]').click();
      await expect(composer).toBeHidden({ timeout: 10_000 });
    });
  } finally {
    console.log("TREE", JSON.stringify(results));
    await junto.close();
    await stage.cleanup();
  }
  for (const r of results) expect.soft(r.pass, `${r.row}: ${r.detail ?? ""}`).toBe(true);
});
