/**
 * Real app, release checklist F7, the image half the files-walk spec does not
 * cover: a box drawn on an image takes a comment that lists in the rail, and
 * the rail shows only the open file's threads. Built on files-walk's working
 * steps (the box tool, the New comment composer); files-comments.spec.ts is
 * still marked fixme on main and names test ids the product does not ship.
 * Dark and bright; each check is reported on its own.
 *   bun run test:e2e:fast e2e/scenarios/files-f7-verify.spec.ts
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture } from "../harness/model";
import { filesNode, openFilesModal, openInTree, stageFiles } from "../harness/files-scenario";

const CANVAS = "files-f7-verify";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/files-f7-verify";

const drag = async (page: Page, surface: Locator, from: [number, number], to: [number, number]): Promise<void> => {
  const box = (await surface.boundingBox())!;
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + (from[0] + to[0]) / 2, box.y + (from[1] + to[1]) / 2, { steps: 4 });
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 4 });
  await page.mouse.up();
};

type Result = { row: string; pass: boolean; detail?: string };

test("F7: a box on an image takes a comment the rail lists, and the rail shows only the open file's threads", async () => {
  test.setTimeout(240_000);
  const stage = await stageFiles();
  const junto = await launchJunto({ windowContentSize: { width: 1600, height: 1000 }, seedModels: { [CANVAS]: modelFixture([filesNode(stage.fixture.root)]) } });
  const results: Result[] = [];
  const check = async (row: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
      results.push({ row, pass: true });
    } catch (error) {
      results.push({ row, pass: false, detail: String(error).replace(/\u001b\[[0-9;]*m/gu, "").split("\n").slice(0, 5).join(" ") });
    }
  };
  try {
    const { page } = junto;
    for (const theme of ["dark", "bright"] as const) {
      mkdirSync(join(SHOTS, theme), { recursive: true });
      await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
      const modal = await openFilesModal(page);
      await openInTree(modal, stage.fixture.paths.png);
      const tool = modal.getByTestId("file-view-box-tool");
      await expect(tool).toBeVisible({ timeout: 15_000 });
      const picture = modal.getByTestId("file-box-layer").first();
      await expect(picture).toBeVisible({ timeout: 15_000 });
      if ((await tool.getAttribute("aria-pressed")) !== "true") await tool.click();
      await drag(page, picture, [40, 30], [200, 140]);
      const text = `picture note ${theme}`;
      await check(`${theme}: a box on the image opens the composer`, async () => {
        const composer = modal.getByRole("combobox", { name: "New comment" }).or(modal.getByRole("textbox", { name: "New comment" }));
        await composer.first().click({ timeout: 10_000 });
        await page.keyboard.type(text);
        await modal.getByRole("button", { name: "Comment", exact: true }).click();
      });
      const thread = modal.locator(".artifact-thread", { hasText: text });
      await check(`${theme}: the comment lists in the rail, once`, async () => {
        await expect(thread).toHaveCount(1, { timeout: 15_000 });
        console.log("F7-ANCHOR", theme, await thread.locator(".artifact-thread__anchor").innerText().catch(() => "(no anchor line)"));
      });
      await page.screenshot({ path: join(SHOTS, theme, "1-image-box-comment.png") });
      await openInTree(modal, stage.fixture.paths.markdown);
      await check(`${theme}: another file's rail does not list it`, () => expect(modal.locator(".artifact-thread", { hasText: text })).toHaveCount(0, { timeout: 10_000 }));
      await page.screenshot({ path: join(SHOTS, theme, "2-other-file-rail.png") });
      await openInTree(modal, stage.fixture.paths.png);
      await check(`${theme}: back on the image it lists again`, () => expect(modal.locator(".artifact-thread", { hasText: text })).toHaveCount(1, { timeout: 10_000 }));
      await expect(async () => {
        await page.keyboard.press("Escape");
        await expect(modal).toBeHidden({ timeout: 1_000 });
      }).toPass({ timeout: 10_000 });
    }
  } finally {
    console.log("F7", JSON.stringify(results));
    await junto.close();
    await stage.cleanup();
  }
  for (const r of results) expect.soft(r.pass, `${r.row}: ${r.detail ?? ""}`).toBe(true);
});
