/**
 * 0.11 F8, the way back. A box extracted from page 3 of a PDF becomes a file
 * artifact naming "docs/pages.pdf, page 3"; pressing that source line in the
 * artifact opens the Files node on the PDF with the viewer on page 3, dark and
 * bright (canvas bdcd71f74, product-shell 2f96bc472).
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/files-extract-link.spec.ts
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import type { Locator, Page } from "@playwright/test";
import { Node } from "../../src/shared/model";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture } from "../harness/model";
import { filesNode, openFilesModal, openInTree, stageFiles } from "../harness/files-scenario";

const CANVAS = "files-extract-link";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/files-extract-link";
const shelf = Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })({
  kind: "artifacts",
  id: "shelf",
  label: "Shelf",
  x: 420,
  y: 60,
  width: 280,
  height: 160,
  z: 0,
});

const drag = async (page: Page, surface: Locator, from: [number, number], to: [number, number]): Promise<void> => {
  const box = (await surface.boundingBox())!;
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 8 });
  await page.mouse.up();
};

/** True when `inner` is at least half inside `outer` vertically. */
const shownIn = async (outer: Locator, inner: Locator): Promise<boolean> => {
  const o = await outer.boundingBox();
  const i = await inner.boundingBox();
  if (o === null || i === null) return false;
  const top = Math.max(o.y, i.y);
  const bottom = Math.min(o.y + o.height, i.y + i.height);
  return bottom - top >= i.height / 2 || bottom - top >= o.height / 2;
};

test("an extract from page 3 links back to page 3 of its PDF, dark and bright", async () => {
  test.setTimeout(240_000);
  const stage = await stageFiles();
  const junto = await launchJunto({
    windowContentSize: { width: 1600, height: 1000 },
    seedModels: { [CANVAS]: modelFixture([filesNode(stage.fixture.root), shelf]) },
  });
  try {
    const { page } = junto;
    const path = stage.fixture.paths.pagesPdf;
    for (const theme of ["dark", "bright"] as const) {
      mkdirSync(join(SHOTS, theme), { recursive: true });
      await page.waitForFunction(() => window.junto !== undefined);
      await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
      await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe(theme === "bright" ? "bright" : null);

      // Page 3, a box on it, extracted to Shelf.
      const modal = await openFilesModal(page);
      await openInTree(modal, path);
      const pdf = modal.getByTestId("pdf-viewer");
      const pages = pdf.getByTestId("pdf-page");
      await expect(pages).toHaveCount(4, { timeout: 30_000 });
      const field = pdf.getByTestId("pdf-page-input");
      await field.click();
      await field.fill("3");
      await field.press("Enter");
      const third = pages.nth(2);
      await expect(third.locator(".textLayer span", { hasText: stage.fixture.pagesPdfText[2]! })).toBeVisible({ timeout: 15_000 });
      await pdf.getByTestId("file-view-box-tool").click();
      await drag(page, third, [60, 40], [360, 160]);
      await expect(third.getByTestId("file-box-draft")).toBeVisible();
      await pdf.getByTestId("file-box-extract").click();
      await expect(pdf.getByTestId("file-view-said")).toHaveText("Extracted to Shelf.", { timeout: 15_000 });

      // Back to page 1, then away, so the link has to do the work.
      await field.click();
      await field.fill("1");
      await field.press("Enter");
      await expect(field).toHaveValue("1");
      await openInTree(modal, stage.fixture.paths.markdown);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(modal).toBeHidden({ timeout: 10_000 });

      // The artifact names page 3; its source line opens the PDF there.
      await page.locator('.react-flow__node[data-id="shelf"]').dblclick();
      const list = page.getByRole("list", { name: "Artifacts" });
      await expect(list).toBeVisible({ timeout: 20_000 });
      await list.locator("button").filter({ hasText: "pages.pdf, page 3" }).first().click();
      const source = page.getByRole("button", { name: "From docs/pages.pdf, page 3, open in its Files node" });
      await expect(source).toBeVisible({ timeout: 15_000 });
      await page.screenshot({ path: join(SHOTS, theme, "1-artifact.png") });
      await source.click();

      const back = page.getByRole("dialog", { name: "Files" });
      await expect(back).toBeVisible({ timeout: 20_000 });
      const viewer = back.getByTestId("pdf-viewer");
      await expect(viewer.getByTestId("pdf-page")).toHaveCount(4, { timeout: 30_000 });
      await expect(viewer.getByTestId("pdf-page-input")).toHaveValue("3", { timeout: 15_000 });
      const landed = viewer.getByTestId("pdf-page").nth(2).locator(".textLayer span", { hasText: stage.fixture.pagesPdfText[2]! });
      await expect(landed).toBeVisible({ timeout: 15_000 });
      await expect.poll(() => shownIn(viewer, viewer.getByTestId("pdf-page").nth(2)), { timeout: 10_000 }).toBe(true);
      await page.screenshot({ path: join(SHOTS, theme, "2-landed-on-page-3.png") });

      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(back).toBeHidden({ timeout: 10_000 });
      // The Artifacts modal may still be under it.
      if (await list.isVisible()) {
        await page.keyboard.press("Escape");
        await expect(list).toBeHidden({ timeout: 10_000 });
      }
    }
  } finally {
    await junto.close();
    await stage.cleanup();
  }
});
